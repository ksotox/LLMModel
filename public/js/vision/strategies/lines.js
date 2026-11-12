// Cards as four straight edges (see ../lines.js): for busy patterned cloth, sleeves and blur, where
// the card's outline merges with whatever touches it. The straight edges themselves are found once
// per photo (straightEdges) and also used to straighten every other strategy's outlines.

import { mergeSegments, rectanglesFromLines } from '../lines.js';

/** The photo's long straight edges, in lightness and in colour, merged into lines. */
export function straightEdges({ cv, lab, W, H }) {
  // Colour counts too: a silver border against a blue cloth of the same brightness.
  const blurred = new cv.Mat();
  cv.GaussianBlur(lab, blurred, new cv.Size(5, 5), 0);
  const channels = new cv.MatVector();
  cv.split(blurred, channels);
  const edges = new cv.Mat();
  const one = new cv.Mat();
  for (let c = 0; c < 3; c++) {
    const ch = channels.get(c);
    cv.Canny(ch, c ? one : edges, c ? 20 : 30, c ? 60 : 90);
    if (c) cv.bitwise_or(edges, one, edges);
    ch.delete();
  }
  const found = new cv.Mat();
  const short = Math.min(W, H);
  cv.HoughLinesP(edges, found, 1, Math.PI / 360, 40, short * 0.1, 4);
  const segments = [];
  for (let i = 0; i < found.rows; i++) {
    const [x1, y1, x2, y2] = found.data32S.subarray(i * 4, i * 4 + 4);
    segments.push({ x1, y1, x2, y2 });
  }
  for (const m of [blurred, channels, edges, one, found]) m.delete();
  return mergeSegments(segments).filter((l) => l.length > short * 0.08);
}

export function lines({ straight, W, H, add }) {
  const short = Math.min(W, H);
  for (const r of rectanglesFromLines(straight(), { W, H, minSide: short * 0.12, maxSide: Math.max(W, H) })) {
    add({ ...r, label: 'lines' });
  }
}
