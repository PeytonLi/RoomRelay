/** Shared JSON contracts for the T-008 buyer/seller journey UI.
 * QuoteView/QuoteSummary are served by GET /api/v1/quotes(/[id]) in this lane;
 * OrderView mirrors the lane-A GET /api/v1/orders/[id] contract. */
import type { LayoutFinding, RoomGeometry } from "@roomrelay/spatial";

export type QuoteStatus = "REQUESTED" | "SELLER_APPROVED" | "BUYER_APPROVED" | "SUPERSEDED" | "EXPIRED" | "REJECTED";
export type ParticipantRole = "BUYER" | "SELLER";

export interface QuoteLineView {
  itemId: string;
  title: string;
  widthM: number | null;
  depthM: number | null;
  heightM: number | null;
  conditionDisclosure: string | null;
  priceCents: number;
}

export interface QuoteView {
  id: string;
  version: number;
  role: ParticipantRole;
  status: QuoteStatus;
  /** True when status is SUPERSEDED/EXPIRED/REJECTED, expiresAt has passed, or a quoted item/room changed. */
  stale: boolean;
  staleReasons: string[];
  environment: string;
  merchantId: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  roomId: string | null;
  roomRevision: number | null;
  layoutRevisionId: string | null;
  pickupSlot: { start: string; end: string };
  termsVersion: string;
  contentHash: string;
  acknowledgedWarnings: string[] | null;
  sellerApprovedAt: string | null;
  buyerApprovedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  replacementQuoteId: string | null;
  lines: QuoteLineView[];
  /** Latest checkout for this quote; buyer only (null for seller). */
  checkout: { id: string; status: string } | null;
}

export interface QuoteSummary {
  id: string;
  version: number;
  role: ParticipantRole;
  status: QuoteStatus;
  stale: boolean;
  totalCents: number;
  currency: string;
  pickupSlot: { start: string; end: string };
  expiresAt: string | null;
  createdAt: string;
  lineTitles: string[];
}

export interface CandidatePlacement {
  itemId: string;
  listingVersion: number;
  xM: number;
  zM: number;
  yawRad: number;
}

export type CandidateRejection = "BUDGET_EXCEEDED" | "PICKUP_WINDOW_MISMATCH" | "NO_GEOMETRIC_FIT";

/** One entry of POST /api/v1/rooms/[id]/candidates `candidates[]`. */
export interface CandidateResult {
  itemId: string;
  listingVersion: number;
  title: string;
  sellerId: string;
  priceCents: number;
  widthM: number;
  depthM: number;
  heightM: number;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  /** Present when the item fits; absent with rejectionReason otherwise. */
  placement?: CandidatePlacement;
  findings?: LayoutFinding[];
  rejectionReason?: CandidateRejection;
}

export interface CheckoutView {
  id: string;
  status: string;
  environment: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  providerOrderId: string | null;
  approveUrl: string | null;
  capturedCents: number;
  refundedCents: number;
  paidAt: string | null;
  hold: { state: string; expiresAt: string };
  quote: { id: string; lines: { title: string; priceCents: number; conditionDisclosure: string | null }[] };
}

export interface PlacementGuide {
  roomId: string;
  roomRevision: number;
  layoutRevisionId: string;
  room: RoomGeometry;
  items: { n: number; itemId: string; title: string; xM: number; zM: number; yawRad: number; widthM: number; depthM: number; heightM: number }[];
  assumptions: string[];
}

export type HandoffState =
  | "UNSCHEDULED" | "SCHEDULED" | "READY" | "BUYER_ACKNOWLEDGED" | "SELLER_ACKNOWLEDGED" | "COMPLETED" | "ISSUE_OPEN";

export interface OrderCase {
  id: string;
  openedByRole: ParticipantRole;
  reason: "UNAVAILABLE" | "DAMAGED" | "MISSING" | "OTHER";
  affectedItemIds: string[];
  description: string;
  status: "OPEN" | "RESOLVED";
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OrderView {
  id: string;
  role: ParticipantRole;
  status: string;
  environment: string;
  merchantId: string;
  currency: string;
  amountCents: number;
  capturedCents: number;
  refundedCents: number;
  paidAt: string | null;
  providerOrderId: string | null;
  providerCaptureId: string | null;
  refund: { status: string; providerRefundId: string | null; amountCents: number } | null;
  quote: {
    id: string;
    version: number;
    totalCents: number;
    termsVersion: string;
    acknowledgedWarnings: string[] | null;
    pickupSlot: { start: string; end: string };
    lines: { itemId: string; title: string; widthM: number; depthM: number; heightM: number; conditionDisclosure: string | null; priceCents: number }[];
  };
  placementGuide: PlacementGuide | null;
  handoff: null | {
    state: HandoffState | string;
    pickupSlot: { start: string; end: string };
    buyerAcknowledgedAt: string | null;
    sellerAcknowledgedAt: string | null;
    pickupLocations: { itemIds: string[]; exactPickupAddress: string }[];
  };
  cases: OrderCase[];
  notes: { id: string; authorRole: ParticipantRole; body: string; createdAt: string }[];
  nextAction: "PAY" | "RECHECK_PAYMENT" | "PICKUP" | "ACKNOWLEDGE" | "SUPPORT" | "DONE" | "REFUNDED";
}

/** Recorded on buyer approval (POST /quotes/[id]/buyer-approval acknowledgedWarnings). */
export const BUYER_ACKNOWLEDGEMENTS = [
  "FIT_MEASURED_ROOM_ONLY_V1",
  "PICKUP_ROUTE_NOT_MEASURED_V1",
  "PICKUP_TERMS_V1",
] as const;

export const QUOTE_TERMS_VERSION = "roomrelay-pickup-terms-v1";
