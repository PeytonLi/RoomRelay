import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getConfig } from "../lib/env";
import { getSmokePaymentDeps } from "../lib/payments/deps";
import { createProviderOrder, recordApproval, captureCheckout } from "../lib/payments/checkout";
import { startCheckout } from "../lib/payments/holds";
import { requestQuote, sellerApproveQuote, buyerApproveQuote } from "../lib/payments/quotes";
import { refundFull, reconcileRefund } from "../lib/payments/refunds";
import { reconcileOrder } from "../lib/payments/reconcile";
import { getPayPalApiBaseUrl, PayPalHttpError } from "../lib/payments/paypal/client";
import type { PaymentDeps } from "../lib/payments/deps";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
class ApprovalTimeoutError extends Error {}
let waitingOrderId: string | undefined;

function requiredCredentialNames(): string[] {
  return [
    "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_MERCHANT_ID",
  ].filter((name) => !process.env[name]?.trim());
}

function printPayPalFailure(error: unknown): void {
  if (error instanceof PayPalHttpError) {
    console.error(`PayPal error name: ${error.providerName ?? "unknown"}`);
    console.error(`PayPal HTTP status: ${error.status}`);
    console.error(`PayPal debug id: ${error.debugId ?? "none"}`);
  }
  console.error(error instanceof Error ? error.message : "Sandbox smoke failed");
}

async function seedCheckout(deps: PaymentDeps): Promise<string> {
  const sellerId = "sandbox-smoke-seller";
  const buyerId = "sandbox-smoke-buyer";
  const item = await deps.prisma.item.create({
    data: {
      sellerId,
      title: "RoomRelay sandbox smoke item",
      widthM: "0.5000",
      depthM: "0.5000",
      heightM: "0.5000",
      provenance: "ILLUSTRATIVE_GENERATED",
      status: "ACTIVE",
    },
  });
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const quote = await requestQuote({
    buyerId,
    sellerId,
    lines: [{ itemId: item.id, priceCents: 1234 }],
    discountCents: 0,
    pickupSlot: { start, end },
    termsVersion: "t006-smoke-v1",
  }, deps);
  await sellerApproveQuote({ quoteId: quote.id, sellerId, contentHash: quote.contentHash }, deps);
  await buyerApproveQuote({ quoteId: quote.id, buyerId, contentHash: quote.contentHash }, deps);
  const checkout = await startCheckout({
    buyerId,
    quoteId: quote.id,
    idempotencyKey: `paypal-smoke-${randomUUID()}`,
  }, deps);
  return checkout.id;
}

function assertSandboxApprovalUrl(approveUrl: string): void {
  const host = new URL(approveUrl).hostname;
  if (host !== "www.sandbox.paypal.com") {
    throw new Error(`PayPal approval URL host is not the required sandbox host: ${host}`);
  }
}

async function showCreateOnly(paymentOrderId: string, deps: PaymentDeps): Promise<void> {
  const order = await createProviderOrder({
    orderId: paymentOrderId,
    buyerId: "sandbox-smoke-buyer",
  }, deps);
  if (!order.providerOrderId || !order.approveUrl) throw new Error("PayPal order did not include an approval URL");
  assertSandboxApprovalUrl(order.approveUrl);
  const providerOrder = await deps.paypal.getOrder(order.providerOrderId);
  if (!["CREATED", "PAYER_ACTION_REQUIRED"].includes(providerOrder.status)) {
    throw new Error(`PayPal order is not awaiting buyer approval: ${providerOrder.status}`);
  }
  const operation = await deps.prisma.paymentOperation.findUnique({
    where: { orderId_type: { orderId: paymentOrderId, type: "CREATE" } },
    select: { debugId: true },
  });
  console.log(`PaymentOrder id: ${order.id}`);
  console.log(`PayPal order id: ${order.providerOrderId}`);
  console.log(`PaymentOrder status: ${order.status}`);
  console.log(`PayPal status: ${providerOrder.status}`);
  console.log(`PayPal debug id: ${operation?.debugId ?? "none"}`);
  console.log(`Approve URL: ${order.approveUrl}`);
  console.log("Approve with a sandbox PERSONAL account within the 15-minute hold.");
  console.log("PENDING BUYER APPROVAL: capture/refund not run");
}

async function waitForApproval(paymentOrderId: string, deps: PaymentDeps): Promise<void> {
  const timeoutMs = getConfig().env.PAYPAL_SMOKE_APPROVAL_TIMEOUT_SECONDS * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await deps.prisma.paymentOrder.findUniqueOrThrow({
      where: { id: paymentOrderId },
      include: { hold: true },
    });
    if (order.hold.expiresAt.getTime() <= Date.now()) {
      throw new ApprovalTimeoutError("Inventory hold expired while waiting");
    }
    const provider = await deps.paypal.getOrder(order.providerOrderId!);
    if (provider.status === "APPROVED" || provider.status === "COMPLETED") return;
    await sleep(5_000);
  }
  throw new ApprovalTimeoutError(`Approval timeout for PaymentOrder ${paymentOrderId}`);
}

async function finishCheckout(paymentOrderId: string, deps: PaymentDeps): Promise<void> {
  const order = await deps.prisma.paymentOrder.findUnique({
    where: { id: paymentOrderId },
    include: { hold: true },
  });
  if (!order?.providerOrderId) throw new Error("Checkout does not have a PayPal order");
  if (order.approveUrl) assertSandboxApprovalUrl(order.approveUrl);
  await waitForApproval(paymentOrderId, deps);
  const approved = await recordApproval({
    orderId: order.id,
    buyerId: order.buyerId,
    providerOrderId: order.providerOrderId,
  }, deps);
  let captured = await captureCheckout({
    orderId: approved.id,
    buyerId: approved.buyerId,
    providerOrderId: order.providerOrderId,
  }, deps);
  const timeoutMs = getConfig().env.PAYPAL_SMOKE_APPROVAL_TIMEOUT_SECONDS * 1000;
  const deadline = Date.now() + timeoutMs;
  while (!["PAID", "FAILED", "EXCEPTION"].includes(captured.status) && Date.now() < deadline) {
    await sleep(5_000);
    captured = (await reconcileOrder(captured.id, deps))!;
  }
  const captureOperation = await deps.prisma.paymentOperation.findUnique({
    where: { orderId_type: { orderId: paymentOrderId, type: "CAPTURE" } },
    select: { debugId: true },
  });
  console.log(`Capture status: ${captured.status}`);
  console.log(`Capture id: ${captured.providerCaptureId ?? "none"}`);
  console.log(`Capture debug id: ${captureOperation?.debugId ?? "none"}`);
  if (captured.status !== "PAID") throw new Error(`Capture did not complete; final status ${captured.status}`);

  const refunded = await refundFull({
    orderId: paymentOrderId,
    actorId: "sandbox-smoke-operator",
    actorRole: "operator",
    requestKey: `sandbox-smoke-refund-${paymentOrderId}`,
    reason: "RoomRelay T-006 sandbox smoke refund",
  }, deps);
  let refund = refunded.refund;
  const refundDeadline = Date.now() + timeoutMs;
  while (refund.status === "PENDING" || refund.status === "RECONCILING" || refund.status === "SUBMITTED") {
    if (Date.now() >= refundDeadline) break;
    await sleep(5_000);
    refund = (await reconcileRefund(refund.id, deps)).refund;
  }
  const finalOrder = await deps.prisma.paymentOrder.findUniqueOrThrow({ where: { id: paymentOrderId } });
  console.log(`Refund status: ${refund.status}`);
  console.log(`Refund id: ${refund.providerRefundId ?? "none"}`);
  console.log(`Refund debug id: ${refund.debugId ?? "none"}`);
  console.log(`Final payment status: ${finalOrder.status}`);
  console.log(JSON.stringify({
    paymentOrderId,
    paypalOrderId: order.providerOrderId,
    captureId: captured.providerCaptureId,
    captureStatus: captured.status,
    captureDebugId: captureOperation?.debugId ?? null,
    refundId: refund.providerRefundId,
    refundStatus: refund.status,
    refundDebugId: refund.debugId,
    paymentStatus: finalOrder.status,
  }, null, 2));
  if (refund.status !== "COMPLETED" || finalOrder.status !== "REFUNDED") {
    throw new Error(`Full refund did not complete; final status ${refund.status}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const createOnly = args.length === 1 && args[0] === "--create-only";
  const resumeIndex = args.indexOf("--resume");
  const resumeId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  if ((!createOnly && resumeIndex < 0 && args.length > 0) ||
      (resumeIndex >= 0 && (!resumeId || args.length !== 2))) {
    throw new Error("Usage: paypal:sandbox-smoke [--create-only | --resume <paymentOrderId>]");
  }
  if (process.env.PAYPAL_ENVIRONMENT !== "sandbox") {
    throw new Error("Sandbox smoke requires PAYPAL_ENVIRONMENT=sandbox");
  }
  const missing = requiredCredentialNames();
  if (missing.length) {
    console.log(`PayPal sandbox smoke SKIPPED: credentials absent (missing: ${missing.join(", ")}). See build_status.md Known gaps.`);
    return;
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.log("PayPal sandbox smoke SKIPPED: DATABASE_URL is absent. See build_status.md Known gaps.");
    return;
  }
  const { env } = getConfig();
  const apiBase = getPayPalApiBaseUrl(env.PAYPAL_ENVIRONMENT);
  if (apiBase !== "https://api-m.sandbox.paypal.com" || env.PAYPAL_ENVIRONMENT !== "sandbox") {
    throw new Error("Sandbox smoke refuses to run unless the PayPal API base is the sandbox API");
  }
  const deps = getSmokePaymentDeps();
  if (!deps) throw new Error("Sandbox smoke configuration is incomplete");
  deps.config.operatorIds = [...new Set([...deps.config.operatorIds, "sandbox-smoke-operator"])];
  let paymentOrderId = resumeId;
  if (!paymentOrderId) paymentOrderId = await seedCheckout(deps);
  waitingOrderId = paymentOrderId;
  if (createOnly) {
    await showCreateOnly(paymentOrderId, deps);
    return;
  }
  const order = await deps.prisma.paymentOrder.findUniqueOrThrow({
    where: { id: paymentOrderId },
  });
  console.log(`PaymentOrder id: ${paymentOrderId}`);
  console.log(`PayPal order id: ${order.providerOrderId ?? "not-created"}`);
  await finishCheckout(paymentOrderId, deps);
}

main()
  .catch((error: unknown) => {
    if (error instanceof ApprovalTimeoutError) {
      console.error(`PENDING BUYER APPROVAL: capture/refund not run; PaymentOrder id: ${waitingOrderId ?? "unknown"}`);
      process.exitCode = 3;
      return;
    }
    printPayPalFailure(error);
    process.exitCode = 1;
  });
