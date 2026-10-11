import { mat4Multiply, mat4RotationY, mat4Scale, mat4Translation } from "./mat4";
import { toMeters, type LinearUnit } from "./units";
import type { ConfirmedDimsM, Mat4, Vec3 } from "./types";

/** Review threshold per C-05: max(0.02m, 5% of the confirmed axis length). */
export const ABS_MISMATCH_M = 0.02;
export const REL_MISMATCH = 0.05;

export interface AxisReport {
  axis: "width" | "depth" | "height";
  measuredM: number;
  confirmedM: number | null;
  deltaM: number | null;
  thresholdM: number | null;
  withinThreshold: boolean | null; // null = no confirmed value to compare
}

export interface NormalizeInput {
  boundsMin: Vec3;
  boundsMax: Vec3;
  sourceUnits: LinearUnit;
  /** Seller-confirmed dimensions in meters; null axes/whole object = unknown. */
  confirmedDimsM?: ConfirmedDimsM | null;
  /** Radians the source model's +Z must be yawed to face canonical +Z. */
  sourceYawRad?: number;
}

export interface NormalizeResult {
  status: "READY" | "NEEDS_REVIEW" | "UNKNOWN";
  /** Uniform scale applied from source units to meters. */
  scaleToMeters: number;
  /** Post-normalization measured size in meters (width=X, height=Y, depth=Z). */
  measuredDimsM: ConfirmedDimsM;
  /** Column-major local transform: bottom-footprint center at origin, front +Z. */
  localMatrix: Mat4;
  axes: AxisReport[];
}

/**
 * Normalize item bounds into the canonical local frame (C-04): uniform scale
 * from source units, footprint center at origin on the floor, front +Z.
 * Never stretches non-uniformly; a confirmed-dimension mismatch over
 * max(0.02m, 5%) on any axis is reported as NEEDS_REVIEW.
 */
export function normalizeItem(input: NormalizeInput): NormalizeResult {
  const { boundsMin, boundsMax, sourceUnits } = input;
  const srcSize: Vec3 = [
    boundsMax[0] - boundsMin[0],
    boundsMax[1] - boundsMin[1],
    boundsMax[2] - boundsMin[2],
  ];
  // toMeters validates non-finite/negative and rejects unknown units.
  toMeters(0, sourceUnits);
  const scale = { m: 1, cm: 0.01, mm: 0.001 }[sourceUnits];
  const sizeM: Vec3 = [srcSize[0] * scale, srcSize[1] * scale, srcSize[2] * scale];
  if (sizeM.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error("normalizeItem: degenerate or non-finite bounds");
  }

  const confirmed = input.confirmedDimsM ?? null;
  const yaw = input.sourceYawRad ?? 0;
  if (!Number.isFinite(yaw)) throw new Error("normalizeItem: sourceYawRad not finite");

  const axisOf = (i: 0 | 1 | 2): { name: AxisReport["axis"]; confirmed: number | null } => {
    const names: AxisReport["axis"][] = ["width", "height", "depth"];
    const conf = confirmed ? [confirmed.widthM, confirmed.heightM, confirmed.depthM][i]! : null;
    return { name: names[i]!, confirmed: conf };
  };

  const axes: AxisReport[] = ([0, 1, 2] as const).map((i) => {
    const { name, confirmed: conf } = axisOf(i);
    const measured = sizeM[i]!;
    if (conf === null || !Number.isFinite(conf) || conf <= 0) {
      return { axis: name, measuredM: measured, confirmedM: null, deltaM: null, thresholdM: null, withinThreshold: null };
    }
    const delta = Math.abs(measured - conf);
    const threshold = Math.max(ABS_MISMATCH_M, REL_MISMATCH * conf);
    return { axis: name, measuredM: measured, confirmedM: conf, deltaM: delta, thresholdM: threshold, withinThreshold: delta <= threshold };
  });

  let status: NormalizeResult["status"] = "READY";
  if (axes.some((a) => a.withinThreshold === false)) status = "NEEDS_REVIEW";
  else if (axes.some((a) => a.withinThreshold === null)) status = "UNKNOWN";

  // Bottom-footprint center in source units.
  const centerSrc: Vec3 = [
    (boundsMin[0] + boundsMax[0]) / 2,
    boundsMin[1], // bottom of the footprint sits on Y=0
    (boundsMin[2] + boundsMax[2]) / 2,
  ];

  // canonical = S(scale) * R_y(yaw) * T(-center) applied to source points.
  // The recenter happens in source space before unit scaling; equivalent to
  // scaling then recentering by the scaled center.
  const localMatrix = mat4Multiply(
    mat4Scale(scale, scale, scale),
    mat4Multiply(mat4RotationY(yaw), mat4Translation(-centerSrc[0], -centerSrc[1], -centerSrc[2])),
  );

  return {
    status,
    scaleToMeters: scale,
    measuredDimsM: { widthM: sizeM[0]!, heightM: sizeM[1]!, depthM: sizeM[2]! },
    localMatrix,
    axes,
  };
}
