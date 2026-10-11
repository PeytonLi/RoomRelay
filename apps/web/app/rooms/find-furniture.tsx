"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { LayoutFinding } from "@roomrelay/spatial";
import { apiJson, failureMessage, formatDateTime, formatMeters, formatMoney, fromLocalInput, toLocalInput } from "@/lib/client/api";
import { QUOTE_TERMS_VERSION, type CandidateResult, type CandidateRejection } from "@/lib/journey/types";

export interface SelectedRoom {
  id: string;
  name: string;
  measurementRevision: number;
}

interface Requirements { budgetCents: number; pickupFrom: string; pickupTo: string }
interface LayoutState {
  layoutId: string;
  candidate: CandidateResult;
  findings: LayoutFinding[];
  quotable: boolean;
  reasons: { code: string; message: string }[];
}

const REJECTION_TEXT: Record<CandidateRejection, string> = {
  BUDGET_EXCEEDED: "Over your budget",
  PICKUP_WINDOW_MISMATCH: "Pickup window does not overlap your dates",
  NO_GEOMETRIC_FIT: "Does not fit the measured room",
};

export function constraintAdvice(candidates: CandidateResult[], requirements: Requirements): string[] {
  const rejected = candidates.filter((c) => c.rejectionReason);
  if (candidates.length === 0) return ["No published listings are available right now. Try again later or widen your search."];
  const advice: string[] = [];
  const overBudget = rejected.filter((c) => c.rejectionReason === "BUDGET_EXCEEDED");
  if (overBudget.length) {
    const cheapest = Math.min(...overBudget.map((c) => c.priceCents));
    advice.push(`${overBudget.length} item(s) exceed your ${formatMoney(requirements.budgetCents)} budget. Raise the budget to at least ${formatMoney(cheapest)} to include the cheapest one.`);
  }
  const window = rejected.filter((c) => c.rejectionReason === "PICKUP_WINDOW_MISMATCH");
  if (window.length) {
    const earliest = window.map((c) => c.pickupWindowStart).sort()[0]!;
    advice.push(`${window.length} item(s) have pickup windows outside your dates. Widen your pickup dates (earliest available pickup starts ${formatDateTime(earliest)}).`);
  }
  const noFit = rejected.filter((c) => c.rejectionReason === "NO_GEOMETRIC_FIT");
  if (noFit.length) advice.push(`${noFit.length} item(s) do not fit this room's measured free floor area. Choose a different room or re-measure it.`);
  return advice;
}

function Findings({ findings }: { findings: LayoutFinding[] }) {
  if (!findings.length) return <p className="muted">No fit findings returned.</p>;
  return (
    <ul className="finding-list" aria-label="Fit findings">
      {findings.map((f, i) => (
        <li key={`${f.code}-${i}`} className={`finding ${f.status.toLowerCase()}`}>
          <span className="dot" aria-hidden="true" />
          <span><strong>{f.status}</strong> {f.message}</span>
        </li>
      ))}
    </ul>
  );
}

function defaultRange(offsetHours: number): string {
  return toLocalInput(new Date(Date.now() + offsetHours * 3_600_000).toISOString());
}

export default function FindFurniture({ room }: { room: SelectedRoom }) {
  const router = useRouter();
  const [budget, setBudget] = useState("500");
  const [pickupFrom, setPickupFrom] = useState(() => defaultRange(1));
  const [pickupTo, setPickupTo] = useState(() => defaultRange(72));
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [candidates, setCandidates] = useState<CandidateResult[] | null>(null);
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [slotStart, setSlotStart] = useState("");
  const [slotEnd, setSlotEnd] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLayout(null);
    const budgetCents = Math.round(Number(budget) * 100);
    const from = fromLocalInput(pickupFrom);
    const to = fromLocalInput(pickupTo);
    if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) return setError("Enter a budget in dollars, for example 250 or 249.99.");
    if (!from || !to || from >= to) return setError("Pickup 'to' must be after pickup 'from'.");
    const next = { budgetCents, pickupFrom: from, pickupTo: to };
    setBusy("find");
    try {
      const body = await apiJson<{ candidates: CandidateResult[] }>(`/api/v1/rooms/${room.id}/candidates`, { json: next });
      setRequirements(next);
      setCandidates(body.candidates);
    } catch (failure) {
      setCandidates(null);
      setError(failureMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  async function choose(candidate: CandidateResult) {
    if (!candidate.placement || !requirements) return;
    setError("");
    setBusy(`choose-${candidate.itemId}`);
    try {
      const created = await apiJson<{ layout: { id: string }; evaluation: { findings: LayoutFinding[] } }>("/api/v1/layouts", {
        json: { roomId: room.id, roomRevision: room.measurementRevision, placements: [candidate.placement], requirements },
      });
      let quotable = false;
      let findings = created.evaluation.findings;
      let reasons: { code: string; message: string }[] = [];
      try {
        const check = await apiJson<{ quotable: boolean; findings: LayoutFinding[]; reasons: typeof reasons }>(`/api/v1/layouts/${created.layout.id}/quotable`, { method: "POST" });
        quotable = check.quotable === true;
        findings = check.findings;
        reasons = check.reasons;
      } catch (failure) {
        const body = (failure as { body?: { findings?: LayoutFinding[]; reasons?: typeof reasons } }).body;
        if (body?.findings) findings = body.findings;
        reasons = body?.reasons ?? [{ code: "NOT_QUOTABLE", message: failureMessage(failure) }];
      }
      const start = [requirements.pickupFrom, candidate.pickupWindowStart].sort().at(-1)!;
      const windowEnd = [requirements.pickupTo, candidate.pickupWindowEnd].sort()[0]!;
      const end = new Date(Math.min(new Date(start).getTime() + 3_600_000, new Date(windowEnd).getTime())).toISOString();
      setSlotStart(toLocalInput(start));
      setSlotEnd(toLocalInput(end));
      setLayout({ layoutId: created.layout.id, candidate, findings, quotable, reasons });
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!layout?.quotable) return;
    setError("");
    const start = fromLocalInput(slotStart);
    const end = fromLocalInput(slotEnd);
    const windowStart = [requirements!.pickupFrom, layout.candidate.pickupWindowStart].sort().at(-1)!;
    const windowEnd = [requirements!.pickupTo, layout.candidate.pickupWindowEnd].sort()[0]!;
    if (!start || !end || start >= end) return setError("Pickup slot end must be after its start.");
    if (start < windowStart || end > windowEnd) {
      return setError(`Pickup slot must be inside ${formatDateTime(windowStart)} – ${formatDateTime(windowEnd)}.`);
    }
    setBusy("quote");
    try {
      const body = await apiJson<{ quote: { id: string } }>("/api/v1/quotes", {
        json: {
          sellerId: layout.candidate.sellerId,
          lines: [{ itemId: layout.candidate.itemId, priceCents: layout.candidate.priceCents }],
          pickupSlot: { start, end },
          roomId: room.id,
          layoutRevisionId: layout.layoutId,
          termsVersion: QUOTE_TERMS_VERSION,
        },
      });
      router.push(`/quotes/${body.quote.id}`);
    } catch (failure) {
      setError(failureMessage(failure));
      setBusy(null);
    }
  }

  const fitting = (candidates ?? []).filter((c) => c.placement).slice(0, 3);
  const rejected = (candidates ?? []).filter((c) => !c.placement);

  return (
    <section className="card journey-card" aria-labelledby="find-heading">
      <h2 id="find-heading">Find furniture for {room.name}</h2>
      <p className="muted">Room measurement revision {room.measurementRevision}. Fit is checked by the server against this measured geometry.</p>
      <form className="form-grid" onSubmit={find}>
        <label>Budget (USD)<input name="budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} required /></label>
        <label>Pickup from<input name="pickupFrom" type="datetime-local" value={pickupFrom} onChange={(e) => setPickupFrom(e.target.value)} required /></label>
        <label>Pickup to<input name="pickupTo" type="datetime-local" value={pickupTo} onChange={(e) => setPickupTo(e.target.value)} required /></label>
        <button type="submit" disabled={busy !== null}>{busy === "find" ? "Searching…" : "Find furniture"}</button>
      </form>
      {error && <p className="notice fail" role="alert">{error}</p>}
      {candidates && (
        <div aria-live="polite">
          {fitting.length === 0 ? (
            <div className="notice warn" role="status">
              <strong>No furniture fits these constraints.</strong>
              <ul>{constraintAdvice(candidates, requirements!).map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          ) : (
            <>
              <h3>Candidates ({fitting.length})</h3>
              <ol className="candidate-list">
                {fitting.map((c) => (
                  <li key={c.itemId} className={`candidate${layout?.candidate.itemId === c.itemId ? " selected" : ""}`}>
                    <div className="candidate-head">
                      <strong>{c.title}</strong>
                      <span className="price">{formatMoney(c.priceCents)}</span>
                    </div>
                    <table className="facts">
                      <caption className="sr-only">Contents of {c.title}</caption>
                      <tbody>
                        <tr><th scope="row">Contents</th><td>1 × {c.title} ({formatMeters(c.widthM)} W × {formatMeters(c.depthM)} D × {formatMeters(c.heightM)} H)</td></tr>
                        <tr><th scope="row">Total</th><td>{formatMoney(c.priceCents)}</td></tr>
                        <tr><th scope="row">Pickup window</th><td>{formatDateTime(c.pickupWindowStart)} – {formatDateTime(c.pickupWindowEnd)}</td></tr>
                      </tbody>
                    </table>
                    <Findings findings={c.findings ?? []} />
                    <button type="button" onClick={() => choose(c)} disabled={busy !== null} aria-label={`Choose ${c.title}`}>
                      {busy === `choose-${c.itemId}` ? "Validating layout…" : "Choose this"}
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
          {rejected.length > 0 && (
            <details className="rejections">
              <summary>Not shown ({rejected.length}) and why</summary>
              <ul>{rejected.map((c) => <li key={c.itemId}>{c.title} ({formatMoney(c.priceCents)}): {REJECTION_TEXT[c.rejectionReason!] ?? c.rejectionReason}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      {layout && (
        <section className="layout-result" aria-labelledby="layout-heading">
          <h3 id="layout-heading">Server layout check for {layout.candidate.title}</h3>
          <p className={`verdict ${layout.quotable ? "pass" : "fail"}`} role="status">
            {layout.quotable ? "PASS — server confirmed this layout is quotable" : "FAIL — server says this layout is not quotable"}
          </p>
          <p className="muted">Layout revision <code>{layout.layoutId}</code></p>
          <Findings findings={layout.findings} />
          {!layout.quotable && layout.reasons.length > 0 && (
            <ul>{layout.reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
          )}
          {layout.quotable && (
            <form className="form-grid" onSubmit={requestQuote}>
              <label>Pickup slot start<input name="slotStart" type="datetime-local" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} required /></label>
              <label>Pickup slot end<input name="slotEnd" type="datetime-local" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} required /></label>
              <button type="submit" disabled={busy !== null}>{busy === "quote" ? "Requesting…" : "Request quote"}</button>
            </form>
          )}
        </section>
      )}
    </section>
  );
}
