"use client";

import { useEffect, useState, type FormEvent } from "react";
import FindFurniture from "./find-furniture";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rooms.find((room) => room.id === selectedId) ?? null;

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
    // Defer so the post-fetch setState doesn't run synchronously in the effect.
    const timer = setTimeout(() => void refreshRooms(), 0);
    return () => clearTimeout(timer);
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
    <main className="journey">
      <h1>Your rooms</h1>
      {identityUnavailable && <p role="status">Identity unavailable</p>}
      {message && <p role="status">{message}</p>}
      <form onSubmit={submit}>
        <p><label htmlFor="roomName">Room name</label><input id="roomName" name="name" required maxLength={80} /></p>
        <p><label htmlFor="geometry">Room geometry JSON</label><textarea id="geometry" name="geometry" rows={18} defaultValue={initialGeometry} required /></p>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create room"}</button>
      </form>
      <h2>Saved rooms</h2>
      {rooms.length === 0 ? <p className="muted">No saved rooms yet.</p> : (
        <fieldset className="room-picker">
          <legend>Select a room to furnish</legend>
          <ul>
            {rooms.map((room) => (
              <li key={room.id}>
                <label>
                  <input type="radio" name="selectedRoom" value={room.id} checked={selectedId === room.id} onChange={() => setSelectedId(room.id)} />
                  {room.name} — measurement revision {room.measurementRevision}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {selected && <FindFurniture key={`${selected.id}-${selected.measurementRevision}`} room={selected} />}
    </main>
  );
}
