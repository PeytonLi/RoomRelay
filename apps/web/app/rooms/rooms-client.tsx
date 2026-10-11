"use client";

import { useEffect, useState, type FormEvent } from "react";

interface RoomRecord {
  id: string;
  name: string;
  measurementRevision: number;
}

export default function RoomsClient({ initialGeometry }: { initialGeometry: string }) {
  const [rooms, setRooms] = useState<RoomRecord[]>([]);
  const [message, setMessage] = useState("");
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshRooms() {
    const response = await fetch("/api/v1/rooms");
    const body = await response.json();
    if (!response.ok) {
      if (body.code === "IDENTITY_UNAVAILABLE") setIdentityUnavailable(true);
      setMessage(body.message ?? "Could not load rooms.");
      return;
    }
    setRooms(body);
  }

  useEffect(() => {
    void refreshRooms();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setMessage("");
    const form = new FormData(formElement);
    try {
      let geometry: unknown;
      try {
        geometry = JSON.parse(String(form.get("geometry")));
      } catch {
        throw new Error("Enter valid geometry JSON.");
      }
      const response = await fetch("/api/v1/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), geometry }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "IDENTITY_UNAVAILABLE") setIdentityUnavailable(true);
        throw new Error(body.message ?? "Could not create room.");
      }
      setMessage(`Created ${body.name} at measurement revision ${body.measurementRevision}.`);
      formElement.reset();
      await refreshRooms();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create room.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Your rooms</h1>
      {identityUnavailable && <p role="status">Identity unavailable</p>}
      {message && <p role="status">{message}</p>}
      <form onSubmit={submit}>
        <p><label htmlFor="roomName">Room name</label><input id="roomName" name="name" required maxLength={80} /></p>
        <p><label htmlFor="geometry">Room geometry JSON</label><textarea id="geometry" name="geometry" rows={18} defaultValue={initialGeometry} required /></p>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create room"}</button>
      </form>
      <h2>Saved rooms</h2>
      <ul>{rooms.map((room) => <li key={room.id}>{room.name} — measurement revision {room.measurementRevision}</li>)}</ul>
    </main>
  );
}
