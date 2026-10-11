const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export interface RawChunk {
  type: number;
  bytes: Uint8Array;
  declaredLength?: number;
}

export interface BuildGlbOptions {
  jsonBytes?: Uint8Array;
  jsonDeclaredLength?: number;
  declaredFileLength?: number;
  jsonChunkType?: number;
  chunks?: RawChunk[];
}

type NonEmpty<T> = [T, ...T[]];
type FixtureJson = Record<string, unknown> & {
  asset: Record<string, unknown> & { version: string };
  buffers: NonEmpty<Record<string, unknown> & { byteLength?: number; uri?: string }>;
  bufferViews: NonEmpty<Record<string, unknown> & { buffer: number; byteOffset: number; byteLength: number }>;
  images: NonEmpty<Record<string, unknown> & { bufferView?: number; uri?: string; mimeType?: string }>;
  materials: NonEmpty<Record<string, unknown> & {
    pbrMetallicRoughness: Record<string, unknown> & {
      baseColorTexture: Record<string, unknown> & { index: number };
    };
  }>;
  textures: NonEmpty<Record<string, unknown> & { source: number }>;
  meshes: NonEmpty<Record<string, unknown> & {
    primitives: NonEmpty<Record<string, unknown> & {
      attributes: Record<string, number>;
      indices: number;
      material: number;
      mode?: number;
    }>;
  }>;
  accessors: NonEmpty<Record<string, unknown> & {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }>;
  nodes: NonEmpty<Record<string, unknown> & { mesh?: number; children?: number[] }>;
};

export interface ValidGlbOptions {
  width?: number;
  height?: number;
  imageFormat?: "png" | "jpeg";
  imageMimeType?: string;
  mutateJson?: (json: FixtureJson) => void;
}

export function buildGlb(
  json: unknown,
  bin?: Uint8Array,
  options: BuildGlbOptions = {},
): Uint8Array {
  const encoder = new TextEncoder();
  let jsonBytes = options.jsonBytes ?? encoder.encode(JSON.stringify(json));
  if (!options.jsonBytes) {
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const padded = new Uint8Array(jsonBytes.length + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length);
    jsonBytes = padded;
  }
  const chunks: RawChunk[] = [];
  if (bin !== undefined) {
    const binPad = (4 - (bin.length % 4)) % 4;
    const padded = new Uint8Array(bin.length + binPad);
    padded.set(bin);
    chunks.push({ type: BIN_CHUNK, bytes: padded });
  }
  chunks.push(...(options.chunks ?? []));

  const total = 12 + 8 + jsonBytes.length + chunks.reduce((size, chunk) => size + 8 + chunk.bytes.length, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, options.declaredFileLength ?? total, true);
  view.setUint32(12, options.jsonDeclaredLength ?? jsonBytes.length, true);
  view.setUint32(16, options.jsonChunkType ?? JSON_CHUNK, true);
  output.set(jsonBytes, 20);

  let offset = 20 + jsonBytes.length;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.declaredLength ?? chunk.bytes.length, true);
    view.setUint32(offset + 4, chunk.type, true);
    output.set(chunk.bytes, offset + 8);
    offset += 8 + chunk.bytes.length;
  }
  return output;
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
}

export function validGlb(options: ValidGlbOptions = {}): Uint8Array {
  const width = options.width ?? 128;
  const height = options.height ?? 96;
  const imageFormat = options.imageFormat ?? "png";
  const image = imageFormat === "png" ? pngHeader(width, height) : jpegHeader(width, height);
  const imageOffset = 44;
  const binary = new Uint8Array(imageOffset + image.length);
  const binaryView = new DataView(binary.buffer);
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 1,
  ];
  positions.forEach((value, index) => binaryView.setFloat32(index * 4, value, true));
  [0, 1, 2].forEach((value, index) => binaryView.setUint16(36 + index * 2, value, true));
  binary.set(image, imageOffset);

  const json: FixtureJson = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        material: 0,
      }],
    }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{
      bufferView: 2,
      mimeType: options.imageMimeType ?? (imageFormat === "png" ? "image/png" : "image/jpeg"),
    }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: imageOffset, byteLength: image.length },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
  };
  options.mutateJson?.(json);
  return buildGlb(json, binary);
}
