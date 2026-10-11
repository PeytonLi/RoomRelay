import { createHash } from "node:crypto";
import type { PaymentOrder } from "../generated/prisma/client";
import { PaymentError } from "./errors";
import type { PaymentDeps, PaymentTx } from "./deps";
import { revalidateQuote } from "./quotes";

const HOLD_MS = 15 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

function isTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; meta?: { code?: string }; message?: string };
  return value.code === "P2034" ||
    value.meta?.code === "40001" ||
    value.meta?.code === "40P01" ||
    value.message?.includes("40001") === true ||
    value.message?.includes("40P01") === true;
}

async function transactionWithRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("Transaction retry limit exceeded");
}

async function readExistingCheckout(
  buyerId: string,
  idempotencyKey: string,
  requestHash: string,
  deps: PaymentDeps,
): Promise<PaymentOrder | null> {
  const hold = await deps.prisma.inventoryHold.findUnique({
    where: { buyerId_idempotencyKey: { buyerId, idempotencyKey } },
    include: { order: true },
  });
  if (!hold) return null;
  if (hold.requestHash !== requestHash) {
    throw new PaymentError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different quote");
  }
  if (!hold.order) throw new PaymentError("INVALID_STATE", "Checkout has no payment order");
  return hold.order;
}

export async function startCheckout(
  input: { buyerId: string; quoteId: string; idempotencyKey: string },
  deps: PaymentDeps,
): Promise<{ id: string; holdId: string; expiresAt: Date; status: PaymentOrder["status"] }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new PaymentError("VALIDATION", "A bounded idempotency key is required");
  }
  const requestHash = createHash("sha256").update(input.quoteId).digest("hex");
  const prior = await readExistingCheckout(input.buyerId, input.idempotencyKey, requestHash, deps);
  if (prior) {
    const hold = await deps.prisma.inventoryHold.findUniqueOrThrow({ where: { id: prior.holdId } });
    return { id: prior.id, holdId: hold.id, expiresAt: hold.expiresAt, status: prior.status };
  }
  const now = deps.now?.() ?? new Date();
  try {
    const created = await transactionWithRetry(() => deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "quotes" WHERE "id" = ${input.quoteId} FOR UPDATE`;
      const quote = await tx.quote.findUnique({
        where: { id: input.quoteId },
        include: { lines: true },
      });
      if (!quote) throw new PaymentError("NOT_FOUND", "Quote was not found");
      if (quote.buyerId !== input.buyerId) throw new PaymentError("FORBIDDEN", "Quote belongs to another buyer");
      await revalidateQuote(tx, quote, deps, now);
      const itemIds = quote.lines.map((line) => line.itemId).sort();
      if (!itemIds.length) throw new PaymentError("QUOTE_NOT_PAYABLE", "Quote has no items");
      for (const itemId of itemIds) {
        await tx.$executeRaw`
          INSERT INTO "item_inventory" ("item_id", "state", "hold_id", "version", "updated_at")
          VALUES (${itemId}, 'AVAILABLE', NULL, 0, CURRENT_TIMESTAMP)
          ON CONFLICT ("item_id") DO NOTHING
        `;
      }
      const inventory = [];
      for (const itemId of itemIds) {
        const rows = await tx.$queryRaw<Array<{ itemId: string; state: string; holdId: string | null }>>`
          SELECT "item_id" AS "itemId", "state"::text AS "state", "hold_id" AS "holdId"
          FROM "item_inventory" WHERE "item_id" = ${itemId} FOR UPDATE
        `;
        inventory.push(...rows);
      }
      if (
        inventory.length !== itemIds.length ||
        inventory.some((row) => row.state !== "AVAILABLE" || row.holdId !== null)
      ) {
        throw new PaymentError("INVENTORY_CONFLICT", "One or more quoted items are unavailable");
      }
      const expiresAt = new Date(now.getTime() + HOLD_MS);
      const hold = await tx.inventoryHold.create({
        data: {
          quoteId: quote.id,
          buyerId: input.buyerId,
          state: "ACTIVE",
          expiresAt,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          activeQuoteLock: quote.id,
          items: { create: itemIds.map((itemId) => ({ itemId })) },
        },
      });
      for (const itemId of itemIds) {
        await tx.itemInventory.update({
          where: { itemId },
          data: { state: "HELD", holdId: hold.id, version: { increment: 1 } },
        });
      }
      const order = await tx.paymentOrder.create({
        data: {
          holdId: hold.id,
          quoteId: quote.id,
          buyerId: quote.buyerId,
          sellerId: quote.sellerId,
          environment: quote.environment,
          merchantId: quote.merchantId,
          currency: "USD",
          amountCents: quote.totalCents,
          status: "CREATED",
          events: {
            create: {
              toStatus: "CREATED",
              kind: "transition",
              source: "API",
              detail: { holdId: hold.id },
            },
          },
        },
      });
      return { id: order.id, holdId: hold.id, expiresAt, status: order.status };
    }, { isolationLevel: "ReadCommitted", timeout: 10_000 }));
    return created;
  } catch (error) {
    const retryCheckout = await readExistingCheckout(input.buyerId, input.idempotencyKey, requestHash, deps);
    if (retryCheckout) {
      const retryHold = await deps.prisma.inventoryHold.findUniqueOrThrow({ where: { id: retryCheckout.holdId } });
      return {
        id: retryCheckout.id,
        holdId: retryHold.id,
        expiresAt: retryHold.expiresAt,
        status: retryCheckout.status,
      };
    }
    if (error instanceof PaymentError && error.code === "QUOTE_STALE") {
      const quote = await deps.prisma.quote.findUnique({ where: { id: input.quoteId } });
      if (quote?.expiresAt && quote.expiresAt <= now && quote.status !== "EXPIRED") {
        await deps.prisma.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
      }
    }
    if (isUniqueViolation(error)) {
      const duplicate = await readExistingCheckout(input.buyerId, input.idempotencyKey, requestHash, deps);
      if (duplicate) {
        const hold = await deps.prisma.inventoryHold.findUniqueOrThrow({ where: { id: duplicate.holdId } });
        return { id: duplicate.id, holdId: hold.id, expiresAt: hold.expiresAt, status: duplicate.status };
      }
      throw new PaymentError("INVENTORY_CONFLICT", "Another checkout already holds these items");
    }
    throw error;
  }
}

export async function getCheckout(
  input: { orderId: string; actorId: string },
  deps: PaymentDeps,
) {
  const order = await deps.prisma.paymentOrder.findUnique({
    where: { id: input.orderId },
    include: { hold: true, quote: { include: { lines: true } }, refund: true },
  });
  if (!order) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (order.buyerId !== input.actorId && order.sellerId !== input.actorId) {
    throw new PaymentError("NOT_FOUND", "Checkout was not found");
  }
  return order;
}

export async function cancelCheckout(
  input: { orderId: string; buyerId: string },
  deps: PaymentDeps,
) {
  return deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "payment_orders" WHERE "id" = ${input.orderId} FOR UPDATE
    `;
    if (!rows.length) throw new PaymentError("NOT_FOUND", "Checkout was not found");
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
    if (order.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
    await tx.$queryRaw`SELECT "id" FROM "inventory_holds" WHERE "id" = ${order.holdId} FOR UPDATE`;
    const hold = await tx.inventoryHold.findUniqueOrThrow({ where: { id: order.holdId } });
    const capture = await tx.paymentOperation.findUnique({
      where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
    });
    if (hold.state !== "ACTIVE" || capture) {
      return tx.paymentOrder.update({
        where: { id: order.id },
        data: { cancelRequestedAt: deps.now?.() ?? new Date(), version: { increment: 1 } },
      });
    }
    await tx.itemInventory.updateMany({
      where: { holdId: hold.id },
      data: { state: "AVAILABLE", holdId: null, version: { increment: 1 } },
    });
    await tx.inventoryHold.update({
      where: { id: hold.id },
      data: { state: "RELEASED", activeQuoteLock: null, releasedAt: deps.now?.() ?? new Date() },
    });
    await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "CANCELED",
        kind: "transition",
        source: "USER",
      },
    });
    return tx.paymentOrder.update({
      where: { id: order.id },
      data: { status: "CANCELED", version: { increment: 1 } },
    });
  });
}

export async function expireHolds(now: Date, deps: PaymentDeps): Promise<number> {
  const candidates = await deps.prisma.inventoryHold.findMany({
    where: { state: "ACTIVE", expiresAt: { lte: now } },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
  });
  let expired = 0;
  for (const candidate of candidates) {
    const changed = await deps.prisma.$transaction(async (tx) => {
      const order = await tx.paymentOrder.findUnique({
        where: { holdId: candidate.id },
        select: { id: true, status: true },
      });
      if (order) {
        await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${order.id} FOR UPDATE`;
      }
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "inventory_holds"
        WHERE "id" = ${candidate.id} AND "state" = 'ACTIVE' AND "expires_at" <= ${now}
        FOR UPDATE SKIP LOCKED
      `;
      if (!locked.length) return false;
      const capture = await tx.paymentOrder.findFirst({
        where: { holdId: candidate.id, operations: { some: { type: "CAPTURE" } } },
        select: { id: true },
      });
      if (capture) return false;
      const hold = await tx.inventoryHold.findUniqueOrThrow({ where: { id: candidate.id } });
      await tx.itemInventory.updateMany({
        where: { holdId: hold.id, state: "HELD" },
        data: { state: "AVAILABLE", holdId: null, version: { increment: 1 } },
      });
      await tx.inventoryHold.update({
        where: { id: hold.id },
        data: { state: "EXPIRED", activeQuoteLock: null, releasedAt: now },
      });
      if (order) {
        await tx.paymentOrder.update({
          where: { id: order.id },
          data: { status: "EXPIRED", version: { increment: 1 } },
        });
        await tx.paymentEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: "EXPIRED",
            kind: "transition",
            source: "EXPIRY",
          },
        });
      }
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

export { HOLD_MS };
