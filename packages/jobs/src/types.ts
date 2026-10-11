import type { PoolClient } from "pg";

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "SUPERSEDED";

export interface JobSubject {
  type: string;
  id: string;
  version: number;
}

export interface EnqueueInput {
  type: string;
  stage: string;
  subject: JobSubject;
  inputRef?: unknown;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface JobRow {
  id: string;
  type: string;
  stage: string;
  subject: JobSubject;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  runAfter: Date;
  inputRef: unknown;
  outputRef: unknown;
  reason: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type SubjectState = "CURRENT" | "SUPERSEDED" | "DELETED";
export type Queryable = Pick<PoolClient, "query">;

export interface SubjectVersionGuard {
  check(subject: JobSubject, tx: Queryable): Promise<SubjectState>;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export type CompleteOutcome = "SUCCEEDED" | "CANCELLED" | "SUPERSEDED" | "LEASE_LOST";

export type PublishJobOutput = (tx: Queryable, job: JobRow, output: unknown) => Promise<void>;
