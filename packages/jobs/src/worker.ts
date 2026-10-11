import type {
  CompleteOutcome,
  JobRow,
  PublishJobOutput,
  SubjectVersionGuard,
} from "./types";
import { PgJobQueue } from "./queue";

export interface JobHandlerContext {
  job: JobRow;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobHandlerContext) => Promise<unknown>;

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface WorkerOptions {
  queue: PgJobQueue;
  workerId: string;
  handlers: Record<string, JobHandler>;
  guard: SubjectVersionGuard;
  publish?: PublishJobOutput;
  leaseMs?: number;
  heartbeatMs?: number;
}

export type WorkerOnceResult = CompleteOutcome | "IDLE" | "RETRY_SCHEDULED" | "FAILED";

export async function runWorkerOnce(opts: WorkerOptions): Promise<WorkerOnceResult> {
  const leaseMs = opts.leaseMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? Math.floor(leaseMs / 3);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new RangeError("heartbeatMs must be positive");
  }
  const job = await opts.queue.lease({
    workerId: opts.workerId,
    types: Object.keys(opts.handlers),
    leaseMs,
  });
  if (!job) return "IDLE";

  const handler = opts.handlers[job.type];
  if (!handler) return opts.queue.fail(job.id, job.leaseToken!, {
    reason: "no handler registered for job type",
    retryable: false,
  });

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void opts.queue.heartbeat(job.id, job.leaseToken!, leaseMs).then((result) => {
      if (!result.ok || result.cancelRequested) controller.abort();
    }).catch(() => controller.abort());
  }, heartbeatMs);

  let output: unknown;
  let thrown: unknown;
  let didThrow = false;
  try {
    output = await handler({ job, signal: controller.signal });
  } catch (error) {
    didThrow = true;
    thrown = error;
  } finally {
    clearInterval(heartbeat);
  }

  if (didThrow) {
    const reason = (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 500);
    return opts.queue.fail(job.id, job.leaseToken!, {
      reason,
      retryable: !(thrown instanceof PermanentJobError),
    });
  }
  return opts.queue.complete(job.id, job.leaseToken!, output, opts.guard, opts.publish);
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorker(
  opts: WorkerOptions & {
    pollMs?: number;
    signal: AbortSignal;
    onResult?: (result: WorkerOnceResult) => void;
  },
): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  while (!opts.signal.aborted) {
    let result: WorkerOnceResult;
    try {
      result = await runWorkerOnce(opts);
    } catch {
      console.error("[jobs] runWorkerOnce failed");
      await waitForPoll(pollMs, opts.signal);
      continue;
    }
    opts.onResult?.(result);
    if (result === "IDLE") await waitForPoll(pollMs, opts.signal);
  }
}
