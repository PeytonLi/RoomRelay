import { randomUUID } from "node:crypto";
import type { PrismaClient, User } from "../generated/prisma/client";

export type UploadRole = "CONDITION_PHOTO" | "ITEM_MODEL" | "ROOM_MODEL";

export interface CreateUploadInput {
  role: UploadRole;
  contentType: string;
  bytes: number;
  sha256: string;
}

export async function createUploadManifest(prisma: PrismaClient, user: User, input: CreateUploadInput) {
  const now = new Date();
  return prisma.uploadManifest.create({
    data: {
      ownerId: user.id,
      role: input.role,
      contentType: input.contentType,
      declaredBytes: input.bytes,
      declaredSha256: input.sha256,
      objectKey: `u/${randomUUID()}`,
      backend: "LOCAL_FS",
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    },
  });
}

export async function getOwnedUploadManifest(prisma: PrismaClient, user: User, id: string) {
  return prisma.uploadManifest.findFirst({ where: { id, ownerId: user.id } });
}

export async function markUploadComplete(prisma: PrismaClient, user: User, id: string) {
  return prisma.uploadManifest.updateMany({
    where: { id, ownerId: user.id, status: "PENDING" },
    data: { status: "UPLOADED" },
  });
}

export async function finalizeUpload(prisma: PrismaClient, user: User, id: string) {
  return prisma.$transaction(async (tx) => {
    const manifest = await tx.uploadManifest.findFirst({ where: { id, ownerId: user.id } });
    if (!manifest) return { kind: "not-found" as const };
    if (manifest.status === "FINALIZED" && manifest.assetId) {
      return { kind: "finalized" as const, assetId: manifest.assetId };
    }
    if (manifest.status !== "UPLOADED" || manifest.expiresAt <= new Date()) {
      return { kind: "invalid-state" as const };
    }

    const asset = await tx.asset.create({
      data: {
        ownerId: user.id,
        kind: manifest.role === "CONDITION_PHOTO" ? "PHOTO" : "MODEL_GLB",
        visibility: "PRIVATE",
        objectKey: manifest.objectKey,
        contentType: manifest.contentType,
        sha256: manifest.declaredSha256,
        bytes: BigInt(manifest.declaredBytes),
      },
      select: { id: true },
    });
    await tx.uploadManifest.update({
      where: { id: manifest.id },
      data: { status: "FINALIZED", assetId: asset.id },
    });
    return { kind: "finalized" as const, assetId: asset.id };
  });
}

export async function getOwnedAssetMetadata(prisma: PrismaClient, user: User, id: string) {
  return prisma.asset.findFirst({
    where: { id, ownerId: user.id },
    select: { id: true, kind: true, contentType: true, bytes: true, sha256: true, visibility: true, createdAt: true },
  });
}

export async function getDownloadableAsset(prisma: PrismaClient, userId: string | null, id: string) {
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) return null;
  if (userId === asset.ownerId) return asset;
  if (asset.visibility !== "APPROVED_LISTING") return null;

  const versions = await prisma.listingVersion.findMany({
    where: {
      conditionPhotoAssetIds: { has: id },
      item: { is: { status: "ACTIVE" } },
    },
    select: { version: true, item: { select: { publishedVersion: true } } },
  });
  return versions.some((version) => version.item.publishedVersion === version.version) ? asset : null;
}
