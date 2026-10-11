import { MAX_GLB_BYTES } from "./inspectGlb";
import { readImageHeader } from "./imageHeaders";

export type GlbValidationStatus = "OK" | "NEEDS_REVIEW" | "REJECTED";
export type IssueSeverity = "ERROR" | "WARNING" | "INFO";
export type GlbIssueCode =
  | "TOO_LARGE"
  | "TRUNCATED"
  | "BAD_MAGIC"
  | "BAD_VERSION"
  | "BAD_LENGTH"
  | "BAD_CHUNK_LAYOUT"
  | "BAD_CHUNK_ALIGNMENT"
  | "JSON_TOO_LARGE"
  | "BAD_JSON"
  | "UNSAFE_JSON_KEY"
  | "JSON_LIMIT"
  | "BAD_ASSET_VERSION"
  | "PATH_TRAVERSAL"
  | "EXTERNAL_URI"
  | "DATA_URI_INVALID"
  | "DATA_URI_TOO_LARGE"
  | "DATA_URI_EMBEDDED"
  | "MISSING_BIN_CHUNK"
  | "BUFFER_RANGE"
  | "DANGLING_INDEX"
  | "BUFFER_VIEW_RANGE"
  | "ACCESSOR_RANGE"
  | "INVALID_ACCESSOR"
  | "MISSING_TEXTURE"
  | "MISSING_IMAGE"
  | "NODE_GRAPH_INVALID"
  | "INVALID_PRIMITIVE"
  | "TRIANGLES_OVER_BUDGET"
  | "IMAGE_SIGNATURE_MISMATCH"
  | "IMAGE_HEADER_INVALID"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "TEXTURE_TOO_LARGE"
  | "TEXTURE_OVER_2K"
  | "TEXTURE_MEMORY_EXCEEDED"
  | "EXTENSION_NOT_DECLARED"
  | "REQUIRED_COMPRESSION_UNSUPPORTED"
  | "REQUIRED_EXTENSION_UNSUPPORTED"
  | "UNKNOWN_CHUNK"
  | "INTERNAL_ERROR";

export interface GlbIssue {
  code: GlbIssueCode;
  severity: IssueSeverity;
  message: string;
  path: string;
}

export interface GlbLimits {
  maxBytes: number;
  maxJsonBytes: number;
  maxDataUriBytes: number;
  maxArrayLength: number;
  maxNodeDepth: number;
  reviewTextureDimension: number;
  maxTextureDimension: number;
  maxDecodedTextureBytes: number;
  reviewTriangleCount: number;
}

export const DEFAULT_GLB_LIMITS: GlbLimits = {
  maxBytes: MAX_GLB_BYTES,
  maxJsonBytes: 8 * 1024 * 1024,
  maxDataUriBytes: 1024 * 1024,
  maxArrayLength: 100_000,
  maxNodeDepth: 256,
  reviewTextureDimension: 2048,
  maxTextureDimension: 16_384,
  maxDecodedTextureBytes: 512 * 1024 * 1024,
  reviewTriangleCount: 1_000_000,
};

export interface GlbStats {
  bytes: number;
  jsonBytes: number;
  binBytes: number;
  triangleCount: number;
  meshCount: number;
  nodeCount: number;
  accessorCount: number;
  textureCount: number;
  imageCount: number;
  maxTextureWidth: number;
  maxTextureHeight: number;
  estimatedTextureBytes: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
}

export interface GlbValidationResult {
  status: GlbValidationStatus;
  issues: GlbIssue[];
  stats: GlbStats;
}

type JsonObject = Record<string, unknown>;

interface UnsafeKeyRecord {
  holder: object;
  key: string;
}

interface ParsedChunks {
  json: JsonObject;
  bin: Uint8Array | null;
  hasBin: boolean;
  dataUriBuffers: Set<number>;
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const COMPRESSION_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
  "KHR_texture_basisu",
]);
const SUPPORTED_REQUIRED_EXTENSIONS = new Set([
  "KHR_texture_transform",
  "KHR_mesh_quantization",
]);
const COMPONENT_SIZES = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const TYPE_SHAPES = new Map<string, { rows: number; columns: number }>([
  ["SCALAR", { rows: 1, columns: 1 }],
  ["VEC2", { rows: 2, columns: 1 }],
  ["VEC3", { rows: 3, columns: 1 }],
  ["VEC4", { rows: 4, columns: 1 }],
  ["MAT2", { rows: 2, columns: 2 }],
  ["MAT3", { rows: 3, columns: 3 }],
  ["MAT4", { rows: 4, columns: 4 }],
]);

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getOwn(object: JsonObject, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function getIndex(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : null;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointer(parent: string, key: string | number): string {
  return `${parent}/${escapePointer(String(key))}`;
}

function emptyStats(byteLength: number): GlbStats {
  return {
    bytes: byteLength,
    jsonBytes: 0,
    binBytes: 0,
    triangleCount: 0,
    meshCount: 0,
    nodeCount: 0,
    accessorCount: 0,
    textureCount: 0,
    imageCount: 0,
    maxTextureWidth: 0,
    maxTextureHeight: 0,
    estimatedTextureBytes: 0,
    extensionsUsed: [],
    extensionsRequired: [],
  };
}

function objectPath(root: unknown, target: object): string | null {
  const stack: Array<{ value: unknown; path: string }> = [{ value: root, path: "" }];
  const visited = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === target) return current.path;
    if (current.value === null || typeof current.value !== "object" || visited.has(current.value)) continue;
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({ value: current.value[index], path: pointer(current.path, index) });
      }
    } else {
      const object = current.value as JsonObject;
      const keys = Object.keys(object);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        stack.push({ value: object[key], path: pointer(current.path, key) });
      }
    }
  }

  return null;
}

function dataUriInfo(uri: string): { mimeType: string; payload: string } | null {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(uri);
  if (!match) return null;
  return { mimeType: match[1]!, payload: uri.slice(match[0].length) };
}

function decodedBase64Size(payload: string): number {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function decodeBase64Prefix(payload: string, maxChars = 64): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index++) lookup[alphabet.charCodeAt(index)] = index;

  const chars = payload.slice(0, maxChars);
  const output: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < chars.length; index++) {
    const code = chars.charCodeAt(index);
    if (code === 0x3d) break;
    const value = code < lookup.length ? lookup[code]! : -1;
    if (value < 0) break;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

function uriHasTraversal(uri: string): boolean {
  const decodedDots = uri.replace(/%2e/gi, ".");
  return (
    decodedDots.includes("..") ||
    uri.includes("\\") ||
    uri.startsWith("/") ||
    /(?:^|\/)[a-z]:/i.test(uri)
  );
}

function componentByteSize(componentType: unknown, type: unknown): number | null {
  if (typeof componentType !== "number" || typeof type !== "string") return null;
  const componentSize = COMPONENT_SIZES.get(componentType);
  const shape = TYPE_SHAPES.get(type);
  if (componentSize === undefined || shape === undefined) return null;
  if (shape.columns > 1 && componentSize < 4) {
    return shape.columns * Math.ceil((shape.rows * componentSize) / 4) * 4;
  }
  return shape.rows * shape.columns * componentSize;
}

function parseChunks(
  bytes: Uint8Array,
  view: DataView,
  limits: GlbLimits,
  add: (code: GlbIssueCode, severity: IssueSeverity, path: string, message: string) => void,
  stats: GlbStats,
): ParsedChunks | null {
  let offset = 12;
  let chunkIndex = 0;
  let jsonBytes: Uint8Array | null = null;
  let bin: Uint8Array | null = null;
  let hasBin = false;

  while (offset < bytes.byteLength) {
    const chunkPath = `chunk[${chunkIndex}]`;
    if (offset + 8 > bytes.byteLength) {
      add("TRUNCATED", "ERROR", chunkPath, "chunk header overruns the file");
      return null;
    }

    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkLength;

    if (chunkIndex === 0) {
      if (chunkType !== JSON_CHUNK) {
        add("BAD_CHUNK_LAYOUT", "ERROR", chunkPath, "the first GLB chunk must be JSON");
        return null;
      }
      if (chunkLength % 4 !== 0) {
        add("BAD_CHUNK_ALIGNMENT", "ERROR", chunkPath, "JSON chunk length must be a multiple of four");
        return null;
      }
      if (chunkLength > limits.maxJsonBytes) {
        add("JSON_TOO_LARGE", "ERROR", chunkPath, "JSON chunk exceeds the configured byte limit");
        return null;
      }
      if (bodyEnd > bytes.byteLength) {
        add("TRUNCATED", "ERROR", chunkPath, "JSON chunk overruns the file");
        return null;
      }
      jsonBytes = bytes.subarray(bodyStart, bodyEnd);
      stats.jsonBytes = chunkLength;
    } else if (chunkType === JSON_CHUNK) {
      add("BAD_CHUNK_LAYOUT", "ERROR", chunkPath, "GLB must contain exactly one JSON chunk");
      return null;
    } else if (chunkType === BIN_CHUNK) {
      if (hasBin || chunkIndex !== 1) {
        add("BAD_CHUNK_LAYOUT", "ERROR", chunkPath, "BIN must appear once immediately after JSON");
        return null;
      }
      if (bodyEnd > bytes.byteLength) {
        add("TRUNCATED", "ERROR", chunkPath, "BIN chunk overruns the file");
        return null;
      }
      bin = bytes.subarray(bodyStart, bodyEnd);
      stats.binBytes = chunkLength;
      hasBin = true;
    } else {
      if (bodyEnd > bytes.byteLength) {
        add("TRUNCATED", "ERROR", chunkPath, "chunk body overruns the file");
        return null;
      }
      add("UNKNOWN_CHUNK", "INFO", chunkPath, "unknown GLB chunk was ignored");
    }

    offset = bodyEnd;
    chunkIndex++;
  }

  if (jsonBytes === null) {
    add("TRUNCATED", "ERROR", "header", "GLB does not contain a JSON chunk");
    return null;
  }

  let jsonText: string;
  try {
    jsonText = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    add("BAD_JSON", "ERROR", "chunk[0]", "JSON chunk is not valid UTF-8");
    return null;
  }

  const unsafeKeys: UnsafeKeyRecord[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText, function (this: unknown, key: string, value: unknown) {
      if (UNSAFE_KEYS.has(key)) {
        if (this !== null && typeof this === "object") unsafeKeys.push({ holder: this, key });
        return undefined;
      }
      return value;
    }) as unknown;
  } catch {
    add("BAD_JSON", "ERROR", "chunk[0]", "GLB JSON chunk is not valid JSON");
    return null;
  }

  if (!isObject(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    add("BAD_JSON", "ERROR", "chunk[0]", "top-level glTF JSON value must be a plain object");
    return null;
  }
  for (const unsafe of unsafeKeys) {
    const holderPath = objectPath(parsed, unsafe.holder);
    add(
      "UNSAFE_JSON_KEY",
      "ERROR",
      pointer(holderPath ?? "", unsafe.key),
      "unsafe JSON property was dropped",
    );
  }

  const buffers = getArray(getOwn(parsed, "buffers"));
  const dataUriBuffers = new Set<number>();
  for (let index = 0; index < buffers.length; index++) {
    const buffer = getObject(buffers[index]);
    const uri = buffer && getOwn(buffer, "uri");
    if (uri !== undefined && typeof uri !== "string") {
      add("DATA_URI_INVALID", "ERROR", pointer(`/buffers/${index}`, "uri"), "buffer URI must be a string");
      continue;
    }
    if (typeof uri !== "string") continue;

    if (!uri.startsWith("data:")) {
      add(
        uriHasTraversal(uri) ? "PATH_TRAVERSAL" : "EXTERNAL_URI",
        "ERROR",
        pointer(`/buffers/${index}`, "uri"),
        "buffer URI must not reference an external resource",
      );
      continue;
    }
    const data = dataUriInfo(uri);
    if (!data) {
      add("DATA_URI_INVALID", "ERROR", pointer(`/buffers/${index}`, "uri"), "data URI must be base64 encoded");
      continue;
    }
    dataUriBuffers.add(index);
    if (decodedBase64Size(data.payload) > limits.maxDataUriBytes) {
      add("DATA_URI_TOO_LARGE", "ERROR", pointer(`/buffers/${index}`, "uri"), "decoded data URI exceeds the configured limit");
    } else {
      add("DATA_URI_EMBEDDED", "WARNING", pointer(`/buffers/${index}`, "uri"), "embedded data URI requires review");
    }
  }

  return { json: parsed, bin, hasBin, dataUriBuffers };
}

function validateReferences(
  json: JsonObject,
  add: (code: GlbIssueCode, severity: IssueSeverity, path: string, message: string) => void,
  limits: GlbLimits,
  stats: GlbStats,
): void {
  const scenes = getArray(getOwn(json, "scenes"));
  const nodes = getArray(getOwn(json, "nodes"));
  const meshes = getArray(getOwn(json, "meshes"));
  const accessors = getArray(getOwn(json, "accessors"));
  const materials = getArray(getOwn(json, "materials"));
  const textures = getArray(getOwn(json, "textures"));
  const images = getArray(getOwn(json, "images"));
  const samplers = getArray(getOwn(json, "samplers"));
  const skins = getArray(getOwn(json, "skins"));
  const animations = getArray(getOwn(json, "animations"));
  const buffers = getArray(getOwn(json, "buffers"));
  const bufferViews = getArray(getOwn(json, "bufferViews"));

  const checkReference = (
    value: unknown,
    target: unknown[],
    path: string,
    code: GlbIssueCode = "DANGLING_INDEX",
  ): number | null => {
    const index = getIndex(value);
    if (index === null || index >= target.length) {
      add(code, "ERROR", path, "reference does not resolve to an existing array entry");
      return null;
    }
    return index;
  };

  const selectedScene = getOwn(json, "scene");
  if (selectedScene !== undefined) checkReference(selectedScene, scenes, "/scene");
  for (let index = 0; index < scenes.length; index++) {
    const scene = getObject(scenes[index]);
    for (const [nodeIndex, node] of getArray(scene && getOwn(scene, "nodes")).entries()) {
      checkReference(node, nodes, `/scenes/${index}/nodes/${nodeIndex}`);
    }
  }

  const parentCounts = new Array<number>(nodes.length).fill(0);
  for (let index = 0; index < nodes.length; index++) {
    const node = getObject(nodes[index]);
    if (!node) continue;
    for (const key of ["mesh", "skin", "camera"] as const) {
      const value = getOwn(node, key);
      if (value !== undefined) {
        checkReference(value, key === "mesh" ? meshes : key === "skin" ? skins : getArray(getOwn(json, "cameras")), pointer(`/nodes/${index}`, key));
      }
    }
    for (const [childIndex, child] of getArray(getOwn(node, "children")).entries()) {
      const resolved = checkReference(child, nodes, `/nodes/${index}/children/${childIndex}`);
      if (resolved !== null) parentCounts[resolved] = parentCounts[resolved]! + 1;
    }
  }
  for (let index = 0; index < parentCounts.length; index++) {
    if (parentCounts[index]! > 1) {
      add("NODE_GRAPH_INVALID", "ERROR", `/nodes/${index}`, "node has more than one parent");
    }
  }

  let cycleReported = false;
  let depthReported = false;
  const colors = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start++) {
    if (colors[start] !== 0) continue;
    const stack: Array<{ index: number; depth: number; childIndex: number }> = [
      { index: start, depth: 1, childIndex: 0 },
    ];
    colors[start] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.depth > limits.maxNodeDepth && !depthReported) {
        add("JSON_LIMIT", "ERROR", `/nodes/${frame.index}`, "node graph exceeds the configured depth limit");
        depthReported = true;
      }
      const node = getObject(nodes[frame.index]);
      const children = getArray(node && getOwn(node, "children"));
      if (frame.childIndex >= children.length) {
        colors[frame.index] = 2;
        stack.pop();
        continue;
      }
      const childPosition = frame.childIndex++;
      const child = getIndex(children[childPosition]);
      if (child === null || child >= nodes.length) continue;
      if (colors[child] === 1) {
        if (!cycleReported) {
          add("NODE_GRAPH_INVALID", "ERROR", `/nodes/${frame.index}/children/${childPosition}`, "node graph contains a cycle");
          cycleReported = true;
        }
      } else if (colors[child] === 0) {
        colors[child] = 1;
        stack.push({ index: child, depth: frame.depth + 1, childIndex: 0 });
      }
    }
  }

  for (let index = 0; index < meshes.length; index++) {
    const mesh = getObject(meshes[index]);
    for (const [primitiveIndex, primitiveValue] of getArray(mesh && getOwn(mesh, "primitives")).entries()) {
      const primitive = getObject(primitiveValue);
      if (!primitive) continue;
      const primitivePath = `/meshes/${index}/primitives/${primitiveIndex}`;
      const modeValue = getOwn(primitive, "mode");
      const mode = modeValue === undefined ? 4 : modeValue;
      if (!Number.isInteger(mode) || typeof mode !== "number" || mode < 0 || mode > 6) {
        add("INVALID_PRIMITIVE", "ERROR", pointer(primitivePath, "mode"), "primitive mode must be an integer from zero through six");
      }
      const attributes = getObject(getOwn(primitive, "attributes"));
      let positionIndex: number | null = null;
      if (attributes) {
        for (const [name, value] of Object.entries(attributes)) {
          const resolved = checkReference(value, accessors, pointer(`${primitivePath}/attributes`, name));
          if (name === "POSITION") positionIndex = resolved;
        }
      }
      const indexValue = getOwn(primitive, "indices");
      const indicesIndex = indexValue === undefined
        ? null
        : checkReference(indexValue, accessors, pointer(primitivePath, "indices"));
      const materialValue = getOwn(primitive, "material");
      if (materialValue !== undefined) checkReference(materialValue, materials, pointer(primitivePath, "material"));
      for (const [targetIndex, targetValue] of getArray(getOwn(primitive, "targets")).entries()) {
        const target = getObject(targetValue);
        if (!target) continue;
        for (const [name, value] of Object.entries(target)) {
          checkReference(value, accessors, `/meshes/${index}/primitives/${primitiveIndex}/targets/${targetIndex}/${escapePointer(name)}`);
        }
      }

      if (typeof mode === "number" && Number.isInteger(mode) && mode >= 4 && mode <= 6) {
        const countSource = indicesIndex !== null
          ? getObject(accessors[indicesIndex])
          : positionIndex !== null
            ? getObject(accessors[positionIndex])
            : null;
        const count = getOwn(countSource ?? {}, "count");
        if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
          stats.triangleCount += mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
        }
      }
    }
  }

  for (let index = 0; index < materials.length; index++) {
    const material = getObject(materials[index]);
    if (!material) continue;
    const pbr = getObject(getOwn(material, "pbrMetallicRoughness"));
    const textureRefs = [
      ["pbrMetallicRoughness/baseColorTexture", pbr && getOwn(pbr, "baseColorTexture")],
      ["pbrMetallicRoughness/metallicRoughnessTexture", pbr && getOwn(pbr, "metallicRoughnessTexture")],
      ["normalTexture", getOwn(material, "normalTexture")],
      ["occlusionTexture", getOwn(material, "occlusionTexture")],
      ["emissiveTexture", getOwn(material, "emissiveTexture")],
    ] as const;
    for (const [path, value] of textureRefs) {
      const textureInfo = getObject(value);
      if (textureInfo && getOwn(textureInfo, "index") !== undefined) {
        checkReference(getOwn(textureInfo, "index"), textures, `/materials/${index}/${path}`, "MISSING_TEXTURE");
      }
    }
  }

  for (let index = 0; index < textures.length; index++) {
    const texture = getObject(textures[index]);
    if (!texture) continue;
    const source = getOwn(texture, "source");
    if (source !== undefined) checkReference(source, images, `/textures/${index}/source`, "MISSING_IMAGE");
    const sampler = getOwn(texture, "sampler");
    if (sampler !== undefined) checkReference(sampler, samplers, `/textures/${index}/sampler`);
    const extensions = getObject(getOwn(texture, "extensions"));
    for (const extension of ["EXT_texture_webp", "KHR_texture_basisu"]) {
      const sourceValue = getObject(extensions && getOwn(extensions, extension));
      const extensionSource = sourceValue ? getOwn(sourceValue, "source") : undefined;
      if (extensionSource !== undefined) {
        checkReference(extensionSource, images, `/textures/${index}/extensions/${extension}/source`, "MISSING_IMAGE");
      }
    }
  }

  for (let index = 0; index < bufferViews.length; index++) {
    const bufferView = getObject(bufferViews[index]);
    if (!bufferView) continue;
    const bufferIndex = checkReference(
      getOwn(bufferView, "buffer"),
      buffers,
      `/bufferViews/${index}/buffer`,
    );
    const offsetValue = getOwn(bufferView, "byteOffset");
    const byteOffset = offsetValue === undefined ? 0 : offsetValue;
    const byteLength = getOwn(bufferView, "byteLength");
    const buffer = bufferIndex === null ? null : getObject(buffers[bufferIndex]);
    const bufferLength = buffer && getOwn(buffer, "byteLength");
    if (
      bufferIndex !== null &&
      (!Number.isInteger(byteOffset) ||
        typeof byteOffset !== "number" ||
        byteOffset < 0 ||
        !Number.isInteger(byteLength) ||
        typeof byteLength !== "number" ||
        byteLength < 0 ||
        !Number.isInteger(bufferLength) ||
        typeof bufferLength !== "number" ||
        byteOffset + byteLength > bufferLength)
    ) {
      add("BUFFER_VIEW_RANGE", "ERROR", `/bufferViews/${index}`, "bufferView range exceeds its buffer");
    }
    const stride = getOwn(bufferView, "byteStride");
    if (
      stride !== undefined &&
      (typeof stride !== "number" || !Number.isInteger(stride) || stride < 4 || stride > 252 || stride % 4 !== 0)
    ) {
      add("BUFFER_VIEW_RANGE", "ERROR", `/bufferViews/${index}/byteStride`, "byteStride must be a multiple of four from four through 252");
    }
  }

  for (let index = 0; index < accessors.length; index++) {
    const accessor = getObject(accessors[index]);
    if (!accessor) continue;
    const componentType = getOwn(accessor, "componentType");
    const type = getOwn(accessor, "type");
    const count = getOwn(accessor, "count");
    const componentSize = typeof componentType === "number" ? COMPONENT_SIZES.get(componentType) : undefined;
    const shape = typeof type === "string" ? TYPE_SHAPES.get(type) : undefined;
    if (
      componentSize === undefined ||
      shape === undefined ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      add("INVALID_ACCESSOR", "ERROR", `/accessors/${index}`, "accessor componentType, type, or count is invalid");
    }

    const bufferViewValue = getOwn(accessor, "bufferView");
    let bufferViewIndex: number | null = null;
    if (bufferViewValue !== undefined) {
      bufferViewIndex = checkReference(bufferViewValue, bufferViews, `/accessors/${index}/bufferView`);
    }
    const sparse = getObject(getOwn(accessor, "sparse"));
    if (sparse) {
      const indices = getObject(getOwn(sparse, "indices"));
      const values = getObject(getOwn(sparse, "values"));
      if (indices) checkReference(getOwn(indices, "bufferView"), bufferViews, `/accessors/${index}/sparse/indices/bufferView`);
      if (values) checkReference(getOwn(values, "bufferView"), bufferViews, `/accessors/${index}/sparse/values/bufferView`);
    }

    if (bufferViewIndex !== null && componentSize !== undefined && shape !== undefined &&
      typeof count === "number" && Number.isInteger(count) && count > 0) {
      const view = getObject(bufferViews[bufferViewIndex]);
      const viewLength = view && getOwn(view, "byteLength");
      const byteOffsetValue = getOwn(accessor, "byteOffset");
      const byteOffset = byteOffsetValue === undefined ? 0 : byteOffsetValue;
      const elementSize = componentByteSize(componentType, type);
      const strideValue = view && getOwn(view, "byteStride");
      const stride = typeof strideValue === "number" ? strideValue : elementSize;
      if (
        elementSize === null ||
        typeof viewLength !== "number" ||
        typeof byteOffset !== "number" ||
        !Number.isInteger(byteOffset) ||
        byteOffset < 0 ||
        typeof stride !== "number" ||
        byteOffset + stride * (count - 1) + elementSize > viewLength
      ) {
        add("ACCESSOR_RANGE", "ERROR", `/accessors/${index}`, "accessor data exceeds its bufferView");
      }
    }
  }

  for (let index = 0; index < images.length; index++) {
    const image = getObject(images[index]);
    if (!image) continue;
    const bufferViewValue = getOwn(image, "bufferView");
    if (bufferViewValue !== undefined) {
      checkReference(bufferViewValue, bufferViews, `/images/${index}/bufferView`);
    }
  }

  for (let index = 0; index < skins.length; index++) {
    const skin = getObject(skins[index]);
    if (!skin) continue;
    const inverseBindMatrices = getOwn(skin, "inverseBindMatrices");
    if (inverseBindMatrices !== undefined) checkReference(inverseBindMatrices, accessors, `/skins/${index}/inverseBindMatrices`);
    for (const [jointIndex, joint] of getArray(getOwn(skin, "joints")).entries()) {
      checkReference(joint, nodes, `/skins/${index}/joints/${jointIndex}`);
    }
  }

  for (let index = 0; index < animations.length; index++) {
    const animation = getObject(animations[index]);
    if (!animation) continue;
    for (const [samplerIndex, samplerValue] of getArray(getOwn(animation, "samplers")).entries()) {
      const sampler = getObject(samplerValue);
      if (!sampler) continue;
      for (const key of ["input", "output"] as const) {
        const value = getOwn(sampler, key);
        if (value !== undefined) checkReference(value, accessors, `/animations/${index}/samplers/${samplerIndex}/${key}`);
      }
    }
    for (const [channelIndex, channelValue] of getArray(getOwn(animation, "channels")).entries()) {
      const channel = getObject(channelValue);
      if (!channel) continue;
      const sampler = getOwn(channel, "sampler");
      if (sampler !== undefined) {
        checkReference(sampler, getArray(getOwn(animation, "samplers")), `/animations/${index}/channels/${channelIndex}/sampler`);
      }
      const target = getObject(getOwn(channel, "target"));
      const node = target && getOwn(target, "node");
      if (node !== undefined) checkReference(node, nodes, `/animations/${index}/channels/${channelIndex}/target/node`);
    }
  }

  stats.meshCount = meshes.length;
  stats.nodeCount = nodes.length;
  stats.accessorCount = accessors.length;
  stats.textureCount = textures.length;
  stats.imageCount = images.length;

  const extensionStrings = (value: unknown): string[] =>
    getArray(value).filter((entry): entry is string => typeof entry === "string");
  stats.extensionsUsed = extensionStrings(getOwn(json, "extensionsUsed"));
  stats.extensionsRequired = extensionStrings(getOwn(json, "extensionsRequired"));
  const used = new Set(stats.extensionsUsed);
  for (const [index, extension] of stats.extensionsRequired.entries()) {
    if (!used.has(extension)) {
      add("EXTENSION_NOT_DECLARED", "WARNING", `/extensionsRequired/${index}`, "required extension is missing from extensionsUsed");
    }
    if (COMPRESSION_EXTENSIONS.has(extension)) {
      add("REQUIRED_COMPRESSION_UNSUPPORTED", "WARNING", `/extensionsRequired/${index}`, "required compression extension is not decoded");
    } else if (
      !SUPPORTED_REQUIRED_EXTENSIONS.has(extension) &&
      !extension.startsWith("KHR_materials_")
    ) {
      add("REQUIRED_EXTENSION_UNSUPPORTED", "WARNING", `/extensionsRequired/${index}`, "required extension is not supported");
    }
  }

  if (stats.triangleCount > limits.reviewTriangleCount) {
    add("TRIANGLES_OVER_BUDGET", "WARNING", "/meshes", "triangle count exceeds the review budget");
  }
}

function validateImages(
  json: JsonObject,
  chunks: ParsedChunks,
  limits: GlbLimits,
  add: (code: GlbIssueCode, severity: IssueSeverity, path: string, message: string) => void,
  stats: GlbStats,
): void {
  const images = getArray(getOwn(json, "images"));
  const bufferViews = getArray(getOwn(json, "bufferViews"));

  for (let index = 0; index < images.length; index++) {
    const image = getObject(images[index]);
    if (!image) continue;
    const path = `/images/${index}`;
    const uri = getOwn(image, "uri");
    let mimeType = getOwn(image, "mimeType");
    let data: ReturnType<typeof dataUriInfo> = null;
    if (uri !== undefined && typeof uri !== "string") {
      add("DATA_URI_INVALID", "ERROR", pointer(path, "uri"), "image URI must be a string");
      continue;
    }
    if (typeof uri === "string") {
      if (!uri.startsWith("data:")) {
        add(
          uriHasTraversal(uri) ? "PATH_TRAVERSAL" : "EXTERNAL_URI",
          "ERROR",
          pointer(path, "uri"),
          "image URI must not reference an external resource",
        );
        continue;
      }
      data = dataUriInfo(uri);
      if (!data) {
        add("DATA_URI_INVALID", "ERROR", pointer(path, "uri"), "data URI must be base64 encoded");
        continue;
      }
      if (typeof mimeType !== "string") mimeType = data.mimeType;
      if (decodedBase64Size(data.payload) > limits.maxDataUriBytes) {
        add("DATA_URI_TOO_LARGE", "ERROR", pointer(path, "uri"), "decoded data URI exceeds the configured limit");
        continue;
      }
      add("DATA_URI_EMBEDDED", "WARNING", pointer(path, "uri"), "embedded data URI requires review");
      if (data.mimeType.toLowerCase() !== String(mimeType).toLowerCase()) {
        add("IMAGE_SIGNATURE_MISMATCH", "ERROR", pointer(path, "uri"), "data URI MIME type does not match image mimeType");
      }
    }
    if (typeof mimeType !== "string" || !["image/png", "image/jpeg"].includes(mimeType)) {
      add("IMAGE_FORMAT_UNSUPPORTED", "WARNING", pointer(path, "mimeType"), "image format cannot be inspected");
      continue;
    }

    let header: ReturnType<typeof readImageHeader> = null;
    let unavailableFromDataBuffer = false;
    if (data) {
      header = readImageHeader(decodeBase64Prefix(data.payload));
    } else if (getOwn(image, "bufferView") !== undefined) {
      const bufferViewIndex = getIndex(getOwn(image, "bufferView"));
      const bufferView = bufferViewIndex === null ? null : getObject(bufferViews[bufferViewIndex]);
      if (bufferView) {
        const bufferIndex = getIndex(getOwn(bufferView, "buffer"));
        if (
          bufferIndex !== null &&
          chunks.bin !== null &&
          bufferIndex === 0 &&
          !chunks.dataUriBuffers.has(bufferIndex)
        ) {
          const offsetValue = getOwn(bufferView, "byteOffset");
          const lengthValue = getOwn(bufferView, "byteLength");
          const offset = offsetValue === undefined ? 0 : offsetValue;
          if (
            typeof offset === "number" &&
            Number.isInteger(offset) &&
            typeof lengthValue === "number" &&
            Number.isInteger(lengthValue) &&
            offset >= 0 &&
            lengthValue >= 0 &&
            offset + lengthValue <= chunks.bin.byteLength
          ) {
            header = readImageHeader(chunks.bin.subarray(offset, offset + lengthValue));
          }
        } else if (bufferIndex !== null && chunks.dataUriBuffers.has(bufferIndex)) {
          unavailableFromDataBuffer = true;
        }
      }
    }

    if (unavailableFromDataBuffer) continue;
    if (header === null) {
      add("IMAGE_HEADER_INVALID", "ERROR", path, "image dimensions could not be read from its header");
      continue;
    }

    const expectedFormat = mimeType === "image/png" ? "png" : "jpeg";
    if (header.format !== expectedFormat) {
      add("IMAGE_SIGNATURE_MISMATCH", "ERROR", path, "image header does not match its mimeType");
    }
    stats.maxTextureWidth = Math.max(stats.maxTextureWidth, header.width);
    stats.maxTextureHeight = Math.max(stats.maxTextureHeight, header.height);
    stats.estimatedTextureBytes += header.width * header.height * 4;
    if (
      header.width === 0 ||
      header.height === 0 ||
      header.width > limits.maxTextureDimension ||
      header.height > limits.maxTextureDimension
    ) {
      add("TEXTURE_TOO_LARGE", "ERROR", path, "texture dimensions are zero or exceed the maximum");
    }
    if (header.width > limits.reviewTextureDimension || header.height > limits.reviewTextureDimension) {
      add("TEXTURE_OVER_2K", "WARNING", path, "texture exceeds the review dimension");
    }
  }

  if (stats.estimatedTextureBytes > limits.maxDecodedTextureBytes) {
    add("TEXTURE_MEMORY_EXCEEDED", "ERROR", "/images", "decoded texture memory exceeds the configured limit");
  }
}

export function validateGlb(
  bytes: Uint8Array,
  limitOverrides?: Partial<GlbLimits>,
): GlbValidationResult {
  let limits = DEFAULT_GLB_LIMITS;
  const stats = emptyStats(bytes instanceof Uint8Array ? bytes.byteLength : 0);
  const issues: GlbIssue[] = [];
  const add = (
    code: GlbIssueCode,
    severity: IssueSeverity,
    path: string,
    message: string,
  ) => issues.push({ code, severity, message, path });
  const finish = (): GlbValidationResult => ({
    status: issues.some((issue) => issue.severity === "ERROR")
      ? "REJECTED"
      : issues.some((issue) => issue.severity === "WARNING")
        ? "NEEDS_REVIEW"
        : "OK",
    issues,
    stats,
  });

  try {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
    limits = { ...DEFAULT_GLB_LIMITS, ...limitOverrides };
    if (bytes.byteLength > limits.maxBytes) {
      add("TOO_LARGE", "ERROR", "header", "GLB exceeds the configured byte limit");
      return finish();
    }
    if (bytes.byteLength < 12) {
      add("TRUNCATED", "ERROR", "header", "GLB header is truncated");
      return finish();
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
      add("BAD_MAGIC", "ERROR", "header", "GLB magic is invalid");
      return finish();
    }
    if (view.getUint32(4, true) !== 2) {
      add("BAD_VERSION", "ERROR", "header", "GLB version must be two");
      return finish();
    }
    if (view.getUint32(8, true) !== bytes.byteLength) {
      add("BAD_LENGTH", "ERROR", "header", "declared GLB length does not match actual length");
      return finish();
    }

    const chunks = parseChunks(bytes, view, limits, add, stats);
    if (!chunks) return finish();

    const root = chunks.json;
    for (const [key, value] of Object.entries(root)) {
      if (Array.isArray(value) && value.length > limits.maxArrayLength) {
        add("JSON_LIMIT", "ERROR", pointer("", key), "top-level array exceeds the configured entry limit");
        return finish();
      }
    }

    const asset = getObject(getOwn(root, "asset"));
    const version = asset && getOwn(asset, "version");
    if (typeof version !== "string" || !version.startsWith("2.")) {
      add("BAD_ASSET_VERSION", "ERROR", "/asset/version", "asset.version must be a glTF 2.x string");
    }

    const buffers = getArray(getOwn(root, "buffers"));
    for (let index = 0; index < buffers.length; index++) {
      const buffer = getObject(buffers[index]);
      if (!buffer) continue;
      const uri = getOwn(buffer, "uri");
      if (uri !== undefined) continue;
      const byteLength = getOwn(buffer, "byteLength");
      if (index > 0) {
        add("BUFFER_RANGE", "ERROR", `/buffers/${index}`, "buffers after the first must have a URI");
      } else if (!chunks.hasBin) {
        add("MISSING_BIN_CHUNK", "ERROR", `/buffers/${index}`, "buffer zero requires a GLB BIN chunk");
      } else if (
        typeof byteLength !== "number" ||
        !Number.isInteger(byteLength) ||
        byteLength <= 0 ||
        chunks.bin === null ||
        byteLength > chunks.bin.byteLength ||
        chunks.bin.byteLength - byteLength > 3
      ) {
        add("BUFFER_RANGE", "ERROR", `/buffers/${index}/byteLength`, "buffer byteLength does not match the BIN chunk");
      }
    }

    validateReferences(root, add, limits, stats);
    validateImages(root, chunks, limits, add, stats);

    return finish();
  } catch (error) {
    add(
      "INTERNAL_ERROR",
      "ERROR",
      "header",
      error instanceof Error ? error.message.slice(0, 300) : "unexpected validation error",
    );
    return finish();
  }
}
