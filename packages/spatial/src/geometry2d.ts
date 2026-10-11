import type { Vec2 } from "./types";

export function polygonAreaXZ(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

const EPS = 1e-9;

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a[0], b[0]) - EPS <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + EPS &&
    Math.min(a[1], b[1]) - EPS <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + EPS &&
    Math.abs(orient(a, b, p)) <= EPS
  );
}

/** Proper segment intersection: counts touching at endpoints, which callers
 * must treat appropriately for adjacent polygon edges. */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  if (Math.abs(d1) <= EPS && onSegment(b1, b2, a1)) return true;
  if (Math.abs(d2) <= EPS && onSegment(b1, b2, a2)) return true;
  if (Math.abs(d3) <= EPS && onSegment(a1, a2, b1)) return true;
  if (Math.abs(d4) <= EPS && onSegment(a1, a2, b2)) return true;
  return false;
}

/** True when no pair of non-adjacent edges intersects (touches included). */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i]!;
    const a2 = poly[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // skip adjacent edges (share a vertex), including wrap-around pair
      if (j === i) continue;
      if ((i + 1) % n === j) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = poly[j]!;
      const b2 = poly[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

/** Ray-casting point-in-polygon; points exactly on an edge count as inside. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (onSegment(poly[i]!, poly[(i + 1) % n]!, p)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum distance from point p to any edge of poly. */
export function distanceToPolygonEdges(p: Vec2, poly: Vec2[]): number {
  let min = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d < min) min = d;
  }
  return min;
}

/** Polygon-polygon intersection for simple polygons: any vertex inside the
 * other polygon, or any edge pair crossing. */
export function polygonsIntersect(a: Vec2[], b: Vec2[]): boolean {
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return false;
}
