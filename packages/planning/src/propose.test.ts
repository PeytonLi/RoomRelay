import { describe, expect, it } from "vitest";
import { MAX_MODEL_CALLS, proposeLayout } from "./propose";
import { ProviderError } from "./provider";
import { fixtureContext, goodDeskChairJson, GOOD_DESK_CHAIR, loadFixtureRoom, mockProvider, proposalJson, reply } from "./testkit";

describe("proposeLayout: accepted outputs", () => {
  it("accepts a valid single-seller proposal and takes prices from inventory", async () => {
    const { provider } = mockProvider([goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    if (out.status !== "PROPOSAL") return;
    expect(out.proposal.sellerId).toBe("seller-a");
    expect(out.proposal.totalPriceCents).toBe(10500);
    expect(out.proposal.layout.fitsProvidedMeasurements).toBe(true);
    expect(out.proposal.placements[1]!.yawRad).toBeCloseTo(Math.PI);
    expect(out.calls).toHaveLength(1);
  });

  it("returns a clarification question without selecting items", async () => {
    const clarify = JSON.stringify({
      schemaVersion: 1, intent: "CLARIFY", selectedItems: [], placements: [], totalPriceCents: 0,
      constraintChanges: [], clarification: "Do you want seating or storage?", rationale: "", reasonCodes: [],
    });
    const { provider } = mockProvider([clarify]);
    const out = await proposeLayout(fixtureContext({ preferences: "make it nice" }), provider);
    expect(out).toMatchObject({ status: "CLARIFICATION", question: "Do you want seating or storage?" });
  });

  it("logs model id, config, latency and token usage per call without secrets", async () => {
    const { provider } = mockProvider(["not json", goodDeskChairJson()]);
    const logs: unknown[] = [];
    let t = 0;
    const out = await proposeLayout(fixtureContext(), provider, { onCall: (l) => logs.push(l), now: () => (t += 50) });
    expect(out.status).toBe("PROPOSAL");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({
      event: "planning.model_call", attempt: 2, purpose: "repair", provider: "mock", requestedModel: "mock-model-1",
      responseModel: "mock-model-1-0001", latencyMs: 50, outcome: "PROPOSAL",
      usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
      config: { temperature: 0.2, maxTokens: 1500, thinking: "disabled", timeoutMs: 2000, responseFormat: "json_object" },
    });
    expect(logs[0]).toMatchObject({ outcome: "REJECTED", rejectionCodes: ["INVALID_JSON"] });
  });
});

describe("TEST-04: invalid JSON", () => {
  it("does one bounded repair, then falls back to manual placement", async () => {
    const { provider, requests } = mockProvider(["Sure! Here is a layout: desk by the wall", "{\"schemaVersion\":1,"]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    if (out.status !== "MANUAL_FALLBACK") return;
    expect(out.reason).toBe("INVALID_OUTPUT");
    expect(requests).toHaveLength(MAX_MODEL_CALLS);
    expect(requests[1]!.messages.at(-1)!.content).toContain("INVALID_JSON");
  });

  it("rejects unknown fields (strict schema)", async () => {
    const { provider } = mockProvider([goodDeskChairJson({ discountCents: 500 }), goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    expect(out.calls[0]!.rejectionCodes).toEqual(["SCHEMA_INVALID"]);
  });

  it("treats empty and truncated content as invalid output", async () => {
    const { provider } = mockProvider([reply(""), reply("{\"schemaV", { finishReason: "length" })]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "INVALID_OUTPUT" });
    expect(out.calls.map((c) => c.outcome)).toEqual(["EMPTY_OUTPUT", "TRUNCATED"]);
  });
});

describe("TEST-04: invented item", () => {
  it("rejects an item ID that is not in the candidate inventory", async () => {
    const invented = proposalJson([{ itemId: "lamp-ghost-9", priceCents: 1000 }], [{ itemId: "lamp-ghost-9", xM: 1, zM: 2, yawDeg: 0 }]);
    const { provider } = mockProvider([invented, invented]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "VALIDATION_FAILED" });
    if (out.status !== "MANUAL_FALLBACK") return;
    expect(out.rejections.map((r) => r.code)).toContain("INVENTED_ITEM");
  });

  it("rejects placements for unselected or unknown items", async () => {
    const bad = proposalJson(GOOD_DESK_CHAIR.items, [...GOOD_DESK_CHAIR.placements, { itemId: "shelf-pine-80", xM: 0.3, zM: 2, yawDeg: 90 }]);
    const { provider } = mockProvider([bad, goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    expect(out.calls[0]!.rejectionCodes).toEqual(["PLACEMENT_MISMATCH"]);
  });
});

describe("TEST-04: hallucinated price", () => {
  it("rejects an item price that differs from inventory", async () => {
    const cheap = proposalJson([{ itemId: "desk-oak-120", priceCents: 100 }], [{ itemId: "desk-oak-120", xM: 1, zM: 3.6, yawDeg: 0 }]);
    const { provider } = mockProvider([cheap, cheap]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    if (out.status !== "MANUAL_FALLBACK") return;
    expect(out.rejections[0]).toMatchObject({ code: "HALLUCINATED_PRICE" });
  });

  it("rejects a total that is not the inventory sum", async () => {
    const { provider } = mockProvider([goodDeskChairJson({ totalPriceCents: 9000 }), goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    expect(out.calls[0]!.rejectionCodes).toEqual(["HALLUCINATED_PRICE"]);
  });

  it("enforces a stated hard budget against inventory prices", async () => {
    const { provider } = mockProvider([goodDeskChairJson(), goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext({ budgetMaxCents: 10000 }), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    expect(out.calls.every((c) => c.rejectionCodes.includes("OVER_BUDGET"))).toBe(true);
  });
});

describe("one-seller rule", () => {
  it("rejects a bundle from two sellers", async () => {
    const mixed = proposalJson(
      [{ itemId: "desk-oak-120", priceCents: 8000 }, { itemId: "dresser-6d", priceCents: 12000 }],
      [{ itemId: "desk-oak-120", xM: 1, zM: 3.6, yawDeg: 0 }, { itemId: "dresser-6d", xM: 0.4, zM: 2, yawDeg: 90 }],
    );
    const { provider } = mockProvider([mixed, mixed]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    expect(out.calls[0]!.rejectionCodes).toContain("MULTIPLE_SELLERS");
  });
});

describe("TEST-04: forbidden constraint change", () => {
  it("cannot place or move a kept obstacle", async () => {
    const moveBed = proposalJson(GOOD_DESK_CHAIR.items, [...GOOD_DESK_CHAIR.placements, { itemId: "bed-kept", xM: 1.7, zM: 2, yawDeg: 0 }]);
    const { provider } = mockProvider([moveBed, moveBed]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    expect(out.calls[0]!.rejectionCodes).toContain("INVENTED_ITEM");
  });

  it("cannot loosen clearance via an extra field", async () => {
    const { provider } = mockProvider([goodDeskChairJson({ wallClearanceM: 0 }), goodDeskChairJson({ ceilingHeightM: 3 })]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "INVALID_OUTPUT" });
  });

  it("validates against the unchanged room even when the model claims a constraint was removed", async () => {
    const sofaInDoor = proposalJson([{ itemId: "sofa-3seat", priceCents: 30000 }], [{ itemId: "sofa-3seat", xM: 1.5, zM: 0.6, yawDeg: 0 }], {
      constraintChanges: [{ constraint: "door-entry swing", requestedChange: "ignore the door swing" }],
    });
    const { provider, requests } = mockProvider([sofaInDoor, sofaInDoor]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    if (out.status !== "MANUAL_FALLBACK") return;
    expect(out.reason).toBe("VALIDATION_FAILED");
    expect(out.spatialFindings!.some((f) => f.code === "DOOR_SWING" && f.status === "FAIL")).toBe(true);
    expect(requests[1]!.messages.at(-1)!.content).toContain("DOOR_SWING");
  });

  it("returns requested constraint changes as unapplied and leaves the room untouched", async () => {
    const ctx = fixtureContext({ preferences: "Move my bed to the middle and give me a desk." });
    const withChange = goodDeskChairJson({ constraintChanges: [{ constraint: "bed-kept", requestedChange: "move bed to room center" }] });
    const { provider } = mockProvider([withChange]);
    const out = await proposeLayout(ctx, provider);
    expect(out.status).toBe("PROPOSAL");
    if (out.status !== "PROPOSAL") return;
    expect(out.proposal.unappliedConstraintChanges).toHaveLength(1);
    expect(ctx.room).toEqual(loadFixtureRoom());
  });
});
