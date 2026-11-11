// The card finder's pipeline: every strategy proposes outlines, the best non-overlapping ones are
// kept, then each is snapped onto the card's real edges. Works on raw RGBA pixels with the OpenCV
// module passed in, so it runs in the page, in a Web Worker, and in Node.

import { bbox, overlap, readingOrder } from './geometry.js';
import { collectCandidates } from './contours.js';
import { snapToEdges } from './snap.js';
import { brightness } from './strategies/brightness.js';
import { edges } from './strategies/edges.js';

export const STRATEGIES = { brightness, edges };
const DEFAULT_STRATEGIES = ['brightness', 'edges'];

/** Gradient strength of a grey image, as a Float32Array (row-major, W × H). */
function gradient(cv, gray) {
  const smooth = new cv.Mat();
  cv.GaussianBlur(gray, smooth, new cv.Size(3, 3), 0);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(smooth, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(smooth, gy, cv.CV_32F, 0, 1, 3);
  const grad = new Float32Array(gray.cols * gray.rows);
  for (let i = 0; i < grad.length; i++) grad[i] = Math.hypot(gx.data32F[i], gy.data32F[i]);
  for (const m of [smooth, gx, gy]) m.delete();
  return grad;
}

/**
 * Find the cards in an image ({ data: RGBA bytes, width, height }, already downscaled for speed).
 * Returns quads in that image's pixels (TL/TR/BR/BL), in reading order. Empty when nothing
 * card-shaped was found. `strategies` names the ways of finding outlines to use.
 */
export function detectQuads(cv, image, { strategies = DEFAULT_STRATEGIES } = {}) {
  const W = image.width;
  const H = image.height;
  const pad = 12;
  const src = cv.matFromImageData(image);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
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
    cv, src, gray, padded, blurred, kernel, pad, W, H,
    collect: (binary, label) => collectCandidates(cv, binary, { ...limits, label }, candidates),
  };
  let grad;
  try {
    for (const name of strategies) STRATEGIES[name](prep);
    grad = gradient(cv, gray);
  } finally {
    for (const m of [src, gray, padded, blurred, kernel]) m.delete();
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

  // Keep the best candidate wherever several overlap.
  candidates.sort((a, b) => b.score * Math.sqrt(b.area) - a.score * Math.sqrt(a.area));
  const kept = [];
  for (const c of candidates) if (!kept.some((k2) => overlap(k2.quad, c.quad) > 0.3)) kept.push(c);

  const quads = kept.map((c) => snapToEdges(c.quad, grad, W, H)
    .map((p) => ({ x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y)) })));
  return readingOrder(quads);
}
