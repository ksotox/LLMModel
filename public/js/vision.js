// Computer vision in the browser (OpenCV.js, served from this app): finds each card's four corners in
// a photo and straightens it, so the saved picture is just the card, without background.
// The pieces live in ./vision/ (see detect.js for the card finder's pipeline).

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

/**
 * Find the cards in a photo. Returns quads (4 corners each, in image pixels, TL/TR/BR/BL),
 * in reading order. Empty when nothing card-shaped was found.
 */
export async function findCards(img, options = {}) {
  const image = workingCopy(img);
  const { cv } = await loadOpenCV();
  const sx = img.naturalWidth / image.width;
  const sy = img.naturalHeight / image.height;
  return detectQuads(cv, image, options).map((q) => q.map((p) => ({ x: p.x * sx, y: p.y * sy })));
}
