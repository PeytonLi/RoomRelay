import {
  buildAssetManifest,
  DEFAULT_GLB_LIMITS,
  GlbError,
  validateGlb,
  type AssetProvenance,
  type BuildAssetManifestInput,
} from "@roomrelay/assets";
import {
  PgJobQueue,
  PermanentJobError,
  type JobHandler,
  type JobSubject,
} from "@roomrelay/jobs";
import { z } from "zod";
import type { ObjectReader } from "./objectReader";

export const ASSET_VALIDATE_JOB = "asset.validate";
export const ASSET_VALIDATE_STAGE = "validate";

const dimensionsSchema = z.object({
  widthM: z.number().finite().positive(),
  depthM: z.number().finite().positive(),
  heightM: z.number().finite().positive(),
}).strict();

export const assetValidationInputSchema = z.object({
  objectKey: z.string().min(1),
  provenance: z.enum([
    "SCANNED_ACTUAL",
    "CATALOG_EXACT_MATCH",
    "APPROXIMATE_PROXY",
    "ILLUSTRATIVE_GENERATED",
  ]),
  sourceUnits: z.enum(["m", "cm", "mm"]).optional(),
  confirmedDimsM: dimensionsSchema.nullable().optional(),
  evidenceRef: z.string().nullable().optional(),
}).strict();

export interface AssetValidationInput {
  objectKey: string;
  provenance: AssetProvenance;
  sourceUnits?: "m" | "cm" | "mm";
  confirmedDimsM?: { widthM: number; depthM: number; heightM: number } | null;
  evidenceRef?: string | null;
}

export interface AssetValidationOutput {
  validation: ReturnType<typeof validateGlb>;
  manifest: ReturnType<typeof buildAssetManifest> | null;
  manifestError?: { code: string; message: string } | null;
}

export function createAssetValidationHandler(reader: ObjectReader): JobHandler {
  return async ({ job }) => {
    const parsed = assetValidationInputSchema.safeParse(job.inputRef);
    if (!parsed.success) throw new PermanentJobError("INVALID_ASSET_VALIDATE_INPUT");
    const input = parsed.data;
    const bytes = await reader.read(input.objectKey, DEFAULT_GLB_LIMITS.maxBytes);
    const validation = validateGlb(bytes);
    let manifest: AssetValidationOutput["manifest"] = null;
    let manifestError: { code: string; message: string } | null = null;
    if (validation.status !== "REJECTED") {
      const manifestInput: BuildAssetManifestInput = {
        bytes,
        validation,
        provenance: input.provenance,
        ...(input.sourceUnits === undefined ? {} : { sourceUnits: input.sourceUnits }),
        ...(input.confirmedDimsM === undefined ? {} : { confirmedDimsM: input.confirmedDimsM }),
        ...(input.evidenceRef === undefined ? {} : { evidenceRef: input.evidenceRef }),
        subject: { type: job.subject.type, id: job.subject.id, version: job.subject.version },
      };
      try {
        manifest = buildAssetManifest(manifestInput);
      } catch (error) {
        if (!(error instanceof GlbError)) throw error;
        manifestError = { code: error.code, message: error.message };
      }
    }
    return { validation, manifest, manifestError } satisfies AssetValidationOutput;
  };
}

export async function enqueueAssetValidation(
  queue: PgJobQueue,
  subject: JobSubject,
  inputRef: AssetValidationInput,
): Promise<Awaited<ReturnType<PgJobQueue["enqueue"]>>> {
  return queue.enqueue({
    type: ASSET_VALIDATE_JOB,
    stage: ASSET_VALIDATE_STAGE,
    subject,
    inputRef,
    maxAttempts: 3,
  });
}
