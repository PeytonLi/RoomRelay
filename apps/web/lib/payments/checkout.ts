import { randomUUID } from "node:crypto";
import type { PaymentOrder, PaymentStatus } from "../generated/prisma/client";
import { formatUsdCents, parseUsdToCents } from "./money";
import { PaymentError } from "./errors";
import type { PaymentDeps } from "./deps";
import { PayPalHttpError, PayPalNetworkError } from "./paypal/client";
import type { PayPalCapture, PayPalOrder } from "./paypal/types";
import { protectHold, releaseHold, transitionOrder } from "./state";

function nowFor(deps: PaymentDeps): Date {
  return deps.now?.() ?? new Date();
}

function retryDelayMs(attempts: number): number {
  return [5_000, 15_000, 60_000, 300_000, 900_000][Math.min(Math.max(attempts - 1, 0), 4)]!;
}

function expectedUnit(
  order: { id: string; merchantId: string; amountCents: number },
  unit: PayPalOrder["purchase_units"][number],
  options: { requirePayee?: boolean; allowCustomReference?: boolean } = {},
): void {
  let amountCents: number | null = null;
  try {
    amountCents = parseUsdToCents(unit.amount?.value ?? "");
  } catch {
    amountCents = null;
  }
  if (
    (options.allowCustomReference
      ? unit.reference_id !== order.id && unit.custom_id !== order.id
      : unit.reference_id !== order.id) ||
    (options.requirePayee && !unit.payee?.merchant_id) ||
    (unit.payee?.merchant_id && unit.payee.merchant_id !== order.merchantId) ||
    unit.amount?.currency_code !== "USD" ||
    amountCents !== order.amountCents
  ) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order does not match the saved checkout");
  }
}

function validatePayPalOrder(
  order: PaymentOrder,
  provider: PayPalOrder,
  options: { requirePayee?: boolean; allowCustomReference?: boolean } = {},
): void {
  if (provider.purchase_units.length !== 1) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order must contain exactly one purchase unit");
  }
  expectedUnit(order, provider.purchase_units[0]!, options);
  if (order.providerOrderId && provider.id !== order.providerOrderId) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order id does not match the saved checkout");
  }
}

async function readOrder(orderId: string, deps: PaymentDeps) {
  return deps.prisma.paymentOrder.findUnique({
    where: { id: orderId },
    include: { quote: { include: { lines: true } }, hold: true },
  });
}

async function setCreateFailure(
  input: { orderId: string; operationId: string; error: unknown },
  deps: PaymentDeps,
): Promise<void> {
  const now = nowFor(deps);
  const uncertain = input.error instanceof PayPalNetworkError ||
    (input.error instanceof PayPalHttpError && input.error.status >= 500);
  const debugId = input.error instanceof PayPalHttpError ? input.error.debugId : deps.paypal.lastDebugId;
  await deps.prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
    const operation = await tx.paymentOperation.findUniqueOrThrow({ where: { id: input.operationId } });
    await tx.paymentOperation.update({
      where: { id: input.operationId },
      data: {
        status: uncertain ? "UNKNOWN" : "FAILED",
        nextAttemptAt: uncertain ? new Date(now.getTime() + retryDelayMs(operation.attempts)) : null,
        debugId: debugId ?? null,
        lastErrorCode: input.error instanceof PayPalHttpError
          ? `${input.error.status}:${input.error.issue ?? input.error.providerName ?? "provider_error"}`
          : "network_error",
      },
    });
    if (!uncertain) {
      await releaseHold(tx, order.holdId, now);
      await transitionOrder(tx, {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "FAILED",
        source: "PAYPAL",
      });
    }
  });
}

export async function createPayPalOrder(
  input: { orderId: string; buyerId: string },
  deps: PaymentDeps,
): Promise<PaymentOrder> {
  const start = await readOrder(input.orderId, deps);
  if (!start) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (start.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (start.providerOrderId) return start;
  if (!["CREATED", "RECONCILING"].includes(start.status)) {
    throw new PaymentError("INVALID_STATE", "Checkout cannot create a PayPal order in its current state");
  }
  const staged = await deps.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "payment_orders" WHERE "id" = ${input.orderId} FOR UPDATE
    `;
    if (!locked.length) throw new PaymentError("NOT_FOUND", "Checkout was not found");
    const current = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: input.orderId },
      include: { quote: { include: { lines: true } }, hold: true },
    });
    if (current.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
    if (current.providerOrderId) return { order: current, operation: null };
    if (current.hold.state !== "ACTIVE" || current.hold.expiresAt <= nowFor(deps)) {
      throw new PaymentError("HOLD_EXPIRED", "Inventory hold expired");
    }
    let operation = await tx.paymentOperation.findUnique({
      where: { orderId_type: { orderId: current.id, type: "CREATE" } },
    });
    if (!operation) {
      operation = await tx.paymentOperation.create({
        data: { orderId: current.id, type: "CREATE", requestId: randomUUID(), status: "STAGED" },
      });
    }
    if (operation.status === "FAILED") {
      throw new PaymentError("INVALID_STATE", "PayPal order creation previously failed");
    }
    if (operation.status === "SUBMITTED" && operation.nextAttemptAt && operation.nextAttemptAt > nowFor(deps)) {
      return { order: current, operation: null };
    }
    await tx.paymentOperation.update({
      where: { id: operation.id },
      data: {
        status: "SUBMITTED",
        attempts: { increment: 1 },
        nextAttemptAt: new Date(nowFor(deps).getTime() + 30_000),
      },
    });
    return { order: current, operation };
  });
  if (!staged.operation) return staged.order;
  const order = staged.order;
  const subtotalCents = order.quote.lines.reduce((sum, line) => sum + line.priceCents, 0);
  const body = {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: order.id,
      custom_id: order.id,
      invoice_id: `RR-${order.id}`,
      description: "RoomRelay pickup order (sandbox)",
      payee: { merchant_id: order.merchantId },
      amount: {
        currency_code: "USD",
        value: formatUsdCents(order.amountCents),
        breakdown: {
          item_total: { currency_code: "USD", value: formatUsdCents(subtotalCents) },
          ...(order.quote.discountCents
            ? { discount: { currency_code: "USD", value: formatUsdCents(order.quote.discountCents) } }
            : {}),
        },
      },
      items: order.quote.lines.map((line) => ({
        name: line.title.slice(0, 127),
        quantity: "1",
        unit_amount: { currency_code: "USD", value: formatUsdCents(line.priceCents) },
        sku: line.itemId,
        category: "PHYSICAL_GOODS",
        ...(line.conditionDisclosure ? { description: line.conditionDisclosure.slice(0, 127) } : {}),
      })),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "RoomRelay",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: `${deps.config.webBaseUrl.replace(/\/$/, "")}/checkout/${order.id}?paypal=return`,
          cancel_url: `${deps.config.webBaseUrl.replace(/\/$/, "")}/checkout/${order.id}?paypal=cancel`,
        },
      },
    },
  };
  try {
    const provider = await deps.paypal.createOrder(body, staged.operation.requestId);
    validatePayPalOrder(order, provider);
    const approveUrl = provider.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href;
    if (!approveUrl) throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal did not return an approval link");
    await deps.prisma.$transaction(async (tx) => {
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
      await tx.paymentOperation.update({
        where: { id: staged.operation!.id },
        data: {
          status: "SUCCEEDED",
          providerRef: provider.id,
          debugId: provider.debugId ?? null,
          nextAttemptAt: null,
        },
      });
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { providerOrderId: provider.id, approveUrl, version: { increment: 1 } },
      });
      await transitionOrder(tx, {
        orderId: order.id,
        fromStatus: current.status,
        toStatus: "PROVIDER_CREATED",
        source: "PAYPAL",
        detail: { providerOrderId: provider.id, debugId: provider.debugId ?? null },
      });
    });
  } catch (error) {
    if (error instanceof PaymentError && error.code === "ORDER_BINDING_MISMATCH") {
      await deps.prisma.$transaction(async (tx) => {
        const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
        await tx.paymentOperation.update({
          where: { id: staged.operation!.id },
          data: { status: "FAILED", debugId: deps.paypal.lastDebugId ?? null, lastErrorCode: "binding_mismatch" },
        });
        await releaseHold(tx, order.holdId, nowFor(deps));
        await tx.paymentOrder.update({
          where: { id: order.id },
          data: { operatorAttention: true, exceptionReason: "provider_binding_mismatch" },
        });
        await transitionOrder(tx, {
          orderId: order.id,
          fromStatus: current.status,
          toStatus: "FAILED",
          source: "PAYPAL",
        });
      });
      throw error;
    }
    if (error instanceof PayPalHttpError || error instanceof PayPalNetworkError) {
      await setCreateFailure({ orderId: order.id, operationId: staged.operation.id, error }, deps);
      throw new PaymentError("PROVIDER_UNAVAILABLE", "PayPal order creation did not complete", true);
    }
    throw error;
  }
  return (await readOrder(order.id, deps))!;
}

export const createProviderOrder = createPayPalOrder;

export async function recordApproval(
  input: { orderId: string; buyerId: string; providerOrderId: string },
  deps: PaymentDeps,
): Promise<PaymentOrder> {
  const order = await readOrder(input.orderId, deps);
  if (!order) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (order.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (!order.providerOrderId || order.providerOrderId !== input.providerOrderId) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order id does not match the saved checkout");
  }
  let provider: PayPalOrder;
  try {
    provider = await deps.paypal.getOrder(order.providerOrderId);
  } catch {
    throw new PaymentError("PROVIDER_UNAVAILABLE", "PayPal approval status could not be checked", true);
  }
  validatePayPalOrder(order, provider);
  if (provider.status === "COMPLETED") {
    await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${order.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
      if (current.status === "PAID" || current.status === "REFUNDED") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "APPROVED",
          source: "PAYPAL",
          detail: { providerOrderId: provider.id, debugId: provider.debugId ?? null },
        });
      }
    });
    return applyProviderOrder(order, provider, deps, "RECONCILE");
  }
  if (provider.status !== "APPROVED") return order;
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${order.id} FOR UPDATE`;
    const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (current.status === "APPROVED") return current;
    await transitionOrder(tx, {
      orderId: current.id,
      fromStatus: current.status,
      toStatus: "APPROVED",
      source: "PAYPAL",
      detail: { providerOrderId: provider.id, debugId: provider.debugId ?? null },
    });
    await tx.paymentOperation.updateMany({
      where: { orderId: current.id, type: "CREATE" },
      data: { status: "SUCCEEDED", providerRef: provider.id, debugId: provider.debugId ?? null },
    });
    return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
  });
}

async function applyProviderOrder(
  saved: PaymentOrder,
  provider: PayPalOrder,
  deps: PaymentDeps,
  source: string,
): Promise<PaymentOrder> {
  if (provider.purchase_units.length === 1 && !provider.purchase_units[0]!.payee?.merchant_id) {
    provider = await deps.paypal.getOrder(saved.providerOrderId!);
  }
  try {
    validatePayPalOrder(saved, provider, { allowCustomReference: true, requirePayee: true });
  } catch (error) {
    if (!(error instanceof PaymentError) || error.code !== "ORDER_BINDING_MISMATCH") throw error;
    return deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
      await protectHold(tx, current.holdId);
      const capture = provider.purchase_units[0]?.payments?.captures?.[0];
      await tx.paymentOrder.update({
        where: { id: current.id },
        data: {
          ...(capture?.id ? { providerCaptureId: capture.id } : {}),
          operatorAttention: true,
          exceptionReason: "provider_order_binding_mismatch",
        },
      });
      if (current.status !== "EXCEPTION") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "EXCEPTION",
          source,
          detail: { providerOrderId: provider.id, debugId: provider.debugId ?? null },
        });
      }
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
    });
  }
  const unit = provider.purchase_units[0]!;
  const capture = unit.payments?.captures?.find((entry) =>
    ["COMPLETED", "PENDING", "DECLINED", "FAILED"].includes(entry.status));
  if (capture) return applyCapture(saved, capture, provider.debugId, deps, source);
  if (provider.status === "APPROVED") {
    return deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
      if (current.status !== "APPROVED") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "APPROVED",
          source,
          detail: { providerOrderId: provider.id },
        });
      }
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
    });
  }
  return saved;
}

async function applyCapture(
  saved: PaymentOrder,
  capture: PayPalCapture,
  debugId: string | undefined,
  deps: PaymentDeps,
  source: string,
): Promise<PaymentOrder> {
  let actualCents: number | null = null;
  try {
    actualCents = parseUsdToCents(capture.amount.value);
  } catch {
    actualCents = null;
  }
  if (
    capture.amount.currency_code !== "USD" ||
    actualCents !== saved.amountCents ||
    (capture.custom_id && capture.custom_id !== saved.id) ||
    (capture.invoice_id && capture.invoice_id !== `RR-${saved.id}`)
  ) {
    await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
      await protectHold(tx, current.holdId);
      await tx.paymentOrder.update({
        where: { id: current.id },
        data: { operatorAttention: true, exceptionReason: "capture_binding_mismatch" },
      });
      if (current.status !== "EXCEPTION") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "EXCEPTION",
          source,
        });
      }
    });
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal capture does not match the saved checkout");
  }
  if (capture.status === "PENDING") {
    return deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
      await tx.paymentOperation.updateMany({
        where: { orderId: current.id, type: "CAPTURE" },
        data: { status: "PENDING", providerRef: capture.id, debugId: debugId ?? null },
      });
      await tx.paymentOrder.update({
        where: { id: current.id },
        data: { providerCaptureId: capture.id, version: { increment: 1 } },
      });
      if (current.status !== "PENDING") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "PENDING",
          source,
          detail: { captureId: capture.id, debugId: debugId ?? null },
        });
      }
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
    });
  }
  if (capture.status !== "COMPLETED") {
    return deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
      const current = await tx.paymentOrder.findUniqueOrThrow({ where: { id: saved.id } });
      await tx.paymentOperation.updateMany({
        where: { orderId: current.id, type: "CAPTURE" },
        data: { status: "FAILED", providerRef: capture.id, debugId: debugId ?? null, lastErrorCode: capture.status },
      });
      await releaseHold(tx, current.holdId, nowFor(deps));
      if (current.status !== "FAILED") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "FAILED",
          source,
          detail: { captureId: capture.id, status: capture.status },
        });
      }
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
    });
  }
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${saved.id} FOR UPDATE`;
    const current = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: saved.id },
      include: { hold: true },
    });
    await tx.$queryRaw`SELECT "id" FROM "inventory_holds" WHERE "id" = ${current.holdId} FOR UPDATE`;
    if (current.status === "PAID" || current.status === "PARTIALLY_REFUNDED" || current.status === "REFUNDED") {
      return current;
    }
    if (current.hold.state !== "CAPTURE_PENDING" && current.hold.state !== "CONSUMED") {
      await tx.paymentOperation.updateMany({
        where: { orderId: current.id, type: "CAPTURE" },
        data: { status: "SUCCEEDED", providerRef: capture.id, debugId: debugId ?? null },
      });
      await tx.paymentOrder.update({
        where: { id: current.id },
        data: {
          providerCaptureId: capture.id,
          ...(actualCents === null ? {} : { capturedCents: actualCents }),
          operatorAttention: true,
          exceptionReason: "capture_after_hold_release",
          version: { increment: 1 },
        },
      });
      await tx.inventoryHold.update({
        where: { id: current.holdId },
        data: { state: "EXCEPTION" },
      });
      if (current.status !== "EXCEPTION") {
        await transitionOrder(tx, {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: "EXCEPTION",
          source,
          detail: { captureId: capture.id, debugId: debugId ?? null },
        });
      }
      return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
    }
    await tx.paymentOperation.updateMany({
      where: { orderId: current.id, type: "CAPTURE" },
      data: { status: "SUCCEEDED", providerRef: capture.id, debugId: debugId ?? null },
    });
    await tx.paymentOrder.update({
      where: { id: current.id },
      data: {
        providerCaptureId: capture.id,
        capturedCents: actualCents!,
        paidAt: nowFor(deps),
        version: { increment: 1 },
      },
    });
    await tx.inventoryHold.update({
      where: { id: current.holdId },
      data: { state: "CONSUMED" },
    });
    await tx.itemInventory.updateMany({
      where: { holdId: current.holdId },
      data: { state: "SOLD", version: { increment: 1 } },
    });
    await transitionOrder(tx, {
      orderId: current.id,
      fromStatus: current.status,
      toStatus: "PAID",
      source,
        detail: { captureId: capture.id, amountCents: actualCents!, debugId: debugId ?? null },
    });
    return tx.paymentOrder.findUniqueOrThrow({ where: { id: current.id } });
  });
}

async function markCaptureUnknown(orderId: string, error: unknown, deps: PaymentDeps): Promise<void> {
  const now = nowFor(deps);
  const debugId = error instanceof PayPalHttpError ? error.debugId : deps.paypal.lastDebugId;
  await deps.prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    const operation = await tx.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId, type: "CAPTURE" } },
    });
    await tx.paymentOperation.updateMany({
      where: { orderId, type: "CAPTURE" },
      data: {
        status: "UNKNOWN",
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(operation.attempts)),
        debugId: debugId ?? null,
        lastErrorCode: error instanceof PayPalHttpError
          ? `${error.status}:${error.issue ?? error.providerName ?? "provider_error"}`
          : "network_error",
      },
    });
    if (order.status !== "RECONCILING") {
      await transitionOrder(tx, {
        orderId,
        fromStatus: order.status,
        toStatus: "RECONCILING",
        source: "PAYPAL",
        detail: { debugId: debugId ?? null },
      });
    }
  });
}

export async function captureCheckout(
  input: { orderId: string; buyerId: string; providerOrderId: string },
  deps: PaymentDeps,
): Promise<PaymentOrder> {
  const initial = await readOrder(input.orderId, deps);
  if (!initial) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (initial.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
  if (initial.providerOrderId !== input.providerOrderId) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order id does not match the saved checkout");
  }
  if (initial.status === "PAID") return initial;
  if (initial.status === "PENDING") return initial;
  const stage = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "payment_orders" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const order = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: input.orderId },
      include: { hold: true },
    });
    await tx.$queryRaw`SELECT "id" FROM "inventory_holds" WHERE "id" = ${order.holdId} FOR UPDATE`;
    if (order.buyerId !== input.buyerId) throw new PaymentError("NOT_FOUND", "Checkout was not found");
    if (order.status === "PAID") return { order, operation: null };
    if (order.status === "EXPIRED" || order.hold.state === "EXPIRED") {
      throw new PaymentError("HOLD_EXPIRED", "Inventory hold expired before capture");
    }
    if (!["APPROVED", "CAPTURE_SUBMITTING", "RECONCILING"].includes(order.status)) {
      throw new PaymentError("INVALID_STATE", "Checkout is not ready for capture");
    }
    const hold = order.hold;
    let operation = await tx.paymentOperation.findUnique({
      where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
    });
    if (!operation) {
      if (hold.state !== "ACTIVE" || hold.expiresAt <= nowFor(deps)) {
        throw new PaymentError("HOLD_EXPIRED", "Inventory hold expired before capture");
      }
      operation = await tx.paymentOperation.create({
        data: { orderId: order.id, type: "CAPTURE", requestId: randomUUID(), status: "STAGED" },
      });
      await tx.inventoryHold.update({
        where: { id: hold.id },
        data: { state: "CAPTURE_PENDING" },
      });
      await tx.itemInventory.updateMany({
        where: { holdId: hold.id, state: "HELD" },
        data: { state: "PAYMENT_PENDING", version: { increment: 1 } },
      });
    } else if (operation.status === "SUCCEEDED") {
      return { order, operation: null };
    } else if (operation.status === "FAILED") {
      throw new PaymentError("INVALID_STATE", "Capture previously failed");
    } else if (operation.status === "PENDING") {
      return { order, operation: null };
    }
    if (order.status !== "CAPTURE_SUBMITTING") {
      await transitionOrder(tx, {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "CAPTURE_SUBMITTING",
        source: "API",
      });
    }
    return { order, operation };
  });
  if (!stage.operation) return stage.order;
  await deps.hooks?.afterCaptureStaged?.();
  await deps.prisma.paymentOperation.update({
    where: { id: stage.operation.id },
    data: { status: "SUBMITTED", attempts: { increment: 1 }, nextAttemptAt: null },
  });
  let provider: PayPalOrder;
  try {
    provider = await deps.paypal.captureOrder(input.providerOrderId, stage.operation.requestId);
  } catch (error) {
    if (error instanceof PayPalHttpError && error.status === 422 && error.issue === "ORDER_ALREADY_CAPTURED") {
      try {
        provider = await deps.paypal.getOrder(input.providerOrderId);
      } catch (getError) {
        await markCaptureUnknown(input.orderId, getError, deps);
        return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
      }
    } else if (error instanceof PayPalNetworkError || error instanceof PayPalHttpError && error.status >= 500) {
      await markCaptureUnknown(input.orderId, error, deps);
      return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
    } else if (error instanceof PayPalHttpError) {
      try {
        provider = await deps.paypal.getOrder(input.providerOrderId);
      } catch (getError) {
        await markCaptureUnknown(input.orderId, getError, deps);
        return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
      }
    } else {
      throw error;
    }
  }
  await deps.hooks?.afterProviderCapture?.();
  const current = (await readOrder(input.orderId, deps))!;
  try {
    const result = await applyProviderOrder(current, provider, deps, "PAYPAL");
    if (result.status === "APPROVED" || result.status === "CAPTURE_SUBMITTING") {
      await markCaptureUnknown(input.orderId, new Error("capture_not_authoritative"), deps);
    }
    return deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: input.orderId } });
  } catch (error) {
    if (error instanceof PaymentError && error.code === "ORDER_BINDING_MISMATCH") throw error;
    throw error;
  }
}

export async function syncProviderOrder(
  input: { orderId: string; providerOrderId?: string },
  deps: PaymentDeps,
): Promise<PaymentOrder> {
  const order = await readOrder(input.orderId, deps);
  if (!order || !order.providerOrderId) throw new PaymentError("NOT_FOUND", "PayPal order was not found");
  if (input.providerOrderId && input.providerOrderId !== order.providerOrderId) {
    throw new PaymentError("ORDER_BINDING_MISMATCH", "PayPal order id does not match the saved checkout");
  }
  const provider = await deps.paypal.getOrder(order.providerOrderId);
  return applyProviderOrder(order, provider, deps, "RECONCILE");
}

export async function forceReconcileState(
  orderId: string,
  toStatus: PaymentStatus,
  deps: PaymentDeps,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    await transitionOrder(tx, { orderId, fromStatus: order.status, toStatus, source: "RECONCILE" });
  });
}
