import type { Material, Object3D, Texture } from "three";

/**
 * Dispose GPU resources under an Object3D root: geometries, materials and
 * every texture referenced by each material's map slots. Safe to call on
 * unmount or when replacing a loaded scene (C-07: no GPU leaks across
 * repeated room sessions).
 */
export function disposeObject3D(root: Object3D): void {
  root.traverse((obj) => {
    const anyObj = obj as unknown as { geometry?: { dispose(): void }; material?: Material | Material[] };
    anyObj.geometry?.dispose();
    const mats = anyObj.material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      for (const value of Object.values(m)) {
        if (value && typeof (value as Texture).isTexture === "boolean" && (value as Texture).isTexture) {
          (value as Texture).dispose();
        }
      }
      m.dispose();
    }
  });
}
