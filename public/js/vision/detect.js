// The card finder's pipeline: every strategy proposes outlines, the best non-overlapping ones are
// kept, then each is snapped onto the card's real edges. Works on raw RGBA pixels with the OpenCV
// module passed in, so it runs in the page, in a Web Worker, and in Node.

import { bbox, dist, overlap, polygonArea, readingOrder } from './geometry.js';
import { collectCandidates } from './contours.js';
import { completePart, edgeSupport, runsOn, snapToEdges } from './snap.js';
import { brightness } from './strategies/brightness.js';
import { edges } from './strategies/edges.js';
import { background, tableDistance } from './strategies/background.js';
import { peelSleeve } from './sleeve.js';
import { lines, straightEdges } from './strategies/lines.js';
import { fitSidesToLines } from './lines.js';

export const STRATEGIES = { brightness, edges, background, lines };
const DEFAULT_STRATEGIES = ['brightness', 'edges', 'background', 'lines'];

/**
 * Gradient strength, as a Float32Array (row-major, W × H). With a Lab image it is the combined
 * strength over lightness and colour, so a silver border on brown wood (similar in grey) counts.
 */
function gradient(cv, image) {
  const smooth = new cv.Mat();
  cv.GaussianBlur(image, smooth, new cv.Size(3, 3), 0);
  const channels = new cv.MatVector();
  cv.split(smooth, channels);
  const grad = new Float32Array(image.cols * image.rows);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  for (let c = 0; c < channels.size(); c++) {
    const ch = channels.get(c);
    cv.Sobel(ch, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(ch, gy, cv.CV_32F, 0, 1, 3);
    for (let i = 0; i < grad.length; i++) grad[i] += gx.data32F[i] ** 2 + gy.data32F[i] ** 2;
    ch.delete();
  }
  for (let i = 0; i < grad.length; i++) grad[i] = Math.sqrt(grad[i]);
  for (const m of [smooth, channels, gx, gy]) m.delete();
  return grad;
}

/** Distance from point p to the line through a and b. */
const lineDist = (p, a, b) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / (dist(a, b) || 1);

/** How many of `small`'s sides lie along a side of `big` (both ends within `tol` of that side's line). */
export function sharedSides(small, big, tol) {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const [p, q] = [small[i], small[(i + 1) % 4]];
    if (big.some((a, j) => lineDist(p, a, big[(j + 1) % 4]) < tol && lineDist(q, a, big[(j + 1) % 4]) < tol)) n++;
  }
  return n;
}

/**
 * Outlines that are groups of cards or parts of one:
 * - a group holds two or more separate smaller card outlines (each at most 40% of its size): a 2×2
 *   block of binder pockets has a card's shape;
 * - a part lies inside a bigger outline at 30–80% of its size and shares three of its sides: a
 *   card's top half (down to its picture's frame) has a card's shape turned sideways.
 * Near-equal pairs (a card's inner frame, a sleeve around it) are left for the ranking to decide.
 */
export function dropGroupsAndParts(candidates) {
  const inside = (small, big) => small.area < big.area && overlap(small.quad, big.quad) > 0.85;
  const groups = new Set(candidates.filter((big) => {
    const small = candidates.filter((c) => c.area <= big.area * 0.4 && inside(c, big)).sort((x, y) => y.rank - x.rank);
    const separate = [];
    for (const c of small) if (!separate.some((d) => overlap(d.quad, c.quad) > 0.3)) separate.push(c);
    return separate.length >= 2;
  }));
  const isPart = (c) => candidates.some((big) => !groups.has(big) && big !== c
    && c.area >= big.area * 0.3 && c.area <= big.area * 0.8 && inside(c, big) && big.rank >= c.rank * 0.5
    && sharedSides(c.quad, big.quad, Math.sqrt(big.area) * 0.025) >= 3);
  return candidates.filter((c) => !groups.has(c) && !isPart(c));
}

/**
 * Find the cards in an image ({ data: RGBA bytes, width, height }, already downscaled for speed).
 * Returns quads in that image's pixels (TL/TR/BR/BL), in reading order. Empty when nothing
 * card-shaped was found. `strategies` names the ways of finding outlines to use.
 */
export function detectQuads(cv, image, { strategies = DEFAULT_STRATEGIES, colourEdges = true, fitLines = true, sleeves = true, debug = null } = {}) {
  const W = image.width;
  const H = image.height;
  const pad = 12;
  const src = cv.matFromImageData(image);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  rgb.delete();
  const padded = new cv.Mat();
  // A dark frame around the photo gives cards that touch the photo's edge a closed outline.
  cv.copyMakeBorder(gray, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const blurred = new cv.Mat();
  cv.GaussianBlur(padded, blurred, new cv.Size(5, 5), 0);
  const k = Math.max(3, Math.round(Math.min(W, H) * 0.012)) | 1;
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));

  let candidates = [];
  const limits = { offset: pad, minArea: W * H * 0.03, maxArea: (W + 2 * pad) * (H + 2 * pad) * 0.995 };
  const prep = {
    cv, src, gray, lab, padded, blurred, kernel, pad, W, H,
    collect: (binary, label) => collectCandidates(cv, binary, { ...limits, label }, candidates),
    add: (candidate) => candidates.push(candidate),
  };
  let straight = null;
  prep.straight = () => (straight ??= straightEdges(prep));
  let table = null;
  prep.table = () => (table ??= tableDistance(lab.data, W, H));
  let grad;
  let light = null;
  try {
    for (const name of strategies) STRATEGIES[name](prep);
    grad = gradient(cv, colourEdges ? lab : gray);
    if (fitLines) prep.straight();
    if (sleeves) {
      light = new Uint8Array(W * H);
      for (let i = 0; i < light.length; i++) light[i] = lab.data[i * 3];
    }
  } finally {
    for (const m of [src, gray, lab, padded, blurred, kernel]) m.delete();
  }

  // The dark frame added above can make the photo's own border look like one big card (on a
  // lighter table). An outline along all four photo edges is the photo, not a card: drop it when
  // real cards were found inside. (A card filling the whole photo is then the only candidate.)
  const isPhotoFrame = (q) => {
    const b = bbox(q);
    const mx = W * 0.02;
    const my = H * 0.02;
    return b.x0 <= mx && b.y0 <= my && b.x1 >= W - mx && b.y1 >= H - my;
  };
  if (candidates.some((c) => !isPhotoFrame(c.quad))) candidates = candidates.filter((c) => !isPhotoFrame(c.quad));

  // Snap every candidate onto the real edges, then rank it: card-like, large, and with a clear edge
  // on every side. An outline made of a shadow, a binder pocket or a pattern on the table has at
  // least one faint side; a card's own outline doesn't.
  const completed = [];
  const settle = (c) => {
    // Nudge each side onto the strongest edge nearby. Outlines from the table's colour include the
    // card's shadow, so they may move further inwards. Also try straightening the sides onto real
    // straight edges first (fixes an outline with a corner cut off), and keep whichever version has
    // the clearer edges all round (a binder pocket's line next to the card is straight too).
    const range = c.label === 'background' ? { inwards: 0.05, outwards: 0.03 } : {};
    const clamp = (q) => q.map((p) => ({ x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y)) }));
    const versions = [clamp(snapToEdges(c.quad, grad, W, H, range))];
    if (fitLines && c.label !== 'lines') versions.push(clamp(snapToEdges(fitSidesToLines(c.quad, straight), grad, W, H, range)));
    const supports = versions.map((q) => edgeSupport(q, grad, W, H, 1));
    const pick = supports[1] > supports[0] ? 1 : 0;
    c.quad = versions[pick];
    c.support = supports[pick];
    // A card in a sleeve: take the card inside, not the sleeve's rim. It keeps the rank the sleeve's
    // clear outline earned (the card's own edge under the plastic is fainter).
    const peeled = sleeves ? peelSleeve(c.quad, grad, light, W, H) : null;
    if (peeled) {
      c.sleeve = true;
      c.quad = clamp(snapToEdges(peeled, grad, W, H, { inwards: 0.015, outwards: 0.005 }));
    }
    const side = runsOn(c.quad, grad, W, H);
    c.part = side >= 0;
    c.rank = c.score * Math.sqrt(c.area) * c.support * (c.part ? 0.3 : 1);
    // A part of a card (its top half, say) shows where the whole card is: try that too.
    if (c.part && !c.completed) {
      const whole = completePart(c.quad, side);
      if (whole) completed.push({ quad: whole, area: polygonArea(whole), score: c.score, label: `${c.label}+`, completed: true });
    }
  };
  candidates.forEach(settle);
  completed.forEach(settle);
  candidates.push(...completed);
  if (debug) Object.assign(debug, { candidates: candidates.map((c) => ({ ...c })), grad, W, H });
  candidates = dropGroupsAndParts(candidates.filter((c) => c.rank > 0));

  // Keep the best candidate wherever several overlap.
  candidates.sort((a, b) => b.rank - a.rank);
  const kept = [];
  for (const c of candidates) if (!kept.some((k2) => overlap(k2.quad, c.quad) > 0.3)) kept.push(c);
  const quads = kept.map((c) => c.quad);
  return readingOrder(quads);
}
