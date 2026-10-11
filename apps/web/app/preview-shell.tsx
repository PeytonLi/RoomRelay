"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { validateLayout, validateRoom, type Placement, type PlacedItem, type RoomGeometry } from "@roomrelay/spatial";
import type { FrameStats, ViewerItem } from "@/lib/viewer-types";
import Plan2D from "./plan2d";
import { FitPanel, ImportPanel, ItemPanel, PlacementControls } from "./panels";
import roomJson from "../fixtures/room.synthetic.json";
import itemJson from "../fixtures/item.sheen-chair.json";

const Viewer3D = dynamic(() => import("./viewer3d"), { ssr: false });

const room: RoomGeometry = validateRoom(roomJson);

const fixtureItem: ViewerItem = {
  id: itemJson.id,
  title: itemJson.title,
  dimsM: itemJson.confirmedDimsM,
  provenance: itemJson.provenance as ViewerItem["provenance"],
  provenanceNote: itemJson.provenanceNote,
  assetUrl: itemJson.asset.path,
  // Normalization for the fixture: bounds are already meter-scale centered-ish;
  // recompute through normalizeItem contract (source m, yaw 0).
  localMatrix: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -((itemJson.asset.boundsMin[0]! + itemJson.asset.boundsMax[0]!) / 2),
    -itemJson.asset.boundsMin[1]!,
    -((itemJson.asset.boundsMin[2]! + itemJson.asset.boundsMax[2]!) / 2),
    1,
  ],
  stats: { bytes: itemJson.asset.bytes, triangleCount: itemJson.asset.triangleCount },
  conditionPhotos: itemJson.conditionPhotos,
  photosNote: itemJson.photosNote,
};

const DEFAULT_PLACEMENT: Placement = { xM: 1.55, zM: 3.1, yawRad: Math.PI };

function webglSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("webgl") === "off") return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function PreviewShell() {
  const [items, setItems] = useState<ViewerItem[]>([fixtureItem]);
  const [placements, setPlacements] = useState<Record<string, Placement>>({
    [fixtureItem.id]: DEFAULT_PLACEMENT,
  });
  const [selectedId, setSelectedId] = useState<string | null>(fixtureItem.id);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  const [frameStats, setFrameStats] = useState<FrameStats>({ medianMs: null });

  useEffect(() => setWebgl(webglSupported()), []);

  const setPlacement = useCallback((itemId: string, placement: Placement) => {
    setPlacements((prev) => ({ ...prev, [itemId]: placement }));
  }, []);

  const placedItems: PlacedItem[] = useMemo(
    () =>
      items
        .filter((it) => placements[it.id])
        .map((it) => ({ id: it.id, title: it.title, dimsM: it.dimsM, placement: placements[it.id]! })),
    [items, placements],
  );
  const layout = useMemo(() => validateLayout(room, placedItems, { marginM: 0.05 }), [placedItems]);

  // Keyboard nudges when an item is selected: arrows ±0.05m, Q/E ±15°.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId || !placements[selectedId]) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      const p = { ...placements[selectedId]! };
      const step = 0.05;
      const rot = (15 * Math.PI) / 180;
      if (e.key === "ArrowUp") p.zM -= step;
      else if (e.key === "ArrowDown") p.zM += step;
      else if (e.key === "ArrowLeft") p.xM -= step;
      else if (e.key === "ArrowRight") p.xM += step;
      else if (e.key === "q" || e.key === "Q") p.yawRad += rot;
      else if (e.key === "e" || e.key === "E") p.yawRad -= rot;
      else return;
      e.preventDefault();
      setPlacement(selectedId, p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, placements, setPlacement]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const addImportedItem = useCallback((item: ViewerItem, placement: Placement) => {
    setItems((prev) => [...prev, item]);
    setPlacements((prev) => ({ ...prev, [item.id]: placement }));
    setSelectedId(item.id);
  }, []);

  return (
    <div className="workspace">
      <header className="topbar">
        <h1>RoomRelay</h1>
        <span className="sub">Measured preview · synthetic room fixture · {items.length} item{items.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <span className="sub">units: meters · yaw: degrees</span>
      </header>

      <main className="stage">
        {webgl === null ? null : webgl ? (
          <Viewer3D
            room={room}
            items={items}
            placements={placements}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={setPlacement}
            onStats={setFrameStats}
          />
        ) : (
          <div style={{ padding: 24 }}>
            <div className="notice">
              3D preview unavailable — this browser can&apos;t create a WebGL context.
              The measured 2D plan and item details below still work.
            </div>
          </div>
        )}
      </main>

      <aside className="side">
        <FitPanel layout={layout} />
        {selected ? (
          <>
            <ItemPanel item={selected} />
            <PlacementControls
              item={selected}
              placement={placements[selected.id]!}
              onChange={(p) => setPlacement(selected.id, p)}
              onReset={() => setPlacement(selected.id, DEFAULT_PLACEMENT)}
            />
          </>
        ) : (
          <div className="card muted">Select an item to inspect and move it.</div>
        )}
        <div className="card plan-wrap">
          <h2>Top-down plan</h2>
          <Plan2D room={room} items={items} placements={placements} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="stats-line">
            {items[0] ? `${(items[0].stats.bytes / 1e6).toFixed(2)} MB · ${items[0].stats.triangleCount.toLocaleString()} tris` : ""}
            {frameStats.medianMs !== null ? ` · median frame ${frameStats.medianMs.toFixed(1)} ms (last 120)` : ""}
          </div>
        </div>
        <ImportPanel onAccept={addImportedItem} />
      </aside>
    </div>
  );
}
