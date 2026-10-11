import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { disposeObject3D } from "./dispose";

describe("disposeObject3D", () => {
  it("disposes geometries, materials and material maps under a root", () => {
    const geo = new BoxGeometry(1, 1, 1);
    const mat = new MeshStandardMaterial();
    const tex = new Texture();
    mat.map = tex;
    const geoDispose = vi.spyOn(geo, "dispose");
    const matDispose = vi.spyOn(mat, "dispose");
    const texDispose = vi.spyOn(tex, "dispose");

    const mesh = new Mesh(geo, mat);
    const root = new Group();
    root.add(mesh);

    disposeObject3D(root);
    expect(geoDispose).toHaveBeenCalledOnce();
    expect(matDispose).toHaveBeenCalledOnce();
    expect(texDispose).toHaveBeenCalledOnce();
  });

  it("handles material arrays and nested children", () => {
    const g1 = new BoxGeometry();
    const m1 = new MeshStandardMaterial();
    const m2 = new MeshStandardMaterial();
    const inner = new Group();
    inner.add(new Mesh(g1, [m1, m2]));
    const root = new Group();
    root.add(inner);
    const spies = [g1, m1, m2].map((r) => vi.spyOn(r, "dispose"));
    disposeObject3D(root);
    for (const s of spies) expect(s).toHaveBeenCalledOnce();
  });
});
