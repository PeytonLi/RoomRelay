"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiFailure, apiJson, failureMessage, formatMoney } from "@/lib/client/api";
import type { CheckoutView } from "@/lib/journey/types";
import { StatusPill, formatRemaining, useNow } from "../../journey-ui";

const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);
const CLOSED = new Set(["CANCELED", "EXPIRED", "FAILED", "REVERSED", "EXCEPTION"]);
const UNCERTAIN = new Set(["CAPTURE_SUBMITTING", "PENDING", "RECONCILING"]);
const PAYABLE = new Set(["CREATED", "PROVIDER_CREATED", "APPROVED"]);
const POLL_MS = 3000;
const MAX_POLLS = 40;

type LoadError = { kind: "unavailable" | "identity" | "notfound" | "other"; message: string };

function classify(failure: unknown): LoadError {
  if (failure instanceof ApiFailure) {
    if (failure.code === "PAYMENTS_UNAVAILABLE") return { kind: "unavailable", message: failure.message };
    if (failure.code === "IDENTITY_UNAVAILABLE" || failure.code === "UNAUTHENTICATED" || failure.status === 401) return { kind: "identity", message: failure.message };
    if (failure.status === 404) return { kind: "notfound", message: failure.message };
  }
  return { kind: "other", message: failureMessage(failure) };
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="workspace journey">
      <header className="topbar">
        <h1>RoomRelay checkout</h1>
        <span className="sub">Sandbox payment capability</span>
        <span className="badge sandbox">PayPal Sandbox</span>
      </header>
      <section className="stage journey-body" aria-label="Checkout status">{children}</section>
    </main>
  );
}

export default function CheckoutClient({ checkoutId }: { checkoutId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const now = useNow();
  const [checkout, setCheckout] = useState<CheckoutView | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [phase, setPhase] = useState<"idle" | "redirecting" | "processing" | "rechecking" | "canceling">("idle");
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState("");
  const returnHandled = useRef(false);
  const paypalParam = params.get("paypal");

  const load = useCallback(async (): Promise<CheckoutView | null> => {
    try {
      const body = await apiJson<{ checkout: CheckoutView }>(`/api/v1/checkouts/${checkoutId}`);
      setCheckout(body.checkout);
      setLoadError(null);
      return body.checkout;
    } catch (failure) {
      setLoadError(classify(failure));
      return null;
    }
  }, [checkoutId]);

  useEffect(() => {
    const timer = setTimeout(() => void (async () => {
      const current = await load();
      if (!current || paypalParam !== "return" || returnHandled.current) return;
      returnHandled.current = true;
      if (!PAYABLE.has(current.status)) return;
      const providerOrderId = params.get("token") ?? current.providerOrderId;
      if (!providerOrderId) return setError("PayPal did not return an order reference. Payment status is unchanged.");
      setPhase("processing");
      try {
        await apiJson(`/api/v1/checkouts/${checkoutId}/approval`, { json: { providerOrderId } });
        await apiJson(`/api/v1/checkouts/${checkoutId}/capture`, { json: { providerOrderId } });
      } catch (failure) {
        setError(`${failureMessage(failure)} Rechecking payment status with the server.`);
      }
      setPhase("rechecking");
      await load();
    })(), 0);
    return () => clearTimeout(timer);
  }, [load, checkoutId, params, paypalParam]);

  const status = checkout?.status;
  useEffect(() => {
    if (status && PAID.has(status)) router.replace(`/orders/${checkoutId}`);
  }, [status, router, checkoutId]);

  const shouldPoll = !!status && (UNCERTAIN.has(status) || (phase === "rechecking" && status === "APPROVED"));
  useEffect(() => {
    if (!shouldPoll || polls >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [shouldPoll, polls, load]);

  async function pay() {
    setError("");
    setPhase("redirecting");
    try {
      const body = await apiJson<{ checkout: { approveUrl: string | null } }>(`/api/v1/checkouts/${checkoutId}/paypal-order`, { json: {} });
      if (!body.checkout.approveUrl) throw new Error("PayPal did not return an approval link. No payment was taken.");
      window.location.assign(body.checkout.approveUrl);
    } catch (failure) {
      setError(failureMessage(failure));
      setPhase("idle");
      await load();
    }
  }

  async function cancel() {
    setError("");
    setPhase("canceling");
    try {
      await apiJson(`/api/v1/checkouts/${checkoutId}/cancel`, { json: {} });
    } catch (failure) {
      setError(failureMessage(failure));
    }
    setPhase("idle");
    await load();
  }

  if (loadError) {
    const heading = { unavailable: "Checkout unavailable", identity: "Checkout requires sign-in", notfound: "Checkout not found", other: "Checkout status unavailable" }[loadError.kind];
    return (
      <Shell>
        <article className="card" role="alert">
          <h2>{heading}</h2>
          {loadError.kind === "unavailable" && <p>PayPal sandbox checkout is unavailable</p>}
          <p className="muted">{loadError.kind === "notfound" ? "This checkout does not exist or you are not its buyer." : loadError.message}</p>
          <p className="notice">No payment will be recorded.</p>
        </article>
      </Shell>
    );
  }
  if (!checkout) return <Shell><p role="status">Loading checkout…</p></Shell>;

  const holdMs = new Date(checkout.hold.expiresAt).getTime() - now;
  const holdExpired = holdMs <= 0 || checkout.status === "EXPIRED" || checkout.hold.state === "EXPIRED";
  const uncertain = UNCERTAIN.has(checkout.status) || phase === "processing" || (phase === "rechecking" && checkout.status === "APPROVED");
  const payable = PAYABLE.has(checkout.status) && !holdExpired && phase === "idle";
  const tone = PAID.has(checkout.status) ? "pass" : CLOSED.has(checkout.status) || holdExpired ? "fail" : uncertain ? "unknown" : "warn";

  return (
    <Shell>
      <article className="card" aria-labelledby="checkout-summary">
        <h2 id="checkout-summary">Order summary</h2>
        <p><StatusPill tone={tone}>Payment status: {checkout.status}</StatusPill></p>
        <dl className="facts-list">
          <dt>Merchant</dt><dd><code>{checkout.merchantId}</code> ({checkout.environment === "sandbox" ? "PayPal Sandbox — test money only" : checkout.environment})</dd>
          <dt>Total</dt><dd className="total">{formatMoney(checkout.amountCents, checkout.currency)}</dd>
          <dt>Item hold</dt><dd>{checkout.hold.state === "ACTIVE" && !CLOSED.has(checkout.status) && !holdExpired
            ? <>Held for you for <span data-testid="hold-countdown">{formatRemaining(holdMs)}</span></>
            : ({ CONSUMED: "Consumed", RELEASED: "Released", EXPIRED: "Expired" }[checkout.hold.state] ?? (holdExpired ? "Expired" : "Ended"))}</dd>
        </dl>
        <table className="data-table">
          <thead><tr><th scope="col">Item</th><th scope="col">Condition disclosure</th><th scope="col" className="num">Price</th></tr></thead>
          <tbody>{checkout.quote.lines.map((line, i) => (
            <tr key={`${line.title}-${i}`}><td>{line.title}</td><td>{line.conditionDisclosure ?? "None provided"}</td><td className="num">{formatMoney(line.priceCents, checkout.currency)}</td></tr>
          ))}</tbody>
        </table>
      </article>
      <article className="card" aria-labelledby="checkout-pay">
        <h2 id="checkout-pay">Payment</h2>
        {error && <p className="notice fail" role="alert">{error}</p>}
        {paypalParam === "cancel" && PAYABLE.has(checkout.status) && <p className="notice" role="status">You left PayPal without approving. No payment was taken.</p>}
        {uncertain && (
          <p className="notice" role="status" aria-live="polite">
            {phase === "processing" ? "Processing — confirming your PayPal approval with the server…" : "Rechecking payment status… We only show success after PayPal confirms the capture."}
            {polls >= MAX_POLLS && " This is taking longer than usual; refresh this page to check again."}
          </p>
        )}
        {PAID.has(checkout.status) && <p role="status">Payment confirmed. Opening your order…</p>}
        {checkout.status === "CANCELED" && <p className="notice fail" role="status">This checkout was canceled. No payment was taken and the item hold was released.</p>}
        {holdExpired && !PAID.has(checkout.status) && !uncertain && (
          <div className="notice fail" role="alert">
            <strong>The item hold expired. Payment is disabled.</strong>
            <p><Link href={`/quotes/${checkout.quote.id}`}>Review the quote and request a new one</Link></p>
          </div>
        )}
        {CLOSED.has(checkout.status) && checkout.status !== "EXPIRED" && !holdExpired && (
          <p><Link href={`/quotes/${checkout.quote.id}`}>Back to the quote</Link></p>
        )}
        <div className="actions">
          <button type="button" onClick={pay} disabled={!payable}>{phase === "redirecting" ? "Opening PayPal…" : "Pay with PayPal"}</button>
          {PAYABLE.has(checkout.status) && <button type="button" className="secondary" onClick={cancel} disabled={phase !== "idle"}>{phase === "canceling" ? "Canceling…" : "Cancel checkout"}</button>}
        </div>
        <p className="muted">PayPal Sandbox processes the payment only. Pickup happens in person and is not covered by PayPal purchase protection.</p>
      </article>
    </Shell>
  );
}
