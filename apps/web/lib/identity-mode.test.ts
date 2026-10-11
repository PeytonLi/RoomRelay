import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getIdentityMode } from "./identity-mode";

const temporaryDirectories: string[] = [];

function temporaryCwd(): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "roomrelay-identity-"));
  temporaryDirectories.push(cwd);
  return cwd;
}

function addClaimTokenBreadcrumb(cwd: string, claimToken = "unclaimed"): void {
  const breadcrumbPath = path.join(cwd, ".clerk", "keyless.json");
  mkdirSync(path.dirname(breadcrumbPath), { recursive: true });
  writeFileSync(breadcrumbPath, JSON.stringify({ claimToken }));
}

function addLegacyBreadcrumb(cwd: string, publishableKey: string): void {
  const breadcrumbPath = path.join(cwd, ".clerk", ".tmp", "keyless.json");
  mkdirSync(path.dirname(breadcrumbPath), { recursive: true });
  writeFileSync(breadcrumbPath, JSON.stringify({ publishableKey }));
}

afterEach(() => {
  for (const cwd of temporaryDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("getIdentityMode", () => {
  const keys = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_local",
    CLERK_SECRET_KEY: "sk_test_local",
  };

  it("is unavailable when either Clerk key is missing", () => {
    expect(getIdentityMode({}, temporaryCwd())).toBe("unavailable");
  });

  it("allows a claim-token breadcrumb in non-automated development", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd);
    expect(getIdentityMode({ ...keys, NODE_ENV: "development" }, cwd)).toBe("keyless-dev");
  });

  it("ignores an empty claim token", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd, " ");
    expect(getIdentityMode({ ...keys, NODE_ENV: "development" }, cwd)).toBe("available");
  });

  it("rejects a claim-token breadcrumb in automated environments", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd);
    expect(getIdentityMode({ ...keys, NODE_ENV: "development", CI: "1" }, cwd)).toBe("unavailable");
  });

  it("honors the keyless-disabled flag", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd);
    expect(
      getIdentityMode(
        { ...keys, NODE_ENV: "development", NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: "1" },
        cwd,
      ),
    ).toBe("unavailable");
  });

  it("rejects unclaimed breadcrumbs in production", () => {
    const cwd = temporaryCwd();
    addClaimTokenBreadcrumb(cwd);
    expect(getIdentityMode({ ...keys, NODE_ENV: "production" }, cwd)).toBe("unavailable");
  });

  it("recognizes the legacy keyless breadcrumb with a matching publishable key", () => {
    const cwd = temporaryCwd();
    addLegacyBreadcrumb(cwd, keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    expect(getIdentityMode({ ...keys, NODE_ENV: "development" }, cwd)).toBe("keyless-dev");
  });

  it("treats keys without a matching breadcrumb as available", () => {
    expect(getIdentityMode({ ...keys, NODE_ENV: "production" }, temporaryCwd())).toBe("available");
  });
});
