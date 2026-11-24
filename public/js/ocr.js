// Reads the text on a straightened card picture (from vision.js) with Tesseract OCR, in the browser:
// the name strip at the top and the set code + number line at the bottom left ("PAL EN 066/193").
// Small print is hard to read reliably, so each area is read a few different ways; the server
// (/api/identify) votes across the readings and checks them against the card database.

import { textBand, textBands } from './vision/textline.js';

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
 * Cut an area (fractions of the card) out, enlarge it and stretch its contrast; optionally sharpen
 * (an unsharp mask: blurry photos of small print), invert (light text in a dark box) or threshold to
 * pure black and white.
 */
function area(card, [x0, y0, x1, y1], { scale = 2, invert = false, binary = false, sharpen = false } = {}) {
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
  if (sharpen) {
    // Unsharp mask on the brightness: add back the difference from a 3×3 blur. Edges of the blurred
    // digits get steeper, so "8" and "6", "0" and "9" come apart.
    const W = c.width;
    const H = c.height;
    const out = new Float32Array(lum.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) { sum += lum[yy * W + Math.min(W - 1, Math.max(0, x + dx))]; n++; }
        }
        const p = y * W + x;
        out[p] = lum[p] + 1.2 * (lum[p] - sum / n);
      }
    }
    lo = 255;
    hi = 0;
    for (let p = 0; p < lum.length; p++) { lum[p] = Math.min(255, Math.max(0, out[p])); lo = Math.min(lo, lum[p]); hi = Math.max(hi, lum[p]); }
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
 * A line of print found by its text inside a search window ([x0, y0, x1, y1], fractions of the card)
 * instead of a fixed band: the `lineH`-tall band (share of the card's height) with the most text,
 * preferring one near `expectedY`. Returns its area [x0, y0, x1, y1] as fractions.
 */
function locateLine(card, [x0, y0, x1, y1], lineH, expectedY) {
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
  const [top, bottom] = textBand(gray, W, H, { lineH: lineH * card.height, expected: (expectedY - y0) * card.height });
  return [x0, y0 + top / card.height, x1, y0 + bottom / card.height];
}
const locateSetLine = (card) => locateLine(card, SET_SEARCH, SET_LINE[3] - SET_LINE[1], (SET_LINE[1] + SET_LINE[3]) / 2);

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SET_LINE = [0, 0.935, 0.42, 0.968];
const CODE_BOX = [0, 0.935, 0.25, 0.968];
const SET_SEARCH = [0, 0.905, 0.42, 0.99]; // where the set line can be, give or take the cut
const NAME_LINE = [0.13, 0.02, 0.74, 0.095];
// Old-layout (Base-set style) cards, also reprinted in the Classic Collections: the name starts at
// the left edge under a small "Basic Pokémon", and the number ("58/102") is at the bottom right.
const OLD_NAME_SEARCH = [0.08, 0.035, 0.62, 0.155];
const NUMBER_RIGHT_SEARCH = [0.72, 0.905, 0.94, 0.975];
const NAME_TIGHT = [0.15, 0.025, 0.6, 0.09];
const TRAINER_NAME = [0.04, 0.085, 0.74, 0.135]; // Trainer and Energy cards print the name lower

/**
 * Read a straightened card. Returns { names: [...], lines: [...] } for /api/identify. `quick`: a
 * first, short pass (the sharpest reads of the set line and name); when it identifies the card
 * surely, the full set of reads isn't needed.
 */
let readQueue = Promise.resolve();
export function readCardText(card, { quick = false } = {}) {
  const task = readQueue.then(() => (quick ? readCardTextQuick(card) : readCardTextNow(card)));
  readQueue = task.catch(() => {});
  return task;
}

const LINE_CHARS = `${UPPER}${UPPER.toLowerCase()}0123456789/- `;
// The code box: letters, and digits for codes like 30C.
const CODE_CHARS = `${UPPER}0123456789 `;

async function reader() {
  const { worker } = await ocrWorker();
  return async (canvas, whitelist = '', psm = '7') => {
    await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist });
    const { data } = await worker.recognize(canvas);
    return data.text.trim();
  };
}

async function readCardTextQuick(card) {
  const read = await reader();
  const found = locateSetLine(card);
  const lines = [
    await read(area(card, found, { scale: 3, sharpen: true }), LINE_CHARS),
    await read(area(card, SET_LINE, { scale: 3, sharpen: true, binary: true }), LINE_CHARS),
    await read(area(card, CODE_BOX, { scale: 3, invert: true }), CODE_CHARS),
  ];
  const names = [
    await read(area(card, NAME_LINE, { scale: 1.5 })),
    await read(area(card, NAME_TIGHT, { scale: 2 })),
  ];
  return { names: names.filter(Boolean), lines: lines.filter(Boolean) };
}

async function readCardTextNow(card) {
  const read = await reader();
  const line = LINE_CHARS;
  const found = locateSetLine(card); // the set line where its text is (the fixed band can clip it)
  const lines = [
    await read(area(card, SET_LINE, { scale: 2 }), line),
    await read(area(card, SET_LINE, { scale: 3, sharpen: true }), line),
    await read(area(card, SET_LINE, { scale: 3, binary: true }), line),
    await read(area(card, found, { scale: 2 }), line),
    await read(area(card, found, { scale: 3, binary: true }), line),
    await read(area(card, found, { scale: 4, sharpen: true, binary: true }), line),
    await read(area(card, CODE_BOX, { scale: 3, invert: true }), CODE_CHARS),
    await read(area(card, CODE_BOX, { scale: 3, invert: true, binary: true }), CODE_CHARS),
  ];
  // Only a whole "58/102" from the bottom right counts: stray digits there are holo sparkle.
  const oldNumber = await read(area(card, locateLine(card, NUMBER_RIGHT_SEARCH, 0.02, 0.937), { scale: 4, sharpen: true }), '0123456789/ ');
  if (/\d+\s*\/\s*\d+/.test(oldNumber)) lines.push(oldNumber);
  const names = [
    await read(area(card, NAME_LINE, { scale: 1.5 })),
    await read(area(card, NAME_LINE, { scale: 2.5, binary: true })),
    await read(area(card, NAME_TIGHT, { scale: 2 })),
    await read(area(card, TRAINER_NAME, { scale: 1.5 })),
    await read(area(card, locateLine(card, OLD_NAME_SEARCH, 0.04, 0.1), { scale: 2 })),
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

/**
 * A close-up photo (the card's bottom corner, or a card filling the frame with no edges in view):
 * nothing says where the print is, so the photo's lines of text are found first (vision/textline.js
 * textBands) and each is read on its own, enlarged to a good size and sharpened.
 * Returns { names, lines } for /api/identify: lines with digits or capitals go in as set lines, and
 * short capitalised words that aren't the card's own labels as possible names (often none: a corner
 * close-up shows no name, so the caller also identifies it by code and number alone).
 */
const CARD_WORDS = /^(weakness|resistance|retreat|illus|ability|basic|stage|evolves|pokemon|pokémon|nintendo|creatures|game|freak|from|the|and)$/i;
export function readCloseUp(img) {
  const task = readQueue.then(async () => {
    const read = await reader();
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    const k = Math.min(1, 1600 / Math.max(W, H));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k));
    c.height = Math.max(1, Math.round(H * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const gray = new Float32Array(c.width * c.height);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const texts = [];
    for (const [i, band] of textBands(gray, c.width, c.height, { max: 8, cut: 0.72, pad: 0.2 }).entries()) {
      const rows = band.bottom - band.top;
      const scale = Math.min(4, Math.max(1, 48 / rows)); // about 48 px of line height for Tesseract
      const box = [0, band.top / c.height, 1, band.bottom / c.height];
      texts.push(await read(area(c, box, { scale, sharpen: true }), LINE_CHARS));
      if (i < 4) {
        // The left part alone: on modern cards the set code and number sit at the bottom left, and
        // the flavour text beside them throws the whole-line read off. A band can hold two lines
        // ("Illus." above the number), so these are read as a block. Plain enlargement reads the
        // boxed code best; a sharpened read helps blurred digits.
        const big = Math.max(1.5, scale);
        texts.push(...(await read(area(c, [0, box[1], 0.55, box[3]], { scale: big }), LINE_CHARS, '6')).split(/\n+/));
        texts.push(...(await read(area(c, [0, box[1], 0.55, box[3]], { scale: big, sharpen: true }), LINE_CHARS, '6')).split(/\n+/));
        texts.push(...(await read(area(c, [0, box[1], 0.34, box[3]], { scale: big }), CODE_CHARS, '6')).split(/\n+/));
      }
    }
    // The copyright line ("©2023 Pokémon / Nintendo / Creatures / GAME FREAK", often cut off: its year
    // gives it away) and the illustrator's ("Illus. sui") read like set codes (CRE, POR, SVI…).
    const all = texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length >= 2 && !/nintendo|creatures|game ?freak|pok[eé]mon ?\/|©|(19[89]\d|20[0-3]\d)(?!\d)|(?:^|\W)\w{0,2}[lI1|][uo]s(?=[\s.Y]|$)/i.test(t));
    const lines = all.filter((t) => /\d/.test(t) || /\b[A-Z0-9]{2,4}\b/.test(t)).slice(0, 12);
    const names = all.flatMap((t) => t.split(' ')).filter((w) => /^[A-Z][a-zé'.-]{2,13}$/.test(w) && !CARD_WORDS.test(w)).slice(0, 12);
    return { names, lines };
  });
  readQueue = task.catch(() => {});
  return task;
}
