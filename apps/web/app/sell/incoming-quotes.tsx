"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiJson, failureMessage, formatDateTime, formatMoney, formatSlot } from "@/lib/client/api";
import type { QuoteSummary } from "@/lib/journey/types";
import { StatusPill } from "../journey-ui";

export default function IncomingQuotes() {
  const [quotes, setQuotes] = useState<QuoteSummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => void apiJson<{ quotes: QuoteSummary[] }>("/api/v1/quotes?role=seller")
      .then((body) => setQuotes(body.quotes))
      .catch((failure) => setError(failureMessage(failure))), 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <section aria-labelledby="incoming-heading" className="incoming">
      <h2 id="incoming-heading">Incoming quotes</h2>
      {error && <p role="status">{error}</p>}
      {quotes && quotes.length === 0 && <p className="muted">No quote requests yet.</p>}
      {quotes && quotes.length > 0 && (
        <table className="data-table">
          <thead><tr><th scope="col">Items</th><th scope="col">Total</th><th scope="col">Pickup</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td>{q.lineTitles.join(", ")}</td>
                <td>{formatMoney(q.totalCents, q.currency)}</td>
                <td>{formatSlot(q.pickupSlot)}</td>
                <td><StatusPill tone={q.stale ? "fail" : q.status === "REQUESTED" ? "warn" : "pass"}>{q.stale ? `Stale (${q.status})` : q.status === "REQUESTED" ? "Needs your approval" : q.status}</StatusPill></td>
                <td>{formatDateTime(q.expiresAt)}</td>
                <td><Link href={`/quotes/${q.id}`}>Review v{q.version}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
