// Cards in clear plastic sleeves: the sleeve's rim is a bright line a little outside the card, and
// it's the outermost strong edge, so outlines land on it. Pure maths on the gradient and lightness
// images (no OpenCV), so it is unit-testable.

import { centre, dist, intersect, lerp } from './geometry.js';

/** Values along the segment a-b (its middle 76%), from a W × H image; outside the photo skipped. */
function along(img, W, H, a, b, samples = 32) {
  const out = [];
  for (let k = 0; k < samples; k++) {
    const p = lerp(a, b, 0.12 + (0.76 * k) / (samples - 1));
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x >= 0 && y >= 0 && x < W && y < H) out.push(img[y * W + x]);
  }
  return out;
}
const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
const median = (v) => (v.length ? [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)] : 0);

/**
 * If the outline is a sleeve around a card, the card's outline inside it; else null.
 * - The sleeve's rim is a thin bright ridge (brighter than both sides of it), where a card's edge is
 *   a step from one brightness to another: needed on at least `ridges` sides.
 * - A little inside each side there is another strong straight edge (the card's): needed on at
 *   least `sides` sides.
 * `light` is the photo's lightness (0–255, W × H).
 */
export function peelSleeve(quad, grad, light, W, H, { from = 0.012, to = 0.07, strong = 0.5, sides = 3, ridges = 2, ridgeLift = 8 } = {}) {
  const c = centre(quad);
  const size = (dist(quad[0], quad[1]) + dist(quad[1], quad[2]) + dist(quad[2], quad[3]) + dist(quad[3], quad[0])) / 4;
  const step = Math.max(0.75, size * 0.003);
  let ridgeCount = 0;
  const inner = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    const len = dist(p, q) || 1;
    let n = { x: (q.y - p.y) / len, y: -(q.x - p.x) / len };
    const mid = lerp(p, q, 0.5);
    if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y > 0) n = { x: -n.x, y: -n.y }; // point inwards
    const shift = (o) => [{ x: p.x + n.x * o, y: p.y + n.y * o }, { x: q.x + n.x * o, y: q.y + n.y * o }];
    // Is this side a bright ridge? Compare it with 3 px either side of it.
    const on = Math.max(...[-1, 0, 1].map((o) => median(along(light, W, H, ...shift(o)))));
    if (on - Math.max(median(along(light, W, H, ...shift(-3.5))), median(along(light, W, H, ...shift(3.5)))) >= ridgeLift) ridgeCount++;
    // The first strong edge inside it: a peak of strength after a dip (the rim's own inner flank,
    // falling away from it, is not an edge of its own).
    const own = mean(along(grad, W, H, p, q));
    let prev = Infinity;
    let dipped = false;
    for (let o = size * from; o <= size * to; o += step) {
      const s = mean(along(grad, W, H, ...shift(o)));
      const next = mean(along(grad, W, H, ...shift(o + step)));
      if (s < own * strong * 0.6) dipped = true;
      if (dipped && s >= own * strong && s >= prev && s >= next) return shift(o);
      prev = s;
    }
    return null;
  });
  if (ridgeCount < ridges || inner.filter(Boolean).length < sides) return null;
  // A side without an inner edge keeps its place; corners are where the sides cross.
  const line = (i) => inner[i] ?? [quad[i], quad[(i + 1) % 4]];
  return quad.map((_, i) => intersect(...line((i + 3) % 4), ...line(i)));
}
