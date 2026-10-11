"use client";

import { useEffect, useState, type ReactNode } from "react";

export function JourneyShell({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <main className="workspace journey">
      <header className="topbar">
        <h1>{title}</h1>
        <span className="sub">{sub}</span>
        <span className="badge sandbox">PayPal Sandbox</span>
      </header>
      <div className="journey-body">{children}</div>
    </main>
  );
}

/** Text + color status pill; the label always carries the meaning. */
export function StatusPill({ tone, children }: { tone: "pass" | "warn" | "fail" | "unknown"; children: ReactNode }) {
  return <span className={`pill ${tone}`}><span className="dot" aria-hidden="true" />{children}</span>;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
