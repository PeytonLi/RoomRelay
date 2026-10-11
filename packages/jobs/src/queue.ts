import type { Pool, PoolClient } from "pg";
import type {
  CompleteOutcome,
  EnqueueInput,
  JobRow,
  JobStatus,
  JobSubject,
  PublishJobOutput,
  Queryable,
  RetryPolicy,
  SubjectVersionGuard,
} from "./types";

/*
 * Payment jobs must never be generically retried with a new idempotency key.
 * They need their own type, persistent provider request key, and retry and
 * reconciliation rules (docs/PAYMENTS.md, ARCHITECTURE A-06). This queue only
 * re-runs the same row/key. Subject guards for T-004 must lock their subject
 * row in the completion transaction so version checks and output publishing
 * cannot race a subject update.
 */

export function jobIdempotencyKey(type: string, subject: JobSubject, stage: string): string {
  const parts = [type, subject.type, subject.id, stage];
  if (parts.some((part) => typeof part !== "string" || part.length === 0 || part.includes("|"))) {
    throw new TypeError("job idempotency key parts must be non-empty strings without '|'");
  }
  if (!Number.isInteger(subject.version) || subject.version < 1) {
    throw new TypeError("subject version must be an integer greater than or equal to one");
  }
  return `${type}|${subject.type}|${subject.id}|v${subject.version}|${stage}`;
}

const DEFAULT_RETRY: RetryPolicy = { baseDelayMs: 5_000, maxDelayMs: 300_000 };

function mapJob(row: Record<string, unknown>): JobRow {
  return {
    id: String(row.id),
    type: String(row.type),
    stage: String(row.stage),
    subject: {
      type: String(row.subject_type),
      id: String(row.subject_id),
      version: Number(row.subject_version),
    },
    idempotencyKey: String(row.idempotency_key),
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at as Date | null,
    runAfter: row.run_after as Date,
    inputRef: row.input_ref,
    outputRef: row.output_ref,
    reason: row.reason === null ? null : String(row.reason),
    cancelRequestedAt: row.cancel_requested_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    finishedAt: row.finished_at as Date | null,
  };
}

function jsonParameter(value: unknown): string | null {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("job JSON value is not serializable");
  return encoded;
}

async function inTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

class LeaseLostError extends Error {}

export class PgJobQueue {
  private readonly retry: RetryPolicy;

  constructor(private readonly pool: Pool, opts?: { retry?: Partial<RetryPolicy> }) {
    this.retry = { ...DEFAULT_RETRY, ...opts?.retry };
    if (
      !Number.isFinite(this.retry.baseDelayMs) ||
      this.retry.baseDelayMs < 0 ||
      !Number.isFinite(this.retry.maxDelayMs) ||
      this.retry.maxDelayMs < 0
    ) {
      throw new RangeError("retry delays must be finite non-negative numbers");
    }
  }

  async enqueue(input: EnqueueInput): Promise<{ job: JobRow; created: boolean }> {
    const key = jobIdempotencyKey(input.type, input.subject, input.stage);
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    const inserted = await this.pool.query(
      `INSERT INTO jobs
        (type, stage, subject_type, subject_id, subject_version, idempotency_key,
         max_attempts, run_after, input_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.type,
        input.stage,
        input.subject.type,
        input.subject.id,
        input.subject.version,
        key,
        maxAttempts,
        input.runAfter ?? null,
        jsonParameter(input.inputRef),
      ],
    );
    if (inserted.rows[0]) return { job: mapJob(inserted.rows[0]), created: true };

    const existing = await this.pool.query("SELECT * FROM jobs WHERE idempotency_key = $1", [key]);
    if (!existing.rows[0]) throw new Error("idempotent job insert conflict without an existing row");
    return { job: mapJob(existing.rows[0]), created: false };
  }

  async lease(opts: { workerId: string; types: string[]; leaseMs: number }): Promise<JobRow | null> {
    if (opts.types.length === 0) return null;
    if (!opts.workerId || !Number.isFinite(opts.leaseMs) || opts.leaseMs <= 0) {
      throw new RangeError("workerId and a positive leaseMs are required");
    }
    return inTransaction(this.pool, async (client) => {
      const expired = await client.query(
        `SELECT id, cancel_requested_at
         FROM jobs
         WHERE status = 'RUNNING'
           AND lease_expires_at < now()
           AND type = ANY($1::text[])
           AND (attempts >= max_attempts OR cancel_requested_at IS NOT NULL)
         FOR UPDATE SKIP LOCKED`,
        [opts.types],
      );
      for (const row of expired.rows) {
        const cancelled = row.cancel_requested_at !== null;
        await client.query(
          `UPDATE jobs
           SET status = $2, reason = $3, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, finished_at = now(), updated_at = now()
           WHERE id = $1`,
          [
            row.id,
            cancelled ? "CANCELLED" : "FAILED",
            cancelled ? "CANCELLED_WHILE_RUNNING" : "LEASE_EXPIRED_MAX_ATTEMPTS",
          ],
        );
      }

      const candidate = await client.query(
        `SELECT id
         FROM jobs
         WHERE type = ANY($1::text[])
           AND cancel_requested_at IS NULL
           AND ((status = 'QUEUED' AND run_after <= now())
             OR (status = 'RUNNING' AND lease_expires_at < now() AND attempts < max_attempts))
         ORDER BY run_after, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [opts.types],
      );
      if (!candidate.rows[0]) return null;
      const leased = await client.query(
        `UPDATE jobs
         SET status = 'RUNNING', attempts = attempts + 1, lease_owner = $2,
             lease_token = gen_random_uuid()::text,
             lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [candidate.rows[0].id, opts.workerId, opts.leaseMs],
      );
      return leased.rows[0] ? mapJob(leased.rows[0]) : null;
    });
  }

  async heartbeat(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<{ ok: boolean; cancelRequested: boolean }> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new RangeError("leaseMs must be positive");
    const result = await this.pool.query(
      `UPDATE jobs
       SET lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
       RETURNING cancel_requested_at`,
      [jobId, leaseToken, leaseMs],
    );
    return {
      ok: result.rowCount === 1,
      cancelRequested: result.rows[0]?.cancel_requested_at !== null && result.rowCount === 1,
    };
  }

  async complete(
    jobId: string,
    leaseToken: string,
    output: unknown,
    guard: SubjectVersionGuard,
    publish?: PublishJobOutput,
  ): Promise<CompleteOutcome> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const selected = await client.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
        const row = selected.rows[0];
        if (!row || row.status !== "RUNNING" || row.lease_token !== leaseToken) {
          throw new LeaseLostError();
        }
        const job = mapJob(row);
        if (row.cancel_requested_at !== null) {
          await this.finish(client, jobId, "CANCELLED", "CANCELLED_WHILE_RUNNING", null);
          return "CANCELLED";
        }
        const state = await guard.check(job.subject, client);
        if (state !== "CURRENT") {
          await this.finish(
            client,
            jobId,
            "SUPERSEDED",
            state === "DELETED" ? "SUBJECT_DELETED" : "SUBJECT_SUPERSEDED",
            null,
          );
          return "SUPERSEDED";
        }
        if (publish) await publish(client, job, output);
        await client.query(
          `UPDATE jobs SET status = 'SUCCEEDED', output_ref = $3::jsonb, reason = NULL,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
               finished_at = now(), updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [jobId, leaseToken, jsonParameter(output)],
        );
        return "SUCCEEDED";
      });
    } catch (error) {
      if (error instanceof LeaseLostError) return "LEASE_LOST";
      throw error;
    }
  }

  async fail(
    jobId: string,
    leaseToken: string,
    err: { reason: string; retryable: boolean },
  ): Promise<"RETRY_SCHEDULED" | "FAILED" | "CANCELLED" | "LEASE_LOST"> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query(
        `SELECT attempts, max_attempts, cancel_requested_at
         FROM jobs
         WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'
         FOR UPDATE`,
        [jobId, leaseToken],
      );
      const row = selected.rows[0];
      if (!row) return "LEASE_LOST";
      if (row.cancel_requested_at !== null) {
        await this.finish(client, jobId, "CANCELLED", "CANCELLED_WHILE_RUNNING", null);
        return "CANCELLED";
      }

      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      if (err.retryable && attempts < maxAttempts) {
        const delay = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempts - 1));
        await client.query(
          `UPDATE jobs
           SET status = 'QUEUED', run_after = now() + ($3 * interval '1 millisecond'),
               reason = $4, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
               updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [jobId, leaseToken, delay, err.reason],
        );
        return "RETRY_SCHEDULED";
      }
      const reason = attempts >= maxAttempts ? `MAX_ATTEMPTS: ${err.reason}` : err.reason;
      await this.finish(client, jobId, "FAILED", reason, null);
      return "FAILED";
    });
  }

  async cancel(jobId: string, reason?: string): Promise<JobStatus | null> {
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query("SELECT status FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
      const status = selected.rows[0]?.status as JobStatus | undefined;
      if (!status) return null;
      if (status === "QUEUED") {
        await this.finish(client, jobId, "CANCELLED", reason ?? "CANCELLED_BY_REQUEST", null);
        return "CANCELLED";
      }
      if (status === "RUNNING") {
        await client.query(
          `UPDATE jobs
           SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
               reason = COALESCE($2, reason), updated_at = now()
           WHERE id = $1`,
          [jobId, reason ?? null],
        );
      }
      return status;
    });
  }

  async get(jobId: string): Promise<JobRow | null> {
    const result = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  private async finish(
    client: Queryable,
    jobId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "SUPERSEDED",
    reason: string,
    output: unknown,
  ): Promise<void> {
    await client.query(
      `UPDATE jobs
       SET status = $2, reason = $3, output_ref = $4::jsonb,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId, status, reason, jsonParameter(output)],
    );
  }
}
