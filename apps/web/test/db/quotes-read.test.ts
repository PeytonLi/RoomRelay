import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../../lib/generated/prisma/client";
import { createPaymentDeps } from "../../lib/payments/deps";
import { startCheckout } from "../../lib/payments/holds";
import { requestQuote, sellerApproveQuote, buyerApproveQuote, reviseQuote } from "../../lib/payments/quotes";
import { HttpPayPalClient } from "../../lib/payments/paypal/client";
import { getQuoteView, listQuoteViews } from "../../lib/services/quote-views";
import { setTestIdentity } from "../../lib/test-identity";
import { GET as getQuoteRoute } from "../../app/api/v1/quotes/[id]/route";
import { GET as listQuotesRoute } from "../../app/api/v1/quotes/route";
import { POST as candidatesRoute } from "../../app/api/v1/rooms/[id]/candidates/route";
import syntheticRoom from "../../fixtures/room.synthetic.json";
import { PayPalContractMock } from "../support/paypal-contract-mock";
import { seedPublishedPaymentItem, upsertPaymentSeller } from "../support/seed-payment-item";

const databaseUrl = process.env.TEST_DATABASE_URL ??
  "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const dbDescribe = process.env.ROOMRELAY_SKIP_DB_TESTS === "1" ? describe.skip : describe;

function quoteParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

dbDescribe("T-008 quote read endpoints", () => {
  let deps: ReturnType<typeof createPaymentDeps>;
  let now: Date;
  let buyer: { id: string };
  let seller: { id: string };

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    setTestIdentity(null);
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "paypal_webhook_events", "payment_events", "refunds",
        "payment_operations", "payment_orders", "inventory_hold_items",
        "item_inventory", "inventory_holds", "quote_lines", "quotes",
        "items", "listing_versions", "rooms", "room_revisions", "assets",
        "layout_revisions", "users" RESTART IDENTITY CASCADE
    `);
    buyer = await upsertPaymentSeller(prisma, "t008-buyer");
    seller = await upsertPaymentSeller(prisma, "t008-seller");
    now = new Date("2026-10-11T12:00:00.000Z");
    const provider = new PayPalContractMock();
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
      operatorIds: ["t008-operator"],
    }, () => now);
  });

  afterAll(async () => {
    setTestIdentity(null);
    await prisma.$disconnect();
  });

  async function seedItem(title = "T008 item") {
    return (await seedPublishedPaymentItem(prisma, "t008-seller", title)).item;
  }

  async function requestedQuote(lines: Array<{ itemId: string; priceCents: number }>) {
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    return requestQuote({
      buyerId: buyer.id,
      sellerId: seller.id,
      lines,
      discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps);
  }

  it("serves the buyer a 200 view with role BUYER, lines, contentHash and no staleness", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    setTestIdentity("t008-buyer");
    const response = await getQuoteRoute(new Request("http://localhost"), quoteParams(quote.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quote.role).toBe("BUYER");
    expect(body.quote.status).toBe("REQUESTED");
    expect(body.quote.stale).toBe(false);
    expect(body.quote.staleReasons).toEqual([]);
    expect(body.quote.contentHash).toBe(quote.contentHash);
    expect(body.quote.lines).toEqual([
      expect.objectContaining({ itemId: item.id, title: "T008 item", priceCents: 1234 }),
    ]);
    expect(body.quote.checkout).toBeNull();
  });

  it("serves the seller role SELLER and always reports checkout null", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    setTestIdentity("t008-seller");
    const response = await getQuoteRoute(new Request("http://localhost"), quoteParams(quote.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quote.role).toBe("SELLER");
    expect(body.quote.checkout).toBeNull();
  });

  it("exposes the latest checkout to the buyer", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    await buyerApproveQuote({ quoteId: quote.id, buyerId: buyer.id, contentHash: quote.contentHash }, deps);
    const checkout = await startCheckout({
      buyerId: buyer.id,
      quoteId: quote.id,
      idempotencyKey: `t008-${quote.id}`,
    }, deps);
    const view = await getQuoteView(prisma, buyer.id, quote.id, now);
    expect(view?.checkout).toEqual({ id: checkout.id, status: "CREATED" });
  });

  it("returns 404 for strangers and unknown quote ids", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    setTestIdentity("t008-stranger");
    const stranger = await getQuoteRoute(new Request("http://localhost"), quoteParams(quote.id));
    expect(stranger.status).toBe(404);
    setTestIdentity("t008-buyer");
    const missing = await getQuoteRoute(
      new Request("http://localhost"),
      quoteParams("00000000-0000-0000-0000-000000000000"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists quotes scoped to the caller for role=buyer and role=seller", async () => {
    const item = await seedItem();
    await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    const otherBuyer = await upsertPaymentSeller(prisma, "t008-other-buyer");
    const otherItem = await seedItem("Other item");
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await requestQuote({
      buyerId: otherBuyer.id,
      sellerId: seller.id,
      lines: [{ itemId: otherItem.id, priceCents: 50 }],
      discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps);

    setTestIdentity("t008-buyer");
    const buyerList = await listQuotesRoute(new Request("http://localhost/api/v1/quotes?role=buyer"));
    expect(buyerList.status).toBe(200);
    const buyerBody = await buyerList.json();
    expect(buyerBody.quotes).toHaveLength(1);
    expect(buyerBody.quotes[0].role).toBe("BUYER");
    expect(buyerBody.quotes[0].lineTitles).toEqual(["T008 item"]);

    setTestIdentity("t008-seller");
    const sellerList = await listQuotesRoute(new Request("http://localhost/api/v1/quotes?role=seller"));
    expect(sellerList.status).toBe(200);
    const sellerBody = await sellerList.json();
    expect(sellerBody.quotes).toHaveLength(2);
    expect(sellerBody.quotes.every((quote: { role: string }) => quote.role === "SELLER")).toBe(true);
  });

  it("rejects a missing or invalid role with 422", async () => {
    setTestIdentity("t008-buyer");
    const missing = await listQuotesRoute(new Request("http://localhost/api/v1/quotes"));
    expect(missing.status).toBe(422);
    const missingBody = await missing.json();
    expect(missingBody.code).toBe("VALIDATION_ERROR");
    expect(missingBody.fieldErrors.role).toBeDefined();
    const invalid = await listQuotesRoute(new Request("http://localhost/api/v1/quotes?role=admin"));
    expect(invalid.status).toBe(422);
  });

  it("flags QUOTE_EXPIRED once expiresAt has passed", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    const before = await getQuoteView(prisma, buyer.id, quote.id, now);
    expect(before?.stale).toBe(false);
    const expiry = new Date(before!.expiresAt!);
    const after = await getQuoteView(prisma, buyer.id, quote.id, new Date(expiry.getTime() + 1000));
    expect(after?.stale).toBe(true);
    expect(after?.staleReasons).toContain("QUOTE_EXPIRED");
  });

  it("flags ITEM_CHANGED when a quoted item is updated after approval", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    const before = await getQuoteView(prisma, buyer.id, quote.id, now);
    expect(before?.stale).toBe(false);
    await prisma.item.update({
      where: { id: item.id },
      data: { updatedAt: new Date(item.updatedAt.getTime() + 60_000) },
    });
    const after = await getQuoteView(prisma, buyer.id, quote.id, now);
    expect(after?.stale).toBe(true);
    expect(after?.staleReasons).toContain("ITEM_CHANGED");
  });

  it("flags STATUS_SUPERSEDED and links the replacement after reviseQuote", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    const revised = await reviseQuote({
      quoteId: quote.id,
      sellerId: seller.id,
      changes: { discountCents: 100 },
    }, deps);
    const view = await getQuoteView(prisma, buyer.id, quote.id, now);
    expect(view?.status).toBe("SUPERSEDED");
    expect(view?.stale).toBe(true);
    expect(view?.staleReasons).toContain("STATUS_SUPERSEDED");
    expect(view?.replacementQuoteId).toBe(revised.id);
  });

  it("summaries share the stale rule", async () => {
    const item = await seedItem();
    const quote = await requestedQuote([{ itemId: item.id, priceCents: 1234 }]);
    await prisma.item.update({
      where: { id: item.id },
      data: { updatedAt: new Date(item.updatedAt.getTime() + 60_000) },
    });
    const summaries = await listQuoteViews(prisma, buyer.id, "buyer", now);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(quote.id);
    expect(summaries[0]?.stale).toBe(true);
  });
});

dbDescribe("T-008 candidates response fields", () => {
  beforeEach(async () => {
    setTestIdentity(null);
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "paypal_webhook_events", "payment_events", "refunds",
        "payment_operations", "payment_orders", "inventory_hold_items",
        "item_inventory", "inventory_holds", "quote_lines", "quotes",
        "items", "listing_versions", "rooms", "room_revisions", "assets",
        "layout_revisions", "users" RESTART IDENTITY CASCADE
    `);
  });

  it("returns listing fields and findings on a fitting entry", async () => {
    const owner = await upsertPaymentSeller(prisma, "t008-room-owner");
    const { item } = await seedPublishedPaymentItem(prisma, "t008-seller", "Candidate chair");
    const room = await prisma.room.create({
      data: {
        ownerId: owner.id,
        name: "Bedroom",
        revisions: {
          create: {
            revision: 1,
            geometry: syntheticRoom as unknown as Prisma.InputJsonValue,
            createdById: owner.id,
          },
        },
      },
    });
    setTestIdentity("t008-room-owner");
    const response = await candidatesRoute(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          budgetCents: 100_000,
          pickupFrom: "2026-10-11T00:00:00.000Z",
          pickupTo: "2026-10-12T00:00:00.000Z",
        }),
      }),
      { params: Promise.resolve({ id: room.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const entry = body.candidates.find((candidate: { itemId: string }) => candidate.itemId === item.id);
    expect(entry).toMatchObject({
      itemId: item.id,
      listingVersion: 1,
      title: "Candidate chair",
      sellerId: item.sellerId,
      priceCents: 1234,
      pickupWindowStart: "2026-10-11T00:00:00.000Z",
      pickupWindowEnd: "2026-10-12T00:00:00.000Z",
    });
    expect(entry.widthM).toBeCloseTo(0.5);
    expect(entry.depthM).toBeCloseTo(0.4);
    expect(entry.heightM).toBeCloseTo(0.7);
    expect(entry.placement).toBeDefined();
    expect(Array.isArray(entry.findings)).toBe(true);
    expect(entry.findings.length).toBeGreaterThan(0);
  });
});
