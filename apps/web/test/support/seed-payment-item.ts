import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../lib/generated/prisma/client";

export async function upsertPaymentSeller(prisma: PrismaClient, sellerName: string) {
  return prisma.user.upsert({
    where: { authSubject: `test:${sellerName}` },
    update: {},
    create: { authSubject: `test:${sellerName}` },
  });
}

export async function seedPublishedPaymentItem(
  prisma: PrismaClient,
  sellerName: string,
  title = "T006 item",
) {
  const seller = await upsertPaymentSeller(prisma, sellerName);
  const photo = await prisma.asset.create({
    data: {
      ownerId: seller.id,
      kind: "PHOTO",
      visibility: "APPROVED_LISTING",
      objectKey: `test/payment-seed/${randomUUID()}`,
      contentType: "image/png",
      sha256: "e".repeat(64),
      bytes: 8n,
    },
  });
  const item = await prisma.item.create({
    data: {
      sellerId: seller.id,
      status: "ACTIVE",
      version: 1,
      currentVersion: 1,
      publishedVersion: 1,
      versions: {
        create: {
          version: 1,
          title,
          widthM: "0.5000",
          depthM: "0.4000",
          heightM: "0.7000",
          dimsConfirmed: true,
          conditionPhotoAssetIds: [photo.id],
          priceCents: 1234,
          currency: "USD",
          pickupWindowStart: new Date("2026-10-11T00:00:00.000Z"),
          pickupWindowEnd: new Date("2026-10-12T00:00:00.000Z"),
          coarseArea: "Test area",
          exactPickupAddress: "Test address",
          provenance: "ILLUSTRATIVE_GENERATED",
          createdById: seller.id,
        },
      },
    },
  });
  return { seller, item, photo };
}
