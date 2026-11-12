// Straightening a card (or any 4-corner region) out of a photo. Runs in the page.

import { CARD_ASPECT, dist } from './geometry.js';
import { loadOpenCV } from './opencv.js';

export const CARD_W = 734;

/**
 * Cut a region out along its 4 corners and straighten it. For cards (the default) the result is a
 * portrait 63:88 picture with transparent rounded corners; `grow` pushes the corners outwards a
 * little so the card's own edge is never cut off.
 */
export async function warpCard(img, quad, { grow = 0.004, width = CARD_W, aspect = CARD_ASPECT, rounded = true, portrait = rounded } = {}) {
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round(width / aspect));
  const { cv } = await loadOpenCV();
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  const pts = quad.map((p) => ({ x: p.x + (p.x - c.x) * grow * 2, y: p.y + (p.y - c.y) * grow * 2 }));
  const [tl, tr, br, bl] = pts;
  const landscape = (dist(tl, tr) + dist(bl, br)) > (dist(tl, bl) + dist(tr, br));
  // A card photographed sideways: rotate the corner order so the output is portrait.
  const ordered = portrait && landscape ? [bl, tl, tr, br] : [tl, tr, br, bl];

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const src = cv.imread(canvas);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(from, to);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_AREA, cv.BORDER_REPLICATE, new cv.Scalar());
  const flat = document.createElement('canvas');
  flat.width = outW;
  flat.height = outH;
  cv.imshow(flat, dst);
  for (const m of [src, from, to, M, dst]) m.delete();
  if (!rounded) return flat;

  // Real cards have rounded corners: make the corners transparent so no table shows through.
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(0, 0, outW, outH, outW * 0.045);
  ctx.clip();
  ctx.drawImage(flat, 0, 0);
  return out;
}
