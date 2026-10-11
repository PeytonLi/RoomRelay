import {
  normalizeItem,
  type AxisReport,
  type ConfirmedDimsM,
  type LinearUnit,
  type Vec3,
} from "@roomrelay/spatial";
import { GlbError, inspectGlb } from "./inspectGlb";
import type { GlbValidationResult, GlbValidationStatus } from "./validateGlb";

export const ASSET_PROCESSING_VERSION = "assets-cpu-1";

export type AssetProvenance =
  | "SCANNED_ACTUAL"
  | "CATALOG_EXACT_MATCH"
  | "APPROXIMATE_PROXY"
  | "ILLUSTRATIVE_GENERATED";

export interface BuildAssetManifestInput {
  bytes: Uint8Array;
  validation: GlbValidationResult;
  provenance: AssetProvenance;
  sourceUnits?: LinearUnit;
  sourceYawRad?: number;
  confirmedDimsM?: ConfirmedDimsM | null;
  evidenceRef?: string | null;
  subject?: { type: string; id: string; version: number } | null;
  conversionPath?: "IMPORTED_CONVERSION" | "AUTOMATIC_RECONSTRUCTION";
  processingVersion?: string;
}

export interface AssetManifest {
  schemaVersion: 1;
  processingVersion: string;
  format: "model/gltf-binary";
  sha256: string;
  bytes: number;
  meshBounds: { min: Vec3; max: Vec3; size: Vec3; units: LinearUnit };
  axisConvention: { up: "+Y"; front: "+Z"; handedness: "right"; source: "glTF 2.0" };
  originConvention: "FOOTPRINT_CENTER_FLOOR";
  normalization: {
    matrix: number[];
    uniformScaleToMeters: number;
    sourceYawRad: number;
    measuredDimsM: ConfirmedDimsM;
  };
  dimensions: {
    confirmedM: ConfirmedDimsM | null;
    evidenceRef: string | null;
    check: "MATCH" | "MISMATCH" | "UNKNOWN";
    axes: AxisReport[];
  };
  provenance: AssetProvenance;
  conversionPath: "IMPORTED_CONVERSION" | "AUTOMATIC_RECONSTRUCTION";
  stats: {
    triangleCount: number;
    textureCount: number;
    imageCount: number;
    maxTextureWidth: number;
    maxTextureHeight: number;
    extensionsRequired: string[];
  };
  validation: { status: GlbValidationStatus; issueCodes: string[] };
  reviewStatus: "OK" | "NEEDS_REVIEW";
  subject: { type: string; id: string; version: number } | null;
}

export function buildAssetManifest(input: BuildAssetManifestInput): AssetManifest {
  if (input.validation.status === "REJECTED") {
    throw new GlbError("REJECTED", "cannot build a manifest for a rejected GLB");
  }

  const inspection = inspectGlb(input.bytes, { allowDataUris: true });
  const sourceUnits = input.sourceUnits ?? "m";
  const sourceYawRad = input.sourceYawRad ?? 0;
  let normalized: ReturnType<typeof normalizeItem>;
  try {
    normalized = normalizeItem({
      boundsMin: inspection.boundsMin,
      boundsMax: inspection.boundsMax,
      sourceUnits,
      sourceYawRad,
      confirmedDimsM: input.confirmedDimsM ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unable to normalize GLB bounds";
    if (message.includes("degenerate or non-finite bounds")) {
      throw new GlbError("DEGENERATE_BOUNDS", message);
    }
    throw new GlbError("INVALID_NORMALIZATION", message);
  }

  const min = inspection.boundsMin;
  const max = inspection.boundsMax;
  const check = normalized.status === "READY"
    ? "MATCH"
    : normalized.status === "NEEDS_REVIEW"
      ? "MISMATCH"
      : "UNKNOWN";
  const reviewStatus = input.validation.status === "NEEDS_REVIEW" || check === "MISMATCH"
    ? "NEEDS_REVIEW"
    : "OK";

  return {
    schemaVersion: 1,
    processingVersion: input.processingVersion ?? ASSET_PROCESSING_VERSION,
    format: "model/gltf-binary",
    sha256: inspection.sha256,
    bytes: inspection.bytes,
    meshBounds: {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      units: sourceUnits,
    },
    axisConvention: { up: "+Y", front: "+Z", handedness: "right", source: "glTF 2.0" },
    originConvention: "FOOTPRINT_CENTER_FLOOR",
    normalization: {
      matrix: normalized.localMatrix,
      uniformScaleToMeters: normalized.scaleToMeters,
      sourceYawRad,
      measuredDimsM: normalized.measuredDimsM,
    },
    dimensions: {
      confirmedM: input.confirmedDimsM ?? null,
      evidenceRef: input.evidenceRef ?? null,
      check,
      axes: normalized.axes,
    },
    provenance: input.provenance,
    conversionPath: input.conversionPath ?? "IMPORTED_CONVERSION",
    stats: {
      triangleCount: input.validation.stats.triangleCount,
      textureCount: input.validation.stats.textureCount,
      imageCount: input.validation.stats.imageCount,
      maxTextureWidth: input.validation.stats.maxTextureWidth,
      maxTextureHeight: input.validation.stats.maxTextureHeight,
      extensionsRequired: [...input.validation.stats.extensionsRequired],
    },
    validation: {
      status: input.validation.status,
      issueCodes: input.validation.issues.map((issue) => issue.code),
    },
    reviewStatus,
    subject: input.subject ?? null,
  };
}
