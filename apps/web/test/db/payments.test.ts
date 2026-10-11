import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";
import { createPaymentDeps } from "../../lib/payments/deps";
import { createProviderOrder, recordApproval, captureCheckout } from "../../lib/payments/checkout";
import { startCheckout, expireHolds } from "../../lib/payments/holds";
import { requestQuote, sellerApproveQuote, buyerApproveQuote, reviseQuote } from "../../lib/payments/quotes";
import { reconcileOrder, reconcilePayments } from "../../lib/payments/reconcile";
import { refundFull, reconcileRefund } from "../../lib/payments/refunds";
import { receivePayPalWebhook } from "../../lib/payments/webhooks";
import { HttpPayPalClient } from "../../lib/payments/paypal/client";
import { patchItem, publishItem } from "../../lib/services/inventory";
import { POST as createCheckoutRoute } from "../../app/api/v1/checkouts/route";
import { PayPalContractMock } from "../support/paypal-contract-mock";
import { seedPublishedPaymentItem, upsertPaymentSeller } from "../support/seed-payment-item";

const databaseUrl = process.env.TEST_DATABASE_URL ??
  "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const dbDescribe = process.env.ROOMRELAY_SKIP_DB_TESTS === "1" ? describe.skip : describe;

dbDescribe("T-006 payment integration", () => {
  let provider: PayPalContractMock;
  let deps: ReturnType<typeof createPaymentDeps>;
  let now: Date;
  let sellerUser: Awaited<ReturnType<typeof upsertPaymentSeller>>;
  let sellerId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "paypal_webhook_events", "payment_events", "refunds",
        "payment_operations", "payment_orders", "inventory_hold_items",
        "item_inventory", "inventory_holds", "quote_lines", "quotes",
        "items", "rooms", "assets" RESTART IDENTITY CASCADE
    `);
    sellerUser = await upsertPaymentSeller(prisma, "t006-seller");
    sellerId = sellerUser.id;
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

  it("rejects active items without a published listing version", async () => {
    const item = await seedItem();
    await prisma.item.update({ where: { id: item.id }, data: { publishedVersion: null } });
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await expect(requestQuote({
      buyerId: "unpublished-buyer",
      sellerId,
      lines: [{ itemId: item.id, priceCents: 1234 }],
      discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps)).rejects.toMatchObject({ code: "QUOTE_NOT_PAYABLE" });
  });

  async function seedItem(title = "T006 item") {
    return (await seedPublishedPaymentItem(prisma, "t006-seller", title)).item;
  }

  async function publishNewTitle(itemId: string, title: string, widthM?: number) {
    const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fields = widthM === undefined ? { title } : { title, widthM };
    const patch = await patchItem(prisma, sellerUser, itemId, item.version, fields);
    expect(patch.kind).toBe("ok");
    if (patch.kind !== "ok") throw new Error(`Could not patch item: ${patch.kind}`);
    const patchedItem = patch.item as { version: number; updatedAt: Date };
    expect(patchedItem.updatedAt.getTime()).toBeGreaterThan(item.updatedAt.getTime());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const publish = await publishItem(prisma, sellerUser, itemId, patchedItem.version);
    expect(publish.kind).toBe("ok");
    if (publish.kind !== "ok") throw new Error(`Could not publish item: ${publish.kind}`);
    const publishedItem = publish.item as { updatedAt: Date };
    expect(publishedItem.updatedAt.getTime()).toBeGreaterThan(patchedItem.updatedAt.getTime());
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

  it("TEST-08: concurrent provider-order creates submit one CREATE operation", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("create-race-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId: "create-race-buyer",
      quoteId: quote.id,
      idempotencyKey: "create-race-key",
    }, deps);
    const [first, second] = await Promise.all([
      createProviderOrder({ orderId: checkout.id, buyerId: "create-race-buyer" }, deps),
      createProviderOrder({ orderId: checkout.id, buyerId: "create-race-buyer" }, deps),
    ]);
    expect(first.id).toBe(second.id);
    expect(provider.callLog.filter((call) => call.type === "createOrder")).toHaveLength(1);
    expect(await prisma.paymentOperation.count({
      where: { orderId: checkout.id, type: "CREATE" },
    })).toBe(1);
    expect(await prisma.paymentOrder.findUniqueOrThrow({ where: { id: checkout.id } }))
      .toMatchObject({ status: "PROVIDER_CREATED" });
  });

  it("TEST-08: create network-after retry reuses its request identity and PayPal order", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("create-timeout-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId: "create-timeout-buyer",
      quoteId: quote.id,
      idempotencyKey: "create-timeout-key",
    }, deps);
    provider.injectFault("createOrder", { mode: "network-after" });
    await expect(createProviderOrder({ orderId: checkout.id, buyerId: "create-timeout-buyer" }, deps))
      .rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const operation = await prisma.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId: checkout.id, type: "CREATE" } },
    });
    expect(operation.status).toBe("UNKNOWN");
    const retried = await createProviderOrder({ orderId: checkout.id, buyerId: "create-timeout-buyer" }, deps);
    const createCalls = provider.callLog.filter((call) => call.type === "createOrder");
    expect(createCalls).toHaveLength(2);
    expect(createCalls.map((call) => call.requestId)).toEqual([operation.requestId, operation.requestId]);
    expect(provider.createdOrderCount).toBe(1);
    expect(retried).toMatchObject({ status: "PROVIDER_CREATED", providerOrderId: "MOCK-ORDER-1" });
  });

  it("TEST-08: amount-tampered provider create releases its hold", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("create-amount-tamper", [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId: "create-amount-tamper",
      quoteId: quote.id,
      idempotencyKey: "create-amount-tamper-key",
    }, deps);
    provider.tamperNext("createOrder", { amountValue: "999.99" });
    await expect(createProviderOrder({ orderId: checkout.id, buyerId: "create-amount-tamper" }, deps))
      .rejects.toMatchObject({ code: "ORDER_BINDING_MISMATCH" });
    expect(await prisma.paymentOrder.findUniqueOrThrow({ where: { id: checkout.id } }))
      .toMatchObject({ status: "FAILED" });
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: checkout.holdId } })).state)
      .toBe("RELEASED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("AVAILABLE");
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(0);
  });

  it("TEST-08: merchant-tampered provider create releases its hold", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("create-merchant-tamper", [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId: "create-merchant-tamper",
      quoteId: quote.id,
      idempotencyKey: "create-merchant-tamper-key",
    }, deps);
    provider.tamperNext("createOrder", { merchantId: "wrong-merchant" });
    await expect(createProviderOrder({ orderId: checkout.id, buyerId: "create-merchant-tamper" }, deps))
      .rejects.toMatchObject({ code: "ORDER_BINDING_MISMATCH" });
    expect(await prisma.paymentOrder.findUniqueOrThrow({ where: { id: checkout.id } }))
      .toMatchObject({ status: "FAILED" });
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: checkout.holdId } })).state)
      .toBe("RELEASED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("AVAILABLE");
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(0);
  });

  it("TEST-08: merchant configuration changes make an approved quote stale before holding inventory", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("merchant-change-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const changedMerchantDeps = createPaymentDeps(prisma, deps.paypal, {
      environment: "sandbox",
      clientId: "mock-client",
      clientSecret: "mock-secret",
      merchantId: "different-merchant",
      webhookId: "mock-webhook",
      webBaseUrl: "http://localhost:3000",
      operatorIds: ["t006-operator"],
    }, () => now);
    await expect(startCheckout({
      buyerId: "merchant-change-buyer",
      quoteId: quote.id,
      idempotencyKey: "merchant-change-key",
    }, changedMerchantDeps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    expect(await prisma.inventoryHold.count()).toBe(0);
    expect(await prisma.itemInventory.findUnique({ where: { itemId: item.id } })).toBeNull();
  });

  it("TEST-08: seller revision supersedes the old quote and rejects a stale buyer hash", async () => {
    const item = await seedItem();
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const original = await requestQuote({
      buyerId: "revision-buyer",
      sellerId,
      lines: [{ itemId: item.id, priceCents: 1234 }],
      discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps);
    await sellerApproveQuote({ quoteId: original.id, sellerId, contentHash: original.contentHash }, deps);
    const revised = await reviseQuote({
      quoteId: original.id,
      sellerId,
      changes: { discountCents: 100 },
    }, deps);
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      status: "SUPERSEDED",
    });
    expect(revised).toMatchObject({ version: 2, previousQuoteId: original.id });
    await expect(startCheckout({
      buyerId: "revision-buyer",
      quoteId: original.id,
      idempotencyKey: "superseded-quote",
    }, deps)).rejects.toMatchObject({ code: "QUOTE_NOT_PAYABLE" });
    await sellerApproveQuote({ quoteId: revised.id, sellerId, contentHash: revised.contentHash }, deps);
    await expect(buyerApproveQuote({
      quoteId: revised.id,
      buyerId: "revision-buyer",
      contentHash: "0".repeat(64),
    }, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
  });

  it("TEST-08: capture rejects a mismatched provider order binding before calling PayPal", async () => {
    const { order } = await checkoutFor("capture-binding-buyer");
    await expect(captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: "not-the-saved-provider-order",
    }, deps)).rejects.toMatchObject({ code: "ORDER_BINDING_MISMATCH" });
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(0);
  });

  it("TEST-08: checkout route fails closed for client-supplied amount and merchant fields", async () => {
    const response = await createCheckoutRoute(new Request("http://localhost/api/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: "quote-id",
        idempotencyKey: "route-tamper",
        amountCents: 1234,
        merchantId: "attacker-merchant",
      }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "PAYMENTS_UNAVAILABLE" } });
  });

  it("TEST-08: changed item snapshots and expired holds block capture without a provider call", async () => {
    const item = await seedItem();
    await approvedQuote("changed-before-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    await publishNewTitle(item.id, "Changed after approval", 0.75);
    const changedQuote = await approvedQuote("changed-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const changedLine = await prisma.quoteLine.findFirstOrThrow({
      where: { quoteId: changedQuote.id, itemId: item.id },
    });
    expect(changedLine.title).toBe("Changed after approval");
    expect(changedLine.widthM?.toNumber()).toBe(0.75);
    await publishNewTitle(item.id, "Changed again");
    await expect(startCheckout({
      buyerId: "changed-buyer", quoteId: changedQuote.id, idempotencyKey: "stale",
    }, deps)).rejects.toMatchObject({ code: "QUOTE_STALE" });
    const { order, checkout } = await checkoutFor("expired-buyer");
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

  it("TEST-09: a paid write failure reconciles to PAID without a webhook or duplicate capture", async () => {
    const { item, checkout, order } = await checkoutFor("paid-write-failure-buyer");
    deps.hooks = { afterProviderCapture: async () => { throw new Error("simulated database failure"); } };
    await expect(captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps)).rejects.toThrow();
    deps.hooks = {};
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe("PAID");
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(1);
    expect(await prisma.webhookEvent.count()).toBe(0);

    const reconciled = await reconcileOrder(order.id, deps);
    expect(reconciled?.status).toBe("PAID");
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(1);
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: checkout.holdId } })).state)
      .toBe("CONSUMED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("SOLD");
  });

  it("TEST-09: persistent capture network failures exhaust into operator attention without releasing inventory", async () => {
    const { item, checkout, order } = await checkoutFor("capture-retry-exhaustion-buyer");
    provider.injectPersistentFault("captureOrder", { mode: "network-before" });
    const first = await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    expect(first.status).toBe("RECONCILING");

    let current = first;
    for (let attempt = 0; attempt < 6 && current.status !== "EXCEPTION"; attempt += 1) {
      current = (await reconcileOrder(order.id, deps))!;
    }
    const operation = await prisma.paymentOperation.findUniqueOrThrow({
      where: { orderId_type: { orderId: order.id, type: "CAPTURE" } },
    });
    expect(operation.attempts).toBeGreaterThanOrEqual(5);
    expect(current).toMatchObject({ status: "EXCEPTION", operatorAttention: true });
    expect((await prisma.inventoryHold.findUniqueOrThrow({ where: { id: checkout.holdId } })).state)
      .toBe("CAPTURE_PENDING");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("PAYMENT_PENDING");
  });

  it("TEST-09: an approval webhook records APPROVED without capturing or marking PAID", async () => {
    const item = await seedItem();
    const quote = await approvedQuote("approval-webhook-buyer", [{ itemId: item.id, priceCents: 1234 }]);
    const checkout = await startCheckout({
      buyerId: "approval-webhook-buyer",
      quoteId: quote.id,
      idempotencyKey: "approval-webhook-key",
    }, deps);
    const order = await createProviderOrder({ orderId: checkout.id, buyerId: "approval-webhook-buyer" }, deps);
    provider.approve(order.providerOrderId!);
    const event = JSON.stringify({
      id: "event-approval-only",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "checkout-order",
      resource: {
        id: order.providerOrderId,
        status: "APPROVED",
        payee: { merchant_id: "mock-merchant" },
      },
    });
    expect(await receivePayPalWebhook({
      headers: provider.signEvent(event),
      rawBody: event,
    }, deps)).toEqual({ accepted: true, duplicate: false });
    expect(await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } }))
      .toMatchObject({ status: "APPROVED" });
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(0);
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state).toBe("HELD");
  });

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
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await prisma.paymentEvent.count({
      where: { orderId: order.id, kind: "ignored_regression" },
    })).toBeGreaterThan(0);
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
    const orderStatusBeforeBadSignature = (await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: order.id },
    })).status;
    await expect(receivePayPalWebhook({ headers: badHeaders, rawBody: badEvent }, deps))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status)
      .toBe(orderStatusBeforeBadSignature);
    expect(await prisma.webhookEvent.count({ where: { providerEventId: "bad-signature" } })).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(3);
  });

  it("TEST-09: webhook verification HTTP and network failures are unavailable without storing events", async () => {
    const { order } = await checkoutFor("verification-failure-buyer");
    for (const [eventId, fault] of [
      ["verify-http-failure", { mode: "http" as const, status: 500 }],
      ["verify-network-failure", { mode: "network-before" as const }],
    ] as const) {
      const rawBody = JSON.stringify({
        id: eventId,
        event_type: "CHECKOUT.ORDER.APPROVED",
        resource: { id: order.providerOrderId },
      });
      provider.injectFault("verifyWebhookSignature", fault);
      await expect(receivePayPalWebhook({
        headers: provider.signEvent(rawBody),
        rawBody,
      }, deps)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(await prisma.webhookEvent.count({ where: { providerEventId: eventId } })).toBe(0);
    }
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("TEST-09: failed capture-webhook processing is retried by reconciliation", async () => {
    const { order } = await checkoutFor("webhook-retry-buyer");
    deps.hooks = { afterProviderCapture: async () => { throw new Error("simulated database failure"); } };
    await expect(captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps)).rejects.toThrow();
    deps.hooks = {};
    const rawBody = JSON.stringify({
      id: "event-capture-processing-retry",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: {
        id: "MOCK-CAPTURE-1",
        status: "COMPLETED",
        payee: { merchant_id: "mock-merchant" },
        supplementary_data: { related_ids: { order_id: order.providerOrderId } },
      },
    });
    provider.injectFault("getOrder", { mode: "network-before" });
    expect(await receivePayPalWebhook({
      headers: provider.signEvent(rawBody),
      rawBody,
    }, deps)).toEqual({ accepted: true, duplicate: false });
    expect((await prisma.webhookEvent.findUniqueOrThrow({
      where: { environment_providerEventId: {
        environment: "sandbox",
        providerEventId: "event-capture-processing-retry",
      } },
    })).processingState).toBe("FAILED");

    await reconcilePayments(deps, now);
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect((await prisma.webhookEvent.findUniqueOrThrow({
      where: { environment_providerEventId: {
        environment: "sandbox",
        providerEventId: "event-capture-processing-retry",
      } },
    })).processingState).toBe("PROCESSED");
    expect(provider.callLog.filter((call) => call.type === "captureOrder")).toHaveLength(1);
  });

  it("TEST-09: a verified pending capture webhook preserves pending inventory", async () => {
    const { item, order } = await checkoutFor("pending-webhook-buyer");
    provider.setCaptureOutcome("PENDING");
    const pending = await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    expect(pending.status).toBe("PENDING");
    const saved = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    const rawBody = JSON.stringify({
      id: "event-capture-pending",
      event_type: "PAYMENT.CAPTURE.PENDING",
      resource_type: "capture",
      resource: {
        id: saved.providerCaptureId,
        status: "PENDING",
        payee: { merchant_id: "mock-merchant" },
        supplementary_data: { related_ids: { order_id: order.providerOrderId } },
      },
    });
    expect(await receivePayPalWebhook({
      headers: provider.signEvent(rawBody),
      rawBody,
    }, deps)).toEqual({ accepted: true, duplicate: false });
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("PAYMENT_PENDING");
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

  it("TEST-10: concurrent same-key refunds create one provider refund and reject another key", async () => {
    const { order } = await checkoutFor("refund-race-buyer");
    await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    const input = {
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller" as const,
      requestKey: "same-refund-key",
      reason: "Concurrent duplicate",
    };
    const [first, second] = await Promise.all([
      refundFull(input, deps),
      refundFull(input, deps),
    ]);
    expect(first.refund.id).toBe(second.refund.id);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect(provider.callLog.filter((call) => call.type === "refundCapture")).toHaveLength(1);
    expect(provider.createdRefundCount).toBe(1);
    await expect(refundFull({ ...input, requestKey: "different-refund-key" }, deps))
      .rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED" });
  });

  it("TEST-10: refund network-after retry reuses the same request idempotency key", async () => {
    const { order } = await checkoutFor("refund-timeout-buyer");
    await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    provider.injectFault("refundCapture", { mode: "network-after" });
    const uncertain = await refundFull({
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller",
      requestKey: "refund-timeout-key",
      reason: "Network-after recovery",
    }, deps);
    expect(uncertain.refund.status).toBe("RECONCILING");
    const requestId = uncertain.refund.requestId;
    const reconciled = await reconcileRefund(uncertain.refund.id, deps);
    expect(reconciled.refund.status).toBe("COMPLETED");
    const calls = provider.callLog.filter((call) => call.type === "refundCapture");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.requestId)).toEqual([requestId, requestId]);
    expect(provider.createdRefundCount).toBe(1);
  });

  it("TEST-10: refund before PAID is rejected without a provider refund call", async () => {
    const { order } = await checkoutFor("refund-before-paid-buyer");
    expect(order.status).toBe("APPROVED");
    await expect(refundFull({
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller",
      requestKey: "refund-before-paid-key",
      reason: "Premature refund",
    }, deps)).rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED" });
    expect(provider.callLog.filter((call) => call.type === "refundCapture")).toHaveLength(0);
    expect(await prisma.refund.count()).toBe(0);
  });

  it("TEST-10: refund actor checks reject buyers and unconfigured operators while allowing configured operators", async () => {
    const { order } = await checkoutFor("refund-actor-buyer");
    await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    await expect(refundFull({
      orderId: order.id,
      actorId: order.buyerId,
      actorRole: "seller",
      requestKey: "buyer-as-seller",
      reason: "Buyer is not the seller",
    }, deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(refundFull({
      orderId: order.id,
      actorId: "unconfigured-operator",
      actorRole: "operator",
      requestKey: "unconfigured-operator",
      reason: "Not configured",
    }, deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(0);

    const result = await refundFull({
      orderId: order.id,
      actorId: "t006-operator",
      actorRole: "operator",
      requestKey: "configured-operator",
      reason: "Authorized operator",
    }, deps);
    expect(result.refund.status).toBe("COMPLETED");
    expect(result.refund.initiatorId).toBe("t006-operator");
    expect(provider.callLog.filter((call) => call.type === "refundCapture")).toHaveLength(1);
  });

  it("TEST-10: verified refund webhook reconciles completion without restocking sold inventory", async () => {
    const { item, order } = await checkoutFor("refund-webhook-buyer");
    const paidOrder = await captureCheckout({
      orderId: order.id,
      buyerId: order.buyerId,
      providerOrderId: order.providerOrderId!,
    }, deps);
    provider.setRefundOutcome("PENDING");
    const pending = await refundFull({
      orderId: order.id,
      actorId: sellerId,
      actorRole: "seller",
      requestKey: "refund-webhook-key",
      reason: "Pending refund webhook",
    }, deps);
    expect(pending.refund.status).toBe("PENDING");
    const refundId = pending.refund.providerRefundId!;
    provider.completePendingRefund(refundId);
    const rawBody = JSON.stringify({
      id: "event-refund-completed",
      event_type: "PAYMENT.REFUND.COMPLETED",
      resource_type: "refund",
      resource: {
        id: refundId,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "12.34" },
        supplementary_data: {
          related_ids: {
            order_id: order.providerOrderId,
            capture_id: paidOrder.providerCaptureId,
          },
        },
      },
    });
    expect(await receivePayPalWebhook({
      headers: provider.signEvent(rawBody),
      rawBody,
    }, deps)).toEqual({ accepted: true, duplicate: false });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: pending.refund.id } })).status)
      .toBe("COMPLETED");
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status)
      .toBe("REFUNDED");
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state)
      .toBe("SOLD");
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
