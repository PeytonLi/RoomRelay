import { distanceToPolygonEdges, pointInPolygon, polygonsIntersect } from "./geometry2d";
import { mat4TransformPoint, placementMatrix } from "./mat4";
import type { ConfirmedDimsM, LayoutFinding, LayoutResult, Placement, PlacedItem, RoomGeometry, Vec2 } from "./types";

export const DEFAULT_MARGIN_M = 0.05;

/** Float tolerance for clearance comparisons: placements that are
 * mathematically at a boundary can land a hair short after rotation math. */
export const GEOMETRY_EPSILON_M = 1e-6;

/** Rotated rectangle footprint corners (XZ) of an item at a placement.
 * The item local frame has width on X, depth on Z, footprint centered at 0. */
export function footprintXZ(
  item: { dimsM: ConfirmedDimsM },
  placement: Placement,
): Vec2[] {
  const m = placementMatrix(placement);
  const w = item.dimsM.widthM / 2;
  const d = item.dimsM.depthM / 2;
  const corners: [number, number, number][] = [
    [-w, 0, -d],
    [w, 0, -d],
    [w, 0, d],
    [-w, 0, d],
  ];
  return corners.map((c) => {
    const p = mat4TransformPoint(m, c);
    return [p[0], p[2]] as Vec2;
  });
}

function finding(partial: Omit<LayoutFinding, "evidenceIds"> & { evidenceIds?: string[] }): LayoutFinding {
  return { evidenceIds: [], ...partial };
}

/**
 * Hard-constraint fit check (C-06). Returns per-check findings with
 * PASS/WARN/FAIL/UNKNOWN; a critical FAIL or UNKNOWN blocks the
 * "Fits provided measurements" verdict.
 */
export function validateLayout(
  room: RoomGeometry,
  items: PlacedItem[],
  options?: { marginM?: number },
): LayoutResult {
  const margin = options?.marginM ?? DEFAULT_MARGIN_M;
  const findings: LayoutFinding[] = [];
  const footprints = new Map<string, Vec2[]>();

  for (const item of items) {
    const { xM, zM, yawRad } = item.placement;
    if (![xM, zM, yawRad].every(Number.isFinite)) {
      findings.push(
        finding({
          code: "INVALID_PLACEMENT",
          status: "UNKNOWN",
          itemIds: [item.id],
          geometryRefs: [],
          message: `${item.title ?? item.id}: placement is not a finite number; fit cannot be verified.`,
        }),
      );
      continue;
    }
    const fp = footprintXZ(item, item.placement);
    footprints.set(item.id, fp);

    // Boundary containment with margin.
    if (!item.dimsM || item.dimsM.widthM <= 0 || item.dimsM.depthM <= 0) {
      findings.push(
        finding({
          code: "MISSING_DIMENSIONS",
          status: "UNKNOWN",
          itemIds: [item.id],
          geometryRefs: [],
          message: `${item.title ?? item.id}: confirmed dimensions missing; fit cannot be verified.`,
        }),
      );
      continue;
    }

    const allInside = fp.every((c) => pointInPolygon(c, room.boundaryXZ));
    const minClear = Math.min(...fp.map((c) => distanceToPolygonEdges(c, room.boundaryXZ)));
    if (!allInside) {
      findings.push(
        finding({
          code: "OUTSIDE_BOUNDARY",
          status: "FAIL",
          itemIds: [item.id],
          geometryRefs: ["boundary"],
          threshold: margin,
          message: `${item.title ?? item.id}: footprint reaches outside the room boundary.`,
        }),
      );
    } else if (minClear < margin - GEOMETRY_EPSILON_M) {
      findings.push(
        finding({
          code: "BOUNDARY_MARGIN",
          status: "FAIL",
          itemIds: [item.id],
          geometryRefs: ["boundary"],
          measuredValue: minClear,
          threshold: margin,
          message: `${item.title ?? item.id}: only ${minClear.toFixed(3)}m from a wall; needs ${margin}m clearance.`,
        }),
      );
    } else {
      findings.push(
        finding({
          code: "BOUNDARY_MARGIN",
          status: "PASS",
          itemIds: [item.id],
          geometryRefs: ["boundary"],
          measuredValue: minClear,
          threshold: margin,
          message: `${item.title ?? item.id}: inside the room with ${minClear.toFixed(2)}m wall clearance.`,
        }),
      );
    }

    // Kept-object / obstacle conflicts.
    for (const ob of room.obstacles) {
      const hit = polygonsIntersect(fp, ob.footprintXZ);
      findings.push(
        finding({
          code: "OBSTACLE_OVERLAP",
          status: hit ? "FAIL" : "PASS",
          itemIds: [item.id],
          geometryRefs: [ob.id],
          message: hit
            ? `${item.title ?? item.id} overlaps the kept ${ob.label ?? ob.id}.`
            : `${item.title ?? item.id} is clear of the kept ${ob.label ?? ob.id}.`,
        }),
      );
    }

    // Door sweep intrusion. An empty swing polygon is UNKNOWN, never safe.
    for (const door of room.doors) {
      if (!door.swingPolygonXZ || door.swingPolygonXZ.length === 0) {
        findings.push(
          finding({
            code: "DOOR_SWING",
            status: "UNKNOWN",
            itemIds: [item.id],
            geometryRefs: [door.id],
            message: `Door ${door.id}: sweep was never measured; intrusion cannot be verified.`,
          }),
        );
        continue;
      }
      const hit = polygonsIntersect(fp, door.swingPolygonXZ);
      findings.push(
        finding({
          code: "DOOR_SWING",
          status: hit ? "FAIL" : "PASS",
          itemIds: [item.id],
          geometryRefs: [door.id],
          message: hit
            ? `${item.title ?? item.id} blocks the swing of door ${door.id}.`
            : `${item.title ?? item.id} is clear of door ${door.id}'s sweep.`,
        }),
      );
    }

    // Height vs ceiling.
    if (room.ceilingHeightM === null || room.ceilingHeightM === undefined || !Number.isFinite(item.dimsM.heightM) || item.dimsM.heightM <= 0) {
      findings.push(
        finding({
          code: "HEIGHT_VS_CEILING",
          status: "UNKNOWN",
          itemIds: [item.id],
          geometryRefs: ["ceiling"],
          message: `${item.title ?? item.id}: height or ceiling unmeasured; clearance unknown.`,
        }),
      );
    } else {
      const headroom = room.ceilingHeightM - item.dimsM.heightM;
      findings.push(
        finding({
          code: "HEIGHT_VS_CEILING",
          status: headroom >= -GEOMETRY_EPSILON_M ? "PASS" : "FAIL",
          itemIds: [item.id],
          geometryRefs: ["ceiling"],
          measuredValue: item.dimsM.heightM,
          threshold: room.ceilingHeightM,
          message:
            headroom >= -GEOMETRY_EPSILON_M
              ? `${item.title ?? item.id}: ${item.dimsM.heightM.toFixed(2)}m tall under a ${room.ceilingHeightM.toFixed(2)}m ceiling.`
              : `${item.title ?? item.id}: ${item.dimsM.heightM.toFixed(2)}m tall exceeds the ${room.ceilingHeightM.toFixed(2)}m ceiling.`,
        }),
      );
    }
  }

  // Item-item overlaps.
  const ids = [...footprints.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = items.find((it) => it.id === ids[i]!)!;
      const b = items.find((it) => it.id === ids[j]!)!;
      const hit = polygonsIntersect(footprints.get(ids[i]!)!, footprints.get(ids[j]!)!);
      findings.push(
        finding({
          code: "ITEM_OVERLAP",
          status: hit ? "FAIL" : "PASS",
          itemIds: [a.id, b.id],
          geometryRefs: [],
          message: hit
            ? `${a.title ?? a.id} and ${b.title ?? b.id} overlap each other.`
            : `${a.title ?? a.id} and ${b.title ?? b.id} do not overlap.`,
        }),
      );
    }
  }

  const blocking = findings.some(
    (f) => f.status === "FAIL" || (f.status === "UNKNOWN" && f.code !== "HEIGHT_VS_CEILING" && f.code !== "INVALID_PLACEMENT"),
  );
  // Height and invalid-placement UNKNOWNs are non-critical: they mean the
  // check couldn't be performed, not that the layout fails. Door-sweep
  // UNKNOWN is critical per C-06 (protected zone unmeasured).
  const heightUnknownOnly =
    !blocking &&
    findings.some((f) => f.status === "UNKNOWN"); // only possible remaining UNKNOWNs are height / invalid placement
  const fits = !blocking && !heightUnknownOnly;
  const verdict = fits
    ? "Fits provided measurements"
    : blocking
      ? "Does not fit provided measurements"
      : "Fit unknown for the measured constraints";
  return { findings, fitsProvidedMeasurements: fits, verdict };
}
