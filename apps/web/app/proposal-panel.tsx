"use client";

import { useState } from "react";
import type { Placement } from "@roomrelay/spatial";
import type { PlanningOutcome } from "@roomrelay/planning";
import type { ViewerItem } from "@/lib/viewer-types";

type ProposalBody =
  | { state: "unavailable"; missing: string[]; reason: string }
  | { state: "invalid_request"; issues: string[] }
  | {
      state: "proposal" | "clarification" | "manual_fallback";
      outcome: PlanningOutcome;
      model: { provider: string; model: string; responseModels: string[] };
    };

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; body: ProposalBody };

type Proposal = Extract<PlanningOutcome, { status: "PROPOSAL" }>["proposal"];

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface CurrentLayoutEntry {
  itemId: string;
  xM: number;
  zM: number;
  yawDeg: number;
}

/** Box proxies built from server-validated inventory dims; the live fit check re-validates them. */
export function proposalToViewer(p: Proposal): { items: ViewerItem[]; placements: Record<string, Placement> } {
  const items: ViewerItem[] = p.items
    .filter((i) => i.confirmedDimsM)
    .map((i) => ({
      id: i.itemId,
      title: i.title,
      dimsM: i.confirmedDimsM!,
      provenance: "APPROXIMATE_PROXY",
      provenanceNote: `Box proxy from confirmed dimensions; no 3D model yet. ${usd(i.priceCents)} from ${p.sellerName}.`,
      assetUrl: "",
      boxProxy: true,
      localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      stats: { bytes: 0, triangleCount: 12 },
      conditionPhotos: [],
      photosNote: "No condition photos in the synthetic inventory.",
    }));
  const placements = Object.fromEntries(p.placements.map((pl) => [pl.itemId, { xM: pl.xM, zM: pl.zM, yawRad: pl.yawRad }]));
  return { items, placements };
}

export function ProposalPanel({
  currentLayout,
  onApply,
}: {
  /** Applied proposal items as they are now, sent so the buyer can ask for edits. */
  currentLayout: CurrentLayoutEntry[];
  onApply: (proposal: Proposal) => void;
}) {
  const [preferences, setPreferences] = useState("");
  const [budget, setBudget] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const budgetCents = budget.trim() === "" ? undefined : Math.round(Number(budget) * 100);
  const budgetInvalid = budgetCents !== undefined && (!Number.isFinite(budgetCents) || budgetCents <= 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (preferences.trim() === "" || budgetInvalid) return;
    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/planning/proposal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preferences,
          ...(budgetCents !== undefined ? { budgetMaxCents: budgetCents } : {}),
          ...(currentLayout.length > 0 ? { currentLayout } : {}),
        }),
      });
      const body = (await res.json()) as ProposalBody;
      setStatus({ kind: "done", body });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the planning service. Place items manually; fit checks still apply." });
    }
  }

  return (
    <div className="card" data-testid="proposal-panel">
      <h2>AI layout proposal</h2>
      <form className="proposal-form" onSubmit={submit}>
        <label>
          <span>What do you need? (preferences, budget, move-in date)</span>
          <textarea
            data-testid="proposal-preferences"
            value={preferences}
            maxLength={2000}
            rows={3}
            onChange={(e) => setPreferences(e.target.value)}
            placeholder={currentLayout.length > 0 ? "e.g. rotate the desk to face the window" : "e.g. a desk and chair for studying, moving in Nov 1"}
          />
        </label>
        <label>
          <span>Max budget (USD, optional)</span>
          <input data-testid="proposal-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={budgetInvalid} />
        </label>
        <button className="btn primary" type="submit" data-testid="proposal-submit" disabled={status.kind === "loading" || preferences.trim() === "" || budgetInvalid}>
          {status.kind === "loading" ? "Planning…" : currentLayout.length > 0 ? "Ask for an edit" : "Propose a layout"}
        </button>
      </form>
      <div aria-live="polite" style={{ marginTop: 10 }}>
        <ProposalResult status={status} onApply={onApply} />
      </div>
      <div className="muted" style={{ marginTop: 8 }}>
        Synthetic inventory. Prices and sellers come from inventory, and every placement is re-checked against the room.
      </div>
    </div>
  );
}

function ProposalResult({ status, onApply }: { status: Status; onApply: (p: Proposal) => void }) {
  if (status.kind === "idle" || status.kind === "loading") return null;
  if (status.kind === "error") return <div className="notice" data-testid="proposal-error">{status.message}</div>;
  const body = status.body;
  if (body.state === "unavailable") {
    return (
      <div className="notice" data-testid="proposal-unavailable">
        {body.reason}
        {body.missing.length > 0 ? <div className="muted">Missing: {body.missing.join(", ")}</div> : null}
      </div>
    );
  }
  if (body.state === "invalid_request") {
    return <div className="notice" data-testid="proposal-invalid">Request rejected: {body.issues.join("; ")}</div>;
  }
  const modelLine = <div className="muted" data-testid="proposal-model">Model: {body.model.responseModels.join(", ") || body.model.model}</div>;
  const o = body.outcome;
  if (o.status === "CLARIFICATION") {
    return (
      <div data-testid="proposal-clarification">
        <div className="notice">{o.question}</div>
        <Unapplied changes={o.unappliedConstraintChanges} />
        {modelLine}
      </div>
    );
  }
  if (o.status === "MANUAL_FALLBACK") {
    return (
      <div data-testid="proposal-fallback">
        <div className="notice">{o.message}</div>
        <ul className="proposal-list muted">
          {o.rejections.map((r, i) => <li key={`r${i}`}>{r.message}</li>)}
          {(o.spatialFindings ?? []).filter((f) => f.status === "FAIL").map((f, i) => <li key={`f${i}`}>{f.message}</li>)}
        </ul>
        {modelLine}
      </div>
    );
  }
  const p = o.proposal;
  return (
    <div data-testid="proposal-result">
      <div className="proposal-seller">
        {p.items.length} item{p.items.length === 1 ? "" : "s"} from {p.sellerName} · <strong data-testid="proposal-total">{usd(p.totalPriceCents)}</strong>
      </div>
      <ul className="proposal-list">
        {p.items.map((i) => (
          <li key={i.itemId} data-testid={`proposal-item-${i.itemId}`}>
            <span>{i.title}</span>
            <span>{usd(i.priceCents)}</span>
          </li>
        ))}
      </ul>
      <div className={`verdict ${p.layout.fitsProvidedMeasurements ? "fits" : "nofit"}`}>
        {p.layout.fitsProvidedMeasurements ? "Server check: fits provided measurements" : "Server check: does not fit"}
      </div>
      {p.modelRationale ? (
        <p className="muted" data-testid="proposal-rationale">
          <strong>AI rationale (unverified):</strong> {p.modelRationale}
        </p>
      ) : null}
      <Unapplied changes={p.unappliedConstraintChanges} />
      <button className="btn primary" type="button" data-testid="proposal-apply" onClick={() => onApply(p)}>
        Apply to room (replaces current items)
      </button>
      {modelLine}
    </div>
  );
}

function Unapplied({ changes }: { changes: Array<{ constraint: string; requestedChange: string }> }) {
  if (changes.length === 0) return null;
  return (
    <div className="muted" data-testid="proposal-unapplied">
      Not applied (room constraints are fixed): {changes.map((c) => `${c.constraint}: ${c.requestedChange}`).join("; ")}
    </div>
  );
}
