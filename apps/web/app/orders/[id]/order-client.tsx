"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiFailure, apiJson, failureMessage, formatDateTime, formatMoney, formatSlot, newIdempotencyKey } from "@/lib/client/api";
import type { OrderCase, OrderView, ParticipantRole } from "@/lib/journey/types";
import { JourneyShell, StatusPill } from "../../journey-ui";
import PlacementGuide from "./placement-guide";

const REASONS: { value: OrderCase["reason"]; label: string }[] = [
  { value: "UNAVAILABLE", label: "Item unavailable at pickup" },
  { value: "DAMAGED", label: "Item damaged / not as described" },
  { value: "MISSING", label: "Item or part missing" },
  { value: "OTHER", label: "Other" },
];
const NEXT_ACTION_TEXT: Record<OrderView["nextAction"], string> = {
  PAY: "Payment not completed yet.",
  RECHECK_PAYMENT: "Payment status is being rechecked with PayPal.",
  PICKUP: "Meet at the pickup slot below.",
  ACKNOWLEDGE: "Confirm the handoff once you have exchanged the item.",
  SUPPORT: "An issue is open. Pickup confirmation is paused until it is resolved.",
  DONE: "This order is complete.",
  REFUNDED: "This order was refunded in full.",
};
const other = (role: ParticipantRole): ParticipantRole => (role === "BUYER" ? "SELLER" : "BUYER");
const roleName = (role: ParticipantRole) => (role === "BUYER" ? "Buyer" : "Seller");

export default function OrderClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issueReason, setIssueReason] = useState<OrderCase["reason"]>("UNAVAILABLE");
  const [issueItems, setIssueItems] = useState<Set<string>>(new Set());
  const [issueText, setIssueText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [resolveText, setResolveText] = useState<Record<string, string>>({});
  const [refundReason, setRefundReason] = useState("");
  const [relistConfirm, setRelistConfirm] = useState<Set<string>>(new Set());
  const [relisted, setRelisted] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const body = await apiJson<{ order: OrderView }>(`/api/v1/orders/${orderId}`);
      setOrder(body.order);
      setLoadError(null);
    } catch (failure) {
      setLoadError({ notFound: failure instanceof ApiFailure && failure.status === 404, message: failureMessage(failure) });
    }
  }, [orderId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(name: string, run: () => Promise<unknown>, success: string) {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await run();
      setNotice(success);
      await load();
      return true;
    } catch (failure) {
      setError(failureMessage(failure));
      await load();
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <JourneyShell title="Order" sub="Receipt and pickup">
        <section className="card" role="alert">
          <h2>{loadError.notFound ? "Order not found" : "Order unavailable"}</h2>
          <p>{loadError.notFound ? "This order does not exist or you are not a participant." : loadError.message}</p>
        </section>
      </JourneyShell>
    );
  }
  if (!order) return <JourneyShell title="Order" sub="Receipt and pickup"><p role="status">Loading order…</p></JourneyShell>;

  const me = order.role;
  const isSeller = me === "SELLER";
  const handoff = order.handoff;
  const myAck = handoff ? (me === "BUYER" ? handoff.buyerAcknowledgedAt : handoff.sellerAcknowledgedAt) : null;
  const theirAck = handoff ? (me === "BUYER" ? handoff.sellerAcknowledgedAt : handoff.buyerAcknowledgedAt) : null;
  const bothAcked = !!handoff?.buyerAcknowledgedAt && !!handoff?.sellerAcknowledgedAt;
  const openCases = order.cases.filter((c) => c.status === "OPEN");
  const refunded = order.status === "REFUNDED";
  const refundProcessing = !refunded && !!order.refund && order.refund.status !== "FAILED";
  const paid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.status);
  const titleOf = (itemId: string) => order.quote.lines.find((l) => l.itemId === itemId)?.title ?? itemId;

  const submitIssue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (issueItems.size === 0) return setError("Select at least one affected item.");
    const ok = await act("issue", () => apiJson(`/api/v1/orders/${orderId}/issues`, {
      json: { reason: issueReason, affectedItemIds: [...issueItems], description: issueText.trim() },
    }), "Issue reported. The other party can see it below.");
    if (ok) { setIssueText(""); setIssueItems(new Set()); }
  };
  const submitNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!noteText.trim()) return;
    const ok = await act("note", () => apiJson(`/api/v1/orders/${orderId}/notes`, { json: { body: noteText.trim() } }), "Note added.");
    if (ok) setNoteText("");
  };
  const refund = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const storageKey = `rr-refund-key:${orderId}`;
    const requestKey = sessionStorage.getItem(storageKey) ?? newIdempotencyKey("refund");
    sessionStorage.setItem(storageKey, requestKey);
    await act("refund", () => apiJson(`/api/v1/orders/${orderId}/refund`, { json: { requestKey, reason: refundReason.trim() } }), "Refund requested from PayPal Sandbox.");
  };
  const relist = async (itemId: string) => {
    const ok = await act(`relist-${itemId}`, () => apiJson(`/api/v1/items/${itemId}/relist`, { json: { possessionConfirmed: true } }), `${titleOf(itemId)} relisted.`);
    if (ok) setRelisted(new Set(relisted).add(itemId));
  };

  return (
    <JourneyShell title="Order" sub={isSeller ? "You are the seller" : "You are the buyer"}>
      <p className="notice" role="status"><strong>Next:</strong> {NEXT_ACTION_TEXT[order.nextAction] ?? order.nextAction}</p>
      {error && <p className="notice fail" role="alert">{error}</p>}
      {notice && <p className="notice pass" role="status">{notice}</p>}

      <section className="card receipt" aria-labelledby="receipt-heading">
        <h2 id="receipt-heading">Receipt</h2>
        <p><StatusPill tone={refunded ? "warn" : paid ? "pass" : "unknown"}>Payment status: {order.status}</StatusPill></p>
        <dl className="facts-list">
          <dt>Environment</dt><dd>{order.environment === "sandbox" ? "PayPal Sandbox — test money only" : order.environment}</dd>
          <dt>Merchant</dt><dd><code>{order.merchantId}</code></dd>
          <dt>PayPal order ID</dt><dd><code>{order.providerOrderId ?? "—"}</code></dd>
          <dt>PayPal capture ID</dt><dd><code>{order.providerCaptureId ?? "—"}</code></dd>
          <dt>Paid at</dt><dd>{formatDateTime(order.paidAt)}</dd>
          <dt>Total</dt><dd>{formatMoney(order.amountCents, order.currency)} (captured {formatMoney(order.capturedCents, order.currency)}{order.refundedCents > 0 && `, refunded ${formatMoney(order.refundedCents, order.currency)}`})</dd>
          <dt>Quote</dt><dd><Link href={`/quotes/${order.quote.id}`}>v{order.quote.version}</Link> · terms {order.quote.termsVersion}</dd>
          <dt>Layout revision</dt><dd>{order.placementGuide ? <code>{order.placementGuide.layoutRevisionId}</code> : isSeller ? "Buyer's room layout is private" : "No measured layout"}</dd>
          {order.refund && <><dt>PayPal refund ID</dt><dd><code>{order.refund.providerRefundId ?? "pending"}</code></dd></>}
        </dl>
        <table className="data-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Condition disclosure</th><th scope="col" className="num">Price</th></tr></thead>
          <tbody>{order.quote.lines.map((l) => <tr key={l.itemId}><td>{l.title}</td><td>{l.conditionDisclosure ?? "None provided"}</td><td className="num">{formatMoney(l.priceCents, order.currency)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row" colSpan={2}>Total</th><td className="num total">{formatMoney(order.quote.totalCents, order.currency)}</td></tr></tfoot>
        </table>
        {order.quote.acknowledgedWarnings && order.quote.acknowledgedWarnings.length > 0 && <p className="muted">Buyer acknowledged: {order.quote.acknowledgedWarnings.join(", ")}</p>}
        <p className="muted">PayPal Sandbox processed this payment. The pickup itself is arranged between you and is not covered by PayPal purchase protection.</p>
      </section>

      {order.placementGuide && (
        <section className="card guide-card" aria-labelledby="guide-heading">
          <div className="card-head">
            <h2 id="guide-heading">Placement guide</h2>
            <button type="button" className="secondary no-print" onClick={() => window.print()}>Print guide</button>
          </div>
          <PlacementGuide guide={order.placementGuide} />
        </section>
      )}

      <section className="card" aria-labelledby="pickup-heading">
        <h2 id="pickup-heading">Pickup</h2>
        {!handoff ? <p>Pickup details appear here once payment is confirmed.</p> : (
          <>
            <dl className="facts-list">
              <dt>Pickup slot</dt><dd>{formatSlot(handoff.pickupSlot)}</dd>
              <dt>Handoff state</dt><dd>{handoff.state}</dd>
            </dl>
            {handoff.pickupLocations.length > 0 && (
              <>
                <h3>Private pickup location{handoff.pickupLocations.length > 1 ? "s" : ""}</h3>
                <p className="muted">Shared only with the two participants of this order.</p>
                <ul>{handoff.pickupLocations.map((loc, i) => <li key={i}><address>{loc.exactPickupAddress}</address> for {loc.itemIds.map(titleOf).join(", ")}</li>)}</ul>
              </>
            )}
            <h3>Handoff confirmation</h3>
            <ul className="ack-list" aria-label="Handoff confirmations">
              <li><StatusPill tone={myAck ? "pass" : "unknown"}>You ({roleName(me)}): {myAck ? `confirmed ${formatDateTime(myAck)}` : "not confirmed yet"}</StatusPill></li>
              <li><StatusPill tone={theirAck ? "pass" : "unknown"}>{roleName(other(me))}: {theirAck ? `confirmed ${formatDateTime(theirAck)}` : "not confirmed yet"}</StatusPill></li>
            </ul>
            {bothAcked && <p role="status">Both participants confirmed the handoff.</p>}
            {!myAck && !refunded && (
              <button type="button" onClick={() => act("ack", () => apiJson(`/api/v1/orders/${orderId}/pickup-ack`, { json: {} }), "Your handoff confirmation was recorded.")} disabled={busy !== null || openCases.length > 0 || !paid}>
                {busy === "ack" ? "Confirming…" : "Confirm handoff"}
              </button>
            )}
            {!myAck && openCases.length > 0 && <p className="muted">Confirmation is paused while an issue is open.</p>}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="issues-heading">
        <h2 id="issues-heading">Issues</h2>
        {order.cases.length === 0 ? <p className="muted">No issues reported.</p> : (
          <ul className="case-list">
            {order.cases.map((c) => (
              <li key={c.id} className="case">
                <p>
                  <StatusPill tone={c.status === "OPEN" ? "fail" : "pass"}>{c.status === "OPEN" ? "Open" : "Resolved"}</StatusPill>{" "}
                  <strong>{REASONS.find((r) => r.value === c.reason)?.label ?? c.reason}</strong> — reported by {roleName(c.openedByRole)} {formatDateTime(c.createdAt)}
                </p>
                <p>Affected: {c.affectedItemIds.map(titleOf).join(", ")}</p>
                <p>{c.description}</p>
                {c.status === "RESOLVED" && <p className="muted">Resolution ({formatDateTime(c.resolvedAt)}): {c.resolutionNote}</p>}
                {c.status === "OPEN" && isSeller && (
                  <form className="inline-form" onSubmit={(e) => {
                    e.preventDefault();
                    void act(`resolve-${c.id}`, () => apiJson(`/api/v1/orders/${orderId}/issues/${c.id}/resolve`, { json: { resolutionNote: (resolveText[c.id] ?? "").trim() } }), "Issue marked resolved.");
                  }}>
                    <label>Resolution note<input name={`resolve-${c.id}`} value={resolveText[c.id] ?? ""} onChange={(e) => setResolveText({ ...resolveText, [c.id]: e.target.value })} required maxLength={1000} /></label>
                    <button type="submit" disabled={busy !== null}>{busy === `resolve-${c.id}` ? "Resolving…" : "Resolve"}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {paid && !refunded && (
          <form className="form-grid issue-form" onSubmit={submitIssue} aria-labelledby="report-heading">
            <h3 id="report-heading">Report an issue</h3>
            <label>Reason
              <select name="reason" value={issueReason} onChange={(e) => setIssueReason(e.target.value as OrderCase["reason"])}>
                {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <fieldset>
              <legend>Affected items</legend>
              {order.quote.lines.map((l) => (
                <label key={l.itemId} className="check">
                  <input type="checkbox" checked={issueItems.has(l.itemId)} onChange={(e) => {
                    const next = new Set(issueItems);
                    if (e.target.checked) next.add(l.itemId); else next.delete(l.itemId);
                    setIssueItems(next);
                  }} />
                  {l.title}
                </label>
              ))}
            </fieldset>
            <label>Description<textarea name="issueDescription" value={issueText} onChange={(e) => setIssueText(e.target.value)} required maxLength={2000} rows={3} /></label>
            <button type="submit" disabled={busy !== null}>{busy === "issue" ? "Reporting…" : "Report issue"}</button>
          </form>
        )}
      </section>

      <section className="card" aria-labelledby="notes-heading">
        <h2 id="notes-heading">Order notes</h2>
        {order.notes.length === 0 ? <p className="muted">No notes yet.</p> : (
          <ol className="notes">{order.notes.map((n) => <li key={n.id}><strong>{n.authorRole === me ? "You" : roleName(n.authorRole)}</strong> <span className="muted">{formatDateTime(n.createdAt)}</span><p>{n.body}</p></li>)}</ol>
        )}
        <form className="inline-form" onSubmit={submitNote}>
          <label>Add a note<textarea name="note" value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={2000} rows={2} /></label>
          <button type="submit" disabled={busy !== null || !noteText.trim()}>{busy === "note" ? "Sending…" : "Add note"}</button>
        </form>
        <p className="muted">Do not share payment details in notes.</p>
      </section>

      {isSeller && paid && (
        <section className="card" aria-labelledby="refund-heading">
          <h2 id="refund-heading">Refund</h2>
          {refunded ? <p><StatusPill tone="warn">Refunded in full ({formatMoney(order.refundedCents, order.currency)})</StatusPill></p>
            : refundProcessing ? <p role="status"><StatusPill tone="unknown">Refund processing — waiting for PayPal Sandbox to confirm</StatusPill></p>
            : (
              <form className="inline-form" onSubmit={refund}>
                <label>Refund reason<input name="refundReason" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} required maxLength={255} /></label>
                <button type="submit" className="danger" disabled={busy !== null || !refundReason.trim()}>{busy === "refund" ? "Requesting refund…" : "Refund in full"}</button>
              </form>
            )}
          {refunded && order.quote.lines.map((l) => (
            <div key={l.itemId} className="relist">
              {relisted.has(l.itemId) ? <p role="status">{l.title} is listed again.</p> : (
                <>
                  <label className="check">
                    <input type="checkbox" checked={relistConfirm.has(l.itemId)} onChange={(e) => {
                      const next = new Set(relistConfirm);
                      if (e.target.checked) next.add(l.itemId); else next.delete(l.itemId);
                      setRelistConfirm(next);
                    }} />
                    I have {l.title} back in my possession
                  </label>
                  <button type="button" onClick={() => relist(l.itemId)} disabled={busy !== null || !relistConfirm.has(l.itemId)}>
                    {busy === `relist-${l.itemId}` ? "Relisting…" : "Relist item (I have it back)"}
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}
    </JourneyShell>
  );
}
