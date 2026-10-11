import { createHash } from "node:crypto";
import type { Prisma, Quote, QuoteLine, Room } from "../generated/prisma/client";
import { PaymentError } from "./errors";
import type { PaymentDeps, PaymentTx } from "./deps";

type QuoteLineInput = {
  itemId: string;
  priceCents: number;
  conditionDisclosure?: string;
};

export type RequestQuoteInput = {
  buyerId: string;
  sellerId: string;
  lines: QuoteLineInput[];
  discountCents: number;
  pickupSlot: { start: Date; end: Date };
  roomId?: string;
  layoutRevisionId?: string;
  termsVersion: string;
};

export type QuoteSnapshot = Prisma.QuoteGetPayload<{ include: { lines: true } }>;

function assertCents(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new PaymentError("VALIDATION", "Money must be an integer number of cents");
  }
}

function canonicalSnapshot(input: {
  buyerId: string;
  sellerId: string;
  environment: string;
  merchantId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  roomId: string | null;
  roomRevision: number | null;
  layoutRevisionId: string | null;
  pickupSlotStart: Date;
  pickupSlotEnd: Date;
  termsVersion: string;
  lines: Array<{
    itemId: string;
    itemUpdatedAt: Date;
    title: string;
    widthM: { toString(): string } | null;
    depthM: { toString(): string } | null;
    heightM: { toString(): string } | null;
    conditionDisclosure: string | null;
    priceCents: number;
  }>;
}): string {
  const stable = {
    buyerId: input.buyerId,
    sellerId: input.sellerId,
    environment: input.environment,
    merchantId: input.merchantId,
    currency: "USD",
    subtotalCents: input.subtotalCents,
    discountCents: input.discountCents,
    totalCents: input.totalCents,
    roomId: input.roomId,
    roomRevision: input.roomRevision,
    layoutRevisionId: input.layoutRevisionId,
    pickupSlotStart: input.pickupSlotStart.toISOString(),
    pickupSlotEnd: input.pickupSlotEnd.toISOString(),
    termsVersion: input.termsVersion,
    lines: [...input.lines]
      .sort((a, b) => a.itemId.localeCompare(b.itemId))
      .map((line) => ({
        itemId: line.itemId,
        itemUpdatedAt: line.itemUpdatedAt.toISOString(),
        title: line.title,
        widthM: line.widthM?.toString() ?? null,
        depthM: line.depthM?.toString() ?? null,
        heightM: line.heightM?.toString() ?? null,
        conditionDisclosure: line.conditionDisclosure,
        priceCents: line.priceCents,
      })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function createQuoteSnapshot(
  deps: PaymentDeps,
  tx: PaymentTx,
  input: RequestQuoteInput,
  version: number,
  previousQuoteId: string | null,
): Promise<QuoteSnapshot> {
  if (!input.lines.length || !input.buyerId || !input.sellerId || !input.termsVersion) {
    throw new PaymentError("VALIDATION", "A buyer, seller, item, and terms version are required");
  }
  if (input.pickupSlot.start >= input.pickupSlot.end) {
    throw new PaymentError("VALIDATION", "Pickup slot must have a positive duration");
  }
  const uniqueIds = new Set(input.lines.map((line) => line.itemId));
  if (uniqueIds.size !== input.lines.length) throw new PaymentError("VALIDATION", "Duplicate quote items are not allowed");
  const subtotalCents = input.lines.reduce((sum, line) => {
    assertCents(line.priceCents);
    const next = sum + line.priceCents;
    assertCents(next);
    return next;
  }, 0);
  assertCents(input.discountCents, true);
  if (input.discountCents >= subtotalCents) {
    throw new PaymentError("VALIDATION", "Discount must be less than the item subtotal");
  }
  const items = await tx.item.findMany({ where: { id: { in: [...uniqueIds] } } });
  if (items.length !== uniqueIds.size) throw new PaymentError("NOT_FOUND", "One or more items were not found");
  const byId = new Map(items.map((item) => [item.id, item]));
  const snapshotLines = input.lines.map((line) => {
    const item = byId.get(line.itemId)!;
    if (item.status !== "ACTIVE" || item.sellerId !== input.sellerId) {
      throw new PaymentError("QUOTE_NOT_PAYABLE", "Every item must be active and owned by the quoted seller");
    }
    return {
      itemId: item.id,
      itemUpdatedAt: item.updatedAt,
      title: item.title.slice(0, 127),
      widthM: item.widthM,
      depthM: item.depthM,
      heightM: item.heightM,
      conditionDisclosure: line.conditionDisclosure ?? null,
      priceCents: line.priceCents,
    };
  });
  let room: Room | null = null;
  if (input.roomId) {
    room = await tx.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new PaymentError("NOT_FOUND", "Room was not found");
  }
  const totalCents = subtotalCents - input.discountCents;
  const contentHash = canonicalSnapshot({
    buyerId: input.buyerId,
    sellerId: input.sellerId,
    environment: deps.config.environment,
    merchantId: deps.config.merchantId,
    subtotalCents,
    discountCents: input.discountCents,
    totalCents,
    roomId: input.roomId ?? null,
    roomRevision: room?.measurementRevision ?? null,
    layoutRevisionId: input.layoutRevisionId ?? null,
    pickupSlotStart: input.pickupSlot.start,
    pickupSlotEnd: input.pickupSlot.end,
    termsVersion: input.termsVersion,
    lines: snapshotLines,
  });
  return tx.quote.create({
    data: {
      buyerId: input.buyerId,
      sellerId: input.sellerId,
      version,
      previousQuoteId,
      environment: deps.config.environment,
      merchantId: deps.config.merchantId,
      subtotalCents,
      discountCents: input.discountCents,
      totalCents,
      roomId: input.roomId ?? null,
      roomRevision: room?.measurementRevision ?? null,
      layoutRevisionId: input.layoutRevisionId ?? null,
      pickupSlotStart: input.pickupSlot.start,
      pickupSlotEnd: input.pickupSlot.end,
      termsVersion: input.termsVersion,
      contentHash,
      lines: { create: snapshotLines },
    },
    include: { lines: true },
  });
}

export async function requestQuote(input: RequestQuoteInput, deps: PaymentDeps): Promise<QuoteSnapshot> {
  return deps.prisma.$transaction((tx) => createQuoteSnapshot(deps, tx, input, 1, null));
}

export async function sellerApproveQuote(
  input: { quoteId: string; sellerId: string; contentHash: string },
  deps: PaymentDeps,
): Promise<Quote> {
  const now = deps.now?.() ?? new Date();
  return deps.prisma.$transaction(async (tx) => {
    const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
    if (!quote) throw new PaymentError("NOT_FOUND", "Quote was not found");
    if (quote.sellerId !== input.sellerId) throw new PaymentError("FORBIDDEN", "Only the quoted seller can approve");
    if (quote.status !== "REQUESTED") throw new PaymentError("INVALID_STATE", "Quote is not awaiting seller approval");
    if (quote.contentHash !== input.contentHash) throw new PaymentError("QUOTE_STALE", "Quote content changed");
    const expiresAt = new Date(Math.min(now.getTime() + 24 * 60 * 60 * 1000, quote.pickupSlotStart.getTime()));
    return tx.quote.update({
      where: { id: quote.id },
      data: { status: "SELLER_APPROVED", sellerApprovedAt: now, expiresAt },
    });
  });
}

export async function buyerApproveQuote(
  input: {
    quoteId: string;
    buyerId: string;
    contentHash: string;
    acknowledgedWarnings?: unknown;
  },
  deps: PaymentDeps,
): Promise<Quote> {
  const now = deps.now?.() ?? new Date();
  const approved = await deps.prisma.$transaction(async (tx) => {
    const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
    if (!quote) throw new PaymentError("NOT_FOUND", "Quote was not found");
    if (quote.buyerId !== input.buyerId) throw new PaymentError("FORBIDDEN", "Only the quoted buyer can approve");
    if (quote.status !== "SELLER_APPROVED") throw new PaymentError("INVALID_STATE", "Quote is not awaiting buyer approval");
    if (quote.contentHash !== input.contentHash) throw new PaymentError("QUOTE_STALE", "Quote content changed");
    if (quote.expiresAt && quote.expiresAt <= now) {
      await tx.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
      return null;
    }
    return tx.quote.update({
      where: { id: quote.id },
      data: {
        status: "BUYER_APPROVED",
        buyerApprovedAt: now,
        ...(input.acknowledgedWarnings === undefined
          ? {}
          : { acknowledgedWarnings: input.acknowledgedWarnings as Prisma.InputJsonValue }),
      },
    });
  });
  if (!approved) throw new PaymentError("QUOTE_STALE", "Quote expired");
  return approved;
}

export async function reviseQuote(
  input: {
    quoteId: string;
    sellerId: string;
    changes: Partial<Pick<RequestQuoteInput, "lines" | "discountCents" | "pickupSlot" | "termsVersion">>;
  },
  deps: PaymentDeps,
): Promise<QuoteSnapshot> {
  return deps.prisma.$transaction(async (tx) => {
    const previous = await tx.quote.findUnique({ where: { id: input.quoteId }, include: { lines: true } });
    if (!previous) throw new PaymentError("NOT_FOUND", "Quote was not found");
    if (previous.sellerId !== input.sellerId) throw new PaymentError("FORBIDDEN", "Only the seller can revise a quote");
    if (["BUYER_APPROVED"].includes(previous.status)) {
      throw new PaymentError("INVALID_STATE", "Buyer-approved quote cannot be revised");
    }
    await tx.quote.update({ where: { id: previous.id }, data: { status: "SUPERSEDED" } });
    const lines = input.changes.lines ?? previous.lines.map((line) => ({
      itemId: line.itemId,
      priceCents: line.priceCents,
      ...(line.conditionDisclosure === null ? {} : { conditionDisclosure: line.conditionDisclosure }),
    }));
    return createQuoteSnapshot(
      deps,
      tx,
      {
        buyerId: previous.buyerId,
        sellerId: previous.sellerId,
        lines,
        discountCents: input.changes.discountCents ?? previous.discountCents,
        pickupSlot: input.changes.pickupSlot ?? {
          start: previous.pickupSlotStart,
          end: previous.pickupSlotEnd,
        },
        ...(previous.roomId === null ? {} : { roomId: previous.roomId }),
        ...(previous.layoutRevisionId === null ? {} : { layoutRevisionId: previous.layoutRevisionId }),
        termsVersion: input.changes.termsVersion ?? previous.termsVersion,
      },
      previous.version + 1,
      previous.id,
    );
  });
}

export async function revalidateQuote(
  tx: PaymentTx,
  quote: Quote & { lines: QuoteLine[] },
  deps: PaymentDeps,
  now: Date,
): Promise<void> {
  if (quote.status !== "BUYER_APPROVED") throw new PaymentError("QUOTE_NOT_PAYABLE", "Quote is not buyer-approved");
  if (quote.expiresAt && quote.expiresAt <= now) throw new PaymentError("QUOTE_STALE", "Quote expired");
  if (quote.environment !== deps.config.environment || quote.merchantId !== deps.config.merchantId) {
    throw new PaymentError("QUOTE_STALE", "Quote merchant or environment changed");
  }
  for (const line of quote.lines) {
    const item = await tx.item.findUnique({ where: { id: line.itemId } });
    if (
      !item ||
      item.status !== "ACTIVE" ||
      item.sellerId !== quote.sellerId ||
      item.updatedAt.getTime() !== line.itemUpdatedAt.getTime()
    ) {
      throw new PaymentError("QUOTE_STALE", "Quoted item changed");
    }
  }
  if (quote.roomId) {
    const room = await tx.room.findUnique({ where: { id: quote.roomId } });
    if (!room || room.measurementRevision !== quote.roomRevision) {
      throw new PaymentError("QUOTE_STALE", "Room measurement revision changed");
    }
  }
}
