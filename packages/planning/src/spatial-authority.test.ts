import { describe, expect, it } from "vitest";
import { proposeLayout } from "./propose";
import { fixtureContext, mockProvider, proposalJson } from "./testkit";

describe("spatial validation is authoritative", () => {
  it("repairs once with findings after a FAIL", async () => {
    const overlapBed = proposalJson([{ itemId: "desk-oak-120", priceCents: 8000 }], [{ itemId: "desk-oak-120", xM: 2.8, zM: 3.0, yawDeg: 0 }]);
    const good = proposalJson([{ itemId: "desk-oak-120", priceCents: 8000 }], [{ itemId: "desk-oak-120", xM: 1.0, zM: 3.6, yawDeg: 0 }]);
    const { provider, requests } = mockProvider([overlapBed, good]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    expect(out.calls.map((c) => c.purpose)).toEqual(["initial", "repair"]);
    expect(requests[1]!.messages.at(-1)!.content).toContain("OBSTACLE_OVERLAP");
  });

  it("rejects an item taller than the ceiling", async () => {
    const tall = proposalJson([{ itemId: "wardrobe-tall", priceCents: 9000 }], [{ itemId: "wardrobe-tall", xM: 0.4, zM: 2.0, yawDeg: 90 }]);
    const { provider } = mockProvider([tall, tall]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("MANUAL_FALLBACK");
    if (out.status !== "MANUAL_FALLBACK") return;
    expect(out.spatialFindings!.map((f) => f.code)).toContain("HEIGHT_VS_CEILING");
  });
});
