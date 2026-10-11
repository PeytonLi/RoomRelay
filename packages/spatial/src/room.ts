import { isSimplePolygon, polygonAreaXZ } from "./geometry2d";
import { SpatialError } from "./units";
import type { RoomGeometry, Vec2 } from "./types";

/** Plausible room bounds (C-04): each axis extent of the boundary polygon
 * must lie inside this span. Explicit constants, not coerced guesses. */
export const ROOM_MIN_SPAN_M = 1.0;
export const ROOM_MAX_SPAN_M = 30.0;
export const ROOM_MIN_AREA_M2 = 0.5;
export const ROOM_MAX_VERTICES = 12;
export const ROOM_MIN_VERTICES = 3;
export const CEILING_MIN_M = 1.5;
export const CEILING_MAX_M = 10.0;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkPolygon(name: string, poly: Vec2[], errors: string[]): void {
  if (!Array.isArray(poly) || poly.length < ROOM_MIN_VERTICES) {
    errors.push(`${name}: needs at least ${ROOM_MIN_VERTICES} vertices`);
    return;
  }
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1])) {
      errors.push(`${name}: non-finite or malformed vertex`);
      return;
    }
  }
  if (Math.abs(polygonAreaXZ(poly)) <= 1e-6) {
    errors.push(`${name}: degenerate (zero-area) polygon`);
  }
}

/** Validate a C-04 room geometry object. Returns the same object typed as
 * RoomGeometry when valid; throws SpatialError("INVALID_ROOM") otherwise. */
export function validateRoom(geometry: unknown): RoomGeometry {
  const errors: string[] = [];
  const g = geometry as Partial<RoomGeometry> | null;
  if (g === null || typeof g !== "object") {
    throw new SpatialError("INVALID_ROOM", "room geometry is not an object");
  }
  if (g.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (g.units !== "m") errors.push(`units must be "m", got ${JSON.stringify(g.units)}`);

  checkPolygon("boundaryXZ", (g.boundaryXZ ?? []) as Vec2[], errors);
  const boundary = (g.boundaryXZ ?? []) as Vec2[];
  if (boundary.length > ROOM_MAX_VERTICES) {
    errors.push(`boundaryXZ: ${boundary.length} vertices exceeds max ${ROOM_MAX_VERTICES}`);
  }
  if (boundary.length >= ROOM_MIN_VERTICES && boundary.every((p) => finite(p[0]) && finite(p[1]))) {
    const xs = boundary.map((p) => p[0]);
    const zs = boundary.map((p) => p[1]);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanZ = Math.max(...zs) - Math.min(...zs);
    if (spanX < ROOM_MIN_SPAN_M || spanX > ROOM_MAX_SPAN_M || spanZ < ROOM_MIN_SPAN_M || spanZ > ROOM_MAX_SPAN_M) {
      errors.push(
        `boundary extent ${spanX.toFixed(3)}m x ${spanZ.toFixed(3)}m outside plausible ${ROOM_MIN_SPAN_M}-${ROOM_MAX_SPAN_M}m`,
      );
    }
    if (Math.abs(polygonAreaXZ(boundary)) < ROOM_MIN_AREA_M2) {
      errors.push("boundaryXZ: degenerate area");
    }
    if (!isSimplePolygon(boundary)) {
      errors.push("boundaryXZ: self-intersecting polygon");
    }
  }

  if (g.ceilingHeightM !== null && g.ceilingHeightM !== undefined) {
    if (!finite(g.ceilingHeightM) || g.ceilingHeightM < CEILING_MIN_M || g.ceilingHeightM > CEILING_MAX_M) {
      errors.push(`ceilingHeightM ${JSON.stringify(g.ceilingHeightM)} outside plausible ${CEILING_MIN_M}-${CEILING_MAX_M}m`);
    }
  }

  for (const door of g.doors ?? []) {
    if (!door.id) errors.push("door missing id");
    if (!Array.isArray(door.openingXZ) || door.openingXZ.length !== 2 || !door.openingXZ.every((p) => finite(p[0]) && finite(p[1]))) {
      errors.push(`door ${door.id ?? "?"}: openingXZ needs exactly two finite points`);
    }
    // An empty swing polygon is legal and means UNKNOWN — see validateLayout.
    if (door.swingPolygonXZ && door.swingPolygonXZ.length > 0) {
      checkPolygon(`door ${door.id} swingPolygonXZ`, door.swingPolygonXZ, errors);
    }
  }

  for (const ob of g.obstacles ?? []) {
    if (!ob.id) errors.push("obstacle missing id");
    checkPolygon(`obstacle ${ob.id ?? "?"} footprintXZ`, ob.footprintXZ ?? [], errors);
  }

  if (errors.length > 0) {
    throw new SpatialError("INVALID_ROOM", errors.join("; "));
  }
  return g as RoomGeometry;
}
