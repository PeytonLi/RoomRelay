"use client";

import { useEffect, useState, type FormEvent } from "react";
import IncomingQuotes from "./incoming-quotes";

interface InventoryItem {
  id: string;
  status: string;
  version: number;
  currentVersion: number;
  publishedVersion: number | null;
  versions: { version: number; title: string }[];
}

function localDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message ?? "Request failed") as Error & { code?: string };
    error.code = body.code;
    throw error;
  }
  return body;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export default function SellClient() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [message, setMessage] = useState("");
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshItems() {
    try {
      setItems(await jsonRequest("/api/v1/items"));
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.code === "IDENTITY_UNAVAILABLE") setIdentityUnavailable(true);
      setMessage(failure.message);
    }
  }

  useEffect(() => {
    // Defer so the post-fetch setState doesn't run synchronously in the effect.
    const timer = setTimeout(() => void refreshItems(), 0);
    return () => clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setMessage("");
    const form = new FormData(formElement);
    try {
      const file = form.get("conditionPhoto");
      if (!(file instanceof File) || file.size === 0) throw new Error("Choose a condition photo.");
      const bytes = await file.arrayBuffer();
      const manifest = await jsonRequest("/api/v1/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "CONDITION_PHOTO",
          contentType: file.type,
          bytes: file.size,
          sha256: await sha256(bytes),
        }),
      });
      await jsonRequest(manifest.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: bytes,
      });
      const asset = await jsonRequest(`/api/v1/uploads/${manifest.id}/finalize`, { method: "POST" });
      const draft = await jsonRequest("/api/v1/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          category: form.get("category") || undefined,
          widthM: Number(form.get("widthM")),
          depthM: Number(form.get("depthM")),
          heightM: Number(form.get("heightM")),
          dimsConfirmed: form.get("dimsConfirmed") === "on",
          conditionNotes: form.get("conditionNotes") || undefined,
          conditionPhotoAssetIds: [asset.assetId],
          priceCents: Number(form.get("priceCents")),
          pickupWindowStart: new Date(String(form.get("pickupWindowStart"))).toISOString(),
          pickupWindowEnd: new Date(String(form.get("pickupWindowEnd"))).toISOString(),
          coarseArea: form.get("coarseArea"),
          exactPickupAddress: form.get("exactPickupAddress"),
          provenance: "APPROXIMATE_PROXY",
        }),
      });
      const published = await jsonRequest(`/api/v1/items/${draft.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: draft.version }),
      });
      setMessage(`Published listing v${published.publishedVersion}.`);
      formElement.reset();
      await refreshItems();
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.code === "IDENTITY_UNAVAILABLE") setIdentityUnavailable(true);
      setMessage(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="journey">
      <h1>Sell furniture</h1>
      {identityUnavailable && <p role="status">Identity unavailable</p>}
      {message && <p role="status">{message}</p>}
      <section aria-labelledby="create-listing-heading">
        <h2 id="create-listing-heading">Create and publish a listing</h2>
        <form onSubmit={submit}>
          <p><label htmlFor="title">Title</label><input id="title" name="title" required maxLength={120} /></p>
          <p><label htmlFor="category">Category</label><input id="category" name="category" /></p>
          <p><label htmlFor="widthM">Width (m)</label><input id="widthM" name="widthM" type="number" min="0.01" max="5" step="0.01" required /></p>
          <p><label htmlFor="depthM">Depth (m)</label><input id="depthM" name="depthM" type="number" min="0.01" max="5" step="0.01" required /></p>
          <p><label htmlFor="heightM">Height (m)</label><input id="heightM" name="heightM" type="number" min="0.01" max="5" step="0.01" required /></p>
          <p><label><input name="dimsConfirmed" type="checkbox" required /> I confirmed these dimensions</label></p>
          <p><label htmlFor="conditionNotes">Condition notes</label><textarea id="conditionNotes" name="conditionNotes" /></p>
          <p><label htmlFor="conditionPhoto">Condition photo</label><input id="conditionPhoto" name="conditionPhoto" type="file" accept="image/jpeg,image/png,image/webp" required /></p>
          <p><label htmlFor="priceCents">Price (cents)</label><input id="priceCents" name="priceCents" type="number" min="1" max="1000000" required /></p>
          <p><label htmlFor="pickupWindowStart">Pickup starts</label><input id="pickupWindowStart" name="pickupWindowStart" type="datetime-local" defaultValue={localDateTime(1)} required /></p>
          <p><label htmlFor="pickupWindowEnd">Pickup ends</label><input id="pickupWindowEnd" name="pickupWindowEnd" type="datetime-local" defaultValue={localDateTime(3)} required /></p>
          <p><label htmlFor="coarseArea">Pickup area</label><input id="coarseArea" name="coarseArea" required /></p>
          <p><label htmlFor="exactPickupAddress">Exact pickup address (private)</label><input id="exactPickupAddress" name="exactPickupAddress" required /></p>
          <button type="submit" disabled={busy}>{busy ? "Publishing…" : "Create draft and publish"}</button>
        </form>
      </section>
      <section aria-labelledby="inventory-heading">
        <h2 id="inventory-heading">Your items</h2>
        <ul>
          {items.map((item) => {
            const current = item.versions.find((version) => version.version === item.currentVersion);
            return <li key={item.id}>{current?.title ?? "Untitled"} — {item.status}; current v{item.currentVersion}; published v{item.publishedVersion ?? "none"}</li>;
          })}
        </ul>
      </section>
      {!identityUnavailable && <IncomingQuotes />}
    </main>
  );
}
