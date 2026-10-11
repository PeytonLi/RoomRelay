import { footprintXZ, type Vec2 } from "@roomrelay/spatial";
import { formatMeters } from "@/lib/client/api";
import type { PlacementGuide as Guide } from "@/lib/journey/types";

/** Printable top-down placement guide (pure SVG, no WebGL). Footprints use
 * the same footprintXZ math as the viewer and Plan2D. */
export default function PlacementGuide({ guide }: { guide: Guide }) {
  const { room } = guide;
  const xs = room.boundaryXZ.map((p) => p[0]);
  const zs = room.boundaryXZ.map((p) => p[1]);
  const pad = 0.6;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad;
  const maxZ = Math.max(...zs) + pad;
  const S = 100;
  const W = (maxX - minX) * S;
  const H = (maxZ - minZ) * S;
  const px = (p: Vec2): [number, number] => [(p[0] - minX) * S, (p[1] - minZ) * S];
  const path = (poly: Vec2[]) => poly.map((p, i) => `${i === 0 ? "M" : "L"}${px(p)[0].toFixed(1)},${px(p)[1].toFixed(1)}`).join(" ") + " Z";
  const edges = room.boundaryXZ.map((a, i) => [a, room.boundaryXZ[(i + 1) % room.boundaryXZ.length]!] as const);

  return (
    <figure className="placement-guide" data-testid="placement-guide">
      <svg viewBox={`0 0 ${W.toFixed(1)} ${H.toFixed(1)}`} role="img" aria-labelledby="guide-title guide-desc">
        <title id="guide-title">Placement guide, room measurement revision {guide.roomRevision}</title>
        <desc id="guide-desc">Top-down plan with {guide.items.length} numbered item footprint(s). The table below lists the same positions.</desc>
        <defs>
          <marker id="guide-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" fill="#1c2421" />
          </marker>
        </defs>
        <path d={path(room.boundaryXZ)} fill="#f7f4ec" stroke="#1c2421" strokeWidth={2} />
        {edges.map(([a, b], i) => {
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.3) return null;
          const [mx, my] = px([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          return <text key={`edge-${i}`} x={mx} y={my - 6} textAnchor="middle" fontSize={12} fill="#5c625e">{formatMeters(len)}</text>;
        })}
        {room.doors.map((d) => (
          <line key={d.id} x1={px(d.openingXZ[0]!)[0]} y1={px(d.openingXZ[0]!)[1]} x2={px(d.openingXZ[1]!)[0]} y2={px(d.openingXZ[1]!)[1]} stroke="#22635a" strokeWidth={5}>
            <title>Door opening</title>
          </line>
        ))}
        {room.obstacles.map((o) => <path key={o.id} d={path(o.footprintXZ)} fill="#d4d8d6" stroke="#7b857e" strokeDasharray="4 3"><title>{o.label}</title></path>)}
        {guide.items.map((it) => {
          const placement = { xM: it.xM, zM: it.zM, yawRad: it.yawRad };
          const fp = footprintXZ({ dimsM: { widthM: it.widthM, depthM: it.depthM, heightM: it.heightM } }, placement);
          const [cx, cz] = px([it.xM, it.zM]);
          const reach = Math.max(it.depthM * 0.5 + 0.25, 0.4);
          const [fx, fz] = px([it.xM + Math.sin(it.yawRad) * reach, it.zM + Math.cos(it.yawRad) * reach]);
          return (
            <g key={it.itemId} data-testid={`guide-item-${it.n}`}>
              <path d={path(fp)} fill="rgba(34,99,90,0.16)" stroke="#22635a" strokeWidth={1.6} />
              <line x1={cx} y1={cz} x2={fx} y2={fz} stroke="#1c2421" strokeWidth={1.6} markerEnd="url(#guide-arrow)" />
              <circle cx={cx} cy={cz} r={12} fill="#22635a" />
              <text x={cx} y={cz + 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="#fff">{it.n}</text>
            </g>
          );
        })}
        <g transform={`translate(${(W - 1.4 * S).toFixed(1)}, ${(H - 16).toFixed(1)})`}>
          <line x1={0} y1={0} x2={S} y2={0} stroke="#1c2421" strokeWidth={2} />
          <text x={S / 2} y={-6} textAnchor="middle" fontSize={11}>1 m</text>
        </g>
      </svg>
      <figcaption>
        <p className="muted">Arrows point to each item&apos;s front. Measured room geometry, revision {guide.roomRevision}; layout revision <code>{guide.layoutRevisionId}</code>.</p>
        <table className="data-table">
          <caption>Placement positions (room frame, meters)</caption>
          <thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">Size (W × D × H)</th><th scope="col">Center (x, z)</th><th scope="col">Facing</th></tr></thead>
          <tbody>
            {guide.items.map((it) => (
              <tr key={it.itemId}>
                <td>{it.n}</td>
                <td>{it.title}</td>
                <td>{formatMeters(it.widthM)} × {formatMeters(it.depthM)} × {formatMeters(it.heightM)}</td>
                <td>{it.xM.toFixed(2)}, {it.zM.toFixed(2)}</td>
                <td>{Math.round((((it.yawRad * 180) / Math.PI) % 360 + 360) % 360)}°</td>
              </tr>
            ))}
          </tbody>
        </table>
        {guide.assumptions.length > 0 && (
          <>
            <h4>Assumptions</h4>
            <ul>{guide.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </>
        )}
      </figcaption>
    </figure>
  );
}
