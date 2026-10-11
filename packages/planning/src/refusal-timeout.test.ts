import { describe, expect, it } from "vitest";
import { proposeLayout } from "./propose";
import { ProviderError } from "./provider";
import { fixtureContext, goodDeskChairJson, mockProvider, reply } from "./testkit";

describe("TEST-04: refusal and timeout", () => {
  it("retries a refusal once, then falls back", async () => {
    const { provider } = mockProvider([reply(null, { finishReason: "content_filter" }), reply(null, { refusal: "I can't help with that." })]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "REFUSAL" });
    expect(out.calls.map((c) => c.outcome)).toEqual(["REFUSAL", "REFUSAL"]);
  });

  it("times out a hanging provider, retries once, then falls back", async () => {
    const { provider, requests } = mockProvider(["HANG", "HANG"], { timeoutMs: 20 });
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "TIMEOUT" });
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.signal.aborted)).toBe(true);
  });

  it("recovers when the retry after a timeout succeeds", async () => {
    const { provider } = mockProvider([new ProviderError("TIMEOUT", "t"), goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out.status).toBe("PROPOSAL");
    expect(out.calls.map((c) => c.purpose)).toEqual(["initial", "retry"]);
  });

  it("does not retry a non-retryable provider error (auth)", async () => {
    const { provider, requests } = mockProvider([new ProviderError("HTTP", "provider HTTP 401", 401), goodDeskChairJson()]);
    const out = await proposeLayout(fixtureContext(), provider);
    expect(out).toMatchObject({ status: "MANUAL_FALLBACK", reason: "PROVIDER_ERROR" });
    expect(requests).toHaveLength(1);
    expect(out.calls[0]!.httpStatus).toBe(401);
  });
});
