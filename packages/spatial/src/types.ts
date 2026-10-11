export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Column-major 4x4 homogeneous transform, right-handed, meters. */
export type Mat4 = number[]; // length 16

export interface DoorGeometry {
  id: string;
  /** Two points describing the opening segment in the floor plane. */
  openingXZ: Vec2[];
  /** Protected sweep polygon; empty means the sweep was never measured. */
  swingPolygonXZ: Vec2[];
  confirmed: boolean;
}

export interface ObstacleGeometry {
  id: string;
  label: string;
  footprintXZ: Vec2[];
  heightM?: number | null;
}

/** Room geometry per CAPTURE_AND_3D.md C-04. Canonical frame: right-handed,
 * meters, Y up, floor at Y=0, boundary vertices in the XZ plane. */
export interface RoomGeometry {
  schemaVersion: 1;
  units: "m";
  frameId?: string;
  boundaryXZ: Vec2[];
  ceilingHeightM: number | null;
  doors: DoorGeometry[];
  obstacles: ObstacleGeometry[];
  captureToRoomMatrix?: Mat4 | null;
  measurementRevision: number;
}

export interface ConfirmedDimsM {
  widthM: number;
  depthM: number;
  heightM: number;
}

export interface Placement {
  xM: number;
  zM: number;
  yawRad: number;
}

export interface PlacedItem {
  id: string;
  title?: string;
  dimsM: ConfirmedDimsM;
  placement: Placement;
}

export type FindingStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface LayoutFinding {
  code: string;
  status: FindingStatus;
  itemIds: string[];
  geometryRefs: string[];
  measuredValue?: number;
  threshold?: number;
  evidenceIds: string[];
  message: string;
}

export interface LayoutResult {
  findings: LayoutFinding[];
  /** True only when no critical FAIL or UNKNOWN finding exists. */
  fitsProvidedMeasurements: boolean;
  verdict: string;
}
