import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InMemorySubjectVersionGuard,
  PgJobQueue,
  PermanentJobError,
  runWorkerOnce,
  type JobSubject,
  type Queryable,
  type SubjectState,
  type SubjectVersionGuard,
} from "./index";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) console.warn("[jobs] DATABASE_URL not set - skipping PostgreSQL integration tests");

const databaseSuite = describe.skipIf(!databaseUrl);

class PgTableSubjectVersionGuard implements SubjectVersionGuard {
  async check(subject: JobSubject, tx: Queryable): Promise<SubjectState> {
    const result = await tx.query(
      `SELECT current_version, deleted
       FROM test_subjects WHERE type = $1 AND id = $2 FOR SHARE`,
      [subject.type, subject.id],
    );
    const row = result.rows[0];
    if (!row || row.deleted) return "DELETED";
    return Number(row.current_version) === subject.version ? "CURRENT" : "SUPERSEDED";
  }
}

let admin: Pool;
let pool: Pool;
let queue: PgJobQueue;
let schema = "";
const tableGuard = new PgTableSubjectVersionGuard();
const memoryGuard = new InMemorySubjectVersionGuard();

function subject(id: string = randomUUID(), version = 1): JobSubject {
  return { type: "item", id, version };
}

function input(id: string = randomUUID(), options: { version?: number; stage?: string; maxAttempts?: number } = {}) {
  const version = options.version ?? 1;
  memoryGuard.setCurrent("item", id, version);
  return {
    type: "test",
    stage: options.stage ?? "run",
    subject: subject(id, version),
    maxAttempts: options.maxAttempts ?? 3,
  };
}

async function enqueue(id?: string, options?: Parameters<typeof input>[1]) {
  return queue.enqueue(input(id, options));
}

async function currentSubject(id: string, version = 1): Promise<void> {
  await pool.query(
    `INSERT INTO test_subjects(type, id, current_version, deleted)
     VALUES ('item', $1, $2, false)
     ON CONFLICT(type, id) DO UPDATE SET current_version = EXCLUDED.current_version, deleted = false`,
    [id, version],
  );
}

async function migrationSql(): Promise<string> {
  const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/prisma/migrations");
  const migrationDir = (await readdir(migrationRoot)).find((name) => name.endsWith("_jobs_queue"));
  if (!migrationDir) throw new Error("jobs_queue migration directory not found");
  return readFile(join(migrationRoot, migrationDir, "migration.sql"), "utf8");
}

databaseSuite("PgJobQueue integration", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    schema = `jobs_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 12,
    });
    await pool.query(await migrationSql());
    await pool.query(`CREATE TABLE test_subjects(
      type text NOT NULL, id text NOT NULL, current_version integer NOT NULL,
      deleted boolean NOT NULL DEFAULT false, PRIMARY KEY(type,id)
    )`);
    queue = new PgJobQueue(pool, { retry: { baseDelayMs: 50, maxDelayMs: 250 } });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE jobs, test_subjects");
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("leases 30 jobs concurrently without duplicate ids", async () => {
    for (let index = 0; index < 30; index++) await enqueue(`parallel-${index}`);
    const leases: Array<{ id: string; attempts: number }> = [];
    await Promise.all(Array.from({ length: 4 }, async (_, workerIndex) => {
      while (true) {
        const job = await queue.lease({ workerId: `parallel-${workerIndex}`, types: ["test"], leaseMs: 10_000 });
        if (!job) return;
        leases.push({ id: job.id, attempts: job.attempts });
        await queue.complete(job.id, job.leaseToken!, { done: true }, memoryGuard);
      }
    }));
    expect(leases).toHaveLength(30);
    expect(new Set(leases.map((lease) => lease.id)).size).toBe(30);
    expect(leases.every((lease) => lease.attempts === 1)).toBe(true);
  });

  it("reclaims expired leases and fences the old token", async () => {
    await enqueue("expired");
    const first = await queue.lease({ workerId: "first", types: ["test"], leaseMs: 200 });
    expect(first).not.toBeNull();
    await delay(350);
    const second = await queue.lease({ workerId: "second", types: ["test"], leaseMs: 1000 });
    expect(second?.id).toBe(first?.id);
    expect(second?.attempts).toBe(2);
    expect(await queue.complete(first!.id, first!.leaseToken!, {}, memoryGuard)).toBe("LEASE_LOST");
    expect(await queue.fail(first!.id, first!.leaseToken!, { reason: "stale", retryable: true })).toBe("LEASE_LOST");
    expect(await queue.heartbeat(first!.id, first!.leaseToken!, 1000)).toMatchObject({ ok: false });
  });

  it("backs off retries and fails after the final attempt", async () => {
    await enqueue("retry", { maxAttempts: 3 });
    let job = await queue.lease({ workerId: "retry", types: ["test"], leaseMs: 5000 });
    expect(job?.attempts).toBe(1);
    expect(await queue.fail(job!.id, job!.leaseToken!, { reason: "temporary", retryable: true })).toBe("RETRY_SCHEDULED");
    expect(await queue.lease({ workerId: "retry", types: ["test"], leaseMs: 5000 })).toBeNull();
    let current = await queue.get(job!.id);
    await delay(Math.max(0, current!.runAfter.getTime() - Date.now() + 5));
    job = await queue.lease({ workerId: "retry", types: ["test"], leaseMs: 5000 });
    expect(job?.attempts).toBe(2);
    expect(await queue.fail(job!.id, job!.leaseToken!, { reason: "temporary", retryable: true })).toBe("RETRY_SCHEDULED");
    current = await queue.get(job!.id);
    await delay(Math.max(0, current!.runAfter.getTime() - Date.now() + 5));
    job = await queue.lease({ workerId: "retry", types: ["test"], leaseMs: 5000 });
    expect(job?.attempts).toBe(3);
    expect(await queue.fail(job!.id, job!.leaseToken!, { reason: "temporary", retryable: true })).toBe("FAILED");
    expect((await queue.get(job!.id))?.reason).toBe("MAX_ATTEMPTS: temporary");
  });

  it("preserves idempotency across concurrent enqueue and terminal rows", async () => {
    const data = input("idempotent");
    const first = await queue.enqueue(data);
    const second = await queue.enqueue(data);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    const leased = await queue.lease({ workerId: "done", types: ["test"], leaseMs: 1000 });
    expect(await queue.complete(leased!.id, leased!.leaseToken!, { done: true }, memoryGuard)).toBe("SUCCEEDED");
    expect((await queue.enqueue(input("idempotent", { version: 2 }))).job.id).not.toBe(first.job.id);
    expect((await queue.enqueue(input("idempotent", { stage: "other" }))).job.id).not.toBe(first.job.id);
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => queue.enqueue(input("concurrent"))));
    expect(new Set(concurrent.map((result) => result.job.id)).size).toBe(1);
    const unchanged = await queue.enqueue(data);
    expect(unchanged.created).toBe(false);
    expect(unchanged.job.status).toBe("SUCCEEDED");
    expect((await queue.get(first.job.id))?.status).toBe("SUCCEEDED");
  });

  it("cancels queued and running work and reports cancellation through heartbeat", async () => {
    const queued = await enqueue("cancel-queued");
    expect(await queue.cancel(queued.job.id)).toBe("CANCELLED");
    expect(await queue.lease({ workerId: "cancel", types: ["test"], leaseMs: 1000 })).toBeNull();

    const running = await enqueue("cancel-running");
    const leased = await queue.lease({ workerId: "cancel", types: ["test"], leaseMs: 1000 });
    expect(leased?.id).toBe(running.job.id);
    expect(await queue.cancel(leased!.id)).toBe("RUNNING");
    expect(await queue.heartbeat(leased!.id, leased!.leaseToken!, 1000)).toMatchObject({
      ok: true,
      cancelRequested: true,
    });
    let published = false;
    expect(await queue.complete(leased!.id, leased!.leaseToken!, { private: true }, memoryGuard, async () => {
      published = true;
    })).toBe("CANCELLED");
    expect(published).toBe(false);
    expect(await queue.get(leased!.id)).toMatchObject({ outputRef: null, reason: "CANCELLED_WHILE_RUNNING" });
  });

  it("checks subject versions in-transaction and rolls back failed publication", async () => {
    await currentSubject("versioned", 1);
    const superseded = await queue.enqueue(input("versioned"));
    const lease = await queue.lease({ workerId: "version", types: ["test"], leaseMs: 1000 });
    await pool.query("UPDATE test_subjects SET current_version = 2 WHERE id = 'versioned'");
    let published = false;
    expect(await queue.complete(lease!.id, lease!.leaseToken!, { value: 1 }, tableGuard, async () => {
      published = true;
    })).toBe("SUPERSEDED");
    expect(published).toBe(false);
    expect(await queue.get(superseded.job.id)).toMatchObject({
      status: "SUPERSEDED",
      outputRef: null,
      reason: "SUBJECT_SUPERSEDED",
    });

    await currentSubject("deleted", 1);
    const deleted = await queue.enqueue(input("deleted"));
    const deletedLease = await queue.lease({ workerId: "deleted", types: ["test"], leaseMs: 1000 });
    await pool.query("UPDATE test_subjects SET deleted = true WHERE id = 'deleted'");
    expect(await queue.complete(deletedLease!.id, deletedLease!.leaseToken!, {}, tableGuard)).toBe("SUPERSEDED");
    expect((await queue.get(deleted.job.id))?.reason).toBe("SUBJECT_DELETED");

    await currentSubject("publish-error", 1);
    const publishError = await queue.enqueue(input("publish-error"));
    const publishLease = await queue.lease({ workerId: "publish", types: ["test"], leaseMs: 1000 });
    await expect(queue.complete(publishLease!.id, publishLease!.leaseToken!, {}, tableGuard, async () => {
      throw new Error("publish failed");
    })).rejects.toThrow("publish failed");
    expect((await queue.get(publishError.job.id))?.status).toBe("RUNNING");
  });

  it("reaps abandoned workers and terminally expires jobs at max attempts", async () => {
    await enqueue("crash-success");
    const abandoned = await queue.lease({ workerId: "crashed", types: ["test"], leaseMs: 100 });
    await delay(150);
    const result = await runWorkerOnce({
      queue,
      workerId: "recovery",
      handlers: { test: async () => ({ recovered: true }) },
      guard: memoryGuard,
      leaseMs: 1000,
      heartbeatMs: 100,
    });
    expect(result).toBe("SUCCEEDED");
    expect((await queue.get(abandoned!.id))?.attempts).toBe(2);

    await enqueue("crash-terminal", { maxAttempts: 1 });
    const terminalLease = await queue.lease({ workerId: "crashed", types: ["test"], leaseMs: 100 });
    await delay(150);
    expect(await queue.lease({ workerId: "reaper", types: ["test"], leaseMs: 1000 })).toBeNull();
    expect(await queue.get(terminalLease!.id)).toMatchObject({
      status: "FAILED",
      reason: "LEASE_EXPIRED_MAX_ATTEMPTS",
    });
  });

  it("permanent handler errors do not retry", async () => {
    const created = await queue.enqueue({ ...input("permanent"), type: "permanent" });
    const result = await runWorkerOnce({
      queue,
      workerId: "permanent",
      handlers: { permanent: async () => { throw new PermanentJobError("bad input"); } },
      guard: memoryGuard,
    });
    expect(result).toBe("FAILED");
    expect(await queue.get(created.job.id)).toMatchObject({ status: "FAILED", attempts: 1, reason: "bad input" });
  });

  it("heartbeats long-running handlers to prevent duplicate leases", async () => {
    await enqueue("heartbeat");
    let started!: () => void;
    const running = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const work = runWorkerOnce({
      queue,
      workerId: "long",
      handlers: { test: async () => { started(); await delay(700); return { done: true }; } },
      guard: memoryGuard,
      leaseMs: 300,
      heartbeatMs: 75,
    });
    await running;
    await delay(350);
    expect(await queue.lease({ workerId: "other", types: ["test"], leaseMs: 1000 })).toBeNull();
    expect(await work).toBe("SUCCEEDED");
    expect((await queue.get((await queue.enqueue(input("heartbeat"))).job.id))?.attempts).toBe(1);
  });

  it("aborts a handler when cancellation is observed by heartbeat", async () => {
    const created = await queue.enqueue({ ...input("heartbeat-cancel"), type: "cancel-handler" });
    let started!: (signal: AbortSignal) => void;
    const began = new Promise<AbortSignal>((resolveStarted) => { started = resolveStarted; });
    const work = runWorkerOnce({
      queue,
      workerId: "cancel-handler",
      handlers: {
        "cancel-handler": ({ signal }) => new Promise((resolveResult) => {
          started(signal);
          signal.addEventListener("abort", () => resolveResult({ stopped: true }), { once: true });
        }),
      },
      guard: memoryGuard,
      leaseMs: 300,
      heartbeatMs: 50,
    });
    const signal = await began;
    await queue.cancel(created.job.id);
    expect(await work).toBe("CANCELLED");
    expect(signal.aborted).toBe(true);
  });
});
