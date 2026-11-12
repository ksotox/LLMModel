// Rectangles from straight lines: the maths behind strategies/lines.js. Plain functions on line
// segments ({ x1, y1, x2, y2 }), no OpenCV, so it is unit-testable.
//
// A card has four long straight edges, two pairs of parallel lines at right angles, in the 63:88
// ratio. That holds on a busy cloth, in a sleeve and when blurred, where the card's outline as a
// shape is lost (it merges with whatever touches it).

import { CARD_ASPECT, orderCorners, polygonArea } from './geometry.js';

const deg = Math.PI / 180;

/** A line through segments, fitted by length: { theta, rho, dir, spans, length, segments }. */
function fitLine(segments) {
  // Average direction with doubled angles (so opposite directions agree), weighted by length.
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let total = 0;
  for (const g of segments) {
    const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    const ang = Math.atan2(g.y2 - g.y1, g.x2 - g.x1);
    sx += Math.cos(2 * ang) * len;
    sy += Math.sin(2 * ang) * len;
    cx += ((g.x1 + g.x2) / 2) * len;
    cy += ((g.y1 + g.y2) / 2) * len;
    total += len;
  }
  const along = Math.atan2(sy, sx) / 2;
  const dir = { x: Math.cos(along), y: Math.sin(along) };
  let theta = along + Math.PI / 2; // normal direction
  let rho = Math.cos(theta) * (cx / total) + Math.sin(theta) * (cy / total);
  if (rho < 0) { theta += Math.PI; rho = -rho; }
  theta = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t = (x, y) => x * dir.x + y * dir.y;
  const spans = segments.map((g) => [Math.min(t(g.x1, g.y1), t(g.x2, g.y2)), Math.max(t(g.x1, g.y1), t(g.x2, g.y2))]);
  return { theta, rho, dir, spans, length: total, segments };
}

/** Distance of point (x, y) from a fitted line. */
const offLine = (l, x, y) => Math.abs(Math.cos(l.theta) * x + Math.sin(l.theta) * y - l.rho);

/**
 * Merge segments that lie on the same line (longest first; a segment joins a line when it points
 * the same way and both its ends are within `distTol` pixels of it; the line is refitted each time).
 * Each line: { theta, rho, dir, spans: [[t0, t1]…], length }, where (cos θ, sin θ)·p = ρ for
 * points p on it, `dir` is its direction and spans are the covered stretches along it.
 */
export function mergeSegments(segments, { angleTol = 3 * deg, distTol = 3 } = {}) {
  const sorted = [...segments].sort((p, q) => Math.hypot(q.x2 - q.x1, q.y2 - q.y1) - Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  const lines = [];
  for (const g of sorted) {
    const theta = Math.atan2(g.y2 - g.y1, g.x2 - g.x1) + Math.PI / 2;
    const i = lines.findIndex((l) => angleDiff(l.theta, theta) < angleTol && offLine(l, g.x1, g.y1) < distTol && offLine(l, g.x2, g.y2) < distTol);
    if (i >= 0) lines[i] = fitLine([...lines[i].segments, g]);
    else lines.push(fitLine([g]));
  }
  return lines;
}

/** Smallest difference between two directions of a line (0–π/2), ignoring which way they point. */
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/** The point halfway along a line's covered stretches. */
function middle(line) {
  const t = line.spans.reduce((sum, [s, e]) => sum + (s + e) / 2 * (e - s), 0) / Math.max(1e-9, line.length);
  return { x: line.rho * Math.cos(line.theta) + t * line.dir.x, y: line.rho * Math.sin(line.theta) + t * line.dir.y };
}

/** Where two lines (normal form) cross, or null when (nearly) parallel. */
function cross(l1, l2) {
  const det = Math.cos(l1.theta) * Math.sin(l2.theta) - Math.sin(l1.theta) * Math.cos(l2.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * Math.sin(l2.theta) - l2.rho * Math.sin(l1.theta)) / det,
    y: (l2.rho * Math.cos(l1.theta) - l1.rho * Math.cos(l2.theta)) / det,
  };
}

/** How much of the stretch between points a and b on `line` its segments cover (0–1). */
export function coverage(line, a, b) {
  const t0 = Math.min(a.x * line.dir.x + a.y * line.dir.y, b.x * line.dir.x + b.y * line.dir.y);
  const t1 = Math.max(a.x * line.dir.x + a.y * line.dir.y, b.x * line.dir.x + b.y * line.dir.y);
  if (t1 - t0 < 1) return 0;
  const parts = line.spans.map(([s, e]) => [Math.max(s, t0), Math.min(e, t1)]).filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let end = t0;
  for (const [s, e] of parts) {
    if (e <= end) continue;
    covered += e - Math.max(s, end);
    end = e;
  }
  return covered / (t1 - t0);
}

/**
 * Card-shaped rectangles made of two pairs of parallel lines at (nearly) right angles, each side
 * mostly covered by real edge segments. Returns [{ quad, score, area }], best first.
 */
export function rectanglesFromLines(lines, { W, H, minSide, maxSide, parallelTol = 4 * deg, squareTol = 8 * deg, ratioTol = 0.08, minCover = 0.35, meanCover = 0.55, runOn = 0.5, limit = 60 } = {}) {
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (angleDiff(a.theta, b.theta) > parallelTol) continue;
      // Separation: the distance from the middle of b's covered stretch to line a.
      const m = middle(b);
      const sep = Math.abs(Math.cos(a.theta) * m.x + Math.sin(a.theta) * m.y - a.rho);
      if (sep < minSide || sep > maxSide) continue;
      pairs.push({ a, b, sep, theta: a.theta });
    }
  }
  const found = [];
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const P = pairs[p];
      const Q = pairs[q];
      if (Math.abs(angleDiff(P.theta, Q.theta) - Math.PI / 2) > squareTol) continue;
      const ratio = Math.min(P.sep, Q.sep) / Math.max(P.sep, Q.sep);
      if (Math.abs(ratio - CARD_ASPECT) > ratioTol) continue;
      const corners = [cross(P.a, Q.a), cross(P.a, Q.b), cross(P.b, Q.b), cross(P.b, Q.a)];
      if (corners.some((c) => !c || c.x < -W * 0.02 || c.y < -H * 0.02 || c.x > W * 1.02 || c.y > H * 1.02)) continue;
      // corners in order around the rectangle: a∩Qa, a∩Qb, b∩Qb, b∩Qa
      const covers = [
        coverage(P.a, corners[0], corners[1]), coverage(Q.b, corners[1], corners[2]),
        coverage(P.b, corners[2], corners[3]), coverage(Q.a, corners[3], corners[0]),
      ];
      const mean = covers.reduce((s, c) => s + c, 0) / 4;
      if (Math.min(...covers) < minCover || mean < meanCover) continue;
      // A card's edges end at its corners. When both side lines carry on well past one side, that
      // side is a line inside something bigger (a card's top half ends at its picture's frame).
      const sideLines = [[P.a, Q.a, Q.b], [Q.b, P.a, P.b], [P.b, Q.b, Q.a], [Q.a, P.b, P.a]]; // side, its two neighbours
      const ends = [[0, 1], [1, 2], [2, 3], [3, 0]];
      const partOfBigger = sideLines.some(([, n1, n2], k) => {
        const [i, j] = ends[k];
        return [[n1, corners[i], corners[(i + 3) % 4]], [n2, corners[j], corners[(j + 1) % 4]]].every(([line, at, from]) => {
          const len = Math.hypot(at.x - from.x, at.y - from.y);
          const beyond = { x: at.x + ((at.x - from.x) / len) * len * 0.3, y: at.y + ((at.y - from.y) / len) * len * 0.3 };
          return coverage(line, at, beyond) > runOn;
        });
      });
      if (partOfBigger) continue;
      const quad = orderCorners(corners);
      found.push({ quad, area: polygonArea(quad), score: mean * (1 - (Math.abs(ratio - CARD_ASPECT) / ratioTol) * 0.3) });
    }
  }
  // Several lines can make nearly the same rectangle: keep the best of each.
  const distinct = [];
  for (const r of found.sort((x, y) => y.score - x.score)) {
    const tol = Math.sqrt(r.area) * 0.015;
    if (!distinct.some((d) => d.quad.every((p, k) => Math.hypot(p.x - r.quad[k].x, p.y - r.quad[k].y) < tol))) distinct.push(r);
    if (distinct.length >= limit) break;
  }
  return distinct;
}

/**
 * Move each side of a rough outline onto a straight edge found nearby: a line pointing (nearly) the
 * same way, within `distTol` (fraction of the outline's size) of both of the side's ends, covering at
 * least `minCover` of it. Of the lines that cover nearly as much as the best one, the outermost is
 * taken (a card's own edge, not its inner frame). Corners are where neighbouring sides cross. Fixes
 * outlines with a corner cut off (part of the card looks like the table), which nudging can't.
 */
export function fitSidesToLines(quad, lines, { angleTol = 10 * deg, distTol = 0.15, minCover = 0.3, near = 0.8 } = {}) {
  const size = Math.sqrt(polygonArea(quad));
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  const sides = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    const theta = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const outwardSign = Math.sign((mid.x - c.x) * Math.cos(theta) + (mid.y - c.y) * Math.sin(theta)) || 1;
    const options = [];
    for (const l of lines) {
      if (angleDiff(l.theta, theta) > angleTol) continue;
      if (offLine(l, p.x, p.y) > distTol * size || offLine(l, q.x, q.y) > distTol * size) continue;
      const cover = coverage(l, p, q);
      if (cover < minCover) continue;
      // How far out the line is, at the side's middle.
      const onLine = Math.cos(l.theta) * mid.x + Math.sin(l.theta) * mid.y - l.rho;
      const out = -onLine * Math.sign(Math.cos(l.theta) * Math.cos(theta) + Math.sin(l.theta) * Math.sin(theta)) * outwardSign;
      options.push({ l, cover, out });
    }
    if (!options.length) return null;
    const best = Math.max(...options.map((o) => o.cover));
    return options.filter((o) => o.cover >= best * near).sort((a, b) => b.out - a.out)[0].l;
  });
  if (sides.every((s) => !s)) return quad;
  // A side without a line keeps its own position, as a line through its two ends.
  const asLine = (i) => sides[i] ?? (() => {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    let theta = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
    let rho = Math.cos(theta) * p.x + Math.sin(theta) * p.y;
    if (rho < 0) { theta += Math.PI; rho = -rho; }
    return { theta, rho };
  })();
  const out = quad.map((_, i) => cross(asLine((i + 3) % 4), asLine(i)));
  return out.some((p) => !p) ? quad : out;
}
