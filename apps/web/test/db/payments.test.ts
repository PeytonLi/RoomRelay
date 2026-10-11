import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";
import { createPaymentDeps } from "../../lib/payments/deps";
import { createProviderOrder, recordApproval, captureCheckout } from "../../lib/payments/checkout";
import { startCheckout, expireHolds } from "../../lib/payments/holds";
import { requestQuote, sellerApproveQuote, buyerApproveQuote } from "../../lib/payments/quotes";
import { reconcileOrder } from "../../lib/payments/reconcile";
import { refundFull, reconcileRefund } from "../../lib/payments/refunds";
import { receivePayPalWebhook } from "../../lib/payments/webhooks";
import { HttpPayPalClient } from "../../lib/payments/paypal/client";
import { PayPalContractMock } from "../support/paypal-contract-mock";

const databaseUrl = process.env.TEST_DATABASE_URL ??
  "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const dbDescribe = process.env.ROOMRELAY_SKIP_DB_TESTS === "1" ? describe.skip : describe;
const sellerId = "t006-seller";

dbDescribe("T-006 payment integration", () => {
  let provider: PayPalContractMock;
  let deps: ReturnType<typeof createPaymentDeps>;
  let now: Date;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "paypal_webhook_events", "payment_events", "refunds",
        "payment_operations", "payment_orders", "inventory_hold_items",
        "item_inventory", "inventory_holds", "quote_lines", "quotes",
        "items", "rooms" RESTART IDENTITY CASCADE
    `);
    now = new Date("2026-10-11T12:00:00.000Z");
    provider = new PayPalContractMock();
    const paypal = new HttpPayPalClient({
      environment: "sandbox",
      clientId: "mock-client",
      clientSecret: "mock-secret",
      fetch: provider.fetch,
    });
    deps = createPaymentDeps(prisma, paypal, {
      environment: "sandbox",
      clientId: "mock-client",
      clientSecret: "mock-secret",
      merchantId: "mock-merchant",
      webhookId: "mock-webhook",
      webBaseUrl: "http://localhost:3000",
      operatorIds: ["t006-operator"],
    }, () => now);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedItem(title = "T006 item", itemSellerId = sellerId) {
    return prisma.item.create({
      data: {
        sellerId: itemSellerId,
        title,
        widthM: "0.5000",
        depthM: "0.4000",
        heightM: "0.7000",
        provenance: "ILLUSTRATIVE_GENERATED",
        status: "ACTIVE",
      },
    });
  }

  async function approvedQuote(
    buyerId: string,
    lines: Array<{ itemId: string; priceCents: number }>,
  ) {
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const quote = await requestQuote({
      buyerId,
      sellerId,
      lines,
      discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps);
    await sellerApproveQuote({ quoteId: quote.id, sellerId, contentHash: quote.contentHash }, deps);
    await buyerApproveQuote({ quoteId: quote.id, buyerId, contentHash: quote.contentHash }, deps);
    return quote;
  }

  async function checkoutFor(buyerId = "t006-buyer", itemId?: string) {
    const item = itemId ? await prisma.item.findUniqueOrThrow({ where: { id: itemId } }) : await seedItem();
    const quote = await approvedQuote(buyerId, [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId,
      quoteId: quote.id,
      idempotencyKey: `key-${buyerId}-${quote.id}`,
    }, deps);
    const order = await createProviderOrder({ orderId: checkout.id, buyerId }, deps);
    provider.approve(order.providerOrderId!);
    const approved = await recordApproval({
      orderId: order.id,
      buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    return { item, quote, checkout, order: approved };
  }

  it("TEST-08: concurrent overlapping buyers produce exactly one all-or-none hold", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const item = await seedItem(`overlap-${iteration}`);
      const buyerA = `buyer-a-${iteration}`;
      const buyerB = `buyer-b-${iteration}`;
      const [quoteA, quoteB] = await Promise.all([
        approvedQuote(buyerA, [{ itemId: item.id, priceCents: 1000 }]),
        approvedQuote(buyerB, [{ itemId: item.id, priceCents: 1000 }]),
      ]);
      const results = await Promise.allSettled([
        startCheckout({ buyerId: buyerA, quoteId: quoteA.id, idempotencyKey: `a-${iteration}` }, deps),
        startCheckout({ buyerId: buyerB, quoteId: quoteB.id, idempotencyKey: `b-${iteration}` }, deps),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect((rejected.reason as { code?: string }).code).toBe("INVENTORY_CONFLICT");
      expect(await prisma.inventoryHold.count()).toBe(iteration + 1);
      expect(await prisma.paymentOrder.count()).toBe(iteration + 1);
      expect(provider.callLog.filter((call) => call.type === "createOrder")).toHaveLength(0);
    }
  }, 180_000);

  it("TEST-08: conflicting bundle reservation leaves every other item available", async () => {
    const [x, y] = await Promise.all([seedItem("bundle-x"), seedItem("bundle-y")]);
    const quoteA = await approvedQuote("buyer-a", [{ itemId: x.id, priceCents: 1000 }]);
    await startCheckout({ buyerId: "buyer-a", quoteId: quoteA.id, idempotencyKey: "hold-x" }, deps);
    const quoteB = await approvedQuote("buyer-b", [
      { itemId: x.id, priceCents: 1000 },
      { itemId: y.id, priceCents: 2000 },
    ]);
    await expect(startCheckout({ buyerId: "buyer-b", quoteId: quoteB.id, idempotencyKey: "hold-x-y" }, deps))
      .rejects.toMatchObject({ code: "INVENTORY_CONFLICT" });
    expect(await prisma.inventoryHoldItem.count({ where: { hold: { buyerId: "buyer-b" } } })).toBe(0);
    const yInventory = await prisma.itemInventory.findUnique({ where: { itemId: y.id } });
    expect(yInventory?.state ?? "AVAILABLE").toBe("AVAILABLE");
    expect(await prisma.paymentOrder.count({ where: { buyerId: "buyer-b" } })).toBe(0);
  });

  it("TEST-08: retries preserve checkout and provider operation identity", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("same-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const input = { buyerId: "same-buyer", quoteId: quote.id, idempotencyKey: "stable-key" };
    const [first, duplicate] = await Promise.all([startCheckout(input, deps), startCheckout(input, deps)]);
    expect(first.id).toBe(duplicate.id);
    await expect(startCheckout({
      buyerId: input.buyerId,
      quoteId: (await approvedQuote("same-buyer", [{ itemId: (await seedItem()).id, priceCents: 99 }])).id,
      idempotencyKey: input.idempotencyKey,
    }, deps)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const order = await createProviderOrder({ orderId: first.id, buyerId: input.buyerId }, deps);
    const providerOrderCalls = provider.callLog.filter((call) => call.type === "createOrder");
    const operation = await prisma.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId: order.id, type: "CREATE" } },
    });
    expect(providerOrderCalls).toHaveLength(1);
    expect(providerOrderCalls[0]!.requestId).toBe(operation.requestId);
    provider.approve(order.providerOrderId!);
    await recordApproval({ orderId: order.id, buyerId: input.buyerId, providerOrderId: order.providerOrderId! }, deps);
    await captureCheckout({ orderId: order.id, buyerId: input.buyerId, providerOrderId: order.providerOrderId! }, deps);
    await captureCheckout({ orderId: order.id, buyerId: input.buyerId, providerOrderId: order.providerOrderId! }, deps);
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(1);
    expect((await prisma.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
    })).requestId).toBe(provider.callLog.find((call) => call.type === "captureOrder")?.requestId);
  });

  it("TEST-08: changed item snapshots and expired holds block capture without a provider call", async () => {
    const { item, order, checkout } = await checkoutFor();
    await prisma.item.update({ where: { id: item.id }, data: { title: "Changed after approval" } });
    const changedQuote = await approvedQuote("changed-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    await prisma.item.update({ where: { id: item.id }, data: { title: "Changed again" } });
    await expect(startCheckout({
      buyerId: "changed-buyer", quoteId: changedQuote.id, idempotencyKey: "stale",
    }, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    now = new Date(checkout.expiresAt.getTime() + 1);
    await expect(captureCheckout({
      orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId!,
    }, deps)).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(0);
  });

  it("TEST-08: capture staging and hold expiry serialize without releasing a staged payment", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const { checkout, order, item } = await checkoutFor(`expiry-race-${iteration}`);
      const expiry = checkout.expiresAt;
      now = new Date(expiry.getTime() - 1);
      const previousCaptureCalls = provider.callLog.filter((call) => call.type === "captureOrder").length;
      const [captureResult] = await Promise.allSettled([
        captureCheckout({
          orderId: order.id,
          buyerId: order.buyerId,
          providerOrderId: order.providerOrderId!,
        }, deps),
        expireHolds(expiry, deps),
      ]);
      const currentOrder = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id }, include: { hold: true } });
      const captureCalls = provider.callLog.filter((call) => call.type === "captureOrder").length - previousCaptureCalls;
      if (captureResult.status === "fulfilled") {
        expect(currentOrder.hold.state).not.toBe("EXPIRED");
        expect(["PAID", "PENDING", "RECONCILING", "EXCEPTION"]).toContain(currentOrder.status);
      } else {
        expect(captureResult.reason.code).toBe("HOLD_EXPIRED");
        expect(currentOrder.hold.state).toBe("EXPIRED");
        expect(captureCalls).toBe(0);
        expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state).toBe("AVAILABLE");
      }
    }
  }, 180_000);

  it("TEST-09: a late provider capture cannot disturb inventory held by a later buyer", async () => {
    const first = await checkoutFor("late-capture-buyer");
    provider.approve(first.order.providerOrderId!);
    const expiry = first.checkout.expiresAt;
    expect(await expireHolds(expiry, deps)).toBe(1);
    const secondQuote = await approvedQuote("replacement-buyer", [{ itemId: first.item.id, priceCents: 1234 }]);
    const secondCheckout = await startCheckout({
      buyerId: "replacement-buyer",
      quoteId: secondQuote.id,
      idempotencyKey: "replacement-hold",
    }, deps);
    const secondHold = await prisma.inventoryHold.findUniqueOrThrow({ where: { id: secondCheckout.holdId } });
    await deps.paypal.captureOrder(first.order.providerOrderId!, "late-capture-request");
    const reconciled = await reconcileOrder(first.order.id, deps);
    expect(reconciled?.status).toBe("EXCEPTION");
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: secondHold.id } })).state).toBe("ACTIVE");
    const inventory = await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: first.item.id } });
    expect(inventory.state).toBe("HELD");
    expect(inventory.holdId).toBe(secondHold.id);
  });

  it("TEST-09: staged and uncertain captures reconcile with one request identity", async () => {
    for (const fault of ["stage", "network-before", "network-after"] as const) {
      const { order } = await checkoutFor(`buyer-${fault}`);
      if (fault === "stage") {
        deps.hooks = { afterCaptureStaged: async () => { throw new Error("simulated crash"); } };
      } else {
        provider.injectFault("captureOrder", { mode: fault });
      }
      if (fault === "stage") {
        await expect(captureCheckout({
          orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId!,
        }, deps)).rejects.toThrow();
      } else {
        await expect(captureCheckout({
          orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId!,
        }, deps)).resolves.toMatchObject({ status: "RECONCILING" });
      }
      const operationBefore = await prisma.paymentOperation.findUniqueOrThrow({
        where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
      });
      deps.hooks = {};
      const final = await reconcileOrder(order.id, deps);
      expect(final?.status).toBe("PAID");
      const operationAfter = await prisma.paymentOperation.findUniqueOrThrow({
        where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
      });
      expect(operationAfter.requestId).toBe(operationBefore.requestId);
      expect(provider.callLog.filter((call) => call.type === "captureOrder" && call.requestId === operationBefore.requestId).length)
        .toBe(fault === "network-before" ? 2 : 1);
    }
  }, 180_000);

  it("TEST-09: pending and declined captures preserve their distinct inventory outcomes", async () => {
    const pending = await checkoutFor("pending-buyer");
    provider.setCaptureOutcome("PENDING");
    const pendingOrder = await captureCheckout({
      orderId: pending.order.id,
      buyerId: pending.order.buyerId,
      providerOrderId: pending.order.providerOrderId!,
    }, deps);
    expect(pendingOrder.status).toBe("PENDING");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: pending.item.id } })).state)
      .toBe("PAYMENT_PENDING");
    expect(await expireHolds(new Date(pending.checkout.expiresAt.getTime() + 1), deps)).toBe(0);
    const capture = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: pending.order.id } });
    provider.completePendingCapture(capture.providerCaptureId!);
    expect((await reconcileOrder(capture.id, deps))?.status).toBe("PAID");
    const declined = await checkoutFor("declined-buyer");
    provider.setCaptureOutcome("DECLINED");
    const failed = await captureCheckout({
      orderId: declined.order.id,
      buyerId: declined.order.buyerId,
      providerOrderId: declined.order.providerOrderId!,
    }, deps);
    expect(failed.status).toBe("FAILED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: declined.item.id } })).state)
      .toBe("AVAILABLE");
  });

  it("TEST-09: capture fact tampering is quarantined and never marks PAID", async () => {
    for (const tamper of [{ amountValue: "999.99" }, { merchantId: "wrong-merchant" }]) {
      const { order } = await checkoutFor(`tamper-${Object.keys(tamper)[0]}`);
      provider.tamperNext("captureOrder", tamper);
      try {
        await captureCheckout({
          orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId!,
        }, deps);
      } catch (error) {
        expect(error).toMatchObject({ code: "ORDER_BINDING_MISMATCH" });
      }
      const result = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
      expect(result.status).toBe("EXCEPTION");
      expect(result.operatorAttention).toBe(true);
    }
  });

  it("TEST-09: a verified duplicate capture webhook reconciles authoritative provider facts", async () => {
    const { order } = await checkoutFor("webhook-buyer");
    deps.hooks = { afterProviderCapture: async () => { throw new Error("simulated database failure"); } };
    await expect(captureCheckout({
      orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId!,
    }, deps)).rejects.toThrow();
    deps.hooks = {};
    const event = JSON.stringify({
      id: "event-capture-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: {
        id: "MOCK-CAPTURE-1",
        status: "COMPLETED",
        payee: { merchant_id: "mock-merchant" },
        supplementary_data: { related_ids: { order_id: order.providerOrderId } },
      },
    });
    const headers = provider.signEvent(event);
    expect(await receivePayPalWebhook({ headers, rawBody: event }, deps))
      .toEqual({ accepted: true, duplicate: false });
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await receivePayPalWebhook({ headers, rawBody: event }, deps))
      .toEqual({ accepted: true, duplicate: true });
    expect(await prisma.webhookEvent.count()).toBe(1);
    const outOfOrder = JSON.stringify({
      id: "event-approval-after-capture",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "checkout-order",
      resource: {
        id: order.providerOrderId,
        status: "APPROVED",
        payee: { merchant_id: "mock-merchant" },
      },
    });
    expect(await receivePayPalWebhook({
      headers: provider.signEvent(outOfOrder),
      rawBody: outOfOrder,
    }, deps)).toEqual({ accepted: true, duplicate: false });
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(1);
    const unrelatedMerchant = JSON.stringify({
      id: "event-other-merchant",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: {
        id: "MOCK-CAPTURE-1",
        status: "COMPLETED",
        payee: { merchant_id: "different-merchant" },
        supplementary_data: { related_ids: { order_id: order.providerOrderId } },
      },
    });
    await receivePayPalWebhook({
      headers: provider.signEvent(unrelatedMerchant),
      rawBody: unrelatedMerchant,
    }, deps);
    expect((await prisma.webhookEvent.findUniqueOrThrow({
      where: { environment_providerEventId: { environment: "sandbox", providerEventId: "event-other-merchant" } },
    })).processingState).toBe("IGNORED");
    const badEvent = JSON.stringify({ id: "bad-signature", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: order.providerOrderId } });
    const badHeaders = { ...provider.signEvent(badEvent), "paypal-transmission-sig": "invalid" };
    await expect(receivePayPalWebhook({ headers: badHeaders, rawBody: badEvent }, deps))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(await prisma.webhookEvent.count()).toBe(3);
  });

  it("TEST-10: full refunds are idempotent, reconcile pending, and never restock sold inventory", async () => {
    const { item, order } = await checkoutFor("refund-buyer");
    await captureCheckout({ orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId! }, deps);
    provider.setRefundOutcome("PENDING");
    const result = await refundFull({
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller",
      requestKey: "full-refund",
      reason: "Sandbox return",
    }, deps);
    expect(result.refund.status).toBe("PENDING");
    const refundId = result.refund.providerRefundId!;
    provider.completePendingRefund(refundId);
    expect((await reconcileRefund(result.refund.id, deps)).refund.status).toBe("COMPLETED");
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state).toBe("SOLD");
    await expect(refundFull({
      orderId: order.id,
      actorId: "not-the-seller",
      actorRole: "seller",
      requestKey: "unauthorized",
      reason: "Nope",
    }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("TEST-10: refund failures do not change the paid order", async () => {
    const { order } = await checkoutFor("refund-failure-buyer");
    await captureCheckout({ orderId: order.id, buyerId: order.buyerId, providerOrderId: order.providerOrderId! }, deps);
    provider.setRefundOutcome("FAILED");
    const result = await refundFull({
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller",
      requestKey: "failed-refund",
      reason: "Failure case",
    }, deps);
    expect(result.refund.status).toBe("FAILED");
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });
});
