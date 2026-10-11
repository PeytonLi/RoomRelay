import { afterEach, describe, expect, it } from "vitest";
import { setTestIdentity } from "./test-identity";

describe("test identity", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const env = process.env as unknown as Record<string, string | undefined>;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
  });

  it("refuses the test seam in production", () => {
    env.NODE_ENV = "production";
    expect(() => setTestIdentity("user-a")).toThrow(/only available in Vitest/);
  });
});
