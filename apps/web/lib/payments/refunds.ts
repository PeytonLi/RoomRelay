import { randomUUID } from "node:crypto";
import type { PaymentOrder, Refund } from "../generated/prisma/client";
import { formatUsdCents, parseUsdToCents } from "./money";
import { PaymentError } from "./errors";
import type { PaymentDeps } from "./deps";
import { PayPalHttpError, PayPalNetworkError } from "./paypal/client";
import type { PayPalRefund } from "./paypal/types";
import { transitionOrder } from "./state";

function nowFor(deps: PaymentDeps): Date {
  return deps.now?.() ?? new Date();
}

function retryDelayMs(attempts: number): number {
  return [5_000, 15_000, 60_000, 300_000, 900_000][Math.min(Math.max(attempts - 1, 0), 4)]!;
}

function isUncertain(error: unknown): boolean {
  return error instanceof PayPalNetworkError ||
    (error instanceof PayPalHttpError && error.status >= 500);
}

async function applyRefund(
  refundId: string,
  provider: PayPalRefund,
  deps: PaymentDeps,
): Promise<PaymentOrder> {
  return deps.prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { order: true },
    });
    let cents: number | null = null;
    try {
      cents = parseUsdToCents(provider.amount.value);
    } catch {
      cents = null;
    }
    if (provider.amount.currency_code !== "USD" || cents !== refund.amountCents) {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "RECONCILING",
          debugId: provider.debugId ?? null,
          lastErrorCode: "refund_amount_mismatch",
          nextAttemptAt: new Date(nowFor(deps).getTime() + 5_000),
        },
      });
      await tx.paymentOrder.update({
        where: { id: refund.orderId },
        data: { operatorAttention: true, exceptionReason: "refund_amount_mismatch" },
      });
      return refund.order;
    }
    if (provider.status === "COMPLETED") {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "COMPLETED",
          providerRefundId: provider.id,
          debugId: provider.debugId ?? null,
          nextAttemptAt: null,
        },
      });
      await tx.paymentOrder.update({
        where: { id: refund.orderId },
        data: { refundedCents: refund.amountCents, version: { increment: 1 } },
      });
      if (refund.order.status !== "REFUNDED") {
        await transitionOrder(tx, {
          orderId: refund.orderId,
          fromStatus: refund.order.status,
          toStatus: "REFUNDED",
          source: "PAYPAL",
          detail: { refundId: provider.id, amountCents: refund.amountCents, debugId: provider.debugId ?? null },
        });
      }
    } else if (provider.status === "PENDING") {
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: "PENDING", providerRefundId: provider.id, debugId: provider.debugId ?? null },
      });
    } else {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "FAILED",
          providerRefundId: provider.id,
          debugId: provider.debugId ?? null,
          lastErrorCode: provider.status,
        },
      });
    }
    return tx.paymentOrder.findUniqueOrThrow({ where: { id: refund.orderId } });
  });
}

async function markRefundUncertain(refundId: string, error: unknown, deps: PaymentDeps): Promise<void> {
  const debugId = error instanceof PayPalHttpError ? error.debugId : deps.paypal.lastDebugId;
  const refund = await deps.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  await deps.prisma.refund.update({
    where: { id: refundId },
    data: {
      status: "RECONCILING",
      nextAttemptAt: new Date(nowFor(deps).getTime() + retryDelayMs(refund.attempts)),
      debugId: debugId ?? null,
      lastErrorCode: error instanceof PayPalHttpError
        ? `${error.status}:${error.issue ?? error.providerName ?? "provider_error"}`
        : "network_error",
    },
  });
}

export async function refundFull(
  input: {
    orderId: string;
    actorId: string;
    actorRole: "seller" | "operator";
    requestKey: string;
    reason: string;
  },
  deps: PaymentDeps,
): Promise<{ order: PaymentOrder; refund: Refund }> {
  if (!input.requestKey || input.requestKey.length > 200 || !input.reason.trim()) {
    throw new PaymentError("VALIDATION", "A request key and refund reason are required");
  }
  if (input.actorRole === "operator" && !deps.config.operatorIds.includes(input.actorId)) {
    throw new PaymentError("FORBIDDEN", "Operator is not configured for payment operations");
  }
  const order = await deps.prisma.paymentOrder.findUnique({
    where: { id: input.orderId },
    include: { refund: true },
  });
  if (!order) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (input.actorRole === "seller" && order.sellerId !== input.actorId) {
    throw new PaymentError("NOT_FOUND", "Checkout was not found");
  }
  if (order.refund) {
    if (order.refund.requestKey !== input.requestKey) {
      throw new PaymentError("REFUND_NOT_ALLOWED", "A refund already exists for this payment");
    }
    const existing = order.refund;
    if (existing.status === "COMPLETED" || existing.status === "PENDING") {
      return { order, refund: existing };
    }
    return submitRefund(existing.id, deps);
  }
  if (
    order.status !== "PAID" ||
    !order.providerCaptureId ||
    order.capturedCents !== order.amountCents ||
    order.refundedCents !== 0
  ) {
    throw new PaymentError("REFUND_NOT_ALLOWED", "Only a fully captured, non-refunded payment can be refunded");
  }
  let refund: Refund;
  try {
    refund = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${order.id} FOR UPDATE`;
    const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (current.status !== "PAID" || !current.providerCaptureId || current.capturedCents !== current.amountCents) {
      throw new PaymentError("REFUND_NOT_ALLOWED", "Payment is no longer eligible for a full refund");
    }
      return tx.refund.create({
      data: {
        orderId: current.id,
        captureId: current.providerCaptureId,
        amountCents: current.capturedCents,
        requestId: randomUUID(),
        requestKey: input.requestKey,
        initiatorId: input.actorId,
        initiatorRole: input.actorRole,
        reason: input.reason.trim().slice(0, 255),
        status: "STAGED",
      },
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const existing = await deps.prisma.refund.findUnique({ where: { orderId: order.id } });
      if (existing?.requestKey === input.requestKey) return submitRefund(existing.id, deps);
      throw new PaymentError("REFUND_NOT_ALLOWED", "A refund already exists for this payment");
    }
    throw error;
  }
  return submitRefund(refund.id, deps);
}

async function submitRefund(
  refundId: string,
  deps: PaymentDeps,
  resume = false,
): Promise<{ order: PaymentOrder; refund: Refund }> {
  const stage = await deps.prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status === "COMPLETED" || refund.status === "PENDING") {
      const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: refund.orderId } });
      return { refund, order, submit: false };
    }
    if (!resume && refund.status !== "STAGED") {
      const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: refund.orderId } });
      return { refund, order, submit: false };
    }
    if (refund.status === "FAILED") {
      throw new PaymentError("REFUND_NOT_ALLOWED", "Refund previously failed");
    }
    const updated = await tx.refund.update({
      where: { id: refund.id },
      data: { status: "SUBMITTED", attempts: { increment: 1 }, nextAttemptAt: null },
    });
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: refund.orderId } });
    return { refund: updated, order, submit: true };
  });
  if (!stage.submit) return { order: stage.order, refund: stage.refund };
  try {
    const provider = await deps.paypal.refundCapture(
      stage.refund.captureId,
      {
        amount: { currency_code: "USD", value: formatUsdCents(stage.refund.amountCents) },
        invoice_id: `RR-${stage.order.id}`,
        note_to_payer: stage.refund.reason,
      },
      stage.refund.requestId,
    );
    const order = await applyRefund(stage.refund.id, provider, deps);
    const refund = await deps.prisma.refund.findUniqueOrThrow({ where: { id: stage.refund.id } });
    return { order, refund };
  } catch (error) {
    if (isUncertain(error)) {
      await markRefundUncertain(stage.refund.id, error, deps);
      const [order, refund] = await Promise.all([
        deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: stage.order.id } }),
        deps.prisma.refund.findUniqueOrThrow({ where: { id: stage.refund.id } }),
      ]);
      return { order, refund };
    }
    if (error instanceof PayPalHttpError) {
      await deps.prisma.refund.update({
        where: { id: stage.refund.id },
        data: {
          status: "FAILED",
          debugId: error.debugId ?? null,
          lastErrorCode: `${error.status}:${error.issue ?? error.providerName ?? "provider_error"}`,
        },
      });
      const [order, refund] = await Promise.all([
        deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: stage.order.id } }),
        deps.prisma.refund.findUniqueOrThrow({ where: { id: stage.refund.id } }),
      ]);
      return { order, refund };
    }
    throw error;
  }
}

export async function reconcileRefund(refundId: string, deps: PaymentDeps) {
  const refund = await deps.prisma.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new PaymentError("NOT_FOUND", "Refund was not found");
  if (refund.providerRefundId) {
    const provider = await deps.paypal.getRefund(refund.providerRefundId);
    const order = await applyRefund(refund.id, provider, deps);
    return { order, refund: await deps.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }) };
  }
  if (refund.attempts >= 5) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: "RECONCILING",
          nextAttemptAt: new Date(nowFor(deps).getTime() + 86_400_000),
          lastErrorCode: "retry_exhausted",
        },
      });
      await tx.paymentOrder.update({
        where: { id: refund.orderId },
        data: { operatorAttention: true, exceptionReason: "refund_reconciliation_exhausted" },
      });
    });
    return {
      order: await deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: refund.orderId } }),
      refund: await deps.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }),
    };
  }
  return submitRefund(refund.id, deps, true);
}

export const requestFullRefund = refundFull;
