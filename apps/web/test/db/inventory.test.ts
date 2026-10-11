import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import syntheticRoom from "../../fixtures/room.synthetic.json";
import { GET as getAsset } from "../../app/api/v1/assets/[id]/route";
import { GET as getAssetDownloadRoute } from "../../app/api/v1/assets/[id]/download/route";
import { GET as getItems, POST as createItem } from "../../app/api/v1/items/route";
import { GET as getItem, PATCH as patchItemRoute } from "../../app/api/v1/items/[id]/route";
import { POST as publishItemRoute } from "../../app/api/v1/items/[id]/publish/route";
import { GET as getListings } from "../../app/api/v1/listings/route";
import { GET as getListing } from "../../app/api/v1/listings/[id]/route";
import { POST as createLayout } from "../../app/api/v1/layouts/route";
import { POST as checkQuotable } from "../../app/api/v1/layouts/[id]/quotable/route";
import { GET as getRooms, POST as createRoom } from "../../app/api/v1/rooms/route";
import { GET as getRoom, PATCH as patchRoomRoute } from "../../app/api/v1/rooms/[id]/route";
import { POST as createUpload } from "../../app/api/v1/uploads/route";
import { PUT as putUploadContent } from "../../app/api/v1/uploads/[id]/content/route";
import { POST as finalizeUpload } from "../../app/api/v1/uploads/[id]/finalize/route";
import { getPrisma } from "../../lib/db";
import { getObjectStore } from "../../lib/object-store";
import { setTestIdentity } from "../../lib/test-identity";

const prisma = getPrisma();
if (!prisma) throw new Error("DATABASE_URL must be configured for integration tests");

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseJson<T = Record<string, any>>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function ensureUser(subject: string) {
  return prisma!.user.upsert({
    where: { authSubject: `test:${subject}` },
    update: {},
    create: { authSubject: `test:${subject}` },
  });
}

async function createPhoto(ownerId: string) {
  return prisma!.asset.create({
    data: {
      ownerId,
      kind: "PHOTO",
      visibility: "PRIVATE",
      objectKey: `u/${randomUUID()}`,
      contentType: "image/png",
      sha256: "a".repeat(64),
      bytes: 8n,
    },
  });
}

function listingBody(photoId: string, title = "Desk") {
  return {
    title,
    category: "Desk",
    widthM: 1,
    depthM: 1,
    heightM: 1,
    dimsConfirmed: true,
    conditionPhotoAssetIds: [photoId],
    priceCents: 5000,
    pickupWindowStart: "2026-05-01T10:00:00.000Z",
    pickupWindowEnd: "2026-05-03T10:00:00.000Z",
    coarseArea: "Central",
    exactPickupAddress: "123 Private Street, Secret City",
  };
}

async function createAndPublishListing(photoId: string, title = "Desk") {
  const created = await responseJson(await createItem(jsonRequest(listingBody(photoId, title))));
  const publishResponse = await publishItemRoute(
    jsonRequest({ expectedVersion: created.version }),
    { params: Promise.resolve({ id: created.id }) },
  );
  expect(publishResponse.status).toBe(200);
  return { itemId: created.id, published: await responseJson(publishResponse) };
}

beforeEach(async () => {
  setTestIdentity(null);
  await prisma!.$executeRawUnsafe(
    'TRUNCATE TABLE "users", "rooms", "room_revisions", "items", "listing_versions", "assets", "upload_manifests", "layout_revisions", "measurement_evidence" CASCADE',
  );
});

describe("T-004 route integration", () => {
  it("returns identity unavailable when the test seam is absent", async () => {
    const [rooms, items, uploads] = await Promise.all([
      getRooms(),
      getItems(),
      createUpload(jsonRequest({ role: "CONDITION_PHOTO", contentType: "image/png", bytes: 8, sha256: "a".repeat(64) })),
    ]);
    expect(rooms.status).toBe(503);
    expect((await responseJson(rooms)).code).toBe("IDENTITY_UNAVAILABLE");
    expect(items.status).toBe(503);
    expect(uploads.status).toBe(503);
  });

  it("isolates rooms, items, assets, manifests and layout creation by owner", async () => {
    const alice = await ensureUser("alice");
    const photo = await createPhoto(alice.id);
    setTestIdentity("alice");
    const room = await responseJson(await createRoom(jsonRequest({ name: "Bedroom", geometry: syntheticRoom })));
    const item = await responseJson(await createItem(jsonRequest(listingBody(photo.id))));
    const manifest = await responseJson(await createUpload(jsonRequest({
      role: "CONDITION_PHOTO",
      contentType: "image/png",
      bytes: 8,
      sha256: "b".repeat(64),
    })));
    const objectStore = getObjectStore();
    if (!objectStore.available) throw new Error("Local object store must be available in integration tests");
    const privateBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await objectStore.store.put(photo.objectKey, privateBytes);
    const ownerDownload = await getAssetDownloadRoute(
      new Request("http://localhost"),
      { params: Promise.resolve({ id: photo.id }) },
    );
    expect(ownerDownload.status).toBe(200);
    expect(new Uint8Array(await ownerDownload.arrayBuffer())).toEqual(privateBytes);

    setTestIdentity("bob");
    expect((await getRoom(new Request("http://localhost"), { params: Promise.resolve({ id: room.id }) })).status).toBe(404);
    expect((await patchRoomRoute(jsonRequest({ expectedRevision: 1, geometry: syntheticRoom }), { params: Promise.resolve({ id: room.id }) })).status).toBe(404);
    expect((await getItem(new Request("http://localhost"), { params: Promise.resolve({ id: item.id }) })).status).toBe(404);
    expect((await patchItemRoute(jsonRequest({ expectedVersion: 1, title: "Changed" }), { params: Promise.resolve({ id: item.id }) })).status).toBe(404);
    expect((await publishItemRoute(jsonRequest({ expectedVersion: 1 }), { params: Promise.resolve({ id: item.id }) })).status).toBe(404);
    expect((await getAsset(new Request("http://localhost"), { params: Promise.resolve({ id: photo.id }) })).status).toBe(404);
    expect((await getAssetDownloadRoute(new Request("http://localhost"), { params: Promise.resolve({ id: photo.id }) })).status).toBe(404);
    expect((await putUploadContent(new Request("http://localhost", { method: "PUT", body: new Uint8Array() }), { params: Promise.resolve({ id: manifest.id }) })).status).toBe(404);
    expect((await finalizeUpload(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: manifest.id }) })).status).toBe(404);

    const foreignPhotoListing = await responseJson(await createItem(jsonRequest(listingBody(photo.id, "Foreign photo"))));
    const foreignPublish = await publishItemRoute(
      jsonRequest({ expectedVersion: foreignPhotoListing.version }),
      { params: Promise.resolve({ id: foreignPhotoListing.id }) },
    );
    expect(foreignPublish.status).toBe(422);

    const layout = await createLayout(jsonRequest({
      roomId: room.id,
      roomRevision: 1,
      placements: [{ itemId: item.id, listingVersion: 1, xM: 1, zM: 1, yawRad: 0 }],
      requirements: { budgetCents: 10000, pickupFrom: "2026-05-01T00:00:00.000Z", pickupTo: "2026-05-04T00:00:00.000Z" },
    }));
    expect(layout.status).toBe(404);
  });

  it("locks seller item mutations while payment inventory is unavailable", async () => {
    const seller = await ensureUser("inventory-lock-seller");
    const photo = await createPhoto(seller.id);
    setTestIdentity("inventory-lock-seller");
    const { itemId } = await createAndPublishListing(photo.id);
    const item = await prisma!.item.findUniqueOrThrow({ where: { id: itemId } });
    const pickupSlotStart = new Date("2026-05-01T00:00:00.000Z");
    const quote = await prisma!.quote.create({
      data: {
        buyerId: "inventory-lock-buyer",
        sellerId: seller.id,
        version: 1,
        environment: "sandbox",
        merchantId: "test-merchant",
        subtotalCents: 5000,
        totalCents: 5000,
        pickupSlotStart,
        pickupSlotEnd: new Date(pickupSlotStart.getTime() + 60 * 60 * 1000),
        termsVersion: "inventory-lock-test-v1",
        contentHash: "c".repeat(64),
      },
    });
    const hold = await prisma!.inventoryHold.create({
      data: {
        quoteId: quote.id,
        buyerId: "inventory-lock-buyer",
        expiresAt: new Date("2026-05-02T00:00:00.000Z"),
        idempotencyKey: randomUUID(),
        requestHash: "d".repeat(64),
      },
    });
    await prisma!.itemInventory.create({
      data: { itemId, state: "HELD", holdId: hold.id },
    });

    const patchResponse = await patchItemRoute(
      jsonRequest({ expectedVersion: item.version, title: "Locked title" }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(patchResponse.status).toBe(409);
    expect((await responseJson(patchResponse)).code).toBe("ITEM_LOCKED");
    const publishResponse = await publishItemRoute(
      jsonRequest({ expectedVersion: item.version }),
      { params: Promise.resolve({ id: itemId }) },
    );
    expect(publishResponse.status).toBe(409);
    expect((await responseJson(publishResponse)).code).toBe("ITEM_LOCKED");
  });

  it("keeps listing revisions immutable, hides exact addresses publicly, and rejects stale writes", async () => {
    const alice = await ensureUser("seller");
    const photo = await createPhoto(alice.id);
    setTestIdentity("seller");
    const { itemId } = await createAndPublishListing(photo.id, "First title");
    const ownerItem = await responseJson(await getItem(new Request("http://localhost"), { params: Promise.resolve({ id: itemId }) }));
    expect(JSON.stringify(ownerItem)).toContain("123 Private Street, Secret City");
    expect(await (await getListings()).text()).not.toContain("123 Private Street, Secret City");

    const v1 = ownerItem.versions.find((version: { version: number }) => version.version === 1);
    const firstPatch = await patchItemRoute(jsonRequest({ expectedVersion: 2, title: "Second title" }), { params: Promise.resolve({ id: itemId }) });
    expect(firstPatch.status).toBe(200);
    expect((await responseJson<Array<{ id: string; title: string }>>(await getListings())).find((listing) => listing.id === itemId)?.title).toBe("First title");
    const publishV2 = await publishItemRoute(jsonRequest({ expectedVersion: 3 }), { params: Promise.resolve({ id: itemId }) });
    expect(publishV2.status).toBe(200);
    expect((await responseJson<Array<{ id: string; title: string }>>(await getListings())).find((listing) => listing.id === itemId)?.title).toBe("Second title");
    await expect(prisma!.listingVersion.update({
      where: { itemId_version: { itemId, version: 1 } },
      data: { title: "illegal mutation" },
    })).rejects.toThrow(/immutable revision/);
    const v1After = await prisma!.listingVersion.findUnique({ where: { itemId_version: { itemId, version: 1 } } });
    expect(v1After?.title).toBe(v1.title);

    const room = await responseJson(await createRoom(jsonRequest({ name: "Room", geometry: syntheticRoom })));
    const staleLayout = await responseJson(await createLayout(jsonRequest({
      roomId: room.id,
      roomRevision: 1,
      placements: [{ itemId, listingVersion: 1, xM: 1.3, zM: 1.5, yawRad: 0 }],
      requirements: { budgetCents: 5000, pickupFrom: "2026-05-01T00:00:00.000Z", pickupTo: "2026-05-04T00:00:00.000Z" },
    })));
    const staleResponse = await checkQuotable(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: staleLayout.layout.id }) });
    expect(staleResponse.status).toBe(409);

    const roomPatch = await patchRoomRoute(jsonRequest({ expectedRevision: 1, geometry: syntheticRoom }), { params: Promise.resolve({ id: room.id }) });
    expect(roomPatch.status).toBe(200);
    const roomRow = await prisma!.roomRevision.findUnique({ where: { roomId_revision: { roomId: room.id, revision: 1 } } });
    await expect(prisma!.roomRevision.update({ where: { id: roomRow!.id }, data: { revision: 99 } })).rejects.toThrow(/immutable revision/);

    const races = await Promise.all([
      patchItemRoute(jsonRequest({ expectedVersion: 4, title: "Race A" }), { params: Promise.resolve({ id: itemId }) }),
      patchItemRoute(jsonRequest({ expectedVersion: 4, title: "Race B" }), { params: Promise.resolve({ id: itemId }) }),
    ]);
    expect(races.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("rejects an overlapping layout, accepts a fitting one, and detects stale room revisions", async () => {
    const seller = await ensureUser("layout-seller");
    const photo = await createPhoto(seller.id);
    setTestIdentity("layout-seller");
    const { itemId } = await createAndPublishListing(photo.id);
    expect(await (await getListing(new Request("http://localhost"), { params: Promise.resolve({ id: itemId }) })).text()).not.toContain(
      "123 Private Street, Secret City",
    );
    const room = await responseJson(await createRoom(jsonRequest({ name: "Bedroom", geometry: syntheticRoom })));

    const overlap = await responseJson(await createLayout(jsonRequest({
      roomId: room.id,
      roomRevision: 1,
      placements: [{ itemId, listingVersion: 1, xM: 2.9, zM: 3, yawRad: 0 }],
      requirements: { budgetCents: 5000, pickupFrom: "2026-05-01T00:00:00.000Z", pickupTo: "2026-05-04T00:00:00.000Z" },
    })));
    expect(overlap.evaluation.prefilterReasons.map((reason: { code: string }) => reason.code)).toContain("LAYOUT_DOES_NOT_FIT");
    const overlapCheck = await checkQuotable(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: overlap.layout.id }) });
    expect(overlapCheck.status).toBe(422);
    expect((await responseJson(overlapCheck)).code).toBe("LAYOUT_NOT_QUOTABLE");

    const fitting = await responseJson(await createLayout(jsonRequest({
      roomId: room.id,
      roomRevision: 1,
      placements: [{ itemId, listingVersion: 1, xM: 1.3, zM: 1.5, yawRad: 0 }],
      requirements: { budgetCents: 5000, pickupFrom: "2026-05-01T00:00:00.000Z", pickupTo: "2026-05-04T00:00:00.000Z" },
    })));
    expect(fitting.evaluation.quotable).toBe(true);
    const fitCheck = await checkQuotable(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: fitting.layout.id }) });
    expect(fitCheck.status).toBe(200);
    await expect(prisma!.layoutRevision.update({ where: { id: fitting.layout.id }, data: { quotable: false } })).rejects.toThrow(/immutable revision/);

    await patchRoomRoute(jsonRequest({ expectedRevision: 1, geometry: syntheticRoom }), { params: Promise.resolve({ id: room.id }) });
    const staleRoomCheck = await checkQuotable(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: fitting.layout.id }) });
    expect(staleRoomCheck.status).toBe(409);
  });
});
