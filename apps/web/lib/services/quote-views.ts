import type { PaymentStatus, PrismaClient } from "../generated/prisma/client";
import type { ParticipantRole, QuoteStatus, QuoteSummary, QuoteView } from "../journey/types";

const TERMINAL_ORDER_STATUSES: PaymentStatus[] = ["CANCELED", "EXPIRED", "FAILED"];
const LIVE_QUOTE_STATUSES: QuoteStatus[] = ["REQUESTED", "SELLER_APPROVED", "BUYER_APPROVED"];

type QuoteRecord = {
  id: string;
  buyerId: string;
  sellerId: string;
  version: number;
  status: QuoteStatus;
  environment: string;
  merchantId: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  roomId: string | null;
  roomRevision: number | null;
  layoutRevisionId: string | null;
  pickupSlotStart: Date;
  pickupSlotEnd: Date;
  termsVersion: string;
  acknowledgedWarnings: unknown;
  contentHash: string;
  sellerApprovedAt: Date | null;
  buyerApprovedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  lines: {
    itemId: string;
    itemUpdatedAt: Date;
    title: string;
    widthM: { toString(): string } | null;
    depthM: { toString(): string } | null;
    heightM: { toString(): string } | null;
    conditionDisclosure: string | null;
    priceCents: number;
  }[];
  orders: { id: string; status: PaymentStatus; createdAt: Date }[];
  nextQuotes: { id: string }[];
};

function decimalOrNull(value: { toString(): string } | null): number | null {
  return value === null ? null : Number(value);
}

function parseAcknowledgedWarnings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

async function quoteStaleReasons(prisma: PrismaClient, quote: QuoteRecord, now: Date): Promise<string[]> {
  const reasons: string[] = [];
  if (["SUPERSEDED", "EXPIRED", "REJECTED"].includes(quote.status)) {
    reasons.push(`STATUS_${quote.status}`);
  }
  if (quote.expiresAt && quote.expiresAt <= now) reasons.push("QUOTE_EXPIRED");
  if (
    LIVE_QUOTE_STATUSES.includes(quote.status) &&
    !quote.orders.some((order) => !TERMINAL_ORDER_STATUSES.includes(order.status))
  ) {
    const items = await prisma.item.findMany({
      where: { id: { in: quote.lines.map((line) => line.itemId) } },
    });
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const itemChanged = quote.lines.some((line) => {
      const item = itemsById.get(line.itemId);
      return (
        !item ||
        item.status !== "ACTIVE" ||
        item.sellerId !== quote.sellerId ||
        item.updatedAt.getTime() !== line.itemUpdatedAt.getTime()
      );
    });
    if (itemChanged) reasons.push("ITEM_CHANGED");
    if (quote.roomId) {
      const room = await prisma.room.findUnique({ where: { id: quote.roomId } });
      if (!room || room.measurementRevision !== quote.roomRevision) reasons.push("ROOM_CHANGED");
    }
  }
  return reasons;
}

function latestCheckout(quote: QuoteRecord, role: ParticipantRole): { id: string; status: string } | null {
  if (role !== "BUYER" || quote.orders.length === 0) return null;
  const latest = [...quote.orders].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  return { id: latest.id, status: latest.status };
}

export async function getQuoteView(
  prisma: PrismaClient,
  userId: string,
  quoteId: string,
  now = new Date(),
): Promise<QuoteView | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      lines: true,
      orders: { select: { id: true, status: true, createdAt: true } },
      nextQuotes: { select: { id: true }, take: 1 },
    },
  });
  if (!quote || (quote.buyerId !== userId && quote.sellerId !== userId)) return null;
  const role: ParticipantRole = quote.buyerId === userId ? "BUYER" : "SELLER";
  const staleReasons = await quoteStaleReasons(prisma, quote, now);
  return {
    id: quote.id,
    version: quote.version,
    role,
    status: quote.status,
    stale: staleReasons.length > 0,
    staleReasons,
    environment: quote.environment,
    merchantId: quote.merchantId,
    currency: quote.currency,
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    totalCents: quote.totalCents,
    roomId: quote.roomId,
    roomRevision: quote.roomRevision,
    layoutRevisionId: quote.layoutRevisionId,
    pickupSlot: { start: quote.pickupSlotStart.toISOString(), end: quote.pickupSlotEnd.toISOString() },
    termsVersion: quote.termsVersion,
    contentHash: quote.contentHash,
    acknowledgedWarnings: parseAcknowledgedWarnings(quote.acknowledgedWarnings),
    sellerApprovedAt: quote.sellerApprovedAt?.toISOString() ?? null,
    buyerApprovedAt: quote.buyerApprovedAt?.toISOString() ?? null,
    expiresAt: quote.expiresAt?.toISOString() ?? null,
    createdAt: quote.createdAt.toISOString(),
    replacementQuoteId: quote.nextQuotes[0]?.id ?? null,
    lines: quote.lines.map((line) => ({
      itemId: line.itemId,
      title: line.title,
      widthM: decimalOrNull(line.widthM),
      depthM: decimalOrNull(line.depthM),
      heightM: decimalOrNull(line.heightM),
      conditionDisclosure: line.conditionDisclosure,
      priceCents: line.priceCents,
    })),
    checkout: latestCheckout(quote, role),
  };
}

export async function listQuoteViews(
  prisma: PrismaClient,
  userId: string,
  role: "buyer" | "seller",
  now = new Date(),
): Promise<QuoteSummary[]> {
  const quotes = await prisma.quote.findMany({
    where: role === "buyer" ? { buyerId: userId } : { sellerId: userId },
    include: {
      lines: true,
      orders: { select: { id: true, status: true, createdAt: true } },
      nextQuotes: { select: { id: true }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const summaries: QuoteSummary[] = [];
  for (const quote of quotes) {
    const staleReasons = await quoteStaleReasons(prisma, quote, now);
    summaries.push({
      id: quote.id,
      version: quote.version,
      role: role === "buyer" ? "BUYER" : "SELLER",
      status: quote.status,
      stale: staleReasons.length > 0,
      totalCents: quote.totalCents,
      currency: quote.currency,
      pickupSlot: { start: quote.pickupSlotStart.toISOString(), end: quote.pickupSlotEnd.toISOString() },
      expiresAt: quote.expiresAt?.toISOString() ?? null,
      createdAt: quote.createdAt.toISOString(),
      lineTitles: quote.lines.map((line) => line.title),
    });
  }
  return summaries;
}
