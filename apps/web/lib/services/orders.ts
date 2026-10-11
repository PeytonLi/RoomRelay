import type { Prisma, PrismaClient, PaymentOrder, Quote, QuoteLine, Handoff, SupportCase, OrderNote } from "../generated/prisma/client";

type Tx = Prisma.TransactionClient;

type OrderWithQuote = PaymentOrder & { quote: Quote & { lines: QuoteLine[] } };

/**
 * Lazily create the handoff row for a paid order (J-09/P-09). Only call when
 * order.paidAt != null. INSERT ... ON CONFLICT DO NOTHING so a concurrent
 * creator does not abort the surrounding transaction.
 */
export async function getOrCreateHandoff(tx: Tx, order: OrderWithQuote): Promise<Handoff> {
  // INSERT ON CONFLICT keeps a concurrent-creator race from aborting the tx.
  await tx.$executeRaw`
    INSERT INTO "handoffs" ("id", "order_id", "state", "pickup_slot_start", "pickup_slot_end", "created_at", "updated_at")
    VALUES (gen_random_uuid(), ${order.id}, 'SCHEDULED', ${order.quote.pickupSlotStart}, ${order.quote.pickupSlotEnd}, now(), now())
    ON CONFLICT ("order_id") DO NOTHING
  `;
  return tx.handoff.findUniqueOrThrow({ where: { orderId: order.id } });
}

function roleFor(order: PaymentOrder, userId: string): "BUYER" | "SELLER" | null {
  if (order.buyerId === userId) return "BUYER";
  if (order.sellerId === userId) return "SELLER";
  return null;
}

export function isOperatorId(userId: string, operatorIds: string[]): boolean {
  return operatorIds.includes(userId);
}

const orderInclude = {
  quote: { include: { lines: true } },
  refund: true,
  handoff: true,
  supportCases: { orderBy: { createdAt: "asc" as const } },
  orderNotes: { orderBy: { createdAt: "asc" as const } },
};

type LoadedOrder = PaymentOrder & {
  quote: Quote & { lines: QuoteLine[] };
  refund: { status: string; providerRefundId: string | null; amountCents: number } | null;
  handoff: Handoff | null;
  supportCases: SupportCase[];
  orderNotes: OrderNote[];
};

type Placement = { itemId: string; listingVersion: number; xM: number; zM: number; yawRad: number };

export function nextActionFor(
  order: { status: string; paidAt: Date | null },
  openCases: number,
  handoff: Handoff | null,
  role: "BUYER" | "SELLER",
): string {
  const status = order.status;
  if (status === "REFUNDED" || status === "REVERSED") return "REFUNDED";
  if (!order.paidAt) {
    if (["PENDING", "RECONCILING", "CAPTURE_SUBMITTING"].includes(status)) return "RECHECK_PAYMENT";
    return "PAY";
  }
  if (status !== "PAID" && status !== "PARTIALLY_REFUNDED") return "RECHECK_PAYMENT";
  if (openCases > 0) return "SUPPORT";
  if (handoff?.state === "COMPLETED") return "DONE";
  const acked = role === "BUYER" ? handoff?.buyerAcknowledgedAt : handoff?.sellerAcknowledgedAt;
  if (acked) return "PICKUP";
  return "ACKNOWLEDGE";
}

/** Participant-scoped order view. Returns null when the user isn't a party. */
export async function getOrderView(prisma: PrismaClient, userId: string, orderId: string) {
  let order = await prisma.paymentOrder.findUnique({ where: { id: orderId }, include: orderInclude }) as LoadedOrder | null;
  const role = order ? roleFor(order, userId) : null;
  if (!order || !role) return null;

  // Lazily materialize the handoff row for paid orders.
  if (order.paidAt && !order.handoff) {
    order = (await prisma.$transaction(async (tx) => {
      await getOrCreateHandoff(tx, order as OrderWithQuote);
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    })) as LoadedOrder;
  }

  const quote = order.quote;
  const handoff = order.handoff;

  // pickupLocations: published ListingVersion per line, grouped by address.
  let pickupLocations: { itemIds: string[]; exactPickupAddress: string }[] | null = null;
  if (handoff) {
    const itemIds = quote.lines.map((line) => line.itemId);
    const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, publishedVersion: true } });
    const versions = await prisma.listingVersion.findMany({
      where: { OR: items.filter((i) => i.publishedVersion !== null).map((i) => ({ itemId: i.id, version: i.publishedVersion! })) },
      select: { itemId: true, exactPickupAddress: true },
    });
    const addressByItem = new Map(versions.map((v) => [v.itemId, v.exactPickupAddress]));
    const groups = new Map<string, string[]>();
    for (const id of itemIds) {
      const address = addressByItem.get(id) ?? "";
      const list = groups.get(address) ?? [];
      list.push(id);
      groups.set(address, list);
    }
    pickupLocations = [...groups.entries()].map(([exactPickupAddress, ids]) => ({ itemIds: ids, exactPickupAddress }));
  }

  // placementGuide: BUYER only — the buyer's room geometry is private (J-07).
  let placementGuide = null;
  if (role === "BUYER" && quote.layoutRevisionId && quote.roomId && quote.roomRevision) {
    const layout = await prisma.layoutRevision.findUnique({ where: { id: quote.layoutRevisionId } });
    const roomRevision = await prisma.roomRevision.findUnique({
      where: { roomId_revision: { roomId: quote.roomId, revision: quote.roomRevision } },
    });
    if (layout && roomRevision) {
      const placements = (layout.placements as unknown as Placement[]) ?? [];
      const lineByItem = new Map(quote.lines.map((line) => [line.itemId, line]));
      const findings = (layout.findings as unknown as { status: string; message: string }[]) ?? [];
      placementGuide = {
        roomId: quote.roomId,
        roomRevision: quote.roomRevision,
        layoutRevisionId: layout.id,
        room: roomRevision.geometry,
        items: placements.map((placement, index) => {
          const line = lineByItem.get(placement.itemId);
          return {
            n: index + 1,
            itemId: placement.itemId,
            title: line?.title ?? "",
            xM: placement.xM,
            zM: placement.zM,
            yawRad: placement.yawRad,
            widthM: line?.widthM !== null && line?.widthM !== undefined ? Number(line.widthM) : null,
            depthM: line?.depthM !== null && line?.depthM !== undefined ? Number(line.depthM) : null,
            heightM: line?.heightM !== null && line?.heightM !== undefined ? Number(line.heightM) : null,
          };
        }),
        assumptions: findings.filter((finding) => finding.status === "WARN" || finding.status === "UNKNOWN").map((finding) => finding.message),
      };
    }
  }

  const openCases = order.supportCases.filter((supportCase) => supportCase.status === "OPEN").length;

  return {
    order: {
      id: order.id,
      role,
      status: order.status,
      environment: order.environment,
      merchantId: order.merchantId,
      currency: order.currency,
      amountCents: order.amountCents,
      capturedCents: order.capturedCents,
      refundedCents: order.refundedCents,
      paidAt: order.paidAt,
      providerOrderId: order.providerOrderId,
      providerCaptureId: order.providerCaptureId,
      refund: order.refund
        ? { status: order.refund.status, providerRefundId: order.refund.providerRefundId, amountCents: order.refund.amountCents }
        : null,
      quote: {
        id: quote.id,
        version: quote.version,
        totalCents: quote.totalCents,
        termsVersion: quote.termsVersion,
        acknowledgedWarnings: quote.acknowledgedWarnings,
        pickupSlot: { start: quote.pickupSlotStart, end: quote.pickupSlotEnd },
        lines: quote.lines.map((line) => ({
          itemId: line.itemId,
          title: line.title,
          widthM: line.widthM !== null ? Number(line.widthM) : null,
          depthM: line.depthM !== null ? Number(line.depthM) : null,
          heightM: line.heightM !== null ? Number(line.heightM) : null,
          conditionDisclosure: line.conditionDisclosure,
          priceCents: line.priceCents,
        })),
      },
      placementGuide,
      handoff: handoff
        ? {
            state: handoff.state,
            pickupSlot: { start: handoff.pickupSlotStart, end: handoff.pickupSlotEnd },
            buyerAcknowledgedAt: handoff.buyerAcknowledgedAt,
            sellerAcknowledgedAt: handoff.sellerAcknowledgedAt,
            pickupLocations: pickupLocations ?? [],
          }
        : null,
      cases: order.supportCases.map((supportCase) => ({
        id: supportCase.id,
        openedByRole: supportCase.openedByRole,
        reason: supportCase.reason,
        affectedItemIds: supportCase.affectedItemIds,
        description: supportCase.description,
        status: supportCase.status,
        resolutionNote: supportCase.resolutionNote,
        createdAt: supportCase.createdAt,
        resolvedAt: supportCase.resolvedAt,
      })),
      notes: order.orderNotes.map((note) => ({ id: note.id, authorRole: note.authorRole, body: note.body, createdAt: note.createdAt })),
      nextAction: nextActionFor(order, openCases, handoff, role),
    },
  };
}

function deriveHandoffState(ack: { buyerAcknowledgedAt: Date | null; sellerAcknowledgedAt: Date | null }): "COMPLETED" | "BUYER_ACKNOWLEDGED" | "SELLER_ACKNOWLEDGED" | "SCHEDULED" {
  if (ack.buyerAcknowledgedAt && ack.sellerAcknowledgedAt) return "COMPLETED";
  if (ack.buyerAcknowledgedAt) return "BUYER_ACKNOWLEDGED";
  if (ack.sellerAcknowledgedAt) return "SELLER_ACKNOWLEDGED";
  return "SCHEDULED";
}

export type AckResult = { kind: "not-found" } | { kind: "not-paid" } | { kind: "case-open" } | { kind: "ok"; handoff: Handoff };

/** Record the caller's pickup acknowledgment. Never touches PaymentOrder. */
export async function acknowledgePickup(prisma: PrismaClient, userId: string, orderId: string): Promise<AckResult> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId }, include: { quote: { include: { lines: true } } } }) as OrderWithQuote | null;
    const role = order ? roleFor(order, userId) : null;
    if (!order || !role) return { kind: "not-found" as const };
    if (!order.paidAt || order.status !== "PAID") return { kind: "not-paid" as const };
    const openCase = await tx.supportCase.count({ where: { orderId, status: "OPEN" } });
    if (openCase > 0) return { kind: "case-open" as const };
    await getOrCreateHandoff(tx, order);
    // Lock the handoff row so concurrent buyer/seller acks serialize.
    await tx.$queryRaw`SELECT "id" FROM "handoffs" WHERE "order_id" = ${orderId} FOR UPDATE`;
    const handoff = await tx.handoff.findUniqueOrThrow({ where: { orderId } });
    const data =
      role === "BUYER"
        ? { buyerAcknowledgedAt: handoff.buyerAcknowledgedAt ?? new Date() }
        : { sellerAcknowledgedAt: handoff.sellerAcknowledgedAt ?? new Date() };
    const merged = { buyerAcknowledgedAt: (data as { buyerAcknowledgedAt?: Date | null }).buyerAcknowledgedAt ?? handoff.buyerAcknowledgedAt, sellerAcknowledgedAt: (data as { sellerAcknowledgedAt?: Date | null }).sellerAcknowledgedAt ?? handoff.sellerAcknowledgedAt };
    return { kind: "ok" as const, handoff: await tx.handoff.update({ where: { orderId }, data: { ...data, state: deriveHandoffState(merged) } }) };
  });
}

export type IssueResult = { kind: "not-found" } | { kind: "not-paid" } | { kind: "invalid-items" } | { kind: "ok"; case: SupportCase };

export async function openIssue(
  prisma: PrismaClient,
  userId: string,
  orderId: string,
  input: { reason: "UNAVAILABLE" | "DAMAGED" | "MISSING" | "OTHER"; affectedItemIds: string[]; description: string },
): Promise<IssueResult> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId }, include: { quote: { include: { lines: true } } } }) as OrderWithQuote | null;
    const role = order ? roleFor(order, userId) : null;
    if (!order || !role) return { kind: "not-found" as const };
    if (!order.paidAt) return { kind: "not-paid" as const };
    const lineItemIds = new Set(order.quote.lines.map((line) => line.itemId));
    if (input.affectedItemIds.length === 0 || !input.affectedItemIds.every((id) => lineItemIds.has(id))) {
      return { kind: "invalid-items" as const };
    }
    const supportCase = await tx.supportCase.create({
      data: { orderId, openedById: userId, openedByRole: role, reason: input.reason, affectedItemIds: input.affectedItemIds, description: input.description },
    });
    await getOrCreateHandoff(tx, order);
    await tx.handoff.update({ where: { orderId }, data: { state: "ISSUE_OPEN" } });
    return { kind: "ok" as const, case: supportCase };
  });
}

export type ResolveResult = { kind: "not-found" } | { kind: "forbidden" } | { kind: "already-resolved" } | { kind: "ok"; case: SupportCase; handoff: Handoff };

export async function resolveIssue(
  prisma: PrismaClient,
  user: { id: string; isOperator: boolean },
  orderId: string,
  caseId: string,
  resolutionNote: string,
): Promise<ResolveResult> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId }, include: { quote: { include: { lines: true } } } }) as OrderWithQuote | null;
    if (!order) return { kind: "not-found" as const };
    const isSeller = order.sellerId === user.id;
    if (!isSeller && !user.isOperator) {
      // Non-participants get not-found; the buyer gets forbidden.
      return order.buyerId === user.id ? { kind: "forbidden" as const } : { kind: "not-found" as const };
    }
    const supportCase = await tx.supportCase.findFirst({ where: { id: caseId, orderId } });
    if (!supportCase) return { kind: "not-found" as const };
    if (supportCase.status !== "OPEN") {
      return { kind: "already-resolved" as const, case: supportCase } as ResolveResult;
    }
    const resolved = await tx.supportCase.update({
      where: { id: supportCase.id },
      data: { status: "RESOLVED", resolutionNote, resolvedById: user.id, resolvedAt: new Date() },
    });
    const remaining = await tx.supportCase.count({ where: { orderId, status: "OPEN" } });
    let handoff = await getOrCreateHandoff(tx, order);
    if (remaining === 0) {
      handoff = await tx.handoff.update({
        where: { orderId },
        data: { state: deriveHandoffState(handoff) },
      });
    }
    return { kind: "ok" as const, case: resolved, handoff };
  });
}

export type NoteResult = { kind: "not-found" } | { kind: "ok"; note: OrderNote };

export async function addOrderNote(prisma: PrismaClient, userId: string, orderId: string, body: string): Promise<NoteResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  const role = order ? roleFor(order, userId) : null;
  if (!order || !role) return { kind: "not-found" as const };
  const note = await prisma.orderNote.create({ data: { orderId, authorId: userId, authorRole: role, body } });
  return { kind: "ok" as const, note };
}

export type RelistResult = { kind: "not-found" } | { kind: "not-relistable" } | { kind: "ok"; itemId: string; version: number };

/** Copy the published ListingVersion into a new DRAFT version after a full
 * refund (P-08/J-10): inventory back to AVAILABLE, item back to DRAFT so the
 * publish flow must explicitly republish before it is public again. */
export async function relistItem(prisma: PrismaClient, userId: string, itemId: string): Promise<RelistResult> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId }, include: { versions: true, inventory: true } });
    if (!item || item.sellerId !== userId) return { kind: "not-found" as const };
    // The sold marker lives on ItemInventory.state (capture sets it to SOLD);
    // Item.status stays ACTIVE through the payment flow.
    if (item.inventory?.state !== "SOLD") return { kind: "not-relistable" as const };
    const refundedOrder = await tx.paymentOrder.findFirst({
      where: { status: "REFUNDED", quote: { lines: { some: { itemId } } } },
      select: { id: true },
    });
    if (!refundedOrder) return { kind: "not-relistable" as const };
    const published = item.versions.find((version) => version.version === item.publishedVersion);
    if (!published) return { kind: "not-relistable" as const };
    const nextVersion = item.currentVersion + 1;
    await tx.listingVersion.create({
      data: {
        itemId: item.id,
        version: nextVersion,
        title: published.title,
        category: published.category,
        widthM: published.widthM,
        depthM: published.depthM,
        heightM: published.heightM,
        dimsConfirmed: published.dimsConfirmed,
        conditionNotes: published.conditionNotes,
        conditionPhotoAssetIds: published.conditionPhotoAssetIds,
        priceCents: published.priceCents,
        currency: published.currency,
        pickupWindowStart: published.pickupWindowStart,
        pickupWindowEnd: published.pickupWindowEnd,
        coarseArea: published.coarseArea,
        exactPickupAddress: published.exactPickupAddress,
        provenance: published.provenance,
        createdById: userId,
      },
    });
    await tx.item.update({ where: { id: item.id }, data: { status: "DRAFT", currentVersion: nextVersion, version: { increment: 1 } } });
    await tx.itemInventory.upsert({
      where: { itemId: item.id },
      create: { itemId: item.id, state: "AVAILABLE", holdId: null },
      update: { state: "AVAILABLE", holdId: null },
    });
    return { kind: "ok" as const, itemId: item.id, version: nextVersion };
  });
}
