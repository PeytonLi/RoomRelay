import type { PaymentStatus } from "../generated/prisma/client";
import type { PaymentTx } from "./deps";

const transitions: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ["PROVIDER_CREATED", "CANCELED", "EXPIRED", "FAILED", "RECONCILING", "EXCEPTION"],
  PROVIDER_CREATED: ["APPROVED", "CAPTURE_SUBMITTING", "CANCELED", "EXPIRED", "FAILED", "RECONCILING", "EXCEPTION"],
  APPROVED: ["CAPTURE_SUBMITTING", "CANCELED", "EXPIRED", "FAILED", "RECONCILING", "EXCEPTION"],
  CAPTURE_SUBMITTING: ["PENDING", "RECONCILING", "PAID", "FAILED", "EXCEPTION"],
  PENDING: ["RECONCILING", "PAID", "FAILED", "EXCEPTION"],
  RECONCILING: ["PROVIDER_CREATED", "APPROVED", "CAPTURE_SUBMITTING", "PENDING", "PAID", "CANCELED", "EXPIRED", "FAILED", "EXCEPTION"],
  PAID: ["PARTIALLY_REFUNDED", "REFUNDED", "REVERSED", "EXCEPTION"],
  PARTIALLY_REFUNDED: ["REFUNDED", "REVERSED", "EXCEPTION"],
  REFUNDED: ["REVERSED", "EXCEPTION"],
  CANCELED: ["RECONCILING", "EXCEPTION"],
  EXPIRED: ["RECONCILING", "EXCEPTION"],
  FAILED: ["RECONCILING", "EXCEPTION"],
  REVERSED: ["EXCEPTION"],
  EXCEPTION: [],
};

export async function transitionOrder(
  tx: PaymentTx,
  input: {
    orderId: string;
    fromStatus: PaymentStatus;
    toStatus: PaymentStatus;
    source: string;
    kind?: string;
    detail?: object;
  },
): Promise<void> {
  if (input.fromStatus === input.toStatus) return;
  if (!transitions[input.fromStatus].includes(input.toStatus)) {
    await tx.paymentEvent.create({
      data: {
        orderId: input.orderId,
        fromStatus: input.fromStatus,
        toStatus: input.fromStatus,
        kind: "ignored_regression",
        source: input.source,
        detail: { requestedStatus: input.toStatus, ...input.detail },
      },
    });
    return;
  }
  await tx.paymentOrder.update({
    where: { id: input.orderId },
    data: { status: input.toStatus, version: { increment: 1 } },
  });
  await tx.paymentEvent.create({
    data: {
      orderId: input.orderId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      kind: input.kind ?? "transition",
      source: input.source,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });
}

export async function releaseHold(tx: PaymentTx, holdId: string, now: Date): Promise<void> {
  await tx.itemInventory.updateMany({
    where: { holdId, state: { in: ["HELD", "PAYMENT_PENDING"] } },
    data: { state: "AVAILABLE", holdId: null, version: { increment: 1 } },
  });
  await tx.inventoryHold.update({
    where: { id: holdId },
    data: {
      state: "RELEASED",
      activeQuoteLock: null,
      releasedAt: now,
    },
  });
}

export async function protectHold(tx: PaymentTx, holdId: string): Promise<void> {
  await tx.itemInventory.updateMany({
    where: { holdId, state: "HELD" },
    data: { state: "PAYMENT_PENDING", version: { increment: 1 } },
  });
  await tx.inventoryHold.update({
    where: { id: holdId },
    data: { state: "EXCEPTION" },
  });
}
