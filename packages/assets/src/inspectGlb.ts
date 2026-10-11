import { sha256Hex } from "./sha256";

export const MAX_GLB_BYTES = 50 * 1024 * 1024; // C-05 intake budget
const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export class GlbError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GlbError";
  }
}

export interface GlbInspection {
  bytes: number;
  sha256: string;
  triangleCount: number;
  textureCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  extensionsRequired: string[];
}

type Mat4 = number[];

function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

function trs(node: Record<string, unknown>): Mat4 {
  if (Array.isArray(node.matrix)) {
    const m = node.matrix as number[];
    if (m.length !== 16 || !m.every(Number.isFinite)) throw new GlbError("INVALID_NODE", "node.matrix must be 16 finite numbers");
    return m.slice();
  }
  const t = (node.translation as number[] | undefined) ?? [0, 0, 0];
  const r = (node.rotation as number[] | undefined) ?? [0, 0, 0, 1];
  const s = (node.scale as number[] | undefined) ?? [1, 1, 1];
  const [qx, qy, qz, qw] = r as [number, number, number, number];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  // Column-major rotation*scale + translation (glTF column-major matrices).
  return [
    (1 - (yy + zz)) * s[0]!, (xy + wz) * s[0]!, (xz - wy) * s[0]!, 0,
    (xy - wz) * s[1]!, (1 - (xx + zz)) * s[1]!, (yz + wx) * s[1]!, 0,
    (xz + wy) * s[2]!, (yz - wx) * s[2]!, (1 - (xx + yy)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

function xform(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

interface GltfAccessor {
  count?: number;
  min?: number[];
  max?: number[];
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: Record<string, unknown>[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: GltfAccessor[];
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
  textures?: unknown[];
  extensionsRequired?: string[];
}

/**
 * Parse and inspect a self-contained GLB. Rejects bad magic/version/length,
 * truncated chunks, files over 50MB, and any external URI on buffers or
 * images (data:, http:, or relative — embedded only for now).
 */
export function inspectGlb(bytes: Uint8Array): GlbInspection {
  if (bytes.byteLength > MAX_GLB_BYTES) {
    throw new GlbError("TOO_LARGE", `GLB is ${bytes.byteLength} bytes; limit is ${MAX_GLB_BYTES}`);
  }
  if (bytes.byteLength < 20) throw new GlbError("TRUNCATED", "file too small for a GLB header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new GlbError("BAD_MAGIC", "not a GLB (bad magic)");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new GlbError("BAD_VERSION", `unsupported GLB version ${version}`);
  const declared = dv.getUint32(8, true);
  if (declared !== bytes.byteLength) {
    throw new GlbError("BAD_LENGTH", `header length ${declared} != actual ${bytes.byteLength}`);
  }

  // Chunk 0 must be JSON.
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new GlbError("BAD_CHUNK", "first chunk is not JSON");
  if (12 + 8 + jsonLen > bytes.byteLength) throw new GlbError("TRUNCATED", "JSON chunk overruns file");
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as GltfJson;
  } catch {
    throw new GlbError("BAD_JSON", "GLB JSON chunk is not valid JSON");
  }
  // Remaining chunks must fit inside the file.
  let off = 20 + jsonLen;
  while (off < bytes.byteLength) {
    if (off + 8 > bytes.byteLength) throw new GlbError("TRUNCATED", "chunk header overruns file");
    const len = dv.getUint32(off, true);
    if (off + 8 + len > bytes.byteLength) throw new GlbError("TRUNCATED", "chunk body overruns file");
    off += 8 + len;
  }

  // Embedded-only policy (A-07: no remote/external references).
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (b.uri !== undefined) {
      throw new GlbError("EXTERNAL_URI", `buffers[${i}] references external data (${b.uri.slice(0, 32)}...)`);
    }
  }
  for (const [i, im] of (json.images ?? []).entries()) {
    if (im.uri !== undefined) {
      throw new GlbError("EXTERNAL_URI", `images[${i}] references external data (${im.uri.slice(0, 32)}...)`);
    }
  }

  // World-space AABB from POSITION accessor min/max through the node graph.
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;
  const accessors = json.accessors ?? [];
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i);
  const visited = new Set<number>();

  const walk = (nodeIdx: number, parent: Mat4) => {
    if (visited.has(nodeIdx)) return;
    visited.add(nodeIdx);
    const node = nodes[nodeIdx];
    if (!node) return;
    const world = mul(parent, trs(node));
    const meshIdx = node.mesh as number | undefined;
    if (meshIdx !== undefined) {
      for (const prim of json.meshes?.[meshIdx]?.primitives ?? []) {
        const posIdx = prim.attributes?.["POSITION"];
        const mode = prim.mode ?? 4;
        if (posIdx !== undefined) {
          const acc = accessors[posIdx];
          if (acc?.min && acc?.max && acc.min.length >= 3 && acc.max.length >= 3) {
            // Transform all 8 accessor-AABB corners to world space.
            for (const xi of [0, 1]) for (const yi of [0, 1]) for (const zi of [0, 1]) {
              const p = xform(world, [acc.min[0]! + (acc.max[0]! - acc.min[0]!) * xi, acc.min[1]! + (acc.max[1]! - acc.min[1]!) * yi, acc.min[2]! + (acc.max[2]! - acc.min[2]!) * zi]);
              for (let k = 0; k < 3; k++) {
                if (p[k]! < min[k]!) min[k] = p[k]!;
                if (p[k]! > max[k]!) max[k] = p[k]!;
              }
            }
          }
          if (mode === 4) {
            if (prim.indices !== undefined) {
              triangleCount += Math.floor((accessors[prim.indices]?.count ?? 0) / 3);
            } else {
              triangleCount += Math.floor((acc?.count ?? 0) / 3);
            }
          }
        } else if (mode === 4 && prim.indices !== undefined) {
          triangleCount += Math.floor((accessors[prim.indices]?.count ?? 0) / 3);
        }
      }
    }
    for (const child of (node.children as number[] | undefined) ?? []) walk(child, world);
  };
  for (const r of roots) walk(r, identity());

  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }

  return {
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    triangleCount,
    textureCount: (json.textures ?? []).length,
    boundsMin: min,
    boundsMax: max,
    extensionsRequired: [...(json.extensionsRequired ?? [])],
  };
}

export { CHUNK_BIN };
