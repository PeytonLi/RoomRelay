import { describe, expect, it } from "vitest";
import { GlbError, inspectGlb } from "./inspectGlb";

/** Build a minimal GLB in-memory: one JSON chunk plus an optional BIN chunk. */
function buildGlb(json: unknown, bin?: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const padded = new Uint8Array(jsonBytes.length + jsonPad);
  padded.set(jsonBytes);
  padded.fill(0x20, jsonBytes.length);
  jsonBytes = padded;

  const binChunk = bin ?? new Uint8Array(0);
  const binPad = (4 - (binChunk.length % 4)) % 4;
  const binLen = bin ? binChunk.length + binPad : 0;
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (bin) {
    const off = 20 + jsonBytes.length;
    dv.setUint32(off, binLen, true);
    dv.setUint32(off + 4, 0x004e4942, true);
    out.set(binChunk, off + 8);
  }
  return out;
}

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
