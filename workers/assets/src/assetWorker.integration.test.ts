import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PgJobQueue, runWorkerOnce, InMemorySubjectVersionGuard } from "@roomrelay/jobs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validGlb } from "../../../packages/assets/src/testing/glbFixtures";
import { createAssetValidationHandler, ASSET_VALIDATE_JOB } from "./assetValidation";
import { LocalFsObjectReader } from "./objectReader";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) console.warn("[jobs] DATABASE_URL not set - skipping PostgreSQL integration tests");
const databaseSuite = describe.skipIf(!databaseUrl);

let admin: Pool;
let pool: Pool;
let queue: PgJobQueue;
let schema = "";
let rootDir = "";
let objectReader: LocalFsObjectReader;
let guard: InMemorySubjectVersionGuard;

async function migrationSql(): Promise<string> {
  const migrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/prisma/migrations");
  const migrationDir = (await readdir(migrationRoot)).find((name) => name.endsWith("_jobs_queue"));
  if (!migrationDir) throw new Error("jobs_queue migration directory not found");
  return readFile(join(migrationRoot, migrationDir, "migration.sql"), "utf8");
}

databaseSuite("asset worker PostgreSQL integration", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    schema = `asset_worker_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    await pool.query(await migrationSql());
    queue = new PgJobQueue(pool);
    rootDir = await mkdtemp(join(tmpdir(), "roomrelay-worker-integration-"));
    objectReader = new LocalFsObjectReader(rootDir);
    guard = new InMemorySubjectVersionGuard();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE jobs");
    guard.setCurrent("item", "worker-item", 1);
  });

  afterAll(async () => {
    await pool?.end();
    if (schema) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("processes a valid fixture and persists a manifest", async () => {
    await writeFile(join(rootDir, "valid.glb"), validGlb());
    const created = await queue.enqueue({
      type: ASSET_VALIDATE_JOB,
      stage: "validate",
      subject: { type: "item", id: "worker-item", version: 1 },
      inputRef: { objectKey: "valid.glb", provenance: "SCANNED_ACTUAL" },
      maxAttempts: 3,
    });
    expect(await runWorkerOnce({
      queue,
      workerId: "asset-integration",
      handlers: { [ASSET_VALIDATE_JOB]: createAssetValidationHandler(objectReader) },
      guard,
    })).toBe("SUCCEEDED");
    expect(await queue.get(created.job.id)).toMatchObject({
      status: "SUCCEEDED",
      outputRef: {
        validation: { status: "OK" },
        manifest: { format: "model/gltf-binary", provenance: "SCANNED_ACTUAL" },
      },
    });
  });

  it("completes rejected GLB validation without a manifest or retry", async () => {
    const hostile = validGlb();
    hostile[0] = 0;
    await writeFile(join(rootDir, "hostile.glb"), hostile);
    const created = await queue.enqueue({
      type: ASSET_VALIDATE_JOB,
      stage: "validate",
      subject: { type: "item", id: "worker-item", version: 1 },
      inputRef: { objectKey: "hostile.glb", provenance: "SCANNED_ACTUAL" },
      maxAttempts: 3,
    });
    expect(await runWorkerOnce({
      queue,
      workerId: "asset-integration",
      handlers: { [ASSET_VALIDATE_JOB]: createAssetValidationHandler(objectReader) },
      guard,
    })).toBe("SUCCEEDED");
    expect(await queue.get(created.job.id)).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      outputRef: { validation: { status: "REJECTED" }, manifest: null },
    });
  });
});
