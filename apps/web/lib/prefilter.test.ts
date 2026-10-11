import { describe, expect, it } from "vitest";
import { evaluateLayout, type ListingFacts } from "./prefilter";

const room = {
  schemaVersion: 1 as const,
  units: "m" as const,
  boundaryXZ: [[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][],
  ceilingHeightM: 2.5,
  doors: [],
  obstacles: [],
  measurementRevision: 1,
};

const placement = { itemId: "item-a", listingVersion: 1, xM: 1.5, zM: 1.5, yawRad: 0 };
const requirements = {
  budgetCents: 5000,
  pickupFrom: new Date("2026-05-01T00:00:00.000Z"),
  pickupTo: new Date("2026-05-02T00:00:00.000Z"),
};

function facts(overrides: Partial<ListingFacts> = {}): ListingFacts {
  return {
    itemId: "item-a",
    listingVersion: 1,
    publishedVersion: 1,
    itemStatus: "ACTIVE",
    sellerId: "seller-a",
    title: "Desk",
    widthM: 1,
    depthM: 1,
    heightM: 1,
    priceCents: 5000,
    pickupWindowStart: requirements.pickupFrom,
    pickupWindowEnd: requirements.pickupTo,
    ...overrides,
  };
}

function evaluate(listingFacts: ListingFacts[], overrides: Partial<typeof requirements> = {}, roomRevision = 1) {
  return evaluateLayout({
    room,
    roomRevision,
    currentRoomRevision: 1,
    placements: [placement, ...(listingFacts.length > 1 ? [{ ...placement, itemId: "item-b" }] : [])],
    listingFacts,
    requirements: { ...requirements, ...overrides },
  });
}

describe("evaluateLayout prefilter", () => {
  it("accepts a budget exactly equal to the total and pickup window edge overlap", () => {
    const result = evaluate([facts({ pickupWindowStart: requirements.pickupTo })]);
    expect(result.quotable).toBe(true);
  });

  it("rejects over-budget, non-overlapping dates, and multiple sellers", () => {
    expect(evaluate([facts({ priceCents: 5001 })]).prefilterReasons.map((reason) => reason.code)).toContain("BUDGET_EXCEEDED");
    expect(
      evaluate([facts({ pickupWindowStart: new Date("2026-05-03T00:00:00.000Z") })]).prefilterReasons.map((reason) => reason.code),
    ).toContain("PICKUP_WINDOW_MISMATCH");
    expect(
      evaluate([facts(), facts({ itemId: "item-b", sellerId: "seller-b" })]).prefilterReasons.map((reason) => reason.code),
    ).toContain("MULTIPLE_SELLERS");
  });

  it("rejects stale room and listing revisions", () => {
    expect(evaluate([facts()], {}, 2).prefilterReasons.map((reason) => reason.code)).toContain("STALE_ROOM_REVISION");
    expect(evaluate([facts({ publishedVersion: 2 })]).prefilterReasons.map((reason) => reason.code)).toContain("STALE_LISTING_VERSION");
  });
});
