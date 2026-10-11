import type { ChatProvider, ProviderConfig } from "@roomrelay/planning";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./env";
import { handleProposalRequest } from "./planning";

const aiEnv = { AI_PROVIDER: "deepseek", AI_API_KEY: "sk-route-test", AI_TEXT_MODEL: "deepseek-flash" };

function fakeProvider(contents: string[]): ChatProvider {
  const config: ProviderConfig = {
    provider: "deepseek", model: "deepseek-flash", baseUrl: "mock://", responseFormat: "json_object",
    temperature: 0.2, maxTokens: 1500, thinking: "disabled", timeoutMs: 1000,
  };
  return {
    config,
    complete: async () => ({
      content: contents.shift() ?? null, finishReason: "stop", refusal: null,
      responseModel: "deepseek-flash", systemFingerprint: "fp", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  };
}

const deskOnly = JSON.stringify({
  schemaVersion: 1, intent: "PROPOSE_LAYOUT",
  selectedItems: [{ itemId: "desk-oak-120", priceCents: 8000 }],
  placements: [{ itemId: "desk-oak-120", xM: 1.0, zM: 3.6, yawDeg: 0 }],
  totalPriceCents: 8000, constraintChanges: [], clarification: null, rationale: "Desk by the back wall.", reasonCodes: ["FITS_ROOM"],
});

describe("POST /api/planning/proposal handler", () => {
  it("returns an explicit unavailable state, never a recommendation, without AI config", async () => {
    const createProvider = vi.fn();
    const res = await handleProposalRequest({ preferences: "desk" }, { config: loadConfig({}), createProvider });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ state: "unavailable", capability: "ai", missing: ["AI_PROVIDER", "AI_API_KEY", "AI_TEXT_MODEL"] });
    expect(JSON.stringify(res.body)).not.toMatch(/desk-oak|placements/);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("reports an unsupported provider as unavailable", async () => {
    const res = await handleProposalRequest({ preferences: "desk" }, { config: loadConfig({ ...aiEnv, AI_PROVIDER: "other" }) });
    expect(res).toMatchObject({ status: 503, body: { state: "unavailable" } });
  });

  it("rejects client-supplied prices or inventory fields", async () => {
    const res = await handleProposalRequest(
      { preferences: "desk", candidates: [{ itemId: "x", priceCents: 1 }] },
      { config: loadConfig(aiEnv), createProvider: () => fakeProvider([deskOnly]) },
    );
    expect(res.status).toBe(400);
  });

  it("returns a validated proposal using inventory prices and logs each call", async () => {
    const logs: unknown[] = [];
    const res = await handleProposalRequest(
      { preferences: "a desk" },
      { config: loadConfig(aiEnv), createProvider: () => fakeProvider([deskOnly]), log: (l) => logs.push(l) },
    );
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect(res.body.state).toBe("proposal");
    expect(res.body.model).toEqual({ provider: "deepseek", model: "deepseek-flash", responseModels: ["deepseek-flash"] });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("sk-route-test");
  });

  it("falls back to manual placement after one failed repair", async () => {
    const res = await handleProposalRequest(
      { preferences: "a desk" },
      { config: loadConfig(aiEnv), createProvider: () => fakeProvider(["nope", "still nope"]), log: () => undefined },
    );
    expect(res).toMatchObject({ status: 200, body: { state: "manual_fallback", outcome: { reason: "INVALID_OUTPUT" } } });
  });
});
