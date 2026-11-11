// Plain geometry for card outlines ("quads": 4 corners {x, y}, top-left, top-right, bottom-right,
// bottom-left). No OpenCV and no page needed, so it runs in a worker and in Node's unit tests.

export const CARD_ASPECT = 63 / 88; // width / height of a Pokémon card

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const centre = (q) => ({ x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length });

/** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const c = centre(pts);
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // sorted is clockwise in screen coordinates starting near the left; rotate so top-left (min x+y) is first
  let start = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[start].x + sorted[start].y) start = i; });
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
  // make sure the second point is the top-right (clockwise order)
  if (ordered[1].y > ordered[3].y) [ordered[1], ordered[3]] = [ordered[3], ordered[1]];
  return ordered;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Where the line through p1-p2 crosses the line through p3-p4 (the midpoint p2-p3 if parallel). */
export function intersect(p1, p2, p3, p4) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return lerp(p2, p3, 0.5);
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
}

export function bbox(q) {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** How much of the smaller box the two outlines' boxes share (0–1). */
export function overlap(a, b) {
  const A = bbox(a);
  const B = bbox(b);
  const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0));
  const iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
  const smaller = Math.min((A.x1 - A.x0) * (A.y1 - A.y0), (B.x1 - B.x0) * (B.y1 - B.y0));
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

/** Mean side lengths: { w, h } (w = top/bottom, h = left/right). */
export function sides([tl, tr, br, bl]) {
  return { w: (dist(tl, tr) + dist(bl, br)) / 2, h: (dist(tl, bl) + dist(tr, br)) / 2 };
}

/** Reading order: top to bottom by rows, left to right within a row. */
export function readingOrder(quads) {
  const rowH = quads.length ? Math.min(...quads.map((q) => bbox(q).y1 - bbox(q).y0)) / 2 : 0;
  return [...quads].sort((a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    return Math.abs(ca.y - cb.y) < rowH ? ca.x - cb.x : ca.y - cb.y;
  });
}
