import type { AxisReport, ConfirmedDimsM, Mat4, Placement } from "@roomrelay/spatial";

/** UI-side item: fixture or locally imported, always labeled honestly. */
export interface ViewerItem {
  id: string;
  title: string;
  dimsM: ConfirmedDimsM;
  provenance: "SCANNED_ACTUAL" | "CATALOG_EXACT_MATCH" | "APPROXIMATE_PROXY" | "ILLUSTRATIVE_GENERATED";
  provenanceNote: string;
  /** Public URL for the GLB, or an object URL for local imports. Empty for box proxies. */
  assetUrl: string;
  /** Render as a box from confirmedDims (no model asset exists yet). */
  boxProxy?: boolean;
  /** Column-major local normalization matrix (bottom-footprint center, front +Z). */
  localMatrix: Mat4;
  stats: { bytes: number; triangleCount: number };
  conditionPhotos: string[];
  photosNote?: string;
  scaleCheck?: { status: string; axes: AxisReport[] };
}

export interface PlacementState {
  itemId: string;
  placement: Placement;
}

export interface FrameStats {
  medianMs: number | null;
}
