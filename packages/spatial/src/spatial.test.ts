import { describe, expect, it } from "vitest";
import {
  footprintXZ,
  mat4TransformPoint,
  normalizeItem,
  placementMatrix,
  toMeters,
  validateLayout,
  validateRoom,
  type RoomGeometry,
} from "./index";

function roomFixture(): RoomGeometry {
  // Quarter-circle door swing from a door at the z=0 wall, hinge near x=0.4.
  const swing: [number, number][] = [[0.4, 0]];
  const r = 0.85;
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    swing.push([0.4 + r * Math.cos(a), r * Math.sin(a)]);
  }
  return {
    schemaVersion: 1,
    units: "m",
    boundaryXZ: [
      [0, 0],
      [3.4, 0],
      [3.4, 4.0],
      [0, 4.0],
    ],
    ceilingHeightM: 2.5,
    doors: [{ id: "door-1", openingXZ: [[0.4, 0], [1.25, 0]], swingPolygonXZ: swing, confirmed: true }],
    obstacles: [
      {
        id: "bed-1",
        label: "bed",
        footprintXZ: [
          [2.4, 2.0],
          [3.4, 2.0],
          [3.4, 4.0],
          [2.4, 4.0],
        ],
      },
    ],
    measurementRevision: 1,
  };
}

const chairDims = { widthM: 0.62, depthM: 0.58, heightM: 0.82 };

describe("toMeters (TEST-01)", () => {
  it("converts m/cm/mm", () => {
    expect(toMeters(1.5, "m")).toBeCloseTo(1.5);
    expect(toMeters(150, "cm")).toBeCloseTo(1.5);
    expect(toMeters(1500, "mm")).toBeCloseTo(1.5);
  });
  it("rejects non-finite, negative and unknown units", () => {
    expect(() => toMeters(NaN, "m")).toThrowError(/finite/);
    expect(() => toMeters(Infinity, "cm")).toThrowError(/finite/);
    expect(() => toMeters(-1, "mm")).toThrowError(/negative/);
    // @ts-expect-error deliberate mismatched unit
    expect(() => toMeters(1, "inches")).toThrowError(/unsupported unit/);
  });
});

describe("validateRoom", () => {
  it("accepts the synthetic room", () => {
    expect(validateRoom(roomFixture()).boundaryXZ).toHaveLength(4);
  });
  it("rejects self-intersecting boundaries", () => {
    const r = roomFixture();
    r.boundaryXZ = [
      [0, 0],
      [3.4, 4.0],
      [3.4, 0],
      [0, 4.0],
    ];
    expect(() => validateRoom(r)).toThrowError(/self-intersecting|extent/);
  });
  it("rejects wrong units and degenerate rooms", () => {
    const r = roomFixture();
    // @ts-expect-error wrong units
    r.units = "cm";
    expect(() => validateRoom(r)).toThrowError(/units/);
    const r2 = roomFixture();
    r2.boundaryXZ = [
      [0, 0],
      [0.2, 0],
      [0.2, 0.2],
      [0, 0.2],
    ];
    expect(() => validateRoom(r2)).toThrowError(/plausible|degenerate/);
  });
});

describe("normalizeItem", () => {
  const base = {
    boundsMin: [0, 0, 0] as [number, number, number],
    boundsMax: [62, 82, 58] as [number, number, number],
    sourceUnits: "cm" as const,
    confirmedDimsM: chairDims,
  };
  it("scales cm/mm/m bounds and compares to confirmed dims", () => {
    const cm = normalizeItem(base);
    expect(cm.status).toBe("READY");
    expect(cm.measuredDimsM.widthM).toBeCloseTo(0.62);
    const mm = normalizeItem({ ...base, boundsMax: [620, 820, 580], sourceUnits: "mm" });
    expect(mm.measuredDimsM.heightM).toBeCloseTo(0.82);
    const m = normalizeItem({ ...base, boundsMax: [0.62, 0.82, 0.58], sourceUnits: "m" });
    expect(m.measuredDimsM.depthM).toBeCloseTo(0.58);
  });
  it("flags NEEDS_REVIEW past max(0.02m, 5%) on any axis with a per-axis report", () => {
    const res = normalizeItem({ ...base, confirmedDimsM: { ...chairDims, widthM: 0.5 } });
    expect(res.status).toBe("NEEDS_REVIEW");
    const widthAxis = res.axes.find((a) => a.axis === "width")!;
    expect(widthAxis.withinThreshold).toBe(false);
    expect(widthAxis.thresholdM).toBeCloseTo(Math.max(0.02, 0.05 * 0.5));
  });
  it("marks UNKNOWN when dimensions are unconfirmed", () => {
    expect(normalizeItem({ ...base, confirmedDimsM: null }).status).toBe("UNKNOWN");
  });
  it("produces a local matrix with bottom-footprint center at origin", () => {
    const res = normalizeItem({ ...base, boundsMin: [10, 5, -10], boundsMax: [72, 87, 48] });
    const p = mat4TransformPoint(res.localMatrix, [41, 5, 19]); // source-space footprint center
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(0);
  });
  it("applies sourceYawRad so a source front faces +Z", () => {
    // Source model's front is +X; yaw -π/2 brings +X onto +Z.
    const res = normalizeItem({ ...base, sourceYawRad: -Math.PI / 2 });
    const front = mat4TransformPoint(res.localMatrix, [41, 46, 19 + 1]); // 1cm in source? no—use a source-space direction
    // Direction check: transform a unit +X offset from the center in source units.
    const c = mat4TransformPoint(res.localMatrix, [41, 5, 19]);
    const px = mat4TransformPoint(res.localMatrix, [51, 5, 19]);
    const dir = [px[0] - c[0], px[1] - c[1], px[2] - c[2]];
    expect(dir[0]).toBeCloseTo(0, 5);
    expect(dir[2]).toBeCloseTo(0.1, 5); // +X source → +Z canonical
    void front;
  });
});

describe("placementMatrix / footprintXZ", () => {
  it("maps +Z front to +X at yaw π/2 (known orientation)", () => {
    const m = placementMatrix({ xM: 1, zM: 2, yawRad: Math.PI / 2 });
    const front = mat4TransformPoint(m, [0, 0, 1]);
    expect(front[0]).toBeCloseTo(2);
    expect(front[2]).toBeCloseTo(2);
    const corners = footprintXZ(
      { dimsM: { widthM: 1, depthM: 2, heightM: 1 } },
      { xM: 0, zM: 0, yawRad: Math.PI / 2 },
    );
    // After yaw π/2 the 1m(X)x2m(Z) item spans 2m on X, 1m on Z.
    const xs = corners.map((c) => c[0]);
    const zs = corners.map((c) => c[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(1);
    expect(corners).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.closeTo(1), expect.closeTo(-0.5)]),
        expect.arrayContaining([expect.closeTo(-1), expect.closeTo(0.5)]),
      ]),
    );
  });

  it("throws on non-finite placement values", () => {
    expect(() => placementMatrix({ xM: NaN, zM: 0, yawRad: 0 })).toThrow(RangeError);
    expect(() => placementMatrix({ xM: 0, zM: Infinity, yawRad: 0 })).toThrow(RangeError);
    expect(() => placementMatrix({ xM: 0, zM: 0, yawRad: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe("validateLayout (TEST-02 subset)", () => {
  const item = (placement: { xM: number; zM: number; yawRad: number }, dims = chairDims) => ({
    id: "chair",
    title: "Chair",
    dimsM: dims,
    placement,
  });

  it("passes a centered placement and says it fits", () => {
    const res = validateLayout(roomFixture(), [item({ xM: 1.5, zM: 3.2, yawRad: 0 })]);
    expect(res.fitsProvidedMeasurements).toBe(true);
    expect(res.verdict).toBe("Fits provided measurements");
  });
  it("fails at the boundary edge exactly at margin", () => {
    // Chair half-depth 0.29: place front edge exactly 0.05 from z=0 wall → boundary clearance = 0.05 - touching? clearance = zM - 0.29.
    const ok = validateLayout(roomFixture(), [item({ xM: 2.8, zM: 0.34, yawRad: 0 })]);
    const edge = ok.findings.find((f) => f.code === "BOUNDARY_MARGIN")!;
    expect(edge.status).toBe("PASS");
    expect(edge.measuredValue).toBeCloseTo(0.05, 5);
    const bad = validateLayout(roomFixture(), [item({ xM: 2.8, zM: 0.33, yawRad: 0 })]);
    expect(bad.findings.find((f) => f.code === "BOUNDARY_MARGIN")!.status).toBe("FAIL");
  });
  it("passes when computed clearance is exactly the margin after a 90° yaw", () => {
    // Rotated 90°, the Z half-extent is widthM/2 = 0.31; zM 0.36 puts the
    // footprint mathematically 0.05 from the z=0 wall (float dust aside).
    const res = validateLayout(roomFixture(), [item({ xM: 2.8, zM: 0.36, yawRad: Math.PI / 2 })]);
    const edge = res.findings.find((f) => f.code === "BOUNDARY_MARGIN")!;
    expect(edge.status).toBe("PASS");
    expect(edge.measuredValue).toBeCloseTo(0.05, 5);
  });
  it("fails when clearance is genuinely below the margin (0.0499)", () => {
    const res = validateLayout(roomFixture(), [item({ xM: 2.8, zM: 0.36 - 0.0001, yawRad: Math.PI / 2 })]);
    expect(res.findings.find((f) => f.code === "BOUNDARY_MARGIN")!.status).toBe("FAIL");
  });
  it("passes when clearance is a float-dust shortfall (1e-9 under the margin)", () => {
    const res = validateLayout(roomFixture(), [item({ xM: 2.8, zM: 0.36 - 1e-9, yawRad: Math.PI / 2 })]);
    expect(res.findings.find((f) => f.code === "BOUNDARY_MARGIN")!.status).toBe("PASS");
  });
  it("fails when a 45°-rotated item clips a corner", () => {
    // Square-ish footprint rotated 45° in the x=0,z=4 corner.
    const res = validateLayout(roomFixture(), [
      item({ xM: 0.3, zM: 3.7, yawRad: Math.PI / 4 }, { widthM: 0.8, depthM: 0.8, heightM: 0.9 }),
    ]);
    const boundary = res.findings.find((f) => f.code === "OUTSIDE_BOUNDARY" || f.code === "BOUNDARY_MARGIN")!;
    expect(boundary.status).toBe("FAIL");
  });
  it("flags door sweep intrusion", () => {
    const res = validateLayout(roomFixture(), [item({ xM: 0.8, zM: 0.5, yawRad: 0 })]);
    const door = res.findings.find((f) => f.code === "DOOR_SWING")!;
    expect(door.status).toBe("FAIL");
  });
  it("reports UNKNOWN door sweep when the polygon is empty", () => {
    const room = roomFixture();
    room.doors = [{ id: "door-1", openingXZ: [[0.4, 0], [1.25, 0]], swingPolygonXZ: [], confirmed: false }];
    const res = validateLayout(room, [item({ xM: 2.5, zM: 3.0, yawRad: 0 })]);
    expect(res.findings.find((f) => f.code === "DOOR_SWING")!.status).toBe("UNKNOWN");
    expect(res.fitsProvidedMeasurements).toBe(false);
  });
  it("fails on kept-bed overlap", () => {
    const res = validateLayout(roomFixture(), [item({ xM: 2.6, zM: 3.0, yawRad: 0 })]);
    const ob = res.findings.find((f) => f.code === "OBSTACLE_OVERLAP")!;
    expect(ob.status).toBe("FAIL");
    expect(ob.message).toMatch(/bed/);
  });
  it("fails item-item overlap", () => {
    const res = validateLayout(roomFixture(), [
      item({ xM: 1.6, zM: 3.0, yawRad: 0 }),
      { id: "chair2", dimsM: chairDims, placement: { xM: 1.7, zM: 3.05, yawRad: 0 } },
    ]);
    expect(res.findings.find((f) => f.code === "ITEM_OVERLAP")!.status).toBe("FAIL");
  });
  it("UNKNOWN when dimensions are missing", () => {
    const res = validateLayout(roomFixture(), [
      { id: "ghost", dimsM: { widthM: 0, depthM: 0, heightM: 0 }, placement: { xM: 1.5, zM: 3, yawRad: 0 } },
    ]);
    expect(res.findings.find((f) => f.code === "MISSING_DIMENSIONS")!.status).toBe("UNKNOWN");
    expect(res.fitsProvidedMeasurements).toBe(false);
  });
  it("reports INVALID_PLACEMENT UNKNOWN for non-finite placements instead of a boundary FAIL", () => {
    const res = validateLayout(roomFixture(), [item({ xM: Number.POSITIVE_INFINITY, zM: 3, yawRad: 0 })]);
    const finding = res.findings.find((f) => f.code === "INVALID_PLACEMENT")!;
    expect(finding.status).toBe("UNKNOWN");
    expect(res.findings.some((f) => f.code === "OUTSIDE_BOUNDARY")).toBe(false);
    expect(res.fitsProvidedMeasurements).toBe(false);
    expect(res.verdict).not.toContain("Does not fit");
  });
});
