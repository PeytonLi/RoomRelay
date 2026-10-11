import { createHash } from "node:crypto";
import type { PayPalWebhookHeaders } from "./paypal/types";
import type { PaymentDeps } from "./deps";
import { PaymentError } from "./errors";
import { PayPalHttpError, PayPalNetworkError } from "./paypal/client";
import { recordApproval } from "./checkout";
import { reconcileOrder } from "./reconcile";
import { reconcileRefund } from "./refunds";
import { transitionOrder } from "./state";

type MinimalEvent = {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code?: string; value?: string };
    supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
    payee?: { merchant_id?: string };
  };
};

function readMinimalEvent(rawBody: string): MinimalEvent {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new PaymentError("VALIDATION", "Webhook payload is not valid JSON");
  }
  if (!value || typeof value !== "object") throw new PaymentError("VALIDATION", "Webhook payload is invalid");
  const event = value as Record<string, unknown>;
  if (typeof event.id !== "string" || typeof event.event_type !== "string") {
    throw new PaymentError("VALIDATION", "Webhook event id and type are required");
  }
  const resource = event.resource && typeof event.resource === "object"
    ? event.resource as Record<string, unknown>
    : {};
  const amount = resource.amount && typeof resource.amount === "object"
    ? resource.amount as Record<string, unknown>
    : undefined;
  const supplemental = resource.supplementary_data && typeof resource.supplementary_data === "object"
    ? (resource.supplementary_data as Record<string, unknown>).related_ids
    : undefined;
  const relatedIds = supplemental && typeof supplemental === "object"
    ? supplemental as Record<string, unknown>
    : {};
  return {
    id: event.id,
    event_type: event.event_type,
    ...(typeof event.resource_type === "string" ? { resource_type: event.resource_type } : {}),
    resource: {
      ...(typeof resource.id === "string" ? { id: resource.id } : {}),
      ...(typeof resource.status === "string" ? { status: resource.status } : {}),
      ...(typeof resource.custom_id === "string" ? { custom_id: resource.custom_id } : {}),
      ...(typeof resource.invoice_id === "string" ? { invoice_id: resource.invoice_id } : {}),
      ...(amount && typeof amount.currency_code === "string" && typeof amount.value === "string"
        ? { amount: { currency_code: amount.currency_code, value: amount.value } }
        : {}),
      supplementary_data: {
        related_ids: {
          ...(typeof relatedIds.order_id === "string" ? { order_id: relatedIds.order_id } : {}),
          ...(typeof relatedIds.capture_id === "string" ? { capture_id: relatedIds.capture_id } : {}),
        },
      },
      ...(resource.payee && typeof resource.payee === "object" &&
        typeof (resource.payee as Record<string, unknown>).merchant_id === "string"
        ? { payee: { merchant_id: (resource.payee as Record<string, string>).merchant_id! } }
        : {}),
    },
  };
}

function findRelatedProviderOrderId(event: MinimalEvent): string | undefined {
  return event.resource?.supplementary_data?.related_ids?.order_id ??
    (event.event_type.startsWith("CHECKOUT.ORDER.") ? event.resource?.id : undefined);
}

export async function receivePayPalWebhook(
  input: { headers: PayPalWebhookHeaders; rawBody: string },
  deps: PaymentDeps,
): Promise<{ accepted: true; duplicate: boolean }> {
  if (!deps.config.webhookId) throw new PaymentError("PAYMENTS_UNAVAILABLE", "PayPal webhook is not configured");
  let verification: "SUCCESS" | "FAILURE";
  try {
    verification = await deps.paypal.verifyWebhookSignature({
      headers: input.headers,
      rawBody: input.rawBody,
      webhookId: deps.config.webhookId,
    });
  } catch (error) {
    if (error instanceof PayPalHttpError || error instanceof PayPalNetworkError) {
      throw new PaymentError("PROVIDER_UNAVAILABLE", "PayPal webhook verification is unavailable");
    }
    throw error;
  }
  if (verification !== "SUCCESS") throw new PaymentError("VALIDATION", "PayPal webhook signature is invalid");
  const event = readMinimalEvent(input.rawBody);
  const relatedProviderOrderId = findRelatedProviderOrderId(event);
  let relatedOrder = relatedProviderOrderId
    ? await deps.prisma.paymentOrder.findUnique({
        where: { providerOrderId: relatedProviderOrderId },
        select: { id: true },
      })
    : null;
  if (!relatedOrder && event.resource?.custom_id) {
    relatedOrder = await deps.prisma.paymentOrder.findUnique({
      where: { id: event.resource.custom_id },
      select: { id: true },
    });
  }
  if (!relatedOrder && event.resource?.supplementary_data?.related_ids?.capture_id) {
    relatedOrder = await deps.prisma.paymentOrder.findUnique({
      where: { providerCaptureId: event.resource.supplementary_data.related_ids.capture_id },
      select: { id: true },
    });
  }
  if (!relatedOrder && event.event_type.startsWith("PAYMENT.CAPTURE.") && event.resource?.id) {
    relatedOrder = await deps.prisma.paymentOrder.findUnique({
      where: { providerCaptureId: event.resource.id },
      select: { id: true },
    });
  }
  const minimal = {
    id: event.id,
    eventType: event.event_type,
    resourceType: event.resource_type ?? null,
    resourceId: event.resource?.id ?? null,
    resourceStatus: event.resource?.status ?? null,
    merchantId: event.resource?.payee?.merchant_id ?? null,
    relatedProviderOrderId: relatedProviderOrderId ?? null,
    amount: event.resource?.amount ?? null,
  };
  let stored;
  try {
    stored = await deps.prisma.webhookEvent.create({
      data: {
        environment: deps.config.environment,
        providerEventId: event.id,
        eventType: event.event_type,
        resourceType: event.resource_type ?? null,
        resourceId: event.resource?.id ?? null,
        relatedOrderId: relatedOrder?.id ?? null,
        payloadSha256: createHash("sha256").update(input.rawBody).digest("hex"),
        minimal,
        verificationStatus: "SUCCESS",
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return { accepted: true, duplicate: true };
    }
    throw error;
  }
  try {
    if (event.resource?.payee?.merchant_id && event.resource.payee.merchant_id !== deps.config.merchantId) {
      await deps.prisma.webhookEvent.update({
        where: { id: stored.id },
        data: { processingState: "IGNORED", processedAt: new Date() },
      });
      return { accepted: true, duplicate: false };
    }
    let processed = false;
    if (event.event_type === "CHECKOUT.ORDER.APPROVED" && relatedOrder) {
      const order = await deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: relatedOrder.id } });
      if (order.providerOrderId) {
        await recordApproval({
          orderId: order.id,
          buyerId: order.buyerId,
          providerOrderId: order.providerOrderId,
        }, deps);
        processed = true;
      }
    } else if (
      relatedOrder &&
      event.event_type.startsWith("PAYMENT.CAPTURE.") &&
      !event.event_type.includes(".REFUNDED") &&
      !event.event_type.includes(".REVERSED")
    ) {
      await reconcileOrder(relatedOrder.id, deps);
      processed = true;
    } else if (event.event_type === "PAYMENT.CAPTURE.REVERSED" && relatedOrder && event.resource?.id) {
      const capture = await deps.paypal.getCapture(event.resource.id);
      await deps.prisma.$transaction(async (tx) => {
        const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: relatedOrder!.id } });
        if (capture.id === order.providerCaptureId && order.status !== "REVERSED") {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { operatorAttention: true, version: { increment: 1 } },
          });
          await transitionOrder(tx, {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: "REVERSED",
            source: "PAYPAL",
            detail: { captureId: capture.id, debugId: capture.debugId },
          });
        }
      });
      processed = true;
    } else if (
      event.event_type === "PAYMENT.CAPTURE.REFUNDED" ||
      event.event_type.startsWith("PAYMENT.REFUND.")
    ) {
      const refund = event.resource?.id
        ? await deps.prisma.refund.findUnique({ where: { providerRefundId: event.resource.id }, select: { id: true } })
        : null;
      const orderId = relatedOrder?.id ??
        (event.resource?.supplementary_data?.related_ids?.capture_id
          ? (await deps.prisma.paymentOrder.findUnique({
              where: { providerCaptureId: event.resource.supplementary_data.related_ids.capture_id },
              select: { id: true },
            }))?.id
          : undefined);
      const orderRefund = !refund && orderId
        ? await deps.prisma.refund.findUnique({ where: { orderId }, select: { id: true } })
        : null;
      if (refund ?? orderRefund) {
        await reconcileRefund((refund ?? orderRefund)!.id, deps);
        processed = true;
      }
    }
    await deps.prisma.webhookEvent.update({
      where: { id: stored.id },
      data: { processingState: processed ? "PROCESSED" : "IGNORED", processedAt: new Date() },
    });
  } catch (error) {
    const code = error instanceof PaymentError ? error.code : "processing_error";
    if (error instanceof PayPalHttpError || error instanceof PayPalNetworkError) {
      await deps.prisma.webhookEvent.update({
        where: { id: stored.id },
        data: { processingState: "FAILED", attempts: { increment: 1 }, lastError: "provider_unavailable" },
      });
      return { accepted: true, duplicate: false };
    }
    await deps.prisma.webhookEvent.update({
      where: { id: stored.id },
      data: {
        processingState: "FAILED",
        attempts: { increment: 1 },
        lastError: code,
      },
    });
    return { accepted: true, duplicate: false };
  }
  return { accepted: true, duplicate: false };
}
