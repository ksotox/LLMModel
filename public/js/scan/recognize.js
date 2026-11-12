import { api } from '../api.js';
import { readCardText } from '../ocr.js';
import { warpCard } from '../vision.js';
import { canvasToBlob } from '../images.js';
const score = (r) => ({ high: 3, medium: 2, low: 1 })[r?.confidence] ?? 0;

/** OCR retries use the same full-resolution source; enlargement alone creates no new detail. */
export async function recognizeCut(cut, img, quad, cancelled = () => false) {
  let readings = await readCardText(cut.canvas);
  let result = await api.identify(readings);
  let canvas = cut.canvas;
  const attempts = [{ confidence: result.confidence, readings, orientation: 0, grow: .004 }];
  for (const grow of [.008, 0]) {
    if (score(result) >= 3 || cancelled()) break;
    const retryCanvas = await warpCard(img, quad, { grow, width: cut.canvas.width });
    const retryText = await readCardText(retryCanvas);
    const retry = await api.identify(retryText);
    attempts.push({ confidence: retry.confidence, readings: retryText, orientation: 0, grow });
    if (score(retry) > score(result)) { result = retry; readings = retryText; canvas = retryCanvas; }
  }
  if (score(result) < 3 && !cancelled()) {
    const flipped = document.createElement('canvas'); flipped.width = cut.canvas.width; flipped.height = cut.canvas.height;
    const ctx = flipped.getContext('2d'); ctx.translate(flipped.width, flipped.height); ctx.rotate(Math.PI); ctx.drawImage(cut.canvas, 0, 0);
    const retryText = await readCardText(flipped);
    const retry = await api.identify(retryText);
    attempts.push({ confidence: retry.confidence, readings: retryText, orientation: 180, grow: .004 });
    if (score(retry) > score(result)) { result = retry; readings = retryText; canvas = flipped; }
  }
  return { result, readings, attempts, canvas, blob: canvas === cut.canvas ? cut.blob : await canvasToBlob(canvas, 'scan-card', { transparent: true }) };
}
