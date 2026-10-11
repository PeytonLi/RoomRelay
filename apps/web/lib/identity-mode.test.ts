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

function addBreadcrumb(cwd: string, publishableKey: string, nested = false): void {
  const breadcrumbPath = nested
    ? path.join(cwd, ".clerk", ".tmp", "keyless.json")
    : path.join(cwd, ".clerk", "keyless.json");
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

  it("allows an unclaimed breadcrumb in non-automated development", () => {
    const cwd = temporaryCwd();
    addBreadcrumb(cwd, keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, true);
    expect(getIdentityMode({ ...keys, NODE_ENV: "development" }, cwd)).toBe("keyless-dev");
  });

  it("rejects an unclaimed breadcrumb in automated environments", () => {
    const cwd = temporaryCwd();
    addBreadcrumb(cwd, keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    expect(getIdentityMode({ ...keys, NODE_ENV: "development", CI: "1" }, cwd)).toBe("unavailable");
  });

  it("honors the keyless-disabled flag", () => {
    const cwd = temporaryCwd();
    addBreadcrumb(cwd, keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    expect(
      getIdentityMode(
        { ...keys, NODE_ENV: "development", NEXT_PUBLIC_CLERK_KEYLESS_DISABLED: "1" },
        cwd,
      ),
    ).toBe("unavailable");
  });

  it("rejects unclaimed breadcrumbs in production", () => {
    const cwd = temporaryCwd();
    addBreadcrumb(cwd, keys.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    expect(getIdentityMode({ ...keys, NODE_ENV: "production" }, cwd)).toBe("unavailable");
  });

  it("treats keys without a matching breadcrumb as available", () => {
    expect(getIdentityMode({ ...keys, NODE_ENV: "production" }, temporaryCwd())).toBe("available");
  });
});
