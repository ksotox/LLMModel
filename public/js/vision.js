// Computer vision in the browser (OpenCV.js, served from this app): finds each card's four corners in
// a photo and straightens it, so the saved picture is just the card, without background.
// The pieces live in ./vision/ (see detect.js for the card finder's pipeline). Finding runs in a
// background worker (workers/vision.worker.js) so the page stays smooth, and falls back to the
// page itself where a module worker can't start.

import { connect } from './workers/rpc.js';
import { detectQuads } from './vision/detect.js';
import { loadOpenCV } from './vision/opencv.js';

export { loadOpenCV } from './vision/opencv.js';
export { orderCorners } from './vision/geometry.js';
export { CARD_W, warpCard } from './vision/warp.js';

const WORK_EDGE = 900; // detection runs on a downscaled copy this big

/** The photo's pixels, downscaled so its longer side is at most WORK_EDGE. */
function workingCopy(img) {
  const scale = Math.min(1, WORK_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale);
  const H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H);
}

let worker = null; // { call, close } once started; false when it can't be used
function visionWorker() {
  if (worker !== null) return worker;
  try {
    const w = new Worker(new URL('./workers/vision.worker.js', import.meta.url), { type: 'module' });
    worker = connect(w);
    w.addEventListener('error', () => { worker = false; });
  } catch {
    worker = false;
  }
  return worker;
}

/** Start loading the card finder in the background (e.g. when the Add page opens). */
export function warmUpCardFinder() {
  visionWorker()?.call?.('warm', {}).catch(() => {});
}

/**
 * Find the cards in a photo. Returns quads (4 corners each, in image pixels, TL/TR/BR/BL),
 * in reading order. Empty when nothing card-shaped was found. Options go to detectQuads;
 * `inPage: true` (or a `debug` object) runs it on the page instead of the worker.
 */
export async function findCards(img, { inPage = false, ...options } = {}) {
  const image = workingCopy(img);
  const sx = img.naturalWidth / image.width;
  const sy = img.naturalHeight / image.height;
  const scale = (quads) => quads.map((q) => q.map((p) => ({ x: p.x * sx, y: p.y * sy })));
  const w = inPage || options.debug ? false : visionWorker();
  if (w) {
    try {
      // The pixels are copied for the worker (not moved), so the page can retry with them.
      return scale(await w.call('detect', { image: { data: image.data, width: image.width, height: image.height }, options }, { timeout: 90000 }));
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      worker = false; // the worker failed (couldn't load, crashed): use the page from now on
    }
  }
  const { cv } = await loadOpenCV();
  return scale(detectQuads(cv, image, options));
}
