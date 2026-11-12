// Reads the text on a straightened card picture (from vision.js) with Tesseract OCR, in the browser:
// the name strip at the top and the set code + number line at the bottom left ("PAL EN 066/193").
// Small print is hard to read reliably, so each area is read a few different ways; the server
// (/api/identify) votes across the readings and checks them against the card database.

import { textBand } from './vision/textline.js';

let workerPromise = null;
let japaneseWorker = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the card reader'));
    document.head.append(s);
  });
}

/** One shared OCR worker (its English model is ~10 MB, cached by the browser after first use). */
function ocrWorker() {
  workerPromise ??= (async () => {
    if (!window.Tesseract) await loadScript('/vendor/tesseract/tesseract.min.js');
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/tessdata',
      gzip: true,
    });
    return { worker };
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

/** A second worker for Japanese names, loaded only when a Japanese card turns up (~2 MB model). */
function japaneseOcr() {
  japaneseWorker ??= (async () => {
    if (!window.Tesseract) await loadScript('/vendor/tesseract/tesseract.min.js');
    return window.Tesseract.createWorker('jpn', 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract-core',
      langPath: '/vendor/tessdata-jpn',
      gzip: true,
    });
  })().catch((err) => {
    japaneseWorker = null;
    throw err;
  });
  return japaneseWorker;
}

// Japanese cards print TCGdex's Japanese set id at the bottom left ("SV2a", "SV4a", "M1L", "SV-P").
const JAPANESE_CODE = /(?:^|[^A-Z0-9])[S5]V\d{1,2}[A-Z]?(?![A-Z0-9])|(?:^|[^A-Z0-9])M\d{1,2}[A-Z]?(?![A-Z0-9])|SV-P/i;
export const looksJapanese = (lines) => lines.some((l) => JAPANESE_CODE.test(l));

/**
 * Cut an area (fractions of the card) out, enlarge it and stretch its contrast; optionally invert
 * (for light text in a dark box) or threshold to pure black and white.
 */
function area(card, [x0, y0, x1, y1], { scale = 2, invert = false, binary = false } = {}) {
  const sw = (x1 - x0) * card.width;
  const sh = (y1 - y0) * card.height;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(card, x0 * card.width, y0 * card.height, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const lum = new Float32Array(d.length / 4);
  let lo = 255;
  let hi = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    lo = Math.min(lo, lum[p]);
    hi = Math.max(hi, lum[p]);
  }
  const range = Math.max(1, hi - lo);
  let threshold = 128;
  if (binary) {
    // Otsu: the cut between text and background that best separates the two.
    const hist = new Array(256).fill(0);
    for (const l of lum) hist[Math.round(((l - lo) / range) * 255)]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = lum.length - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
      if (between > best) {
        best = between;
        threshold = t;
      }
    }
  }
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = ((lum[p] - lo) / range) * 255;
    if (binary) v = v > threshold ? 255 : 0;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * The set line, found by its text inside a search window at the bottom left (fractions of the
 * card), instead of a fixed band: returns its area [x0, y0, x1, y1] as fractions.
 */
function locateSetLine(card, [x0, y0, x1, y1] = SET_SEARCH) {
  const W = Math.max(1, Math.round((x1 - x0) * card.width));
  const H = Math.max(1, Math.round((y1 - y0) * card.height));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(card, x0 * card.width, y0 * card.height, W, H, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const lineH = (SET_LINE[3] - SET_LINE[1]) * card.height;
  const expected = (((SET_LINE[1] + SET_LINE[3]) / 2) - y0) * card.height;
  const [top, bottom] = textBand(gray, W, H, { lineH, expected });
  return [x0, y0 + top / card.height, x1, y0 + bottom / card.height];
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SET_LINE = [0, 0.935, 0.42, 0.968];
const CODE_BOX = [0, 0.935, 0.25, 0.968];
const SET_SEARCH = [0, 0.905, 0.42, 0.99]; // where the set line can be, give or take the cut
const NAME_LINE = [0.13, 0.02, 0.74, 0.095];
const NAME_TIGHT = [0.15, 0.025, 0.6, 0.09];
const TRAINER_NAME = [0.04, 0.085, 0.74, 0.135]; // Trainer and Energy cards print the name lower

/** Read a straightened card. Returns { names: [...], lines: [...] } for /api/identify. */
let readQueue = Promise.resolve();
export function readCardText(card) {
  const task = readQueue.then(() => readCardTextNow(card));
  readQueue = task.catch(() => {});
  return task;
}

async function readCardTextNow(card) {
  const { worker } = await ocrWorker();
  const read = async (canvas, whitelist = '') => {
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist });
    const { data } = await worker.recognize(canvas);
    return data.text.trim();
  };
  const line = `${UPPER}${UPPER.toLowerCase()}0123456789/- `;
  const found = locateSetLine(card); // the set line where its text is (the fixed band can clip it)
  const lines = [
    await read(area(card, SET_LINE, { scale: 2 }), line),
    await read(area(card, SET_LINE, { scale: 3 }), line),
    await read(area(card, SET_LINE, { scale: 3, binary: true }), line),
    await read(area(card, found, { scale: 2 }), line),
    await read(area(card, found, { scale: 3, binary: true }), line),
    await read(area(card, CODE_BOX, { scale: 3, invert: true }), `${UPPER} `),
    await read(area(card, CODE_BOX, { scale: 3, invert: true, binary: true }), `${UPPER} `),
  ];
  const names = [
    await read(area(card, NAME_LINE, { scale: 1.5 })),
    await read(area(card, NAME_LINE, { scale: 2.5, binary: true })),
    await read(area(card, NAME_TIGHT, { scale: 2 })),
    await read(area(card, TRAINER_NAME, { scale: 1.5 })),
  ];
  // A Japanese card: read its name with the Japanese model too (the English readings are noise).
  if (looksJapanese(lines)) {
    try {
      const jp = await japaneseOcr();
      for (const opts of [{ scale: 2 }, { scale: 3, binary: true }]) {
        await jp.setParameters({ tessedit_pageseg_mode: '7' });
        const { data } = await jp.recognize(area(card, NAME_LINE, opts));
        names.unshift(data.text.replace(/\s+/g, '').trim());
      }
    } catch (err) {
      console.warn('Japanese reading unavailable:', err);
    }
  }
  return { names: names.filter(Boolean), lines: lines.filter(Boolean) };
}
