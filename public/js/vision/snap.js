// Moving a rough outline onto the card's real edges, using the photo's gradient strength.
// Pure maths on a Float32Array (no OpenCV), so it is unit-testable.

import { centre as centreOf, dist, intersect, lerp } from './geometry.js';

/** Gradient strength at (x, y), or -1 outside the photo. */
const sampler = (grad, W, H) => (x, y) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  return xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1 ? -1 : grad[yi * W + xi];
};

/**
 * Mean gradient along the segment a-b (skipping its ends, where card corners are rounded); -1 when
 * most of it is off the photo. With `band`, each sample is the strongest within that many pixels
 * either side of the line, so a line a pixel off the edge still counts.
 */
function lineStrength(sample, a, b, { samples = 40, band = 0 } = {}) {
  const len = dist(a, b) || 1;
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  let sum = 0;
  let inside = 0;
  for (let k = 0; k < samples; k++) {
    const pt = lerp(a, b, 0.12 + (0.76 * k) / (samples - 1));
    let g = sample(pt.x, pt.y);
    for (let d = 1; d <= band; d++) g = Math.max(g, sample(pt.x + n.x * d, pt.y + n.y * d), sample(pt.x - n.x * d, pt.y - n.y * d));
    if (g >= 0) { sum += g; inside++; }
  }
  return inside > samples * 0.5 ? sum / inside : -1;
}

/** Outward unit normal of side p-q of a quad centred at c. */
function outward(p, q, c) {
  const len = dist(p, q) || 1;
  let n = { x: (q.y - p.y) / len, y: -(q.x - p.x) / len };
  const mid = lerp(p, q, 0.5);
  if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y };
  return n;
}

/**
 * Snap each side of a rough quad onto the card's real outer edge. The rough outline can sit a little
 * inside the card (glare, white borders) — cutting the card off — so every side is moved outwards to
 * the outermost strong edge within a few percent of the card size. Works on the gradient image `grad`.
 * `inwards` and `outwards` (fractions of the card's size) set how far a side may move each way.
 */
export function snapToEdges(quad, grad, W, H, { inwards = 0.015, outwards = 0.06 } = {}) {
  const c = centreOf(quad);
  const size = (dist(quad[0], quad[1]) + dist(quad[1], quad[2]) + dist(quad[2], quad[3]) + dist(quad[3], quad[0])) / 4;
  const step = Math.max(0.75, size * 0.003);
  const offsets = [];
  for (let o = -size * inwards; o <= size * outwards; o += step) offsets.push(o);
  const sample = sampler(grad, W, H);

  const lines = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    const n = outward(p, q, c);
    const scored = [];
    for (const o1 of offsets) {
      for (const o2 of offsets) {
        if (Math.abs(o1 - o2) > size * 0.02) continue;
        const a = { x: p.x + n.x * o1, y: p.y + n.y * o1 };
        const b = { x: q.x + n.x * o2, y: q.y + n.y * o2 };
        const score = lineStrength(sample, a, b);
        if (score >= 0) scored.push({ a, b, score, out: o1 + o2 });
      }
    }
    if (!scored.length) return [p, q]; // this side runs off the photo: keep it
    const best = Math.max(...scored.map((s) => s.score));
    // The outermost line that is nearly as strong as the strongest one is the card's own edge.
    // (0.8: a looser bar lets slanted lines that cross the edge win; tuned on bench:scan.)
    const pick = scored.filter((s) => s.score >= best * 0.8).sort((x, y) => y.out - x.out)[0];
    return [pick.a, pick.b];
  });
  return lines.map((line, i) => {
    const prev = lines[(i + 3) % 4];
    return intersect(prev[0], prev[1], line[0], line[1]);
  });
}

/**
 * How well the photo supports the outline: the weakest side's gradient strength along the outline,
 * relative to the photo's typical gradient. A real card shows an edge on all four sides; an outline
 * made of a shadow and an inner line usually has one weak side. Sides off the photo are ignored.
 */
export function edgeSupport(quad, grad, W, H, typical) {
  const sample = sampler(grad, W, H);
  const strengths = quad.map((p, i) => lineStrength(sample, p, quad[(i + 1) % 4])).filter((s) => s >= 0);
  if (!strengths.length) return 0;
  return Math.min(...strengths) / Math.max(1e-6, typical);
}

/**
 * Whether the outline looks like part of something bigger: past one of its sides, both neighbouring
 * edges carry on (a card's top half ends at its picture's frame, while the card's own left and right
 * edges continue). Past a real card's corner the edge stops and the table begins. Checks a stretch
 * from `gap` to `gap + reach` (fractions of the edge's length) beyond each corner.
 */
export function runsOn(quad, grad, W, H, { gap = 0.04, reach = 0.1, share = 0.5, band = 2 } = {}) {
  const sample = sampler(grad, W, H);
  const own = quad.map((p, i) => lineStrength(sample, p, quad[(i + 1) % 4], { band }));
  // Edge i runs from corner i to corner i+1. Beyond corner i+1 it continues past side i+1; beyond
  // corner i it continues past side i-1 (going backwards).
  const carriesOn = (i, forward) => {
    const from = forward ? quad[i] : quad[(i + 1) % 4];
    const to = forward ? quad[(i + 1) % 4] : quad[i];
    const len = dist(from, to) || 1;
    const u = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    const a = { x: to.x + u.x * len * gap, y: to.y + u.y * len * gap };
    const b = { x: to.x + u.x * len * (gap + reach), y: to.y + u.y * len * (gap + reach) };
    const s = lineStrength(sample, lerp(a, b, -0.12 / 0.76), lerp(a, b, 1 + 0.12 / 0.76), { band }); // the whole stretch a-b
    return own[i] > 0 && s >= own[i] * share;
  };
  // Side j (corner j to j+1) is passed by edge j-1 going forward and edge j+1 going backward.
  return [0, 1, 2, 3].some((j) => carriesOn((j + 3) % 4, true) && carriesOn((j + 1) % 4, false));
}
