import { describe, expect, it } from "vitest";
import { mat4TransformPoint } from "@roomrelay/spatial";
import { GlbError } from "./inspectGlb";
import { buildAssetManifest, ASSET_PROCESSING_VERSION } from "./manifest";
import { validGlb } from "./testing/glbFixtures";
import { validateGlb } from "./validateGlb";

const provenance = "SCANNED_ACTUAL" as const;

describe("buildAssetManifest", () => {
  it("records the content hash, dimensions, and normalization", () => {
    const bytes = validGlb();
    const manifest = buildAssetManifest({ bytes, validation: validateGlb(bytes), provenance });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.bytes).toBe(bytes.byteLength);
    expect(manifest.meshBounds.min).toEqual([0, 0, 0]);
    expect(manifest.meshBounds.max).toEqual([1, 1, 1]);
    expect(manifest.dimensions.check).toBe("UNKNOWN");
    expect(manifest.dimensions.evidenceRef).toBeNull();
    expect(manifest.processingVersion).toBe(ASSET_PROCESSING_VERSION);
    expect(mat4TransformPoint(manifest.normalization.matrix, [0.5, 0, 0.5])).toEqual([0, 0, 0]);
  });

  it("uses confirmed dimensions to report MATCH or MISMATCH", () => {
    const bytes = validGlb();
    const validation = validateGlb(bytes);
    const matched = buildAssetManifest({
      bytes,
      validation,
      provenance,
      confirmedDimsM: { widthM: 1, depthM: 1, heightM: 1 },
      evidenceRef: "measurement-1",
    });
    expect(matched.dimensions.check).toBe("MATCH");
    expect(matched.dimensions.evidenceRef).toBe("measurement-1");

    const mismatch = buildAssetManifest({
      bytes,
      validation,
      provenance,
      confirmedDimsM: { widthM: 0.5, depthM: 1, heightM: 1 },
    });
    expect(mismatch.dimensions.check).toBe("MISMATCH");
    expect(mismatch.reviewStatus).toBe("NEEDS_REVIEW");
  });

  it("uses source units and applies only a uniform scale", () => {
    const bytes = validGlb();
    const manifest = buildAssetManifest({
      bytes,
      validation: validateGlb(bytes),
      provenance,
      sourceUnits: "cm",
    });
    expect(manifest.meshBounds.units).toBe("cm");
    expect(manifest.normalization.uniformScaleToMeters).toBe(0.01);
    expect(manifest.normalization.measuredDimsM.widthM).toBeCloseTo(0.01);
  });

  it("propagates validation review status", () => {
    const bytes = validGlb({ width: 4096 });
    const manifest = buildAssetManifest({ bytes, validation: validateGlb(bytes), provenance });
    expect(manifest.validation.status).toBe("NEEDS_REVIEW");
    expect(manifest.reviewStatus).toBe("NEEDS_REVIEW");
  });

  it("rejects a rejected validation result", () => {
    const bytes = validGlb();
    const validation = { ...validateGlb(bytes), status: "REJECTED" as const };
    expect(() => buildAssetManifest({ bytes, validation, provenance })).toThrowError(GlbError);
    try {
      buildAssetManifest({ bytes, validation, provenance });
    } catch (error) {
      expect((error as GlbError).code).toBe("REJECTED");
    }
  });

  it("rejects degenerate bounds", () => {
    const bytes = validGlb();
    const validation = validateGlb(bytes);
    const degenerate = validGlb({ mutateJson: (json) => {
      json.accessors[0].min = [0, 0, 0];
      json.accessors[0].max = [0, 0, 0];
    } });
    expect(() => buildAssetManifest({ bytes: degenerate, validation, provenance })).toThrowError(
      expect.objectContaining({ code: "DEGENERATE_BOUNDS" }),
    );
  });
});
