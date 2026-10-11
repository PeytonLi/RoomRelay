import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type IdentityMode = "available" | "keyless-dev" | "unavailable";

// Keep aligned with @clerk/shared runtimeEnvironment's automated-environment detection.
export const AUTOMATED_ENVIRONMENT_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "BITBUCKET_BUILD_NUMBER",
  "APPVEYOR",
  "CODEBUILD_BUILD_ID",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "JENKINS_URL",
  "HUDSON_URL",
  "BAMBOO_BUILDKEY",
  "CF_PAGES",
] as const;

const FALSE_VALUES = new Set(["", "0", "false", "off", "no"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && !FALSE_VALUES.has(value.trim().toLowerCase());
}

function canUseKeyless(source: Record<string, string | undefined>): boolean {
  return (
    source.NODE_ENV === "development" &&
    !AUTOMATED_ENVIRONMENT_VARIABLES.some((name) => isTruthy(source[name])) &&
    !isTruthy(source.NEXT_PUBLIC_CLERK_KEYLESS_DISABLED)
  );
}

function hasMatchingBreadcrumb(cwd: string, publishableKey: string): boolean {
  const paths = [
    path.join(cwd, ".clerk", "keyless.json"),
    path.join(cwd, ".clerk", ".tmp", "keyless.json"),
  ];

  return paths.some((breadcrumbPath) => {
    if (!existsSync(breadcrumbPath)) return false;
    try {
      const breadcrumb: unknown = JSON.parse(readFileSync(breadcrumbPath, "utf8"));
      return (
        typeof breadcrumb === "object" &&
        breadcrumb !== null &&
        "publishableKey" in breadcrumb &&
        typeof breadcrumb.publishableKey === "string" &&
        breadcrumb.publishableKey === publishableKey
      );
    } catch {
      return false;
    }
  });
}

export function getIdentityMode(
  source: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): IdentityMode {
  const publishableKey = source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = source.CLERK_SECRET_KEY;
  if (!publishableKey?.trim() || !secretKey?.trim()) return "unavailable";

  if (!hasMatchingBreadcrumb(cwd, publishableKey)) return "available";
  return canUseKeyless(source) ? "keyless-dev" : "unavailable";
}
