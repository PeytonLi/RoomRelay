import type { PaymentDeps } from "./deps";
import { createPayPalOrder, captureCheckout, syncProviderOrder } from "./checkout";
import { expireHolds } from "./holds";
import { reconcileRefund } from "./refunds";
import { protectHold, transitionOrder } from "./state";
import { PayPalHttpError, PayPalNetworkError } from "./paypal/client";

export async function reconcileOrder(orderId: string, deps: PaymentDeps) {
  const order = await deps.prisma.paymentOrder.findUnique({
    where: { id: orderId },
    include: { operations: true },
  });
  if (!order) return null;
  const createOperation = order.operations.find((operation) => operation.type === "CREATE");
  if (!order.providerOrderId) {
    if (createOperation && ["STAGED", "SUBMITTED", "UNKNOWN"].includes(createOperation.status)) {
      if (createOperation.attempts >= 5) {
        await deps.prisma.$transaction(async (tx) => {
          const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
          await tx.paymentOperation.update({
            where: { id: createOperation.id },
            data: {
              nextAttemptAt: new Date((deps.now?.() ?? new Date()).getTime() + 86_400_000),
              lastErrorCode: "retry_exhausted",
            },
          });
          await protectHold(tx, current.holdId);
          await tx.paymentOrder.update({
            where: { id: orderId },
            data: { operatorAttention: true, exceptionReason: "order_creation_reconciliation_exhausted" },
          });
          if (current.status !== "EXCEPTION") {
            await transitionOrder(tx, {
              orderId,
              fromStatus: current.status,
              toStatus: "EXCEPTION",
              source: "RECONCILE",
            });
          }
        });
        return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
      }
      await createPayPalOrder({ orderId, buyerId: order.buyerId }, deps);
      return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    }
    return order;
  }
  const syncedOrder = await syncProviderOrder({ orderId }, deps);
  const captureOperation = await deps.prisma.paymentOperation.findUnique({
    where: { orderId_type: { orderId, type: "CAPTURE" } },
  });
  if (
    captureOperation &&
    ["STAGED", "SUBMITTED", "UNKNOWN"].includes(captureOperation.status) &&
    ["APPROVED", "CAPTURE_SUBMITTING", "RECONCILING"].includes(syncedOrder.status)
  ) {
    const capturedOrder = await captureCheckout({
      orderId,
      buyerId: syncedOrder.buyerId,
      providerOrderId: syncedOrder.providerOrderId!,
    }, deps);
    const latestOperation = await deps.prisma.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId, type: "CAPTURE" } },
    });
    if (
      ["STAGED", "SUBMITTED", "UNKNOWN"].includes(latestOperation.status) &&
      latestOperation.attempts >= 5
    ) {
      await deps.prisma.$transaction(async (tx) => {
        const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
        await tx.paymentOperation.update({
          where: { id: latestOperation.id },
          data: {
            nextAttemptAt: new Date((deps.now?.() ?? new Date()).getTime() + 86_400_000),
            lastErrorCode: "retry_exhausted",
          },
        });
        await tx.paymentOrder.update({
          where: { id: orderId },
          data: { operatorAttention: true, exceptionReason: "reconciliation_exhausted" },
        });
        if (current.status !== "EXCEPTION") {
          await transitionOrder(tx, {
            orderId,
            fromStatus: current.status,
            toStatus: "EXCEPTION",
            source: "RECONCILE",
          });
        }
      });
      return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    }
    return capturedOrder;
  }
  return syncedOrder;
}

export async function reconcilePayments(
  deps: PaymentDeps,
  now = deps.now?.() ?? new Date(),
): Promise<{ holdsExpired: number; ordersChecked: number; refundsChecked: number; errors: number }> {
  const holdsExpired = await expireHolds(now, deps);
  const dueOperations = await deps.prisma.paymentOperation.findMany({
    where: {
      status: { in: ["STAGED", "SUBMITTED", "UNKNOWN", "PENDING"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { orderId: true },
    distinct: ["orderId"],
    orderBy: { nextAttemptAt: "asc" },
    take: 100,
  });
  let errors = 0;
  for (const operation of dueOperations) {
    try {
      await reconcileOrder(operation.orderId, deps);
    } catch {
      errors += 1;
    }
  }
  const refunds = await deps.prisma.refund.findMany({
    where: {
      status: { in: ["STAGED", "SUBMITTED", "PENDING", "RECONCILING"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true },
    take: 100,
  });
  for (const refund of refunds) {
    try {
      await reconcileRefund(refund.id, deps);
    } catch {
      errors += 1;
    }
  }
  const webhookEvents = await deps.prisma.webhookEvent.findMany({
    where: { processingState: { in: ["RECEIVED", "FAILED"] }, relatedOrderId: { not: null } },
    select: { id: true, eventType: true, resourceId: true, relatedOrderId: true },
    orderBy: { receivedAt: "asc" },
    take: 100,
  });
  for (const event of webhookEvents) {
    try {
      const orderId = event.relatedOrderId!;
      if (event.eventType === "PAYMENT.CAPTURE.REVERSED" && event.resourceId) {
        const capture = await deps.paypal.getCapture(event.resourceId);
        await deps.prisma.$transaction(async (tx) => {
          const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
          if (order.providerCaptureId === capture.id && order.status !== "REVERSED") {
            await tx.paymentOrder.update({
              where: { id: orderId },
              data: { operatorAttention: true, version: { increment: 1 } },
            });
            await transitionOrder(tx, {
              orderId,
              fromStatus: order.status,
              toStatus: "REVERSED",
              source: "RECONCILE",
              detail: { captureId: capture.id, debugId: capture.debugId },
            });
          }
        });
      } else if (
        event.eventType === "PAYMENT.CAPTURE.REFUNDED" ||
        event.eventType.startsWith("PAYMENT.REFUND.")
      ) {
        const refund = event.resourceId
          ? await deps.prisma.refund.findUnique({
              where: { providerRefundId: event.resourceId },
              select: { id: true },
            })
          : null;
        const orderRefund = !refund
          ? await deps.prisma.refund.findUnique({ where: { orderId }, select: { id: true } })
          : null;
        if (refund ?? orderRefund) await reconcileRefund((refund ?? orderRefund)!.id, deps);
      } else {
        await reconcileOrder(orderId, deps);
      }
      await deps.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processingState: "PROCESSED", processedAt: now, attempts: { increment: 1 }, lastError: null },
      });
    } catch (error) {
      errors += 1;
      await deps.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processingState: "FAILED",
          attempts: { increment: 1 },
          lastError: error instanceof PayPalHttpError || error instanceof PayPalNetworkError
            ? "provider_unavailable"
            : "processing_error",
        },
      });
    }
  }
  return {
    holdsExpired,
    ordersChecked: dueOperations.length,
    refundsChecked: refunds.length,
    errors,
  };
}
