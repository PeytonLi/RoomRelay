import { validateLayout } from "@roomrelay/spatial";
import type { LayoutFinding, RoomGeometry } from "@roomrelay/spatial";

export interface LayoutPlacementInput {
  itemId: string;
  listingVersion: number;
  xM: number;
  zM: number;
  yawRad: number;
}

export interface LayoutRequirements {
  budgetCents: number;
  pickupFrom: Date;
  pickupTo: Date;
}

export interface ListingFacts {
  itemId: string;
  listingVersion: number;
  publishedVersion: number | null;
  itemStatus: string;
  sellerId: string;
  title: string;
  widthM: number;
  depthM: number;
  heightM: number;
  priceCents: number;
  pickupWindowStart: Date;
  pickupWindowEnd: Date;
}

export interface EvaluateLayoutInput {
  room: RoomGeometry;
  roomRevision: number;
  currentRoomRevision: number;
  placements: LayoutPlacementInput[];
  listingFacts: ListingFacts[];
  requirements: LayoutRequirements;
}

export interface PrefilterReason {
  code: string;
  message: string;
  itemIds?: string[];
}

export interface LayoutEvaluation {
  findings: LayoutFinding[];
  prefilterReasons: PrefilterReason[];
  fitsProvidedMeasurements: boolean;
  totalCents: number;
  quotable: boolean;
}

function ruleFinding(code: string, passed: boolean, message: string, itemIds: string[] = []): LayoutFinding {
  return {
    code,
    status: passed ? "PASS" : "FAIL",
    itemIds,
    geometryRefs: [],
    evidenceIds: [],
    message,
  };
}

export function evaluateLayout(input: EvaluateLayoutInput): LayoutEvaluation {
  const findings: LayoutFinding[] = [];
  const prefilterReasons: PrefilterReason[] = [];
  const factsByItem = new Map(input.listingFacts.map((facts) => [facts.itemId, facts]));
  const usedFacts: ListingFacts[] = [];

  const roomIsCurrent = input.roomRevision === input.currentRoomRevision;
  findings.push(
    ruleFinding(
      "ROOM_REVISION",
      roomIsCurrent,
      roomIsCurrent ? "Room measurements are current." : "Room measurements changed after this layout was requested.",
    ),
  );
  if (!roomIsCurrent) prefilterReasons.push({ code: "STALE_ROOM_REVISION", message: "room measurement revision changed" });

  for (const placement of input.placements) {
    const facts = factsByItem.get(placement.itemId);
    if (!facts) {
      findings.push(ruleFinding("LISTING_VERSION", false, "The requested listing version is unavailable.", [placement.itemId]));
      prefilterReasons.push({ code: "STALE_LISTING_VERSION", message: "listing version is unavailable", itemIds: [placement.itemId] });
      continue;
    }
    usedFacts.push(facts);
    const listingIsCurrent = facts.listingVersion === placement.listingVersion && facts.publishedVersion === placement.listingVersion;
    findings.push(
      ruleFinding(
        "LISTING_VERSION",
        listingIsCurrent,
        listingIsCurrent ? `${facts.title}: current published version.` : `${facts.title}: listing version changed.`,
        [placement.itemId],
      ),
    );
    if (!listingIsCurrent) {
      prefilterReasons.push({ code: "STALE_LISTING_VERSION", message: "listing version changed", itemIds: [placement.itemId] });
    }
    const active = facts.itemStatus === "ACTIVE";
    findings.push(ruleFinding("ITEM_ACTIVE", active, active ? `${facts.title}: item is active.` : `${facts.title}: item is not active.`, [placement.itemId]));
    if (!active) prefilterReasons.push({ code: "ITEM_NOT_ACTIVE", message: "item is not active", itemIds: [placement.itemId] });

    const overlapsPickup = facts.pickupWindowStart <= input.requirements.pickupTo && facts.pickupWindowEnd >= input.requirements.pickupFrom;
    findings.push(
      ruleFinding(
        "PICKUP_WINDOW",
        overlapsPickup,
        overlapsPickup ? `${facts.title}: pickup dates overlap.` : `${facts.title}: pickup dates do not overlap.`,
        [placement.itemId],
      ),
    );
    if (!overlapsPickup) {
      prefilterReasons.push({ code: "PICKUP_WINDOW_MISMATCH", message: "pickup date windows do not overlap", itemIds: [placement.itemId] });
    }
  }

  const totalCents = usedFacts.reduce((total, facts) => total + facts.priceCents, 0);
  const withinBudget = totalCents <= input.requirements.budgetCents;
  findings.push(
    ruleFinding(
      "BUDGET",
      withinBudget,
      withinBudget ? "Total price is within the budget." : "Total price exceeds the budget.",
      usedFacts.map((facts) => facts.itemId),
    ),
  );
  if (!withinBudget) prefilterReasons.push({ code: "BUDGET_EXCEEDED", message: "total price exceeds the budget" });

  const sellers = new Set(usedFacts.map((facts) => facts.sellerId));
  const oneSeller = sellers.size <= 1;
  findings.push(
    ruleFinding("SINGLE_SELLER", oneSeller, oneSeller ? "All items have one seller." : "Items come from multiple sellers.", usedFacts.map((facts) => facts.itemId)),
  );
  if (!oneSeller) prefilterReasons.push({ code: "MULTIPLE_SELLERS", message: "all items must have one seller" });

  const placedItems = input.placements.flatMap((placement) => {
    const facts = factsByItem.get(placement.itemId);
    return facts
      ? [
          {
            id: placement.itemId,
            title: facts.title,
            dimsM: { widthM: facts.widthM, depthM: facts.depthM, heightM: facts.heightM },
            placement: { xM: placement.xM, zM: placement.zM, yawRad: placement.yawRad },
          },
        ]
      : [];
  });
  const geometry = validateLayout(input.room, placedItems);
  findings.push(...geometry.findings);
  const fitsProvidedMeasurements = geometry.fitsProvidedMeasurements;
  if (!fitsProvidedMeasurements) {
    prefilterReasons.push({ code: "LAYOUT_DOES_NOT_FIT", message: "geometry does not fit the provided measurements" });
  }

  return {
    findings,
    prefilterReasons,
    fitsProvidedMeasurements,
    totalCents,
    quotable: roomIsCurrent && prefilterReasons.length === 0 && fitsProvidedMeasurements,
  };
}
