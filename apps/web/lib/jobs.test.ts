import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client";
import { getJobHealth } from "./jobs";

type JobsPrismaClient = Pick<PrismaClient, "job" | "$queryRaw">;

describe("getJobHealth", () => {
  it("fills missing statuses with zero counts", async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { status: "QUEUED", _count: { _all: 3 } },
      { status: "FAILED", _count: { _all: 2 } },
    ]);
    const queryRaw = vi.fn().mockResolvedValue([
      { oldestQueuedAgeSeconds: 18, expiredLeases: 1 },
    ]);
    const prisma = { job: { groupBy }, $queryRaw: queryRaw } as unknown as JobsPrismaClient;

    await expect(getJobHealth(prisma)).resolves.toEqual({
      status: "ok",
      counts: {
        QUEUED: 3,
        RUNNING: 0,
        SUCCEEDED: 0,
        FAILED: 2,
        CANCELLED: 0,
        SUPERSEDED: 0,
      },
      oldestQueuedAgeSeconds: 18,
      expiredLeases: 1,
    });
    expect(groupBy).toHaveBeenCalledWith({ by: ["status"], _count: { _all: true } });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfigured database without querying", async () => {
    await expect(getJobHealth(null)).resolves.toEqual({ status: "unconfigured" });
  });

  it("reports database errors as unreachable without leaking their messages", async () => {
    const groupByError = new Error("private group query detail");
    const queryError = new Error("private raw query detail");
    const brokenClients = [
      {
        job: { groupBy: vi.fn().mockRejectedValue(groupByError) },
        $queryRaw: vi.fn(),
      },
      {
        job: { groupBy: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockRejectedValue(queryError),
      },
    ];

    for (const client of brokenClients) {
      const health = await getJobHealth(client as unknown as JobsPrismaClient);
      expect(health).toEqual({ status: "unreachable" });
      expect(JSON.stringify(health)).not.toContain("private");
    }
  });
});
