import type { Prisma, PrismaClient, User } from "../generated/prisma/client";
import type { RoomGeometry } from "@roomrelay/spatial";
import {
  evaluateLayout,
  type LayoutPlacementInput,
  type LayoutRequirements,
  type ListingFacts,
} from "../prefilter";

export interface CreateLayoutInput {
  roomId: string;
  roomRevision: number;
  parentId?: string | undefined;
  placements: LayoutPlacementInput[];
  requirements: LayoutRequirements;
}

function requirementJson(requirements: LayoutRequirements) {
  return {
    budgetCents: requirements.budgetCents,
    pickupFrom: requirements.pickupFrom.toISOString(),
    pickupTo: requirements.pickupTo.toISOString(),
  };
}

async function getRoomContext(prisma: PrismaClient, roomId: string, ownerId?: string) {
  const room = await prisma.room.findFirst({
    where: { id: roomId, ...(ownerId ? { ownerId } : {}) },
    include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
  });
  if (!room || !room.revisions[0]) return null;
  return { room, geometry: room.revisions[0].geometry as unknown as RoomGeometry };
}

async function getListingFacts(prisma: PrismaClient, placements: LayoutPlacementInput[]): Promise<ListingFacts[]> {
  if (placements.length === 0) return [];
  const versions = await prisma.listingVersion.findMany({
    where: {
      OR: placements.map((placement) => ({
        itemId: placement.itemId,
        version: placement.listingVersion,
      })),
    },
    select: {
      itemId: true,
      version: true,
      title: true,
      widthM: true,
      depthM: true,
      heightM: true,
      priceCents: true,
      pickupWindowStart: true,
      pickupWindowEnd: true,
      item: { select: { sellerId: true, status: true, publishedVersion: true } },
    },
  });
  return versions.map((version) => ({
    itemId: version.itemId,
    listingVersion: version.version,
    publishedVersion: version.item.publishedVersion,
    itemStatus: version.item.status,
    sellerId: version.item.sellerId,
    title: version.title,
    widthM: Number(version.widthM),
    depthM: Number(version.depthM),
    heightM: Number(version.heightM),
    priceCents: version.priceCents,
    pickupWindowStart: version.pickupWindowStart,
    pickupWindowEnd: version.pickupWindowEnd,
  }));
}

export async function createLayout(prisma: PrismaClient, user: User, input: CreateLayoutInput) {
  const roomContext = await getRoomContext(prisma, input.roomId, user.id);
  if (!roomContext) return { kind: "not-found" as const };
  const listingFacts = await getListingFacts(prisma, input.placements);
  const evaluation = evaluateLayout({
    room: roomContext.geometry,
    roomRevision: input.roomRevision,
    currentRoomRevision: roomContext.room.measurementRevision,
    placements: input.placements,
    listingFacts,
    requirements: input.requirements,
  });
  const totalCents = evaluation.totalCents;
  const revision = await prisma.layoutRevision.create({
    data: {
      roomId: input.roomId,
      roomRevision: input.roomRevision,
      parentId: input.parentId ?? null,
      ownerId: user.id,
      placements: input.placements as unknown as Prisma.InputJsonValue,
      requirements: requirementJson(input.requirements) as Prisma.InputJsonValue,
      findings: evaluation.findings as unknown as Prisma.InputJsonValue,
      fitsProvidedMeasurements: evaluation.fitsProvidedMeasurements,
      totalCents,
      prefilterReasons: evaluation.prefilterReasons as unknown as Prisma.InputJsonValue,
      quotable: evaluation.quotable,
    },
  });
  return { kind: "ok" as const, layout: revision, evaluation };
}

export async function getOwnLayout(prisma: PrismaClient, user: User, id: string) {
  return prisma.layoutRevision.findFirst({ where: { id, ownerId: user.id } });
}

function parseStoredRequirements(value: Prisma.JsonValue): LayoutRequirements {
  const requirements = value as { budgetCents: number; pickupFrom: string; pickupTo: string };
  return {
    budgetCents: requirements.budgetCents,
    pickupFrom: new Date(requirements.pickupFrom),
    pickupTo: new Date(requirements.pickupTo),
  };
}

function parseStoredPlacements(value: Prisma.JsonValue): LayoutPlacementInput[] {
  return value as unknown as LayoutPlacementInput[];
}

export class LayoutEvaluationError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "STALE_VERSION" | "LAYOUT_NOT_QUOTABLE") {
    super(code);
    this.name = "LayoutEvaluationError";
  }
}

export async function evaluateStoredLayout(prisma: PrismaClient, userId: string, id: string) {
  const layout = await prisma.layoutRevision.findFirst({ where: { id, ownerId: userId } });
  if (!layout) throw new LayoutEvaluationError("NOT_FOUND");
  const roomContext = await getRoomContext(prisma, layout.roomId);
  if (!roomContext) throw new LayoutEvaluationError("STALE_VERSION");
  const placements = parseStoredPlacements(layout.placements);
  const requirements = parseStoredRequirements(layout.requirements);
  const listingFacts = await getListingFacts(prisma, placements);
  const evaluation = evaluateLayout({
    room: roomContext.geometry,
    roomRevision: layout.roomRevision,
    currentRoomRevision: roomContext.room.measurementRevision,
    placements,
    listingFacts,
    requirements,
  });
  const stale = evaluation.prefilterReasons.some((reason) =>
    ["STALE_ROOM_REVISION", "STALE_LISTING_VERSION", "ITEM_NOT_ACTIVE"].includes(reason.code),
  );
  if (stale) throw new LayoutEvaluationError("STALE_VERSION");
  if (!evaluation.quotable) throw new LayoutEvaluationError("LAYOUT_NOT_QUOTABLE");
  return { layout, evaluation };
}

export async function assertLayoutQuotable(prisma: PrismaClient, userId: string, layoutId: string) {
  return evaluateStoredLayout(prisma, userId, layoutId);
}

export async function evaluateLayoutForRequest(prisma: PrismaClient, user: User, id: string) {
  const layout = await prisma.layoutRevision.findFirst({ where: { id, ownerId: user.id } });
  if (!layout) return { kind: "not-found" as const };
  const roomContext = await getRoomContext(prisma, layout.roomId);
  if (!roomContext) return { kind: "stale" as const, findings: [], prefilterReasons: [] };
  const placements = parseStoredPlacements(layout.placements);
  const requirements = parseStoredRequirements(layout.requirements);
  const listingFacts = await getListingFacts(prisma, placements);
  const evaluation = evaluateLayout({
    room: roomContext.geometry,
    roomRevision: layout.roomRevision,
    currentRoomRevision: roomContext.room.measurementRevision,
    placements,
    listingFacts,
    requirements,
  });
  if (evaluation.prefilterReasons.some((reason) =>
    ["STALE_ROOM_REVISION", "STALE_LISTING_VERSION", "ITEM_NOT_ACTIVE"].includes(reason.code),
  )) {
    return { kind: "stale" as const, ...evaluation };
  }
  if (!evaluation.quotable) return { kind: "not-quotable" as const, ...evaluation };
  return { kind: "quotable" as const, ...evaluation };
}

export async function candidateListingFacts(prisma: PrismaClient) {
  const items = await prisma.item.findMany({
    where: { status: "ACTIVE", publishedVersion: { not: null }, NOT: { inventory: { is: { state: { not: "AVAILABLE" } } } } },
    select: {
      id: true,
      sellerId: true,
      status: true,
      publishedVersion: true,
    },
    orderBy: { id: "asc" },
    take: 30,
  });
  if (items.length === 0) return [];
  const versions = await prisma.listingVersion.findMany({
    where: {
      dimsConfirmed: true,
      OR: items.map((item) => ({ itemId: item.id, version: item.publishedVersion! })),
    },
    select: {
      itemId: true,
      version: true,
      title: true,
      widthM: true,
      depthM: true,
      heightM: true,
      priceCents: true,
      pickupWindowStart: true,
      pickupWindowEnd: true,
    },
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return versions.map((version) => {
    const item = itemsById.get(version.itemId)!;
    return {
      itemId: version.itemId,
      listingVersion: version.version,
      publishedVersion: item.publishedVersion,
      itemStatus: item.status,
      sellerId: item.sellerId,
      title: version.title,
      widthM: Number(version.widthM),
      depthM: Number(version.depthM),
      heightM: Number(version.heightM),
      priceCents: version.priceCents,
      pickupWindowStart: version.pickupWindowStart,
      pickupWindowEnd: version.pickupWindowEnd,
    };
  });
}

export async function candidateRoomContext(prisma: PrismaClient, user: User, roomId: string) {
  return getRoomContext(prisma, roomId, user.id);
}

export function findCandidatePlacement(room: RoomGeometry, facts: ListingFacts) {
  const xs = room.boundaryXZ.map(([x]) => x);
  const zs = room.boundaryXZ.map(([, z]) => z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const step = 0.1;

  for (const yawRad of [0, Math.PI / 2]) {
    const width = yawRad === 0 ? facts.widthM : facts.depthM;
    const depth = yawRad === 0 ? facts.depthM : facts.widthM;
    const startX = minX + width / 2 + 0.05;
    const startZ = minZ + depth / 2 + 0.05;
    for (let ix = 0; startX + ix * step <= maxX - width / 2 - 0.05 + 1e-9; ix++) {
      const xM = startX + ix * step;
      for (let iz = 0; startZ + iz * step <= maxZ - depth / 2 - 0.05 + 1e-9; iz++) {
        const zM = startZ + iz * step;
        const result = evaluateLayout({
          room,
          roomRevision: room.measurementRevision,
          currentRoomRevision: room.measurementRevision,
          placements: [{ itemId: facts.itemId, listingVersion: facts.listingVersion, xM, zM, yawRad }],
          listingFacts: [facts],
          requirements: {
            budgetCents: facts.priceCents,
            pickupFrom: facts.pickupWindowStart,
            pickupTo: facts.pickupWindowEnd,
          },
        });
        if (result.fitsProvidedMeasurements) return { itemId: facts.itemId, listingVersion: facts.listingVersion, xM, zM, yawRad };
      }
    }
  }
  return null;
}
