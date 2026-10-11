"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiFailure, apiJson, failureMessage, formatDateTime, formatMeters, formatMoney, formatSlot, newIdempotencyKey } from "@/lib/client/api";
import { BUYER_ACKNOWLEDGEMENTS, type QuoteStatus, type QuoteView } from "@/lib/journey/types";
import { JourneyShell, StatusPill, formatRemaining, useNow } from "../../journey-ui";

const STATUS_TEXT: Record<QuoteStatus, string> = {
  REQUESTED: "Requested — waiting for seller to approve exact terms",
  SELLER_APPROVED: "Seller approved — waiting for buyer approval",
  BUYER_APPROVED: "Approved by both — ready for checkout",
  SUPERSEDED: "Superseded by a newer quote",
  EXPIRED: "Expired",
  REJECTED: "Rejected",
};

const ACK_TEXT: Record<(typeof BUYER_ACKNOWLEDGEMENTS)[number], string> = {
  FIT_MEASURED_ROOM_ONLY_V1: "I understand the fit check covers only my measured room geometry and the listed dimensions, not doorways or stairs on the way in.",
  PICKUP_ROUTE_NOT_MEASURED_V1: "I understand the pickup and delivery route was not measured; moving the item is my responsibility.",
  PICKUP_TERMS_V1: "I accept these exact contents, total and pickup slot. PayPal handles the payment only; it does not cover the in-person pickup.",
};

const STALE_TEXT: Record<string, string> = {
  QUOTE_EXPIRED: "The quote expiry time has passed.",
  ITEM_CHANGED: "A quoted item changed or is no longer available.",
  ROOM_CHANGED: "The room was re-measured after this quote.",
  STATUS_SUPERSEDED: "A newer version of this quote replaced it.",
  STATUS_EXPIRED: "The quote expired.",
  STATUS_REJECTED: "The quote was rejected.",
};

const CLOSED_CHECKOUT = new Set(["CANCELED", "EXPIRED", "FAILED"]);

export default function QuoteClient({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const now = useNow();
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await apiJson<{ quote: QuoteView }>(`/api/v1/quotes/${quoteId}`);
      setQuote(body.quote);
      setLoadError(null);
    } catch (failure) {
      setLoadError({ notFound: failure instanceof ApiFailure && failure.status === 404, message: failureMessage(failure) });
    }
  }, [quoteId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(name: string, run: () => Promise<void>) {
    setBusy(name);
    setError("");
    try {
      await run();
    } catch (failure) {
      setError(failureMessage(failure));
      await load();
    } finally {
      setBusy(null);
    }
  }

  const sellerApprove = () => act("seller", async () => {
    await apiJson(`/api/v1/quotes/${quoteId}/seller-approval`, { json: { contentHash: quote!.contentHash } });
    await load();
  });

  const buyerApprove = () => act("buyer", async () => {
    await apiJson(`/api/v1/quotes/${quoteId}/buyer-approval`, {
      json: { contentHash: quote!.contentHash, acknowledgedWarnings: [...BUYER_ACKNOWLEDGEMENTS] },
    });
    await load();
  });

  const startCheckout = () => act("checkout", async () => {
    const storageKey = `rr-checkout-key:${quoteId}`;
    const idempotencyKey = sessionStorage.getItem(storageKey) ?? newIdempotencyKey("checkout");
    sessionStorage.setItem(storageKey, idempotencyKey);
    const body = await apiJson<{ checkout: { id: string } }>("/api/v1/checkouts", { json: { quoteId, idempotencyKey } });
    router.push(`/checkout/${body.checkout.id}`);
  });

  if (loadError) {
    return (
      <JourneyShell title="Quote" sub="Immutable quote snapshot">
        <section className="card" role="alert">
          <h2>{loadError.notFound ? "Quote not found" : "Quote unavailable"}</h2>
          <p>{loadError.notFound ? "This quote does not exist or you are not a participant." : loadError.message}</p>
          <p><Link href="/rooms">Back to your rooms</Link></p>
        </section>
      </JourneyShell>
    );
  }
  if (!quote) return <JourneyShell title="Quote" sub="Immutable quote snapshot"><p role="status">Loading quote…</p></JourneyShell>;

  const expiresMs = quote.expiresAt ? new Date(quote.expiresAt).getTime() - now : null;
  const expiredNow = expiresMs !== null && expiresMs <= 0;
  const stale = quote.stale || expiredNow;
  const staleReasons = expiredNow && !quote.staleReasons.includes("QUOTE_EXPIRED") ? [...quote.staleReasons, "QUOTE_EXPIRED"] : quote.staleReasons;
  const isBuyer = quote.role === "BUYER";
  const openCheckout = quote.checkout && !CLOSED_CHECKOUT.has(quote.checkout.status) ? quote.checkout : null;
  const allAcked = BUYER_ACKNOWLEDGEMENTS.every((key) => acks.has(key));
  const tone = stale ? "fail" : quote.status === "BUYER_APPROVED" ? "pass" : "warn";

  return (
    <JourneyShell title={`Quote v${quote.version}`} sub={isBuyer ? "You are the buyer" : "You are the seller"}>
      <section className="card" aria-labelledby="quote-status">
        <h2 id="quote-status">Status</h2>
        <p><StatusPill tone={tone}>{stale ? `Stale — ${STATUS_TEXT[quote.status]}` : STATUS_TEXT[quote.status]}</StatusPill></p>
        {quote.expiresAt && !stale && <p>Expires {formatDateTime(quote.expiresAt)} (in <span data-testid="quote-expiry">{formatRemaining(expiresMs!)}</span>)</p>}
        {stale && (
          <div className="notice fail" role="alert">
            <strong>This quote is stale and cannot be approved or paid.</strong>
            <ul>{staleReasons.map((r) => <li key={r}>{STALE_TEXT[r] ?? r}</li>)}</ul>
            {quote.replacementQuoteId
              ? <Link href={`/quotes/${quote.replacementQuoteId}`}>Open the newer quote</Link>
              : isBuyer && <Link href="/rooms">Request a new quote (re-run Find furniture)</Link>}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="quote-contents">
        <h2 id="quote-contents">Exact contents</h2>
        <table className="data-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Dimensions (W × D × H)</th><th scope="col">Condition disclosure</th><th scope="col" className="num">Price</th></tr></thead>
          <tbody>
            {quote.lines.map((line) => (
              <tr key={line.itemId}>
                <td>{line.title}</td>
                <td>{formatMeters(line.widthM)} × {formatMeters(line.depthM)} × {formatMeters(line.heightM)}</td>
                <td>{line.conditionDisclosure ?? "None provided"}</td>
                <td className="num">{formatMoney(line.priceCents, quote.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {quote.discountCents > 0 && <tr><th scope="row" colSpan={3}>Discount</th><td className="num">−{formatMoney(quote.discountCents, quote.currency)}</td></tr>}
            <tr><th scope="row" colSpan={3}>Total</th><td className="num total">{formatMoney(quote.totalCents, quote.currency)}</td></tr>
          </tfoot>
        </table>
        <dl className="facts-list">
          <dt>Pickup slot</dt><dd>{formatSlot(quote.pickupSlot)}</dd>
          <dt>Layout revision</dt><dd>{quote.layoutRevisionId ? <code>{quote.layoutRevisionId}</code> : "None (no measured layout)"}{quote.roomRevision !== null && ` · room measurement revision ${quote.roomRevision}`}</dd>
          <dt>Terms version</dt><dd>{quote.termsVersion}</dd>
          <dt>Seller approval</dt><dd>{quote.sellerApprovedAt ? `Approved ${formatDateTime(quote.sellerApprovedAt)}` : "Not yet approved"}</dd>
          <dt>Buyer approval</dt><dd>{quote.buyerApprovedAt ? `Approved ${formatDateTime(quote.buyerApprovedAt)}` : "Not yet approved"}</dd>
          <dt>Payment environment</dt><dd>{quote.environment === "sandbox" ? "PayPal Sandbox (test money)" : quote.environment}</dd>
          <dt>Content hash</dt><dd><code className="hash">{quote.contentHash}</code></dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="quote-actions">
        <h2 id="quote-actions">Next step</h2>
        {error && <p className="notice fail" role="alert">{error}</p>}
        {!stale && !isBuyer && quote.status === "REQUESTED" && (
          <>
            <p>Approving locks these exact contents, total and pickup slot. Any change creates a new quote version.</p>
            <button type="button" onClick={sellerApprove} disabled={busy !== null}>{busy === "seller" ? "Approving…" : "Approve exact terms"}</button>
          </>
        )}
        {!stale && !isBuyer && quote.status !== "REQUESTED" && <p>{quote.status === "BUYER_APPROVED" ? "Both approvals are recorded. The buyer can now pay." : "You approved these exact terms. Waiting for the buyer."}</p>}
        {!stale && isBuyer && quote.status === "REQUESTED" && <p>Waiting for the seller to approve exact terms.</p>}
        {!stale && isBuyer && quote.status === "SELLER_APPROVED" && (
          <fieldset className="acks">
            <legend>Fit assumptions and terms</legend>
            {BUYER_ACKNOWLEDGEMENTS.map((key) => (
              <label key={key} className="check">
                <input type="checkbox" checked={acks.has(key)} onChange={(e) => {
                  const next = new Set(acks);
                  if (e.target.checked) next.add(key); else next.delete(key);
                  setAcks(next);
                }} />
                {ACK_TEXT[key]}
              </label>
            ))}
            <button type="button" onClick={buyerApprove} disabled={!allAcked || busy !== null}>{busy === "buyer" ? "Approving…" : "Approve"}</button>
            {!allAcked && <p className="muted">Tick all three acknowledgments to approve.</p>}
          </fieldset>
        )}
        {!stale && isBuyer && quote.status === "BUYER_APPROVED" && (
          openCheckout
            ? <Link className="button" href={`/checkout/${openCheckout.id}`}>Continue checkout</Link>
            : <button type="button" onClick={startCheckout} disabled={busy !== null}>{busy === "checkout" ? "Starting…" : "Start checkout"}</button>
        )}
      </section>
    </JourneyShell>
  );
}
