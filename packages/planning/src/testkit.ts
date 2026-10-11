import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RoomGeometry } from "@roomrelay/spatial";
import { buildPlanningContext, type PlanningContext } from "./context";
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResponse, type ProviderConfig } from "./provider";
import type { CandidateItem, PlanningRequest } from "./schema";

const fixtureDir = fileURLToPath(new URL("../../../apps/web/fixtures/", import.meta.url));

export function loadFixtureRoom(): RoomGeometry {
  return JSON.parse(readFileSync(`${fixtureDir}room.synthetic.json`, "utf8")) as RoomGeometry;
}

export function loadFixtureInventory(): CandidateItem[] {
  return (JSON.parse(readFileSync(`${fixtureDir}inventory.synthetic.json`, "utf8")) as { items: CandidateItem[] }).items;
}

export function fixtureContext(request: Partial<PlanningRequest> = {}, candidates = loadFixtureInventory()): PlanningContext {
  return buildPlanningContext({
    room: loadFixtureRoom(),
    candidates,
    request: { preferences: "A desk and a chair for studying.", ...request },
  });
}

export type MockStep = ChatResponse | ProviderError | "HANG" | string;

/** Scripted provider: each call consumes the next step. A string is a JSON content reply. */
export function mockProvider(steps: MockStep[], overrides: Partial<ProviderConfig> = {}) {
  const requests: ChatRequest[] = [];
  const config: ProviderConfig = {
    provider: "mock",
    model: "mock-model-1",
    baseUrl: "mock://",
    responseFormat: "json_object",
    temperature: 0.2,
    maxTokens: 1500,
    thinking: "disabled",
    timeoutMs: 2_000,
    ...overrides,
  };
  const provider: ChatProvider = {
    config,
    complete(req) {
      requests.push(req);
      const step = steps.shift();
      if (step === undefined) return Promise.reject(new Error("mock provider exhausted"));
      if (step === "HANG") return new Promise<ChatResponse>(() => undefined);
      if (step instanceof ProviderError) return Promise.reject(step);
      if (typeof step === "string") return Promise.resolve(reply(step));
      return Promise.resolve(step);
    },
  };
  return { provider, requests };
}

export function reply(content: string | null, extra: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content,
    finishReason: "stop",
    refusal: null,
    responseModel: "mock-model-1-0001",
    systemFingerprint: "fp_mock",
    usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
    ...extra,
  };
}

type P = { itemId: string; xM: number; zM: number; yawDeg: number };

export function proposalJson(
  items: Array<{ itemId: string; priceCents: number }>,
  placements: P[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    intent: "PROPOSE_LAYOUT",
    selectedItems: items,
    placements,
    totalPriceCents: items.reduce((s, i) => s + i.priceCents, 0),
    constraintChanges: [],
    clarification: null,
    rationale: "Desk against the back wall with the chair in front.",
    reasonCodes: ["MEETS_REQUESTED_CATEGORY", "FITS_ROOM"],
    ...extra,
  });
}

/** A layout known to pass the fixture room checks. */
export const GOOD_DESK_CHAIR = {
  items: [
    { itemId: "desk-oak-120", priceCents: 8000 },
    { itemId: "chair-task-01", priceCents: 2500 },
  ],
  placements: [
    { itemId: "desk-oak-120", xM: 1.0, zM: 3.6, yawDeg: 0 },
    { itemId: "chair-task-01", xM: 1.0, zM: 2.9, yawDeg: 180 },
  ],
};

export const goodDeskChairJson = (extra: Record<string, unknown> = {}) =>
  proposalJson(GOOD_DESK_CHAIR.items, GOOD_DESK_CHAIR.placements, extra);
