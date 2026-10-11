import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./env";

const temporaryDirectories: string[] = [];

function temporaryCwd(): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "roomrelay-env-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

function addClaimTokenBreadcrumb(cwd: string): void {
  const breadcrumbPath = path.join(cwd, ".clerk", "keyless.json");
  mkdirSync(path.dirname(breadcrumbPath), { recursive: true });
  writeFileSync(breadcrumbPath, JSON.stringify({ claimToken: "unclaimed" }));
}

afterEach(() => {
  for (const cwd of temporaryDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

const fullEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
  OBJECT_STORE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORE_REGION: "us-east-1",
  OBJECT_STORE_BUCKET: "roomrelay",
  OBJECT_STORE_ACCESS_KEY_ID: "k",
  OBJECT_STORE_SECRET_ACCESS_KEY: "s",
  PAYPAL_ENVIRONMENT: "sandbox",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "cid",
  PAYPAL_CLIENT_SECRET: "cs",
  PAYPAL_WEBHOOK_ID: "wh",
  PAYPAL_MERCHANT_ID: "m",
  AI_PROVIDER: "openai",
  AI_API_KEY: "ak",
  AI_TEXT_MODEL: "model-x",
};

describe("loadConfig capabilities", () => {
  it("reports every capability available when all vars are set", () => {
    const c = loadConfig(fullEnv, temporaryCwd());
    expect(c.capabilities.database.status).toBe("available");
    expect(c.capabilities.identity.status).toBe("available");
    expect(c.capabilities.objectStore.status).toBe("available");
    expect(c.capabilities.paypal.status).toBe("available");
    expect(c.capabilities.ai.status).toBe("available");
  });

  it("reports keyless development identity when configured with an unclaimed instance", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd);
    const c = loadConfig({ ...fullEnv, NODE_ENV: "development" }, cwd);

    expect(c.capabilities.identity).toEqual({ status: "keyless-dev", missing: [] });
  });

  it("reports unavailable with missing var names, never values", () => {
    const c = loadConfig({ DATABASE_URL: "postgresql://secret-user:secret-pass@h/db" });
    expect(c.capabilities.database.status).toBe("available");
    expect(c.capabilities.identity).toEqual({
      status: "unavailable",
      missing: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"],
    });
    expect(c.capabilities.paypal.missing).toContain("PAYPAL_CLIENT_SECRET");
    // Missing list contains names only — no values leak.
    const flat = JSON.stringify(c.capabilities);
    expect(flat).not.toContain("secret-pass");
  });

  it("treats empty strings as missing", () => {
    const c = loadConfig({ ...fullEnv, AI_API_KEY: "   " });
    expect(c.capabilities.ai.status).toBe("unavailable");
    expect(c.capabilities.ai.missing).toEqual(["AI_API_KEY"]);
  });
});

describe("live payment guard", () => {
  it("rejects PAYPAL_ENVIRONMENT=live without ALLOW_LIVE_PAYMENTS=true", () => {
    expect(() => loadConfig({ ...fullEnv, PAYPAL_ENVIRONMENT: "live" })).toThrowError(ConfigError);
    expect(() => loadConfig({ ...fullEnv, PAYPAL_ENVIRONMENT: "live", ALLOW_LIVE_PAYMENTS: "false" })).toThrowError(
      /ALLOW_LIVE_PAYMENTS/,
    );
  });
  it("accepts live only with the explicit flag", () => {
    const c = loadConfig({ ...fullEnv, PAYPAL_ENVIRONMENT: "live", ALLOW_LIVE_PAYMENTS: "true" });
    expect(c.capabilities.paypal.status).toBe("available");
    expect(c.env.PAYPAL_ENVIRONMENT).toBe("live");
  });
  it("defaults to sandbox", () => {
    const c = loadConfig({});
    expect(c.env.PAYPAL_ENVIRONMENT).toBe("sandbox");
  });
  it("rejects the test identity seam in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", ROOMRELAY_TEST_IDENTITY: "enabled" })).toThrowError(
      /ROOMRELAY_TEST_IDENTITY/,
    );
  });
  it("reports the effective PayPal environment on the capability (for /api/health)", () => {
    expect(loadConfig({}).capabilities.paypal.environment).toBe("sandbox");
    expect(loadConfig({ ...fullEnv, PAYPAL_ENVIRONMENT: "live", ALLOW_LIVE_PAYMENTS: "true" }).capabilities.paypal.environment).toBe(
      "live",
    );
  });
});
