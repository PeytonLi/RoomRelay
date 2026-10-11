import type {
  CandidateResult,
  CheckoutView,
  OrderView,
  QuoteSummary,
  QuoteView,
} from "../../lib/journey/types";
import type { LayoutFinding } from "@roomrelay/spatial";

export const ROOM_ID = "room-1";
export const QUOTE_ID = "quote-1";
export const ORDER_ID = "order-1";
export const ITEM_IDS = ["item-1", "item-2", "item-3", "item-4"] as const;
export const SELLER_ID = "seller-1";
export const CONTENT_HASH = "f".repeat(64);

const HOUR = 3_600_000;
const T0 = Date.now() + 2 * HOUR;

export const roomsResponse = [
  { id: ROOM_ID, name: "Bedroom", measurementRevision: 1 },
];

function finding(code: string, message: string, itemIds: string[] = []): LayoutFinding {
  return { code, status: "PASS", itemIds, geometryRefs: [], evidenceIds: [], message };
}

function candidate(index: number, title: string, priceCents: number): CandidateResult {
  const itemId = ITEM_IDS[index]!;
  const placement = { itemId, listingVersion: 1, xM: 1 + index, zM: 1.5, yawRad: 0 };
  return {
    itemId,
    listingVersion: 1,
    title,
    sellerId: SELLER_ID,
    priceCents,
    widthM: 0.5,
    depthM: 0.4,
    heightM: 0.7,
    pickupWindowStart: new Date(T0 - 6 * HOUR).toISOString(),
    pickupWindowEnd: new Date(T0 + 96 * HOUR).toISOString(),
    placement,
    findings: [
      finding("ROOM_REVISION", "Room measurements are current."),
      finding("ITEM_ACTIVE", `${title}: item is active.`, [itemId]),
      finding("BUDGET", "Total price is within the budget."),
    ],
  };
}

export function candidatesResponse(): { candidates: CandidateResult[] } {
  return {
    candidates: [
      candidate(0, "Oak chair", 4500),
      candidate(1, "Pine desk", 9000),
      candidate(2, "Small shelf", 2500),
      {
        itemId: ITEM_IDS[3]!,
        listingVersion: 1,
        title: "Leather sofa",
        sellerId: SELLER_ID,
        priceCents: 99000,
        widthM: 2,
        depthM: 0.9,
        heightM: 0.8,
        pickupWindowStart: new Date(T0 - 6 * HOUR).toISOString(),
        pickupWindowEnd: new Date(T0 + 96 * HOUR).toISOString(),
        rejectionReason: "BUDGET_EXCEEDED",
      },
    ],
  };
}

export function quoteView(overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    id: QUOTE_ID,
    version: 1,
    role: "BUYER",
    status: "SELLER_APPROVED",
    stale: false,
    staleReasons: [],
    environment: "sandbox",
    merchantId: "MERCHANT1",
    currency: "USD",
    subtotalCents: 4500,
    discountCents: 0,
    totalCents: 4500,
    roomId: ROOM_ID,
    roomRevision: 1,
    layoutRevisionId: "layout-1",
    pickupSlot: { start: new Date(T0).toISOString(), end: new Date(T0 + HOUR).toISOString() },
    termsVersion: "roomrelay-pickup-terms-v1",
    contentHash: CONTENT_HASH,
    acknowledgedWarnings: null,
    sellerApprovedAt: new Date(T0 - HOUR).toISOString(),
    buyerApprovedAt: null,
    expiresAt: new Date(T0 + HOUR).toISOString(),
    createdAt: new Date(T0 - 2 * HOUR).toISOString(),
    replacementQuoteId: null,
    lines: [
      {
        itemId: ITEM_IDS[0]!,
        title: "Oak chair",
        widthM: 0.5,
        depthM: 0.4,
        heightM: 0.7,
        conditionDisclosure: "Small scratch on the left arm",
        priceCents: 4500,
      },
    ],
    checkout: null,
    ...overrides,
  };
}

export function quoteSummary(overrides: Partial<QuoteSummary> = {}): QuoteSummary {
  return {
    id: QUOTE_ID,
    version: 1,
    role: "SELLER",
    status: "REQUESTED",
    stale: false,
    totalCents: 4500,
    currency: "USD",
    pickupSlot: { start: new Date(T0).toISOString(), end: new Date(T0 + HOUR).toISOString() },
    expiresAt: new Date(T0 + HOUR).toISOString(),
    createdAt: new Date(T0 - 2 * HOUR).toISOString(),
    lineTitles: ["Oak chair"],
    ...overrides,
  };
}

export function checkoutView(overrides: Partial<CheckoutView> = {}): CheckoutView {
  return {
    id: ORDER_ID,
    status: "CREATED",
    environment: "sandbox",
    merchantId: "MERCHANT1",
    amountCents: 4500,
    currency: "USD",
    providerOrderId: null,
    approveUrl: null,
    capturedCents: 0,
    refundedCents: 0,
    paidAt: null,
    hold: { state: "ACTIVE", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
    quote: {
      id: QUOTE_ID,
      lines: [{ title: "Oak chair", priceCents: 4500, conditionDisclosure: "Small scratch on the left arm" }],
    },
    ...overrides,
  };
}

export function orderView(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: ORDER_ID,
    role: "BUYER",
    status: "PAID",
    environment: "sandbox",
    merchantId: "MERCHANT1",
    currency: "USD",
    amountCents: 4500,
    capturedCents: 4500,
    refundedCents: 0,
    paidAt: new Date(T0 - HOUR).toISOString(),
    providerOrderId: "PAYPALORDER1",
    providerCaptureId: "CAPTURE1",
    refund: null,
    quote: {
      id: QUOTE_ID,
      version: 1,
      totalCents: 4500,
      termsVersion: "roomrelay-pickup-terms-v1",
      acknowledgedWarnings: ["FIT_MEASURED_ROOM_ONLY_V1"],
      pickupSlot: { start: new Date(T0).toISOString(), end: new Date(T0 + HOUR).toISOString() },
      lines: [
        { itemId: ITEM_IDS[0]!, title: "Oak chair", widthM: 0.5, depthM: 0.4, heightM: 0.7, conditionDisclosure: null, priceCents: 2500 },
        { itemId: ITEM_IDS[1]!, title: "Pine desk", widthM: 1.2, depthM: 0.6, heightM: 0.75, conditionDisclosure: "Ring stain on top", priceCents: 2000 },
      ],
    },
    placementGuide: {
      roomId: ROOM_ID,
      roomRevision: 1,
      layoutRevisionId: "layout-1",
      room: {
        boundaryXZ: [[0, 0], [4, 0], [4, 3], [0, 3]],
        doors: [],
        obstacles: [],
        measurementRevision: 1,
      },
      items: [
        { n: 1, itemId: ITEM_IDS[0]!, title: "Oak chair", xM: 1, zM: 1, yawRad: 0, widthM: 0.5, depthM: 0.4, heightM: 0.7 },
        { n: 2, itemId: ITEM_IDS[1]!, title: "Pine desk", xM: 2.5, zM: 1.5, yawRad: Math.PI / 2, widthM: 1.2, depthM: 0.6, heightM: 0.75 },
      ],
      assumptions: ["Item footprints use the seller-listed dimensions.", "Doors and stairs are not part of the fit check."],
    },
    handoff: {
      state: "SCHEDULED",
      pickupSlot: { start: new Date(T0).toISOString(), end: new Date(T0 + HOUR).toISOString() },
      buyerAcknowledgedAt: null,
      sellerAcknowledgedAt: new Date(T0 - 30 * 60 * 1000).toISOString(),
      pickupLocations: [{ itemIds: [ITEM_IDS[0]!, ITEM_IDS[1]!], exactPickupAddress: "12 Demo Street" }],
    },
    cases: [],
    notes: [],
    nextAction: "ACKNOWLEDGE",
    ...overrides,
  };
}

export function openCase(): OrderView["cases"][number] {
  return {
    id: "case-1",
    openedByRole: "BUYER",
    reason: "DAMAGED",
    affectedItemIds: [ITEM_IDS[0]!],
    description: "Leg is cracked, not as described.",
    status: "OPEN",
    resolutionNote: null,
    createdAt: new Date(T0 - 10 * 60 * 1000).toISOString(),
    resolvedAt: null,
  };
}
