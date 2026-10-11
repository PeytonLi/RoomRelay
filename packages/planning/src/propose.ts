import type { LayoutFinding } from "@roomrelay/spatial";
import type { PlanningContext } from "./context";
import { buildMessages, buildRepairMessages } from "./prompt";
import { ProviderError, type ChatProvider, type ChatResponse, type ProviderConfig, type TokenUsage } from "./provider";
import { checkModelOutput, type Rejection, type ValidatedProposal } from "./validate";

/** One model call: original attempt plus at most one bounded retry/repair (A-05). */
export const MAX_MODEL_CALLS = 2;

export type CallOutcome =
  | "PROPOSAL"
  | "CLARIFICATION"
  | "REJECTED"
  | "TIMEOUT"
  | "REFUSAL"
  | "EMPTY_OUTPUT"
  | "TRUNCATED"
  | "PROVIDER_ERROR";

/** Per-call log record. Contains no secrets, prompts or listing text. */
export interface CallLog {
  event: "planning.model_call";
  attempt: number;
  purpose: "initial" | "retry" | "repair";
  provider: string;
  requestedModel: string;
  responseModel: string | null;
  systemFingerprint: string | null;
  config: Omit<ProviderConfig, "provider" | "model">;
  latencyMs: number;
  usage: TokenUsage | null;
  finishReason: string | null;
  outcome: CallOutcome;
  rejectionCodes: string[];
  httpStatus?: number;
}

export type FallbackReason = "TIMEOUT" | "REFUSAL" | "PROVIDER_ERROR" | "INVALID_OUTPUT" | "VALIDATION_FAILED";

interface OutcomeBase {
  calls: CallLog[];
}

export type PlanningOutcome =
  | (OutcomeBase & { status: "PROPOSAL"; proposal: ValidatedProposal })
  | (OutcomeBase & {
      status: "CLARIFICATION";
      question: string;
      unappliedConstraintChanges: ValidatedProposal["unappliedConstraintChanges"];
    })
  | (OutcomeBase & {
      status: "MANUAL_FALLBACK";
      reason: FallbackReason;
      message: string;
      rejections: Rejection[];
      spatialFindings?: LayoutFinding[];
    });

export interface ProposeOptions {
  onCall?: (log: CallLog) => void;
  now?: () => number;
}

const FALLBACK_MESSAGE = "No validated AI proposal for this request. Place items manually in the 2D/3D editor; fit checks still apply.";

async function callWithTimeout(provider: ChatProvider, messages: Parameters<ChatProvider["complete"]>[0]["messages"]) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError("TIMEOUT", `no provider response within ${provider.config.timeoutMs}ms`));
    }, provider.config.timeoutMs);
  });
  try {
    return await Promise.race([provider.complete({ messages, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyResponse(res: ChatResponse): CallOutcome | null {
  if (res.refusal || res.finishReason === "content_filter") return "REFUSAL";
  if (res.content === null || res.content.trim() === "") return "EMPTY_OUTPUT";
  if (res.finishReason === "length") return "TRUNCATED";
  return null;
}

export async function proposeLayout(
  ctx: PlanningContext,
  provider: ChatProvider,
  options: ProposeOptions = {},
): Promise<PlanningOutcome> {
  const now = options.now ?? (() => performance.now());
  const { provider: providerName, model, ...config } = provider.config;
  const calls: CallLog[] = [];
  const base = buildMessages(ctx);
  let messages = base;
  let purpose: CallLog["purpose"] = "initial";
  let lastFailure: { reason: FallbackReason; rejections: Rejection[]; spatialFindings?: LayoutFinding[] } = {
    reason: "PROVIDER_ERROR",
    rejections: [],
  };

  const record = (log: Omit<CallLog, "event" | "provider" | "requestedModel" | "config">) => {
    const full: CallLog = { event: "planning.model_call", provider: providerName, requestedModel: model, config, ...log };
    calls.push(full);
    options.onCall?.(full);
  };

  for (let attempt = 1; attempt <= MAX_MODEL_CALLS; attempt++) {
    const started = now();
    let res: ChatResponse;
    try {
      res = await callWithTimeout(provider, messages);
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError("NETWORK", "provider call failed");
      const outcome: CallOutcome = pe.kind === "TIMEOUT" ? "TIMEOUT" : "PROVIDER_ERROR";
      record({
        attempt, purpose, responseModel: null, systemFingerprint: null, latencyMs: Math.round(now() - started),
        usage: null, finishReason: null, outcome, rejectionCodes: [],
        ...(pe.status !== undefined ? { httpStatus: pe.status } : {}),
      });
      lastFailure = { reason: outcome === "TIMEOUT" ? "TIMEOUT" : "PROVIDER_ERROR", rejections: [] };
      if (!pe.retryable) break;
      purpose = "retry";
      continue;
    }
    const latencyMs = Math.round(now() - started);
    const meta = { attempt, purpose, responseModel: res.responseModel, systemFingerprint: res.systemFingerprint, latencyMs, usage: res.usage, finishReason: res.finishReason };

    const transport = classifyResponse(res);
    if (transport) {
      record({ ...meta, outcome: transport, rejectionCodes: [] });
      lastFailure = { reason: transport === "REFUSAL" ? "REFUSAL" : "INVALID_OUTPUT", rejections: [] };
      purpose = "retry";
      messages = base;
      continue;
    }

    const check = checkModelOutput(res.content!, ctx);
    if (check.kind === "PROPOSAL") {
      record({ ...meta, outcome: "PROPOSAL", rejectionCodes: [] });
      return { status: "PROPOSAL", proposal: check.proposal, calls };
    }
    if (check.kind === "CLARIFICATION") {
      record({ ...meta, outcome: "CLARIFICATION", rejectionCodes: [] });
      return { status: "CLARIFICATION", question: check.question, unappliedConstraintChanges: check.unappliedConstraintChanges, calls };
    }
    record({ ...meta, outcome: "REJECTED", rejectionCodes: [...new Set(check.rejections.map((r) => r.code))] });
    const onlyParse = check.rejections.every((r) => r.code === "INVALID_JSON" || r.code === "SCHEMA_INVALID");
    lastFailure = {
      reason: onlyParse ? "INVALID_OUTPUT" : "VALIDATION_FAILED",
      rejections: check.rejections,
      ...(check.spatialFindings ? { spatialFindings: check.spatialFindings } : {}),
    };
    purpose = "repair";
    messages = buildRepairMessages(base, res.content, check.rejections.map((r) => `${r.code}: ${r.message}`));
  }

  return { status: "MANUAL_FALLBACK", message: FALLBACK_MESSAGE, calls, ...lastFailure };
}
