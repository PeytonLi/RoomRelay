import { describe, expect, it } from "vitest";
import { buildGlb, validGlb } from "./testing/glbFixtures";
import { DEFAULT_GLB_LIMITS, validateGlb, type GlbValidationResult } from "./validateGlb";

type ValidGlbOptions = NonNullable<Parameters<typeof validGlb>[0]>;

function withJson(
  mutateJson: NonNullable<ValidGlbOptions["mutateJson"]>,
  options: Omit<ValidGlbOptions, "mutateJson"> = {},
): Uint8Array {
  return validGlb({ ...options, mutateJson });
}

function expectStatus(
  bytes: Uint8Array,
  status: GlbValidationResult["status"],
  code?: string,
  limits?: Parameters<typeof validateGlb>[1],
): GlbValidationResult {
  const result = validateGlb(bytes, limits);
  expect(result.status).toBe(status);
  if (code) expect(result.issues.map((issue) => issue.code)).toContain(code);
  return result;
}

describe("validateGlb", () => {
  it("accepts a triangle and reports embedded texture dimensions", () => {
    const result = expectStatus(validGlb(), "OK");
    expect(result.stats.triangleCount).toBe(1);
    expect(result.stats.textureCount).toBe(1);
    expect(result.stats.imageCount).toBe(1);
    expect(result.stats.maxTextureWidth).toBe(128);
    expect(result.stats.maxTextureHeight).toBe(96);
  });

  it("measures JPEG dimensions from a bounded SOF marker", () => {
    const result = expectStatus(validGlb({ imageFormat: "jpeg", width: 320, height: 180 }), "OK");
    expect(result.stats.maxTextureWidth).toBe(320);
    expect(result.stats.maxTextureHeight).toBe(180);
  });

  it.each([
    ["bad magic", (bytes: Uint8Array) => { bytes[0] = 0; }, "BAD_MAGIC"],
    ["bad version", (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(4, 1, true); }, "BAD_VERSION"],
    ["bad length", (bytes: Uint8Array) => { new DataView(bytes.buffer).setUint32(8, bytes.length + 4, true); }, "BAD_LENGTH"],
  ])("rejects %s", (_label, corrupt, code) => {
    const bytes = validGlb();
    corrupt(bytes);
    expectStatus(bytes, "REJECTED", code);
  });

  it("rejects a truncated chunk", () => {
    const bytes = validGlb();
    const view = new DataView(bytes.buffer);
    const jsonLength = view.getUint32(12, true);
    view.setUint32(20 + jsonLength, 0xfffffff0, true);
    expectStatus(bytes, "REJECTED", "TRUNCATED");
  });

  it("rejects non-JSON first chunks and invalid JSON", () => {
    expectStatus(buildGlb({}, undefined, { jsonChunkType: 0 }), "REJECTED", "BAD_CHUNK_LAYOUT");
    expectStatus(
      buildGlb({}, undefined, { jsonBytes: new Uint8Array([0x7b, 0x20, 0x20, 0x20]) }),
      "REJECTED",
      "BAD_JSON",
    );
  });

  it("requires a glTF 2.x asset version", () => {
    expectStatus(withJson((json) => { json.asset.version = "1.0"; }), "REJECTED", "BAD_ASSET_VERSION");
  });

  it("rejects small configured and over-50-MiB inputs before parsing", () => {
    expectStatus(validGlb(), "REJECTED", "TOO_LARGE", { maxBytes: 12 });
    const tooLarge = new Uint8Array(DEFAULT_GLB_LIMITS.maxBytes + 1);
    expectStatus(tooLarge, "REJECTED", "TOO_LARGE");
  });

  it("rejects an external buffer URI", () => {
    const result = expectStatus(
      withJson((json) => { json.buffers[0].uri = "http://example.invalid/buffer.bin"; }),
      "REJECTED",
      "EXTERNAL_URI",
    );
    expect(result.issues.find((issue) => issue.code === "EXTERNAL_URI")?.path).toBe("/buffers/0/uri");
  });

  it("rejects a relative image URI", () => {
    const result = expectStatus(withJson((json) => { json.images[0].uri = "image.png"; }), "REJECTED", "EXTERNAL_URI");
    expect(result.issues.find((issue) => issue.code === "EXTERNAL_URI")?.path).toBe("/images/0/uri");
  });

  it.each(["../outside.glb", "%2e%2e/outside.glb", "C:\\x"])("rejects traversal URI %s", (uri) => {
    const result = expectStatus(withJson((json) => { json.buffers[0].uri = uri; }), "REJECTED", "PATH_TRAVERSAL");
    expect(result.issues.find((issue) => issue.code === "PATH_TRAVERSAL")?.path).toBe("/buffers/0/uri");
  });

  it("rejects an oversized data URI without decoding it", () => {
    const bytes = withJson((json) => { json.buffers[0].uri = `data:application/octet-stream;base64,${"A".repeat(64)}`; });
    expectStatus(bytes, "REJECTED", "DATA_URI_TOO_LARGE", { maxDataUriBytes: 8 });
  });

  it("marks a small data URI for review", () => {
    const bytes = withJson((json) => { json.buffers[0].uri = "data:application/octet-stream;base64,AAAA"; });
    expectStatus(bytes, "NEEDS_REVIEW", "DATA_URI_EMBEDDED");
  });

  it("rejects malformed data URI syntax", () => {
    const bytes = withJson((json) => { json.buffers[0].uri = "data:application/octet-stream,AAAA"; });
    expectStatus(bytes, "REJECTED", "DATA_URI_INVALID");
  });

  it("rejects a missing material texture index", () => {
    expectStatus(withJson((json) => { json.materials[0].pbrMetallicRoughness.baseColorTexture.index = 9; }), "REJECTED", "MISSING_TEXTURE");
  });

  it("rejects a missing texture image", () => {
    expectStatus(withJson((json) => { json.textures[0].source = 9; }), "REJECTED", "MISSING_IMAGE");
  });

  it("rejects dangling accessors", () => {
    expectStatus(withJson((json) => { json.meshes[0].primitives[0].attributes.POSITION = 9; }), "REJECTED", "DANGLING_INDEX");
  });

  it("rejects accessor ranges outside their bufferView", () => {
    expectStatus(withJson((json) => { json.accessors[0].count = 1000; }), "REJECTED", "ACCESSOR_RANGE");
  });

  it("rejects unsupported accessor and primitive descriptions", () => {
    expectStatus(withJson((json) => { json.accessors[0].componentType = 0; }), "REJECTED", "INVALID_ACCESSOR");
    expectStatus(withJson((json) => { json.meshes[0].primitives[0].mode = 7; }), "REJECTED", "INVALID_PRIMITIVE");
  });

  it("rejects bufferViews outside their buffer", () => {
    expectStatus(withJson((json) => { json.bufferViews[0].byteLength = 1000; }), "REJECTED", "BUFFER_VIEW_RANGE");
  });

  it("rejects a buffer without its BIN chunk and an invalid BIN range", () => {
    expectStatus(buildGlb({ asset: { version: "2.0" }, buffers: [{ byteLength: 1 }] }), "REJECTED", "MISSING_BIN_CHUNK");
    expectStatus(withJson((json) => { json.buffers[0].byteLength = 4; }), "REJECTED", "BUFFER_RANGE");
  });

  it("enforces top-level array and node depth limits", () => {
    expectStatus(validGlb(), "REJECTED", "JSON_LIMIT", { maxArrayLength: 0 });
    expectStatus(withJson((json) => {
      json.nodes.push({}, {}, {});
      json.nodes[0].children = [1];
      json.nodes[1]!.children = [2];
    }), "REJECTED", "JSON_LIMIT", { maxNodeDepth: 1 });
  });

  it("checks oversized JSON length before checking for chunk truncation", () => {
    const bytes = validGlb();
    new DataView(bytes.buffer).setUint32(12, 0xfffffff0, true);
    expectStatus(bytes, "REJECTED", "JSON_TOO_LARGE");
  });

  it("drops unsafe JSON keys and reports them without prototype pollution", () => {
    const bytes = withJson((json) => {
      Object.defineProperty(json, "__proto__", {
        value: { polluted: true },
        enumerable: true,
      });
    });
    expectStatus(bytes, "REJECTED", "UNSAFE_JSON_KEY");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("marks required Draco compression for review", () => {
    expectStatus(withJson((json) => {
      json.extensionsUsed = ["KHR_draco_mesh_compression"];
      json.extensionsRequired = ["KHR_draco_mesh_compression"];
    }), "NEEDS_REVIEW", "REQUIRED_COMPRESSION_UNSUPPORTED");
  });

  it("marks unknown required extensions for review", () => {
    expectStatus(withJson((json) => {
      json.extensionsUsed = ["VENDOR_unknown_feature"];
      json.extensionsRequired = ["VENDOR_unknown_feature"];
    }), "NEEDS_REVIEW", "REQUIRED_EXTENSION_UNSUPPORTED");
  });

  it("reports textures over the review dimension", () => {
    const result = expectStatus(validGlb({ width: 4096 }), "NEEDS_REVIEW", "TEXTURE_OVER_2K");
    expect(result.stats.maxTextureWidth).toBe(4096);
  });

  it("rejects oversized textures and reviews unsupported image formats", () => {
    expectStatus(validGlb({ width: 16_385, height: 1 }), "REJECTED", "TEXTURE_TOO_LARGE");
    expectStatus(
      withJson((json) => { json.images[0].mimeType = "image/webp"; }),
      "NEEDS_REVIEW",
      "IMAGE_FORMAT_UNSUPPORTED",
    );
  });

  it("rejects unreadable image headers", () => {
    const bytes = validGlb();
    const view = new DataView(bytes.buffer);
    const jsonLength = view.getUint32(12, true);
    const binOffset = 20 + jsonLength + 8;
    bytes[binOffset + 44] = 0;
    expectStatus(bytes, "REJECTED", "IMAGE_HEADER_INVALID");
  });

  it("reviews triangle counts above the configured budget", () => {
    const result = expectStatus(validGlb(), "NEEDS_REVIEW", "TRIANGLES_OVER_BUDGET", { reviewTriangleCount: 0 });
    expect(result.stats.triangleCount).toBe(1);
  });

  it("rejects an image whose signature disagrees with its MIME type", () => {
    expectStatus(validGlb({ imageFormat: "jpeg", imageMimeType: "image/png" }), "REJECTED", "IMAGE_SIGNATURE_MISMATCH");
  });

  it("rejects node cycles", () => {
    expectStatus(withJson((json) => { json.nodes[0].children = [0]; }), "REJECTED", "NODE_GRAPH_INVALID");
  });

  it("rejects texture memory beyond the configured cap", () => {
    expectStatus(validGlb({ width: 32, height: 32 }), "REJECTED", "TEXTURE_MEMORY_EXCEEDED", { maxDecodedTextureBytes: 1000 });
  });

  it("rejects an invalid JSON chunk length alignment", () => {
    const bytes = buildGlb({}, undefined, { jsonDeclaredLength: 3 });
    expectStatus(bytes, "REJECTED", "BAD_CHUNK_ALIGNMENT");
  });

  it("reports unknown chunks as informational", () => {
    const bytes = buildGlb(
      { asset: { version: "2.0" }, buffers: [] },
      undefined,
      { chunks: [{ type: 0x12345678, bytes: new Uint8Array(4) }] },
    );
    const result = expectStatus(bytes, "OK", "UNKNOWN_CHUNK");
    expect(result.issues.find((issue) => issue.code === "UNKNOWN_CHUNK")?.severity).toBe("INFO");
  });
});
