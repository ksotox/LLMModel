// Client-side image helpers: decoding uploads, outlines (4-corner "quads") and saving pictures.

import { findCards, warpCard } from './vision.js';

const MAX_SAVE_EDGE = 1800;

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(Object.assign(img, { objectUrl: url }));
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read "${file.name}". Try a JPEG or PNG photo.`));
    };
    img.src = url;
  });
}

/**
 * Encode a canvas. Card cut-outs keep their transparent rounded corners as WebP (or PNG where the
 * browser can't write WebP); everything else is JPEG.
 */
export function canvasToBlob(canvas, name, { transparent = false } = {}) {
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  return (async () => {
    let blob = transparent ? await encode('image/webp', 0.9) : await encode('image/jpeg', 0.9);
    if (transparent && blob?.type !== 'image/webp') blob = await encode('image/png');
    if (!blob) throw new Error('Could not encode image');
    const ext = { 'image/webp': '.webp', 'image/png': '.png' }[blob.type] ?? '.jpg';
    return Object.assign(blob, { name: name.replace(/\.\w+$/, '') + ext });
  })();
}

/** The whole photo as a quad (top-left, top-right, bottom-right, bottom-left). */
export function wholeQuad(img) {
  const w = img.naturalWidth;
  const hgt = img.naturalHeight;
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: hgt }, { x: 0, y: hgt }];
}

/** Split a photo evenly into cols × rows quads, with a small inset so neighbours don't bleed in. */
export function gridQuads(img, cols, rows, inset = 0.02) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const quads = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cw = W / cols;
      const ch = H / rows;
      const x0 = c * cw + cw * inset;
      const y0 = r * ch + ch * inset;
      const x1 = (c + 1) * cw - cw * inset;
      const y1 = (r + 1) * ch - ch * inset;
      quads.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
    }
  }
  return quads;
}

const side = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Find the cards in a photo; falls back to the whole photo when nothing card-shaped is found. */
export async function cardQuads(img) {
  try {
    const quads = await findCards(img);
    if (quads.length) return { quads, detected: true };
  } catch (err) {
    console.warn('Card detection unavailable:', err);
  }
  return { quads: [wholeQuad(img)], detected: false };
}

/**
 * Cut one card out of a photo along its quad, straightened, with transparent rounded corners.
 * Returns { canvas, blob }. The canvas is kept for reading the card's text.
 */
export async function cutCard(img, quad, name = 'card') {
  const width = Math.min(1100, Math.max(734, (side(quad[0], quad[1]) + side(quad[3], quad[2])) / 2));
  const canvas = await warpCard(img, quad, { width });
  return { canvas, blob: await canvasToBlob(canvas, name, { transparent: true }) };
}

/** Cut any rectangle-ish region (e.g. a pack) out along its quad, keeping its own proportions. */
export async function cutRegion(img, quad, name = 'photo.jpg') {
  const w = (side(quad[0], quad[1]) + side(quad[3], quad[2])) / 2;
  const hgt = (side(quad[0], quad[3]) + side(quad[1], quad[2])) / 2;
  const scale = Math.min(1, MAX_SAVE_EDGE / Math.max(w, hgt));
  const canvas = await warpCard(img, quad, { width: w * scale, aspect: w / hgt, rounded: false, grow: 0 });
  return canvasToBlob(canvas, name);
}

/** Scale a whole photo down for saving (used for pack photos and when detection isn't wanted). */
export function cropToBlob(img, name = 'photo.jpg') {
  const scale = Math.min(1, MAX_SAVE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, name);
}
