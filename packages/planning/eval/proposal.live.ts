/**
 * LIVE eval: real provider calls. Run with `pnpm --filter @roomrelay/planning eval:live`.
 * Reads AI_PROVIDER / AI_API_KEY / AI_TEXT_MODEL from the environment or apps/web/.env.
 * Never part of `pnpm test`. Writes eval/results/live-eval.json (no secrets, no prompts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLayout } from "@roomrelay/spatial";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { buildPlanningContext } from "../src/context";
import { proposeLayout, type CallLog, type PlanningOutcome } from "../src/propose";
import { createDeepSeekProvider } from "../src/provider";
import { loadFixtureInventory, loadFixtureRoom } from "../src/testkit";
import { CASES, type EvalCase } from "./cases";

loadDotenv({ path: fileURLToPath(new URL("../../../apps/web/.env", import.meta.url)), quiet: true });

/** Independent re-check of every accepted proposal, outside the pipeline under test. */
function invariantViolations(c: EvalCase, out: PlanningOutcome, ctx: ReturnType<typeof buildPlanningContext>): string[] {
  if (out.status !== "PROPOSAL") return [];
  const v: string[] = [];
  const inv = new Map(ctx.candidates.map((i) => [i.itemId, i]));
  const p = out.proposal;
  for (const item of p.items) {
    const src = inv.get(item.itemId);
    if (!src) v.push(`invented item ${item.itemId}`);
    else if (src.priceCents !== item.priceCents) v.push(`price drift on ${item.itemId}`);
  }
  if (new Set(p.items.map((i) => inv.get(i.itemId)?.sellerId)).size !== 1) v.push("multiple sellers");
  if (p.totalPriceCents !== p.items.reduce((s, i) => s + i.priceCents, 0)) v.push("total mismatch");
  if (c.request.budgetMaxCents !== undefined && p.totalPriceCents > c.request.budgetMaxCents) v.push("over budget");
  const layout = validateLayout(
    ctx.room,
    p.placements.map((pl) => ({ id: pl.itemId, dimsM: inv.get(pl.itemId)!.confirmedDimsM!, placement: { xM: pl.xM, zM: pl.zM, yawRad: (pl.yawDeg * Math.PI) / 180 } })),
    { marginM: ctx.marginM },
  );
  if (!layout.fitsProvidedMeasurements) v.push(`independent spatial re-check failed: ${layout.verdict}`);
  return v;
}

function summarizeOutcome(out: PlanningOutcome) {
  switch (out.status) {
    case "PROPOSAL":
      return {
        itemIds: out.proposal.items.map((i) => i.itemId),
        sellerId: out.proposal.sellerId,
        totalPriceCents: out.proposal.totalPriceCents,
        placements: out.proposal.placements.map(({ itemId, xM, zM, yawDeg }) => ({ itemId, xM, zM, yawDeg })),
        verdict: out.proposal.layout.verdict,
        unappliedConstraintChanges: out.proposal.unappliedConstraintChanges,
        reasonCodes: out.proposal.reasonCodes,
        modelRationale: out.proposal.modelRationale,
      };
    case "CLARIFICATION":
      return { question: out.question, unappliedConstraintChanges: out.unappliedConstraintChanges };
    case "MANUAL_FALLBACK":
      return {
        reason: out.reason,
        rejections: out.rejections.slice(0, 8),
      };
  }
}

type EvalCallRecord = Pick<CallLog, "attempt" | "purpose" | "responseModel" | "systemFingerprint" | "latencyMs" | "usage" | "finishReason" | "outcome" | "rejectionCodes">;

interface CaseResult {
  id: string;
  kind: EvalCase["kind"];
  preferences: string;
  budgetMaxCents: number | null;
  accept: EvalCase["accept"];
  expectProposal: boolean;
  status: PlanningOutcome["status"];
  pass: boolean;
  failures: string[];
  wallMs: number;
  modelCalls: number;
  calls: EvalCallRecord[];
  outcome: ReturnType<typeof summarizeOutcome>;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor((s.length - 1) / 2)]!;
};

describe("live DeepSeek planning eval", () => {
  it("runs every case against the real provider and records results", async () => {
    const { AI_PROVIDER, AI_API_KEY, AI_TEXT_MODEL } = process.env;
    if (AI_PROVIDER !== "deepseek" || !AI_API_KEY || !AI_TEXT_MODEL) {
      throw new Error("live eval needs AI_PROVIDER=deepseek, AI_API_KEY and AI_TEXT_MODEL (env or apps/web/.env)");
    }
    const provider = createDeepSeekProvider({ apiKey: AI_API_KEY, model: AI_TEXT_MODEL });
    const baseRoom = loadFixtureRoom();
    const baseInventory = loadFixtureInventory();
    const startedAt = new Date().toISOString();
    const results: CaseResult[] = [];

    for (const c of CASES) {
      const ctx = buildPlanningContext({
        room: c.room ? c.room(baseRoom) : baseRoom,
        candidates: c.inventory ? c.inventory(baseInventory) : baseInventory,
        request: c.request,
      });
      const roomBefore = JSON.stringify(ctx.room);
      const calls: CallLog[] = [];
      const t0 = performance.now();
      const out = await proposeLayout(ctx, provider, { onCall: (l) => calls.push(l) });
      const wallMs = Math.round(performance.now() - t0);
      const failures = [
        ...(c.accept.includes(out.status) ? [] : [`status ${out.status} not in accepted [${c.accept.join(", ")}]`]),
        ...invariantViolations(c, out, ctx),
        ...(c.check ? c.check(out) : []),
        ...(JSON.stringify(ctx.room) === roomBefore ? [] : ["room constraints were mutated"]),
      ];
      results.push({
        id: c.id,
        kind: c.kind,
        preferences: c.request.preferences,
        budgetMaxCents: c.request.budgetMaxCents ?? null,
        accept: c.accept,
        expectProposal: c.expectProposal,
        status: out.status,
        pass: failures.length === 0,
        failures,
        wallMs,
        modelCalls: calls.length,
        calls: calls.map(({ attempt, purpose, responseModel, systemFingerprint, latencyMs, usage, finishReason, outcome, rejectionCodes }) => ({
          attempt, purpose, responseModel, systemFingerprint, latencyMs, usage, finishReason, outcome, rejectionCodes,
        })),
        outcome: summarizeOutcome(out),
      });
      console.info(`[eval] ${c.id}: ${out.status} ${failures.length === 0 ? "PASS" : `FAIL (${failures.join("; ")})`} calls=${calls.length} ${wallMs}ms`);
    }

    const allCalls = results.flatMap((r) => r.calls);
    const proposalCases = results.filter((r) => r.expectProposal);
    const summary = {
      cases: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).map((r) => r.id),
      totalModelCalls: allCalls.length,
      validatedProposalRate: {
        definition: "cases where a proposal is the desired outcome that ended with a server-validated PROPOSAL",
        validated: proposalCases.filter((r) => r.status === "PROPOSAL").length,
        of: proposalCases.length,
      },
      firstCallAcceptedRate: {
        definition: "cases whose first model response passed all server checks (PROPOSAL or CLARIFICATION) without repair",
        accepted: results.filter((r) => r.calls[0] && (r.calls[0].outcome === "PROPOSAL" || r.calls[0].outcome === "CLARIFICATION")).length,
        of: results.length,
      },
      outcomes: Object.fromEntries(["PROPOSAL", "CLARIFICATION", "MANUAL_FALLBACK"].map((s) => [s, results.filter((r) => r.status === s).length])),
      rejectionCodesSeen: [...new Set(allCalls.flatMap((c) => c.rejectionCodes))],
      unsafeAccepted: results.filter((r) => r.failures.some((f) => !f.startsWith("status ") && !f.startsWith("proposal is missing") && !f.includes("yaw") && !f.includes("desk moved"))).length,
      latencyMs: { median: median(allCalls.map((c) => c.latencyMs)), max: Math.max(...allCalls.map((c) => c.latencyMs)) },
      tokens: {
        prompt: allCalls.reduce((s, c) => s + (c.usage?.promptTokens ?? 0), 0),
        completion: allCalls.reduce((s, c) => s + (c.usage?.completionTokens ?? 0), 0),
        total: allCalls.reduce((s, c) => s + (c.usage?.totalTokens ?? 0), 0),
      },
    };
    const { provider: providerName, model, ...config } = provider.config;
    const report = {
      kind: "roomrelay.planning.live-eval",
      startedAt,
      finishedAt: new Date().toISOString(),
      provider: providerName,
      requestedModel: model,
      responseModels: [...new Set(allCalls.map((c) => c.responseModel).filter(Boolean))],
      systemFingerprints: [...new Set(allCalls.map((c) => c.systemFingerprint).filter(Boolean))],
      config,
      fixtures: { room: "apps/web/fixtures/room.synthetic.json (+ tiny-room variant in eval/cases.ts)", inventory: "apps/web/fixtures/inventory.synthetic.json" },
      summary,
      results,
    };
    const outDir = fileURLToPath(new URL("./results/", import.meta.url));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}live-eval.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.info(`[eval] summary ${JSON.stringify(summary)}`);

    expect(allCalls.length).toBeGreaterThanOrEqual(10);
    expect(summary.unsafeAccepted).toBe(0);
  });
});
