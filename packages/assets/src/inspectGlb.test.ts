import { describe, expect, it } from "vitest";
import { GlbError, inspectGlb } from "./inspectGlb";
import { buildGlb } from "./testing/glbFixtures";

const baseJson = {
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [
    {
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1 },
      ],
    },
  ],
  accessors: [
    { count: 24, min: [0, 0, 0], max: [2, 1, 3] },
    { count: 36 },
  ],
  buffers: [{ byteLength: 100 }],
  images: [],
  textures: [{}, {}],
};

describe("inspectGlb", () => {
  it("inspects a minimal embedded GLB", () => {
    const glb = buildGlb(baseJson, new Uint8Array(16));
    const res = inspectGlb(glb);
    expect(res.bytes).toBe(glb.byteLength);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.triangleCount).toBe(12);
    expect(res.textureCount).toBe(2);
    expect(res.boundsMin).toEqual([0, 0, 0]);
    expect(res.boundsMax).toEqual([2, 1, 3]);
    expect(res.extensionsRequired).toEqual([]);
  });

  it("rejects bad magic, version and truncated length", () => {
    const good = buildGlb(baseJson);
    const badMagic = good.slice();
    badMagic[0] = 0x21;
    expect(() => inspectGlb(badMagic)).toThrowError(GlbError);
    expect(() => inspectGlb(badMagic)).toThrowError(/magic/);

    const badVer = good.slice();
    new DataView(badVer.buffer).setUint32(4, 1, true);
    expect(() => inspectGlb(badVer)).toThrowError(/version/);

    expect(() => inspectGlb(good.subarray(0, good.length - 1))).toThrowError(/length|TRUNCATED/i);
    const big = good.slice();
    new DataView(big.buffer).setUint32(8, big.length + 4, true);
    expect(() => inspectGlb(big)).toThrowError(/length/);
  });

  it("rejects external buffer and image URIs (incl. data: URIs)", () => {
    const extBuf = buildGlb({ ...baseJson, buffers: [{ uri: "https://x/y.bin", byteLength: 1 }] });
    expect(() => inspectGlb(extBuf)).toThrowError(/external/i);
    const dataImg = buildGlb({ ...baseJson, images: [{ uri: "data:image/png;base64,AAAA" }] });
    expect(() => inspectGlb(dataImg)).toThrowError(/external/i);
    const relBuf = buildGlb({ ...baseJson, buffers: [{ uri: "scene.bin", byteLength: 1 }] });
    expect(() => inspectGlb(relBuf)).toThrowError(/external/i);
  });

  it("applies node transforms to bounds", () => {
    const json = {
      ...baseJson,
      nodes: [
        { mesh: 0, translation: [10, 0, 0], scale: [2, 2, 2] },
      ],
      scenes: [{ nodes: [0] }],
    };
    const res = inspectGlb(buildGlb(json));
    expect(res.boundsMin).toEqual([10, 0, 0]);
    expect(res.boundsMax).toEqual([14, 2, 6]);
  });

  it("inherits parent transforms through the node hierarchy", () => {
    const json = {
      ...baseJson,
      nodes: [
        { translation: [0, 5, 0], children: [1] },
        { mesh: 0, scale: [0.5, 0.5, 0.5] },
      ],
      scenes: [{ nodes: [0] }],
    };
    const res = inspectGlb(buildGlb(json));
    expect(res.boundsMin).toEqual([0, 5, 0]);
    expect(res.boundsMax).toEqual([1, 5.5, 1.5]);
  });

  it("rejects oversized files before parsing", () => {
    const over = new Uint8Array(50 * 1024 * 1024 + 1);
    expect(() => inspectGlb(over)).toThrowError(/limit/);
  });
});
