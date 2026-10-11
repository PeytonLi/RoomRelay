import {
  buildPlanningContext,
  createDeepSeekProvider,
  planningRequestSchema,
  proposeLayout,
  type CallLog,
  type ChatProvider,
  type PlanningOutcome,
  type ProviderConfig,
} from "@roomrelay/planning";
import type { RoomGeometry } from "@roomrelay/spatial";
import inventoryFixture from "../fixtures/inventory.synthetic.json";
import roomFixture from "../fixtures/room.synthetic.json";
import type { ServerConfig } from "./env";

export const SUPPORTED_AI_PROVIDERS = ["deepseek"] as const;

export interface ProposalDeps {
  config: ServerConfig;
  createProvider?: (cfg: { provider: string; apiKey: string; model: string }) => ChatProvider;
  log?: (record: CallLog) => void;
}

export type ProposalResponse =
  | { status: 503; body: { state: "unavailable"; capability: "ai"; missing: string[]; reason: string } }
  | { status: 400; body: { state: "invalid_request"; issues: string[] } }
  | {
      status: 200;
      body: {
        state: "proposal" | "clarification" | "manual_fallback";
        outcome: PlanningOutcome;
        model: Pick<ProviderConfig, "provider" | "model"> & { responseModels: string[] };
        room: { measurementRevision: number; synthetic: true };
        inventorySource: "synthetic fixture";
      };
    };

const defaultCreateProvider: NonNullable<ProposalDeps["createProvider"]> = ({ apiKey, model }) =>
  createDeepSeekProvider({ apiKey, model });

const defaultLog = (record: CallLog) => console.info(JSON.stringify(record));

/**
 * POST /api/planning/proposal. Inventory and room are server-side fixtures
 * until persisted inventory exists, so the client cannot supply prices,
 * sellers or geometry. Without the AI capability this never returns a
 * recommendation, only an explicit unavailable state.
 */
export async function handleProposalRequest(body: unknown, deps: ProposalDeps): Promise<ProposalResponse> {
  const { env, capabilities } = deps.config;
  if (capabilities.ai.status !== "available" || !env.AI_PROVIDER || !env.AI_API_KEY || !env.AI_TEXT_MODEL) {
    return {
      status: 503,
      body: { state: "unavailable", capability: "ai", missing: capabilities.ai.missing, reason: "AI planning is not configured. Place items manually; fit checks still apply." },
    };
  }
  if (!(SUPPORTED_AI_PROVIDERS as readonly string[]).includes(env.AI_PROVIDER)) {
    return {
      status: 503,
      body: { state: "unavailable", capability: "ai", missing: [], reason: `AI_PROVIDER "${env.AI_PROVIDER}" is not supported (supported: ${SUPPORTED_AI_PROVIDERS.join(", ")}).` },
    };
  }

  const request = planningRequestSchema.safeParse(body);
  if (!request.success) {
    return { status: 400, body: { state: "invalid_request", issues: request.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`) } };
  }

  const room = roomFixture as unknown as RoomGeometry;
  const ctx = buildPlanningContext({ room, candidates: inventoryFixture.items, request: request.data });
  const provider = (deps.createProvider ?? defaultCreateProvider)({ provider: env.AI_PROVIDER, apiKey: env.AI_API_KEY, model: env.AI_TEXT_MODEL });
  const outcome = await proposeLayout(ctx, provider, { onCall: deps.log ?? defaultLog });

  const state = outcome.status === "PROPOSAL" ? "proposal" : outcome.status === "CLARIFICATION" ? "clarification" : "manual_fallback";
  return {
    status: 200,
    body: {
      state,
      outcome,
      model: {
        provider: provider.config.provider,
        model: provider.config.model,
        responseModels: [...new Set(outcome.calls.map((c) => c.responseModel).filter((m): m is string => m !== null))],
      },
      room: { measurementRevision: room.measurementRevision, synthetic: true },
      inventorySource: "synthetic fixture",
    },
  };
}
