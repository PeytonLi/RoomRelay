import { describe, expect, it } from "vitest";
import { InMemorySubjectVersionGuard } from "./guard";
import { jobIdempotencyKey } from "./queue";

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
