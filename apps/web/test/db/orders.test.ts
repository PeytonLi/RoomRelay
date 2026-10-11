import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";
import { createPaymentDeps } from "../../lib/payments/deps";
import { createProviderOrder, recordApproval, captureCheckout } from "../../lib/payments/checkout";
import { startCheckout } from "../../lib/payments/holds";
import { requestQuote, sellerApproveQuote, buyerApproveQuote } from "../../lib/payments/quotes";
import { refundFull } from "../../lib/payments/refunds";
import { HttpPayPalClient } from "../../lib/payments/paypal/client";
import { publishItem, listPublishedListings } from "../../lib/services/inventory";
import { candidateListingFacts } from "../../lib/services/layouts";
import { setTestIdentity } from "../../lib/test-identity";
import { GET as getOrder } from "../../app/api/v1/orders/[id]/route";
import { POST as pickupAck } from "../../app/api/v1/orders/[id]/pickup-ack/route";
import { POST as openIssue } from "../../app/api/v1/orders/[id]/issues/route";
import { POST as resolveIssue } from "../../app/api/v1/orders/[id]/issues/[caseId]/resolve/route";
import { POST as addNote } from "../../app/api/v1/orders/[id]/notes/route";
import { POST as relist } from "../../app/api/v1/items/[id]/relist/route";
import { PayPalContractMock } from "../support/paypal-contract-mock";
import { seedPublishedPaymentItem, upsertPaymentSeller } from "../support/seed-payment-item";

const databaseUrl = process.env.TEST_DATABASE_URL ??
  "postgresql://roomrelay:roomrelay-dev@localhost:5432/roomrelay_test";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const dbDescribe = process.env.ROOMRELAY_SKIP_DB_TESTS === "1" ? describe.skip : describe;

function req(body: unknown, id: string, extra = ""): Request {
  return new Request(`http://localhost/api/v1/orders/${id}${extra}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const issueParams = (id: string, caseId: string) => ({ params: Promise.resolve({ id, caseId }) });

dbDescribe("T-008 orders, handoff and support", () => {
  let provider: PayPalContractMock;
  let deps: ReturnType<typeof createPaymentDeps>;
  let seller: Awaited<ReturnType<typeof upsertPaymentSeller>>;
  let buyer: Awaited<ReturnType<typeof upsertPaymentSeller>>;

  let operator: Awaited<ReturnType<typeof upsertPaymentSeller>>;
  let now: Date;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "handoffs", "support_cases", "order_notes",
        "paypal_webhook_events", "payment_events", "refunds",
        "payment_operations", "payment_orders", "inventory_hold_items",
        "item_inventory", "inventory_holds", "quote_lines", "quotes",
        "items", "rooms", "room_revisions", "layout_revisions", "assets" RESTART IDENTITY CASCADE
    `);
    setTestIdentity(null);
    seller = await upsertPaymentSeller(prisma, "t008-seller");
    buyer = await upsertPaymentSeller(prisma, "t008-buyer");
    await upsertPaymentSeller(prisma, "t008-outsider");
    operator = await upsertPaymentSeller(prisma, "t008-operator");
    now = new Date("2026-10-11T12:00:00.000Z");
    provider = new PayPalContractMock();
    const paypal = new HttpPayPalClient({ environment: "sandbox", clientId: "mock-client", clientSecret: "mock-secret", fetch: provider.fetch });
    deps = createPaymentDeps(prisma, paypal, {
      environment: "sandbox", clientId: "mock-client", clientSecret: "mock-secret",
      merchantId: "mock-merchant", webhookId: "mock-webhook", webBaseUrl: "http://localhost:3000",
      operatorIds: [operator.id],
    }, () => now);
  });

  afterAll(async () => {
    setTestIdentity(null);
    await prisma.$disconnect();
  });

  async function seedRoomAndLayout() {
    const room = await prisma.room.create({ data: { ownerId: buyer.id, name: "Buyer room" } });
    const geometry = { schemaVersion: 1, units: "m", boundaryXZ: [[0, 0], [3.4, 0], [3.4, 4], [0, 4]] };
    const revision = await prisma.roomRevision.create({
      data: { roomId: room.id, revision: 1, geometry, createdById: buyer.id },
    });
    return { room, revision };
  }

  async function paidOrder(itemTitle = "T008 item", withLayout = false) {
    const { item } = await seedPublishedPaymentItem(prisma, "t008-seller", itemTitle);
    const extra: { roomId?: string; layoutRevisionId?: string } = {};
    if (withLayout) {
      const { room } = await seedRoomAndLayout();
      const layout = await prisma.layoutRevision.create({
        data: {
          roomId: room.id, roomRevision: 1, ownerId: buyer.id,
          placements: [{ itemId: item.id, listingVersion: 1, xM: 1.2, zM: 1.5, yawRad: Math.PI / 4 }],
          requirements: {}, findings: [{ code: "DOOR_SWING", status: "UNKNOWN", message: "Door swing not measured" }],
          fitsProvidedMeasurements: false, totalCents: 1234, prefilterReasons: [], quotable: true,
        },
      });
      extra.roomId = room.id;
      extra.layoutRevisionId = layout.id;
    }
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const quote = await requestQuote({
      buyerId: buyer.id, sellerId: seller.id,
      lines: [{ itemId: item.id, priceCents: 1234 }], discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1", ...extra,
    }, deps);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    await buyerApproveQuote({ quoteId: quote.id, buyerId: buyer.id, contentHash: quote.contentHash }, deps);
    const checkout = await startCheckout({ buyerId: buyer.id, quoteId: quote.id, idempotencyKey: `k-${quote.id}` }, deps);
    const order = await createProviderOrder({ orderId: checkout.id, buyerId: buyer.id }, deps);
    provider.approve(order.providerOrderId!);
    await recordApproval({ orderId: order.id, buyerId: buyer.id, providerOrderId: order.providerOrderId! }, deps);
    const paid = await captureCheckout({ orderId: order.id, buyerId: buyer.id, providerOrderId: order.providerOrderId! }, deps);
    return { item, quote, order: await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paid.id } }) };
  }

  async function paidOrderNoCapture(itemTitle = "T008 unpaid") {
    const { item } = await seedPublishedPaymentItem(prisma, "t008-seller", itemTitle);
    const start = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const quote = await requestQuote({
      buyerId: buyer.id, sellerId: seller.id,
      lines: [{ itemId: item.id, priceCents: 1234 }], discountCents: 0,
      pickupSlot: { start, end: new Date(start.getTime() + 60 * 60 * 1000) },
      termsVersion: "test-v1",
    }, deps);
    await sellerApproveQuote({ quoteId: quote.id, sellerId: seller.id, contentHash: quote.contentHash }, deps);
    await buyerApproveQuote({ quoteId: quote.id, buyerId: buyer.id, contentHash: quote.contentHash }, deps);
    const checkout = await startCheckout({ buyerId: buyer.id, quoteId: quote.id, idempotencyKey: `k2-${quote.id}` }, deps);
    return { item, order: checkout };
  }

  it("(a) non-participant gets 404 on GET, ack, issues and notes", async () => {
    const { order } = await paidOrder();
    setTestIdentity("t008-outsider");
    expect((await getOrder(new Request("http://localhost"), params(order.id))).status).toBe(404);
    expect((await pickupAck(req({}, order.id), params(order.id))).status).toBe(404);
    expect((await openIssue(req({ reason: "DAMAGED", affectedItemIds: ["x"], description: "broken" }, order.id), params(order.id))).status).toBe(404);
    expect((await addNote(req({ body: "hi" }, order.id), params(order.id))).status).toBe(404);
  });

  it("(b) handoff appears only after PAID; placementGuide is buyer-only", async () => {
    // Before capture: no handoff, no address in the payload.
    const unpaid = await paidOrderNoCapture();
    setTestIdentity("t008-buyer");
    const before = await (await getOrder(new Request("http://localhost"), params(unpaid.order.id))).json();
    expect(before.order.handoff).toBeNull();
    expect(JSON.stringify(before)).not.toContain("Test address");
    expect(before.order.nextAction === "PAY" || before.order.nextAction === "RECHECK_PAYMENT").toBe(true);

    // After capture: both parties see pickupLocations; placementGuide is buyer-only.
    const { order } = await paidOrder("Desk", true);
    const buyerView = await (await getOrder(new Request("http://localhost"), params(order.id))).json();
    expect(buyerView.order.handoff.state).toBe("SCHEDULED");
    expect(buyerView.order.handoff.pickupLocations).toEqual([{ itemIds: expect.any(Array), exactPickupAddress: "Test address" }]);
    expect(buyerView.order.placementGuide.items[0]).toMatchObject({ n: 1, title: "Desk", xM: 1.2, zM: 1.5 });
    expect(buyerView.order.placementGuide.assumptions).toContain("Door swing not measured");
    expect(buyerView.order.placementGuide.room.boundaryXZ).toBeDefined();

    setTestIdentity("t008-seller");
    const sellerView = await (await getOrder(new Request("http://localhost"), params(order.id))).json();
    expect(sellerView.order.placementGuide).toBeNull();
    expect(sellerView.order.handoff.pickupLocations).toEqual([{ itemIds: expect.any(Array), exactPickupAddress: "Test address" }]);
    expect(sellerView.order.nextAction).toBe("ACKNOWLEDGE");
  });

  it("(c) sequential and concurrent acks reach COMPLETED; first timestamps kept", async () => {
    const { order } = await paidOrder();
    setTestIdentity("t008-buyer");
    const first = await (await pickupAck(req({}, order.id), params(order.id))).json();
    expect(first.state).toBe("BUYER_ACKNOWLEDGED");
    expect(first.sellerAcknowledgedAt).toBeNull();
    setTestIdentity("t008-seller");
    const second = await (await pickupAck(req({}, order.id), params(order.id))).json();
    expect(second.state).toBe("COMPLETED");
    // Idempotent: buyer re-ack keeps the original timestamp.
    setTestIdentity("t008-buyer");
    const again = await (await pickupAck(req({}, order.id), params(order.id))).json();
    expect(again.buyerAcknowledgedAt).toBe(first.buyerAcknowledgedAt);

    // Concurrent buyer+seller acks on a fresh order end COMPLETED.
    const { order: order2 } = await paidOrder("Chair");
    const ack = async (subject: string) => {
      setTestIdentity(subject);
      return (await pickupAck(req({}, order2.id), params(order2.id))).json();
    };
    await Promise.all([ack("t008-buyer"), ack("t008-seller")]);
    setTestIdentity("t008-buyer");
    const view = await (await getOrder(new Request("http://localhost"), params(order2.id))).json();
    expect(view.order.handoff.state).toBe("COMPLETED");
    expect(view.order.nextAction).toBe("DONE");
  });

  it("(d) open issue blocks ack; buyer cannot resolve; seller resolve restores derived state", async () => {
    const { order, item } = await paidOrder();
    setTestIdentity("t008-buyer");
    const created = await openIssue(req({ reason: "DAMAGED", affectedItemIds: [item.id], description: "leg is broken" }, order.id), params(order.id));
    expect(created.status).toBe(201);
    const issue = await created.json();
    const viewAfter = await (await getOrder(new Request("http://localhost"), params(order.id))).json();
    expect(viewAfter.order.handoff.state).toBe("ISSUE_OPEN");
    expect(viewAfter.order.nextAction).toBe("SUPPORT");
    expect((await pickupAck(req({}, order.id), params(order.id))).status).toBe(409);

    // Buyer cannot resolve.
    expect((await resolveIssue(req({ resolutionNote: "fixed" }, order.id), issueParams(order.id, issue.id))).status).toBe(403);

    // Seller resolves → state derived from acks (none) → SCHEDULED.
    setTestIdentity("t008-seller");
    const resolved = await (await resolveIssue(req({ resolutionNote: "replaced leg" }, order.id), issueParams(order.id, issue.id))).json();
    expect(resolved.handoffState).toBe("SCHEDULED");

    // Now ack works; resolving again is 409.
    const ack = await (await pickupAck(req({}, order.id), params(order.id))).json();
    expect(ack.state).toBe("SELLER_ACKNOWLEDGED");
    expect((await resolveIssue(req({ resolutionNote: "again" }, order.id), issueParams(order.id, issue.id))).status).toBe(409);
  });

  it("(e) ack and issues never modify the PaymentOrder row", async () => {
    const { order, item } = await paidOrder();
    const snapshot = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    setTestIdentity("t008-buyer");
    await pickupAck(req({}, order.id), params(order.id));
    await openIssue(req({ reason: "OTHER", affectedItemIds: [item.id], description: "question" }, order.id), params(order.id));
    await addNote(req({ body: "gate code 1234" }, order.id), params(order.id));
    const after = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    const { updatedAt: _a, ...before } = snapshot;
    const { updatedAt: _b, ...rest } = after;
    expect(rest).toEqual(before);
  });

  it("(f) relist only after REFUNDED; DRAFT until republished", async () => {
    const { order, item } = await paidOrder();
    setTestIdentity("t008-seller");
    // Relist while PAID → 409.
    expect((await relist(req({ possessionConfirmed: true }, item.id), params(item.id))).status).toBe(409);

    // Full refund → REFUNDED.
    await refundFull({ orderId: order.id, actorId: seller.id, actorRole: "seller", requestKey: "rk-1", reason: "returned" }, deps);
    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    // Item's inventory stays SOLD and it stays out of public listings.
    expect((await prisma.itemInventory.findUniqueOrThrow({ where: { itemId: item.id } })).state).toBe("SOLD");
    expect((await listPublishedListings(prisma)).some((listing) => listing.id === item.id)).toBe(false);

    // Relist → DRAFT, inventory AVAILABLE, still not public.
    const relisted = await (await relist(req({ possessionConfirmed: true }, item.id), params(item.id))).json();
    expect(relisted.version).toBe(2);
    const itemAfter = await prisma.item.findUniqueOrThrow({ where: { id: item.id }, include: { inventory: true } });
    expect(itemAfter.status).toBe("DRAFT");
    expect(itemAfter.inventory?.state).toBe("AVAILABLE");
    expect(itemAfter.inventory?.holdId).toBeNull();
    expect((await listPublishedListings(prisma)).some((listing) => listing.id === item.id)).toBe(false);

    // Publish flow makes it public again.
    const patched = await publishItem(prisma, seller, item.id, itemAfter.version);
    expect(patched.kind).toBe("ok");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("ACTIVE");
    expect((await listPublishedListings(prisma)).some((listing) => listing.id === item.id)).toBe(true);
  });

  it("sold inventory is excluded from layout candidates until relisted and republished", async () => {
    const { item } = await paidOrder("Candidates desk");
    expect((await candidateListingFacts(prisma)).some((fact) => fact.itemId === item.id)).toBe(false);

    await refundFull({
      orderId: (await prisma.paymentOrder.findFirstOrThrow({ where: { quote: { lines: { some: { itemId: item.id } } } } })).id,
      actorId: seller.id, actorRole: "seller", requestKey: "rk-candidates", reason: "returned",
    }, deps);
    setTestIdentity("t008-seller");
    await relist(req({ possessionConfirmed: true }, item.id), params(item.id));
    const relisted = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect((await candidateListingFacts(prisma)).some((fact) => fact.itemId === item.id)).toBe(false);
    const published = await publishItem(prisma, seller, item.id, relisted.version);
    expect(published.kind).toBe("ok");
    expect((await candidateListingFacts(prisma)).some((fact) => fact.itemId === item.id)).toBe(true);
  });

  it("(g) out-of-order affectedItemIds → 400 INVALID_ITEMS", async () => {
    const { order } = await paidOrder();
    setTestIdentity("t008-buyer");
    const response = await openIssue(req({ reason: "MISSING", affectedItemIds: ["not-an-item"], description: "missing" }, order.id), params(order.id));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_ITEMS");
    const empty = await openIssue(req({ reason: "MISSING", affectedItemIds: [], description: "missing" }, order.id), params(order.id));
    expect(empty.status).toBe(422);
  });

  it("notes are participant-only and appended in order; order notes immutable in DB", async () => {
    const { order } = await paidOrder();
    setTestIdentity("t008-buyer");
    await addNote(req({ body: "first" }, order.id), params(order.id));
    setTestIdentity("t008-seller");
    await addNote(req({ body: "second" }, order.id), params(order.id));
    const view = await (await getOrder(new Request("http://localhost"), params(order.id))).json();
    expect(view.order.notes.map((note: { body: string }) => note.body)).toEqual(["first", "second"]);
    const note = await prisma.orderNote.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(prisma.orderNote.update({ where: { id: note.id }, data: { body: "edited" } })).rejects.toThrow(/immutable revision/);
  });
});
