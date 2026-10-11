export type LinearUnit = "m" | "cm" | "mm";

const UNIT_SCALE: Record<LinearUnit, number> = { m: 1, cm: 0.01, mm: 0.001 };

/** Convert a linear measurement to meters. No silent unit coercion: the unit
 * must be declared and must be one of m/cm/mm. */
export function toMeters(value: number, unit: LinearUnit): number {
  if (!Number.isFinite(value)) {
    throw new SpatialError("NON_FINITE", `measurement is not finite: ${String(value)}`);
  }
  if (value < 0) {
    throw new SpatialError("NEGATIVE", `measurement is negative: ${value}`);
  }
  const scale = UNIT_SCALE[unit];
  if (scale === undefined) {
    throw new SpatialError("UNIT_MISMATCH", `unsupported unit: ${String(unit)}`);
  }
  return value * scale;
}

export class SpatialError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpatialError";
  }
}
