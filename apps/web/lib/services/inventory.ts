import type { PrismaClient, User } from "../generated/prisma/client";

export interface ListingFields {
  title?: string | undefined;
  category?: string | null | undefined;
  widthM?: number | undefined;
  depthM?: number | undefined;
  heightM?: number | undefined;
  dimsConfirmed?: boolean | undefined;
  conditionNotes?: string | null | undefined;
  conditionPhotoAssetIds?: string[] | undefined;
  priceCents?: number | undefined;
  currency?: string | undefined;
  pickupWindowStart?: Date | undefined;
  pickupWindowEnd?: Date | undefined;
  coarseArea?: string | undefined;
  exactPickupAddress?: string | undefined;
  provenance?: "SCANNED_ACTUAL" | "CATALOG_EXACT_MATCH" | "APPROXIMATE_PROXY" | "ILLUSTRATIVE_GENERATED" | undefined;
}

const defaultPickupEnd = (start: Date) => new Date(start.getTime() + 24 * 60 * 60 * 1000);

function listingData(input: ListingFields, itemId: string, version: number, createdById: string) {
  const pickupWindowStart = input.pickupWindowStart ?? new Date();
  return {
    itemId,
    version,
    title: input.title ?? "",
    category: input.category ?? null,
    widthM: input.widthM ?? 0,
    depthM: input.depthM ?? 0,
    heightM: input.heightM ?? 0,
    dimsConfirmed: input.dimsConfirmed ?? false,
    conditionNotes: input.conditionNotes ?? null,
    conditionPhotoAssetIds: input.conditionPhotoAssetIds ?? [],
    priceCents: input.priceCents ?? 0,
    currency: input.currency ?? "USD",
    pickupWindowStart,
    pickupWindowEnd: input.pickupWindowEnd ?? defaultPickupEnd(pickupWindowStart),
    coarseArea: input.coarseArea ?? "",
    exactPickupAddress: input.exactPickupAddress ?? "",
    provenance: input.provenance ?? "APPROXIMATE_PROXY",
    createdById,
  };
}

export async function createDraftItem(prisma: PrismaClient, user: User, input: ListingFields) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.create({ data: { sellerId: user.id } });
    const listingVersion = await tx.listingVersion.create({
      data: listingData(input, item.id, 1, user.id),
    });
    return { item: { ...item, currentVersion: 1 }, listingVersion };
  });
}

export async function listOwnItems(prisma: PrismaClient, user: User) {
  return prisma.item.findMany({
    where: { sellerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { versions: { orderBy: { version: "desc" } } },
  });
}

export async function getOwnItem(prisma: PrismaClient, user: User, id: string) {
  return prisma.item.findFirst({
    where: { id, sellerId: user.id },
    include: { versions: { orderBy: { version: "desc" } } },
  });
}

export type PatchItemResult =
  | { kind: "not-found" }
  | { kind: "locked" }
  | { kind: "stale" }
  | { kind: "ok"; item: unknown; listingVersion: unknown };

export async function patchItem(
  prisma: PrismaClient,
  user: User,
  id: string,
  expectedVersion: number,
  input: Partial<ListingFields>,
): Promise<PatchItemResult> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findFirst({ where: { id, sellerId: user.id } });
    if (!item) return { kind: "not-found" };
    if (item.status === "RESERVED" || item.status === "SOLD") return { kind: "locked" };
    const inventory = await tx.itemInventory.findUnique({ where: { itemId: id }, select: { state: true } });
    if (inventory && inventory.state !== "AVAILABLE") return { kind: "locked" };
    if (item.version !== expectedVersion) return { kind: "stale" };

    const current = await tx.listingVersion.findUnique({
      where: { itemId_version: { itemId: item.id, version: item.currentVersion } },
    });
    if (!current) return { kind: "not-found" };
    const nextVersion = item.currentVersion + 1;
    const result = await tx.item.updateMany({
      where: { id, sellerId: user.id, version: expectedVersion, status: { notIn: ["RESERVED", "SOLD"] } },
      data: { version: { increment: 1 }, currentVersion: nextVersion },
    });
    if (result.count !== 1) return { kind: "stale" };

    const listingVersion = await tx.listingVersion.create({
      data: {
        itemId: item.id,
        version: nextVersion,
        title: input.title ?? current.title,
        category: input.category === undefined ? current.category : input.category,
        widthM: input.widthM ?? current.widthM,
        depthM: input.depthM ?? current.depthM,
        heightM: input.heightM ?? current.heightM,
        dimsConfirmed: input.dimsConfirmed ?? current.dimsConfirmed,
        conditionNotes: input.conditionNotes === undefined ? current.conditionNotes : input.conditionNotes,
        conditionPhotoAssetIds: input.conditionPhotoAssetIds ?? current.conditionPhotoAssetIds,
        priceCents: input.priceCents ?? current.priceCents,
        currency: input.currency ?? current.currency,
        pickupWindowStart: input.pickupWindowStart ?? current.pickupWindowStart,
        pickupWindowEnd: input.pickupWindowEnd ?? current.pickupWindowEnd,
        coarseArea: input.coarseArea ?? current.coarseArea,
        exactPickupAddress: input.exactPickupAddress ?? current.exactPickupAddress,
        provenance: input.provenance ?? current.provenance,
        createdById: user.id,
      },
    });
    const updatedItem = await tx.item.findUniqueOrThrow({ where: { id } });
    return { kind: "ok", item: updatedItem, listingVersion };
  });
}

export type PublishItemResult =
  | { kind: "not-found" }
  | { kind: "locked" }
  | { kind: "stale" }
  | { kind: "invalid"; fieldErrors: Record<string, string[]> }
  | { kind: "ok"; item: unknown; listingVersion: unknown };

export async function publishItem(
  prisma: PrismaClient,
  user: User,
  id: string,
  expectedVersion: number,
): Promise<PublishItemResult> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findFirst({ where: { id, sellerId: user.id } });
    if (!item) return { kind: "not-found" };
    if (item.status === "RESERVED" || item.status === "SOLD") return { kind: "locked" };
    const inventory = await tx.itemInventory.findUnique({ where: { itemId: id }, select: { state: true } });
    if (inventory && inventory.state !== "AVAILABLE") return { kind: "locked" };
    if (item.version !== expectedVersion) return { kind: "stale" };
    const listingVersion = await tx.listingVersion.findUnique({
      where: { itemId_version: { itemId: item.id, version: item.currentVersion } },
    });
    if (!listingVersion) return { kind: "not-found" };

    const fields: Record<string, string[]> = {};
    const width = Number(listingVersion.widthM);
    const depth = Number(listingVersion.depthM);
    const height = Number(listingVersion.heightM);
    if (!listingVersion.dimsConfirmed) fields.dimsConfirmed = ["dimensions must be confirmed"];
    for (const [name, value] of [["widthM", width], ["depthM", depth], ["heightM", height]] as const) {
      if (!Number.isFinite(value) || value <= 0 || value > 5) fields[name] = ["must be greater than 0 and at most 5m"];
    }
    const photos = listingVersion.conditionPhotoAssetIds.length
      ? await tx.asset.findMany({
          where: {
            id: { in: listingVersion.conditionPhotoAssetIds },
            ownerId: user.id,
            kind: "PHOTO",
          },
          select: { id: true },
        })
      : [];
    if (
      photos.length === 0 ||
      photos.length !== new Set(listingVersion.conditionPhotoAssetIds).size ||
      photos.length !== listingVersion.conditionPhotoAssetIds.length
    ) {
      fields.conditionPhotoAssetIds = ["all referenced photos must be owned by the seller and at least one is required"];
    }
    if (listingVersion.priceCents < 1 || listingVersion.priceCents > 1_000_000) {
      fields.priceCents = ["must be between 1 and 1000000 cents"];
    }
    if (listingVersion.pickupWindowStart >= listingVersion.pickupWindowEnd) {
      fields.pickupWindowEnd = ["must be after pickupWindowStart"];
    }
    if (!listingVersion.coarseArea.trim()) fields.coarseArea = ["required"];
    if (!listingVersion.exactPickupAddress.trim()) fields.exactPickupAddress = ["required"];
    if (Object.keys(fields).length > 0) return { kind: "invalid", fieldErrors: fields };

    const result = await tx.item.updateMany({
      where: { id, sellerId: user.id, version: expectedVersion, status: { notIn: ["RESERVED", "SOLD"] } },
      data: { status: "ACTIVE", publishedVersion: item.currentVersion, version: { increment: 1 } },
    });
    if (result.count !== 1) return { kind: "stale" };
    await tx.asset.updateMany({
      where: { id: { in: photos.map((photo) => photo.id) }, ownerId: user.id, kind: "PHOTO" },
      data: { visibility: "APPROVED_LISTING" },
    });
    const updatedItem = await tx.item.findUniqueOrThrow({ where: { id } });
    return { kind: "ok", item: updatedItem, listingVersion };
  });
}

const publicListingSelection = {
  id: true,
  itemId: true,
  version: true,
  title: true,
  category: true,
  widthM: true,
  depthM: true,
  heightM: true,
  dimsConfirmed: true,
  conditionPhotoAssetIds: true,
  priceCents: true,
  currency: true,
  pickupWindowStart: true,
  pickupWindowEnd: true,
  coarseArea: true,
  provenance: true,
  item: { select: { id: true, sellerId: true, status: true, publishedVersion: true } },
} as const;

export function serializePublicListing(version: {
  id: string;
  itemId: string;
  version: number;
  title: string;
  category: string | null;
  widthM: { toNumber(): number };
  depthM: { toNumber(): number };
  heightM: { toNumber(): number };
  dimsConfirmed: boolean;
  conditionPhotoAssetIds: string[];
  priceCents: number;
  currency: string;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
  coarseArea: string;
  provenance: string;
  item: { id: string; sellerId: string; status: string; publishedVersion: number | null };
}) {
  const provenanceLabel: Record<string, string> = {
    SCANNED_ACTUAL: "Scanned actual item",
    CATALOG_EXACT_MATCH: "Catalog exact match",
    APPROXIMATE_PROXY: "Approximate proxy",
    ILLUSTRATIVE_GENERATED: "Illustrative generated",
  };
  return {
    id: version.item.id,
    sellerId: version.item.sellerId,
    version: version.version,
    title: version.title,
    category: version.category,
    widthM: version.widthM.toNumber(),
    depthM: version.depthM.toNumber(),
    heightM: version.heightM.toNumber(),
    dimsConfirmed: version.dimsConfirmed,
    conditionPhotoAssetIds: version.conditionPhotoAssetIds,
    priceCents: version.priceCents,
    currency: version.currency,
    pickupWindowStart: version.pickupWindowStart,
    pickupWindowEnd: version.pickupWindowEnd,
    coarseArea: version.coarseArea,
    provenance: provenanceLabel[version.provenance] ?? "Unspecified provenance",
  };
}

export async function listPublishedListings(prisma: PrismaClient) {
  const versions = await prisma.listingVersion.findMany({
    where: { item: { is: { status: "ACTIVE", NOT: { inventory: { is: { state: "SOLD" } } } } } },
    select: publicListingSelection,
    orderBy: { createdAt: "desc" },
  });
  return versions
    .filter((version) => version.item.publishedVersion === version.version)
    .map(serializePublicListing);
}

export async function getPublishedListing(prisma: PrismaClient, id: string) {
  const versions = await prisma.listingVersion.findMany({
    where: { itemId: id, item: { is: { status: "ACTIVE", NOT: { inventory: { is: { state: "SOLD" } } } } } },
    select: publicListingSelection,
  });
  const version = versions.find((entry) => entry.item.publishedVersion === entry.version);
  return version ? serializePublicListing(version) : null;
}
