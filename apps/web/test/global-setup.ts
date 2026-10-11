import { execSync } from "node:child_process";
import { Client } from "pg";
import path from "node:path";

const DEFAULT_TEST_DATABASE_URL = "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";

export default async function globalSetup() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const target = new URL(databaseUrl);
  const databaseName = target.pathname.slice(1);
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error("TEST_DATABASE_URL has an invalid database name");

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${databaseName}"`);
    }
  } catch (error) {
    throw new Error("PostgreSQL test database is unreachable or cannot be created.", { cause: error });
  } finally {
    await client.end();
  }

  const appRoot = path.resolve(process.cwd());
  try {
    execSync("pnpm exec prisma migrate deploy", {
      cwd: appRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
      shell: process.env.ComSpec ?? "cmd.exe",
    });
  } catch (error) {
    throw new Error("Could not apply Prisma migrations to TEST_DATABASE_URL.", { cause: error });
  }
}
