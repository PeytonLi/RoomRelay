import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  PgJobQueue,
  runWorker,
  type JobSubject,
  type Queryable,
  type SubjectState,
  type SubjectVersionGuard,
} from "@roomrelay/jobs";
import { createAssetValidationHandler } from "./assetValidation";
import { LocalFsObjectReader } from "./objectReader";

export class DevAcceptAllSubjectsGuard implements SubjectVersionGuard {
  async check(_subject: JobSubject, _tx: Queryable): Promise<SubjectState> {
    return "CURRENT";
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[asset-worker] DATABASE_URL is required");
    process.exitCode = 1;
    return;
  }
  if (process.env.ASSET_WORKER_DEV_ACCEPT_ALL_SUBJECTS !== "1") {
    console.error("[asset-worker] no production SubjectVersionGuard exists; set ASSET_WORKER_DEV_ACCEPT_ALL_SUBJECTS=1 only for development");
    process.exitCode = 1;
    return;
  }

  console.warn("[asset-worker] using DevAcceptAllSubjectsGuard; subject versions are not verified");
  const pool = new Pool({ connectionString });
  const queue = new PgJobQueue(pool);
  const reader = new LocalFsObjectReader(process.env.ASSET_OBJECT_ROOT ?? "./runtime-assets");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorker({
      queue,
      workerId: process.env.WORKER_ID ?? `asset-worker-${hostname()}-${process.pid}`,
      handlers: { "asset.validate": createAssetValidationHandler(reader) },
      guard: new DevAcceptAllSubjectsGuard(),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    console.error("[asset-worker] worker exited:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
