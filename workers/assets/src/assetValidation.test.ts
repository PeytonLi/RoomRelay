import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermanentJobError, type JobRow } from "@roomrelay/jobs";
import { afterEach, describe, expect, it } from "vitest";
import { buildGlb, validGlb } from "../../../packages/assets/src/testing/glbFixtures";
import { createAssetValidationHandler, ASSET_VALIDATE_JOB } from "./assetValidation";
import { LocalFsObjectReader } from "./objectReader";

const directories: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roomrelay-assets-"));
  directories.push(root);
  return root;
}

function job(inputRef: unknown): JobRow {
  return {
    id: "job-1",
    type: ASSET_VALIDATE_JOB,
    stage: "validate",
    subject: { type: "item", id: "item-1", version: 1 },
    idempotencyKey: "asset.validate|item|item-1|v1|validate",
    status: "RUNNING",
    attempts: 1,
    maxAttempts: 3,
    leaseOwner: "worker",
    leaseToken: "token",
    leaseExpiresAt: null,
    runAfter: new Date(),
    inputRef,
    outputRef: null,
    reason: null,
    cancelRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    finishedAt: null,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("asset.validate handler", () => {
  it("builds a manifest for a valid GLB without returning its bytes", async () => {
    const root = await newRoot();
    await writeFile(join(root, "valid.glb"), validGlb());
    const handler = createAssetValidationHandler(new LocalFsObjectReader(root));
    const output = await handler({
      job: job({ objectKey: "valid.glb", provenance: "SCANNED_ACTUAL" }),
      signal: new AbortController().signal,
    });
    expect(output).toMatchObject({
      validation: { status: "OK", stats: { triangleCount: 1 } },
      manifest: { format: "model/gltf-binary", provenance: "SCANNED_ACTUAL" },
    });
    expect(output).toHaveProperty("manifestError", null);
    expect(output).not.toHaveProperty("bytes");
  });

  it("returns a successful rejection result without a manifest for hostile GLB", async () => {
    const root = await newRoot();
    const bytes = validGlb();
    bytes[0] = 0;
    await writeFile(join(root, "hostile.glb"), bytes);
    const handler = createAssetValidationHandler(new LocalFsObjectReader(root));
    const output = await handler({
      job: job({ objectKey: "hostile.glb", provenance: "SCANNED_ACTUAL" }),
      signal: new AbortController().signal,
    });
    expect(output).toMatchObject({ validation: { status: "REJECTED" }, manifest: null });
  });

  it("rejects invalid inputRef with a permanent error", async () => {
    const handler = createAssetValidationHandler({ read: async () => validGlb() });
    await expect(handler({
      job: job({ objectKey: "valid.glb", provenance: "SCANNED_ACTUAL", extra: true }),
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("returns a manifest error for valid GLB without measurable geometry", async () => {
    const root = await newRoot();
    const bytes = buildGlb({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
    });
    await writeFile(join(root, "meshless.glb"), bytes);
    const handler = createAssetValidationHandler(new LocalFsObjectReader(root));
    const output = await handler({
      job: job({ objectKey: "meshless.glb", provenance: "SCANNED_ACTUAL" }),
      signal: new AbortController().signal,
    });

    expect(output).toMatchObject({
      validation: { status: "OK" },
      manifest: null,
      manifestError: { code: "DEGENERATE_BOUNDS" },
    });
  });

  it("rejects traversal keys", async () => {
    const root = await newRoot();
    const reader = new LocalFsObjectReader(root);
    await expect(reader.read("../outside.glb", 100)).rejects.toMatchObject({ message: "INVALID_OBJECT_KEY" });
  });

  it("checks file size before reading", async () => {
    const root = await newRoot();
    await writeFile(join(root, "large.glb"), new Uint8Array(16));
    await expect(new LocalFsObjectReader(root).read("large.glb", 8)).rejects.toMatchObject({
      message: "TOO_LARGE",
    });
  });

  it("treats directories as missing objects", async () => {
    const root = await newRoot();
    await mkdir(join(root, "directory"));
    await expect(new LocalFsObjectReader(root).read("directory", 1000)).rejects.toMatchObject({
      name: "PermanentJobError",
      message: "OBJECT_NOT_FOUND",
    });
  });

  it("rejects symlinks that resolve outside the object root", async () => {
    const root = await newRoot();
    const outside = join(await newRoot(), "outside.glb");
    await writeFile(outside, buildGlb({ asset: { version: "2.0" } }));
    try {
      await (await import("node:fs/promises")).symlink(outside, join(root, "escape.glb"));
    } catch {
      return;
    }
    await expect(new LocalFsObjectReader(root).read("escape.glb", 1000)).rejects.toMatchObject({
      message: "INVALID_OBJECT_KEY",
    });
  });
});
