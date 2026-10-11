import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  if (process.env.ROOMRELAY_SKIP_DB_TESTS === "1") return;
  const databaseUrl = process.env.TEST_DATABASE_URL ??
    "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
  let databaseName = "";
  try {
    databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (databaseName !== "roomrelay_test") {
    throw new Error("Database tests are restricted to the roomrelay_test database");
  }
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  try {
    execSync("pnpm exec prisma migrate deploy", {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    });
  } catch {
    throw new Error("Database tests require reachable PostgreSQL and applied migrations");
  }
}
