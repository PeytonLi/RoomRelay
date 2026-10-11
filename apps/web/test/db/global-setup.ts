import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export default async function globalSetup(): Promise<void> {
  if (process.env.ROOMRELAY_SKIP_DB_TESTS === "1") return;
  const databaseUrl = process.env.TEST_DATABASE_URL ??
    "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  const databaseName = target.pathname.replace(/^\//, "");
  if (databaseName !== "roomrelay_test") {
    throw new Error("Database tests are restricted to the roomrelay_test database");
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (exists.rowCount === 0) await client.query('CREATE DATABASE "roomrelay_test"');
  } catch (error) {
    throw new Error("PostgreSQL test database is unreachable or cannot be created", { cause: error });
  } finally {
    await client.end();
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
