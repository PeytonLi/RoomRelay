import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PgJobQueue, type JobSubject } from "@roomrelay/jobs";
import {
  assetValidationInputSchema,
  enqueueAssetValidation,
  type AssetValidationInput,
} from "./assetValidation";

export interface ParsedEnqueueArgs {
  subject: JobSubject;
  inputRef: AssetValidationInput;
}

export function parseEnqueueArgs(argv: string[]): ParsedEnqueueArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "object-key": { type: "string" },
      "subject-id": { type: "string" },
      provenance: { type: "string" },
      "subject-type": { type: "string" },
      version: { type: "string" },
      units: { type: "string" },
      "evidence-ref": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = (option: string, value: string | undefined): string => {
    if (value === undefined || value.trim().length === 0) throw new TypeError(`--${option} is required`);
    return value;
  };
  const objectKey = required("object-key", values["object-key"]);
  const subjectId = required("subject-id", values["subject-id"]);
  const provenance = required("provenance", values.provenance);
  const subjectType = values["subject-type"] ?? "asset";
  if (subjectType.trim().length === 0) throw new TypeError("--subject-type must not be empty");
  if (subjectId.includes("|") || subjectType.includes("|")) {
    throw new TypeError("subject identifiers cannot contain '|'");
  }

  const version = values.version === undefined ? 1 : Number(values.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("--version must be a positive integer");
  }

  const parsedInput = assetValidationInputSchema.safeParse({
    objectKey,
    provenance,
    ...(values.units === undefined ? {} : { sourceUnits: values.units }),
    ...(values["evidence-ref"] === undefined ? {} : { evidenceRef: values["evidence-ref"] }),
  });
  if (!parsedInput.success) {
    throw new TypeError("Invalid asset validation input; check --object-key, --provenance, --units, and --evidence-ref");
  }

  const inputRef: AssetValidationInput = {
    objectKey: parsedInput.data.objectKey,
    provenance: parsedInput.data.provenance,
    ...(parsedInput.data.sourceUnits === undefined ? {} : { sourceUnits: parsedInput.data.sourceUnits }),
    ...(parsedInput.data.evidenceRef === undefined ? {} : { evidenceRef: parsedInput.data.evidenceRef }),
  };
  return {
    subject: { type: subjectType, id: subjectId, version },
    inputRef,
  };
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    const { subject, inputRef } = parseEnqueueArgs(process.argv.slice(2));
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString });
    const result = await enqueueAssetValidation(new PgJobQueue(pool), subject, inputRef);
    console.log(JSON.stringify({
      id: result.job.id,
      created: result.created,
      idempotencyKey: result.job.idempotencyKey,
      status: result.job.status,
    }));
  } catch (error) {
    console.error(`[asset-worker enqueue] ${error instanceof Error ? error.message : "Invalid enqueue arguments"}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main();
}
