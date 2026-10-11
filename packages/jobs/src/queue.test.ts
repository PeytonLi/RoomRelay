import { describe, expect, it, vi } from "vitest";
import { InMemorySubjectVersionGuard } from "./guard";
import { isFinancialJobType, jobIdempotencyKey } from "./queue";
import { runWorker, type WorkerOptions } from "./worker";

describe("isFinancialJobType", () => {
  it("recognizes financial job type prefixes only", () => {
    expect(["payment.capture", "refund.issue", "payout.send"].every(isFinancialJobType)).toBe(true);
    expect(["asset.validate", "payment", "refunds.issue", "settlement.send"].some(isFinancialJobType)).toBe(false);
  });
});

describe("jobIdempotencyKey", () => {
  it("includes the job type, subject version, and stage", () => {
    expect(jobIdempotencyKey("asset.validate", { type: "item", id: "item-1", version: 2 }, "validate"))
      .toBe("asset.validate|item|item-1|v2|validate");
  });

  it("rejects empty and delimiter-containing parts and invalid versions", () => {
    expect(() => jobIdempotencyKey("", { type: "item", id: "1", version: 1 }, "stage")).toThrow();
    expect(() => jobIdempotencyKey("a|b", { type: "item", id: "1", version: 1 }, "stage")).toThrow();
    expect(() => jobIdempotencyKey("a", { type: "item", id: "1", version: 0 }, "stage")).toThrow();
  });
});

describe("InMemorySubjectVersionGuard", () => {
  const tx = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

  it("distinguishes current, superseded, unknown, and deleted subjects", async () => {
    const guard = new InMemorySubjectVersionGuard();
    guard.setCurrent("item", "1", 2);
    expect(await guard.check({ type: "item", id: "1", version: 2 }, tx)).toBe("CURRENT");
    expect(await guard.check({ type: "item", id: "1", version: 1 }, tx)).toBe("SUPERSEDED");
    expect(await guard.check({ type: "item", id: "missing", version: 1 }, tx)).toBe("DELETED");
    guard.markDeleted("item", "1");
    expect(await guard.check({ type: "item", id: "1", version: 2 }, tx)).toBe("DELETED");
  });
});

describe("runWorker", () => {
  it("continues after a failed iteration and stops when aborted", async () => {
    const controller = new AbortController();
    let leaseCalls = 0;
    const queue = {
      lease: async () => {
        leaseCalls += 1;
        if (leaseCalls === 1) throw new Error("database unavailable");
        controller.abort();
        return null;
      },
    } as unknown as WorkerOptions["queue"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runWorker({
        queue,
        workerId: "worker-1",
        handlers: {},
        guard: new InMemorySubjectVersionGuard(),
        signal: controller.signal,
        pollMs: 0,
      })).resolves.toBeUndefined();
      expect(leaseCalls).toBe(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[jobs] runWorkerOnce failed");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
