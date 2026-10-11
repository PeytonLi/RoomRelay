import type { JobStatus } from "./generated/prisma/enums";
import type { PrismaClient } from "./generated/prisma/client";

export type JobHealth = {
  status: "unconfigured" | "unreachable" | "ok";
  counts?: Record<JobStatus, number>;
  oldestQueuedAgeSeconds?: number | null;
  expiredLeases?: number;
};

type JobHealthPrismaClient = Pick<PrismaClient, "job" | "$queryRaw">;

interface JobHealthAggregate {
  oldestQueuedAgeSeconds: number | null;
  expiredLeases: number;
}

const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
] satisfies JobStatus[];

export async function getJobHealth(prisma: JobHealthPrismaClient | null): Promise<JobHealth> {
  if (!prisma) return { status: "unconfigured" };

  try {
    const [groups, aggregates] = await Promise.all([
      prisma.job.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.$queryRaw<JobHealthAggregate[]>`
        SELECT
          FLOOR(EXTRACT(EPOCH FROM (
            now() - MIN(run_after) FILTER (WHERE status = 'QUEUED' AND run_after <= now())
          )))::int AS "oldestQueuedAgeSeconds",
          COUNT(*) FILTER (WHERE status = 'RUNNING' AND lease_expires_at < now())::int AS "expiredLeases"
        FROM jobs
      `,
    ]);
    const aggregate = aggregates[0];
    if (!aggregate) return { status: "unreachable" };

    const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<JobStatus, number>;
    for (const group of groups) counts[group.status] = group._count._all;

    return {
      status: "ok",
      counts,
      oldestQueuedAgeSeconds: aggregate.oldestQueuedAgeSeconds,
      expiredLeases: aggregate.expiredLeases,
    };
  } catch {
    return { status: "unreachable" };
  }
}
