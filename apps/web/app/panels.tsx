"use client";

import { useRef, useState } from "react";
import { inspectGlb } from "@roomrelay/assets";
import { normalizeItem, toMeters, type LayoutResult, type LinearUnit, type Placement } from "@roomrelay/spatial";
import type { ViewerItem } from "@/lib/viewer-types";

const PROVENANCE_TEXT: Record<ViewerItem["provenance"], string> = {
  SCANNED_ACTUAL: "Scanned actual item",
  CATALOG_EXACT_MATCH: "Exact catalog match",
  APPROXIMATE_PROXY: "Approximate proxy",
  ILLUSTRATIVE_GENERATED: "Illustrative generated model",
};

export function FitPanel({ layout }: { layout: LayoutResult }) {
  const visible = layout.findings.filter((f) => f.status !== "PASS" || f.code === "BOUNDARY_MARGIN" || f.code === "ITEM_OVERLAP");
  return (
    <div className="card" data-testid="fit-panel">
      <h2>Fit check</h2>
      <div className={`verdict ${layout.fitsProvidedMeasurements ? "fits" : "nofit"}`} data-testid="verdict">
        {layout.verdict}
      </div>
      <div style={{ marginTop: 6 }}>
        {visible.map((f, i) => (
          <div key={i} className={`finding ${f.status.toLowerCase()}`} data-testid={`finding-${f.code}`}>
            <span className="dot" aria-hidden="true" />
            <span>
              <span className="sr-only">{f.status}: </span>
              {f.message}
            </span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 8 }}>
        Checks use confirmed measurements with a 0.05 m margin. This verifies the recorded
        dimensions — not delivery fit or structural suitability.
      </div>
    </div>
  );
}

export function ItemPanel({ item }: { item: ViewerItem }) {
  return (
    <div className="card" data-testid="item-panel">
      <h2>Item</h2>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{item.title}</div>
      <div style={{ margin: "8px 0" }}>
        <span className={`badge ${item.provenance === "APPROXIMATE_PROXY" ? "proxy" : ""}`}>
          {PROVENANCE_TEXT[item.provenance]}
        </span>
      </div>
      <div className="muted">{item.provenanceNote}</div>
      <div style={{ marginTop: 10, fontSize: 13 }}>
        Confirmed dims: {item.dimsM.widthM.toFixed(3)} × {item.dimsM.depthM.toFixed(3)} × {item.dimsM.heightM.toFixed(3)} m
        <span className="muted"> (W × D × H)</span>
      </div>
      <div style={{ marginTop: 10, fontSize: 13 }}>
        Condition photos:{" "}
        {item.conditionPhotos.length === 0 ? (
          <span className="muted">{item.photosNote ?? "None"}</span>
        ) : (
          item.conditionPhotos.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p} src={p} alt="item condition" width={64} height={64} style={{ borderRadius: 8, marginRight: 6 }} />
          ))
        )}
      </div>
    </div>
  );
}

export function PlacementControls({
  item,
  placement,
  onChange,
  onReset,
}: {
  item: ViewerItem;
  placement: Placement;
  onChange: (p: Placement) => void;
  onReset: () => void;
}) {
  const deg = (placement.yawRad * 180) / Math.PI;
  return (
    <div className="card" data-testid="placement-controls">
      <h2>Placement</h2>
      <div className="field-row">
        <label htmlFor="in-x">X (m)</label>
        <DraftInput
          id="in-x"
          testid="input-x"
          committed={placement.xM}
          format={(v) => v.toFixed(3)}
          coerce={(n) => (n >= -100 && n <= 100 ? n : null)}
          onCommit={(n) => onChange({ ...placement, xM: n })}
        />
        <label htmlFor="in-z">Z (m)</label>
        <DraftInput
          id="in-z"
          testid="input-z"
          committed={placement.zM}
          format={(v) => v.toFixed(3)}
          coerce={(n) => (n >= -100 && n <= 100 ? n : null)}
          onCommit={(n) => onChange({ ...placement, zM: n })}
        />
      </div>
      <div className="field-row">
        <label htmlFor="in-yaw">Yaw (°)</label>
        <DraftInput
          id="in-yaw"
          testid="input-yaw"
          committed={deg}
          format={(v) => v.toFixed(1)}
          coerce={(n) => (Math.abs(n) <= 36000 ? normalizeYawDeg(n) : null)}
          onCommit={(n) => onChange({ ...placement, yawRad: (n * Math.PI) / 180 })}
        />
        <button className="btn" onClick={onReset} data-testid="reset-placement">
          Reset placement
        </button>
      </div>
      <div className="kbd-hint">Click the model to drag it on the floor. Arrows move ±0.05 m; Q/E rotate ±15°.</div>
      <div className="muted" style={{ marginTop: 4 }}>{item.title}</div>
    </div>
  );
}

/**
 * Numeric input that keeps a local draft string while focused: valid drafts
 * commit live to the placement, invalid drafts show aria-invalid, and the
 * field re-syncs to the formatted committed value on blur/Enter or whenever
 * the committed value changes externally while unfocused.
 */
function DraftInput({
  id,
  testid,
  committed,
  format,
  coerce,
  onCommit,
}: {
  id: string;
  testid: string;
  committed: number;
  format: (v: number) => string;
  /** Maps a parsed draft to the committable value, or null to reject it
   * (out-of-range input gets aria-invalid and is never committed). */
  coerce: (n: number) => number | null;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(() => format(committed));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const displayedDraft = focused ? draft : format(committed);

  const commit = (raw: string) => {
    const n = Number(raw);
    const v = raw.trim() !== "" && Number.isFinite(n) ? coerce(n) : null;
    if (v !== null) {
      setInvalid(false);
      onCommit(v);
    } else {
      setInvalid(true);
    }
  };

  const resync = () => {
    setDraft(format(committed));
    setInvalid(false);
  };

  return (
    <input
      id={id}
      data-testid={testid}
      type="number"
      step={id === "in-yaw" ? 15 : 0.05}
      value={displayedDraft}
      aria-invalid={invalid || undefined}
      onFocus={() => {
        setDraft(format(committed));
        setInvalid(false);
        setFocused(true);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => {
        setFocused(false);
        resync();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          resync();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Normalize degrees into (-180, 180]. */
function normalizeYawDeg(deg: number): number {
  return 180 - ((((180 - deg) % 360) + 360) % 360);
}

interface ImportDraft {
  item: ViewerItem;
  inspect: { bytes: number; sha256: string; triangleCount: number; textureCount: number; boundsMin: number[]; boundsMax: number[] };
  scaleCheck: ReturnType<typeof normalizeItem>;
}

export function ImportPanel({ onAccept }: { onAccept: (item: ViewerItem, placement: Placement) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [unit, setUnit] = useState<LinearUnit>("m");
  const [width, setWidth] = useState("");
  const [depth, setDepth] = useState("");
  const [height, setHeight] = useState("");
  const [yawDeg, setYawDeg] = useState("0");
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const analyze = async () => {
    setError(null);
    setDraft(null);
    setAck(false);
    if (!file) {
      setError("Choose a .glb file first.");
      return;
    }
    const w = Number(width);
    const d = Number(depth);
    const h = Number(height);
    if (![w, d, h].every((v) => Number.isFinite(v) && v > 0)) {
      setError("Enter positive confirmed width, depth and height.");
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = inspectGlb(bytes); // runs fully in the browser — the file is never uploaded
      const confirmedDimsM = {
        widthM: toMeters(w, unit),
        depthM: toMeters(d, unit),
        heightM: toMeters(h, unit),
      };
      const scaleCheck = normalizeItem({
        boundsMin: info.boundsMin,
        boundsMax: info.boundsMax,
        sourceUnits: "m", // glTF is always meters
        confirmedDimsM,
        sourceYawRad: (Number(yawDeg || "0") * Math.PI) / 180,
      });
      const item: ViewerItem = {
        id: `import-${Date.now().toString(36)}`,
        title: file.name.replace(/\.glb$/i, ""),
        dimsM: confirmedDimsM,
        provenance: "APPROXIMATE_PROXY",
        provenanceNote: "Imported asset (unverified provenance): treated as an approximate proxy until a seller confirms it.",
        assetUrl: URL.createObjectURL(file),
        localMatrix: scaleCheck.localMatrix,
        stats: { bytes: info.bytes, triangleCount: info.triangleCount },
        conditionPhotos: [],
        photosNote: "No condition photos: local import.",
        scaleCheck,
      };
      setDraft({ item, inspect: { ...info, boundsMin: [...info.boundsMin], boundsMax: [...info.boundsMax] }, scaleCheck });
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : "Could not inspect that file.");
    } finally {
      setBusy(false);
    }
  };

  const needsReview = draft?.scaleCheck.status === "NEEDS_REVIEW";

  return (
    <div className="card" data-testid="import-panel">
      <h2>Import a GLB</h2>
      <div className="muted">Checked locally in your browser — the file is never uploaded.</div>
      <div className="field-row">
        <input
          ref={fileRef}
          data-testid="import-file"
          type="file"
          accept=".glb"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="field-row">
        <label>Unit</label>
        <select value={unit} onChange={(e) => setUnit(e.target.value as LinearUnit)} data-testid="import-unit">
          <option value="m">m</option>
          <option value="cm">cm</option>
          <option value="mm">mm</option>
        </select>
        <label htmlFor="imp-w">W</label>
        <input id="imp-w" type="number" step="0.01" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="0.00" />
        <label htmlFor="imp-d">D</label>
        <input id="imp-d" type="number" step="0.01" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="0.00" />
        <label htmlFor="imp-h">H</label>
        <input id="imp-h" type="number" step="0.01" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="0.00" />
        <label htmlFor="imp-yaw">Front yaw°</label>
        <input id="imp-yaw" type="number" step={15} value={yawDeg} onChange={(e) => setYawDeg(e.target.value)} style={{ width: 64 }} />
      </div>
      <div className="field-row">
        <button className="btn primary" onClick={analyze} disabled={busy || !file} data-testid="import-analyze">
          {busy ? "Checking…" : "Check asset"}
        </button>
      </div>
      {error ? (
        <div className="notice" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      {draft ? (
        <div style={{ marginTop: 10, fontSize: 13 }} data-testid="import-report">
          <div>
            {(draft.inspect.bytes / 1e6).toFixed(2)} MB · {draft.inspect.triangleCount.toLocaleString()} tris ·{" "}
            {draft.inspect.textureCount} textures
          </div>
          <div className="muted">
            bounds {(draft.inspect.boundsMax[0]! - draft.inspect.boundsMin[0]!).toFixed(3)} ×{" "}
            {(draft.inspect.boundsMax[2]! - draft.inspect.boundsMin[2]!).toFixed(3)} ×{" "}
            {(draft.inspect.boundsMax[1]! - draft.inspect.boundsMin[1]!).toFixed(3)} m
          </div>
          <div style={{ marginTop: 6 }}>
            Scale check: <strong>{draft.scaleCheck.status}</strong>
          </div>
          {draft.scaleCheck.axes
            .filter((a) => a.withinThreshold === false)
            .map((a) => (
              <div key={a.axis} className="finding fail">
                <span className="dot" />
                <span>
                  {a.axis}: measured {a.measuredM.toFixed(3)} m vs confirmed {a.confirmedM!.toFixed(3)} m (Δ{" "}
                  {a.deltaM!.toFixed(3)} m, limit {a.thresholdM!.toFixed(3)} m)
                </span>
              </div>
            ))}
          {needsReview ? (
            <label style={{ display: "block", marginTop: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="import-ack" /> I
              acknowledge the measured size differs from the confirmed dimensions shown above.
            </label>
          ) : null}
          <div className="field-row" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={Boolean(needsReview && !ack)}
              onClick={() => {
                onAccept(draft.item, { xM: 1.0, zM: 1.2, yawRad: 0 });
                setDraft(null);
                setFile(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              data-testid="import-place"
            >
              Place in room
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
