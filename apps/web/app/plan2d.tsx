"use client";

import { footprintXZ, type Placement, type RoomGeometry, type Vec2 } from "@roomrelay/spatial";
import type { ViewerItem } from "@/lib/viewer-types";

interface Props {
  room: RoomGeometry;
  items: ViewerItem[];
  placements: Record<string, Placement>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

/** Top-down measured plan in meters. Footprints come from the same
 * footprintXZ math as the 3D view — no separate projection logic. */
export default function Plan2D({ room, items, placements, selectedId, onSelect }: Props) {
  const xs = room.boundaryXZ.map((p) => p[0]);
  const zs = room.boundaryXZ.map((p) => p[1]);
  const minX = Math.min(...xs) - 0.4;
  const maxX = Math.max(...xs) + 0.4;
  const minZ = Math.min(...zs) - 0.4;
  const maxZ = Math.max(...zs) + 0.4;
  const S = 110; // px per meter
  const W = (maxX - minX) * S;
  const H = (maxZ - minZ) * S;
  const px = (p: Vec2): [number, number] => [(p[0] - minX) * S, (p[1] - minZ) * S];
  const path = (poly: Vec2[], close = true) =>
    poly.map((p, i) => `${i === 0 ? "M" : "L"}${px(p)[0].toFixed(1)},${px(p)[1].toFixed(1)}`).join(" ") + (close ? " Z" : "");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="top-down room plan" data-testid="plan2d">
      <path d={path(room.boundaryXZ)} fill="#eee9dc" stroke="#8b8474" strokeWidth={1.6} />
      {room.doors.flatMap((d) => {
        const els = [];
        if (d.swingPolygonXZ.length > 0) {
          els.push(
            <path key={`${d.id}-swing`} d={path(d.swingPolygonXZ)} fill="rgba(138,90,19,0.16)" stroke="#8a5a13" strokeWidth={1} strokeDasharray="4 3" />,
          );
        }
        const [a, b] = px(d.openingXZ[0]!).concat(px(d.openingXZ[1]!)) as unknown as number[];
        els.push(
          <line key={`${d.id}-opening`} x1={a} y1={b} x2={px(d.openingXZ[1]!)[0]} y2={px(d.openingXZ[1]!)[1]} stroke="#22635a" strokeWidth={4} />,
        );
        return els;
      })}
      {room.obstacles.map((o) => (
        <g key={o.id}>
          <path d={path(o.footprintXZ)} fill="#b9bfc0" stroke="#7b857e" strokeWidth={1.2} />
          <text x={px([(o.footprintXZ[0]![0] + o.footprintXZ[2]![0]) / 2, (o.footprintXZ[0]![1] + o.footprintXZ[2]![1]) / 2])[0]} y={px([(o.footprintXZ[0]![0] + o.footprintXZ[2]![0]) / 2, (o.footprintXZ[0]![1] + o.footprintXZ[2]![1]) / 2])[1]} textAnchor="middle" fontSize={11} fill="#4a5450">
            {o.label}
          </text>
        </g>
      ))}
      {items.map((it) => {
        const p = placements[it.id];
        if (!p) return null;
        const fp = footprintXZ(it, p);
        const sel = it.id === selectedId;
        const cx = (p.xM - minX) * S;
        const cz = (p.zM - minZ) * S;
        // Front marker: +Z of the item, transformed by placement yaw.
        const fx = p.xM + Math.sin(p.yawRad) * it.dimsM.depthM * 0.5;
        const fz = p.zM + Math.cos(p.yawRad) * it.dimsM.depthM * 0.5;
        return (
          <g key={it.id} onClick={() => onSelect(it.id)} style={{ cursor: "pointer" }} data-testid={`footprint-${it.id}`}>
            <path
              d={path(fp)}
              fill={sel ? "rgba(34,99,90,0.35)" : "rgba(34,99,90,0.18)"}
              stroke={sel ? "#22635a" : "#4f7a72"}
              strokeWidth={sel ? 2 : 1.2}
            />
            <circle cx={(fx - minX) * S} cy={(fz - minZ) * S} r={3} fill="#22635a" />
            <circle cx={cx} cy={cz} r={2} fill="#1c2421" />
          </g>
        );
      })}
      {/* 1 m scale bar */}
      <g transform={`translate(${W - 1.6 * S}, ${H - 14})`}>
        <line x1={0} y1={0} x2={S} y2={0} stroke="#1c2421" strokeWidth={2} />
        <line x1={0} y1={-4} x2={0} y2={4} stroke="#1c2421" strokeWidth={2} />
        <line x1={S} y1={-4} x2={S} y2={4} stroke="#1c2421" strokeWidth={2} />
        <text x={S / 2} y={-8} textAnchor="middle" fontSize={11} fill="#1c2421">
          1 m
        </text>
      </g>
    </svg>
  );
}
