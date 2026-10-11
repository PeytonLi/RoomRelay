import type { Prisma, PrismaClient, User } from "../generated/prisma/client";
import type { RoomGeometry } from "@roomrelay/spatial";

export async function createRoom(
  prisma: PrismaClient,
  user: User,
  input: { name: string; geometry: RoomGeometry },
) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: { ownerId: user.id, name: input.name, measurementRevision: 1 },
    });
    const geometry = { ...input.geometry, measurementRevision: 1 };
    const revision = await tx.roomRevision.create({
      data: {
        roomId: room.id,
        revision: 1,
        geometry: geometry as unknown as Prisma.InputJsonValue,
        createdById: user.id,
      },
    });
    return { room, revision };
  });
}

export async function listOwnRooms(prisma: PrismaClient, user: User) {
  const rooms = await prisma.room.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
  });
  return rooms.map(({ revisions, ...room }) => ({
    ...room,
    geometry: revisions[0]?.geometry ?? null,
  }));
}

export async function getOwnRoom(prisma: PrismaClient, user: User, id: string) {
  const room = await prisma.room.findFirst({
    where: { id, ownerId: user.id },
    include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
  });
  if (!room) return null;
  const { revisions, ...data } = room;
  return { ...data, geometry: revisions[0]?.geometry ?? null };
}

export type PatchRoomResult =
  | { kind: "not-found" }
  | { kind: "stale" }
  | { kind: "ok"; room: unknown; revision: unknown };

export async function patchRoom(
  prisma: PrismaClient,
  user: User,
  id: string,
  expectedRevision: number,
  geometry: RoomGeometry,
): Promise<PatchRoomResult> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findFirst({ where: { id, ownerId: user.id } });
    if (!room) return { kind: "not-found" };
    if (room.measurementRevision !== expectedRevision) return { kind: "stale" };
    const revisionNumber = expectedRevision + 1;
    const update = await tx.room.updateMany({
      where: { id, ownerId: user.id, measurementRevision: expectedRevision },
      data: { measurementRevision: revisionNumber },
    });
    if (update.count !== 1) return { kind: "stale" };
    const revision = await tx.roomRevision.create({
      data: {
        roomId: id,
        revision: revisionNumber,
        geometry: { ...geometry, measurementRevision: revisionNumber } as unknown as Prisma.InputJsonValue,
        createdById: user.id,
      },
    });
    const updatedRoom = await tx.room.findUniqueOrThrow({ where: { id } });
    return { kind: "ok", room: updatedRoom, revision };
  });
}
