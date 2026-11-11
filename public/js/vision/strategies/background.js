// Cards are whatever doesn't look like the table: the table's colours are learned from the photo's
// outer ring (cards rarely cover it), and every pixel far from all of them is "not table". Finds
// cards on light desks (where brightness alone sees nothing), wood and busy patterned cloth.

import { distanceTo, palette, percentile, ringSamples } from '../colour.js';

export function background({ cv, lab, W, H, pad, kernel, collect }) {
  const samples = ringSamples(lab.data, W, H);
  const colours = palette(samples, 6);
  const dist = distanceTo(lab.data, colours);
  // How far the table itself strays from its own colours: anything well beyond that is not table.
  const ringDist = distanceTo(Float32Array.from(samples), colours);
  const cut = Math.max(14, percentile(ringDist, 0.97) * 1.6);

  const mask = new cv.Mat(H + 2 * pad, W + 2 * pad, cv.CV_8UC1, new cv.Scalar(0));
  const bytes = mask.data;
  const stride = W + 2 * pad;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (dist[y * W + x] > cut) bytes[(y + pad) * stride + x + pad] = 255;
  }
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
  collect(mask, 'background');
  mask.delete();
}
