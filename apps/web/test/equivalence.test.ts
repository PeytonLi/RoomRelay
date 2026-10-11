import { describe, expect, it } from "vitest";
import { Group, Matrix4, Scene, Vector3 } from "three";
import { footprintXZ, mat4Multiply, placementMatrix } from "@roomrelay/spatial";

/**
 * 2D/3D equivalence (T-003/C-06): the world matrix of the placed item group
 * must equal placementMatrix × localMatrix, and the SVG footprint must equal
 * footprintXZ — the views share one source of truth.
 */
describe("2D/3D transform equivalence", () => {
  const placement = { xM: 1.35, zM: 2.4, yawRad: Math.PI / 3 };
  const localMatrix = [
    0.01, 0, 0, 0,
    0, 0.01, 0, 0,
    0, 0, 0.01, 0,
    -0.5, -0.0, -0.3, 1,
  ]; // e.g. cm-scale model recentered by normalization

  it("Object3D world matrix equals placementMatrix × localMatrix", () => {
    const scene = new Scene();
    const group = new Group();
    const inner = new Group();
    group.matrixAutoUpdate = false;
    inner.matrixAutoUpdate = false;
    group.matrix.fromArray(placementMatrix(placement));
    inner.matrix.fromArray(localMatrix);
    group.add(inner);
    scene.add(group);
    scene.updateMatrixWorld(true);

    const expected = new Matrix4().fromArray(mat4Multiply(placementMatrix(placement), localMatrix));
    for (let i = 0; i < 16; i++) {
      expect(inner.matrixWorld.elements[i]).toBeCloseTo(expected.elements[i]!, 10);
    }
  });

  it("a world-space corner lands where footprintXZ puts it", () => {
    const dimsM = { widthM: 0.62, depthM: 0.58, heightM: 0.82 };
    const corners = footprintXZ({ dimsM }, placement);
    const m = new Matrix4().fromArray(placementMatrix(placement));
    const local = [
      [-dimsM.widthM / 2, 0, -dimsM.depthM / 2],
      [dimsM.widthM / 2, 0, -dimsM.depthM / 2],
      [dimsM.widthM / 2, 0, dimsM.depthM / 2],
      [-dimsM.widthM / 2, 0, dimsM.depthM / 2],
    ];
    local.forEach((c, i) => {
      const w = new Vector3(c[0], c[1], c[2]).applyMatrix4(m);
      expect(w.x).toBeCloseTo(corners[i]![0]!, 10);
      expect(w.z).toBeCloseTo(corners[i]![1]!, 10);
    });
  });
});
