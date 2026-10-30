// Reads the text on a straightened card picture (from vision.js) with Tesseract OCR, in the browser:
// the name strip at the top and the set code + number line at the bottom left ("PAL EN 066/193").
// Small print is hard to read reliably, so each area is read a few different ways; the server
// (/api/identify) votes across the readings and checks them against the card database.

let workerPromise = null;

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

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SET_LINE = [0, 0.935, 0.42, 0.968];
const CODE_BOX = [0, 0.935, 0.25, 0.968];
const NAME_LINE = [0.13, 0.02, 0.74, 0.095];
const NAME_TIGHT = [0.15, 0.025, 0.6, 0.09];
const TRAINER_NAME = [0.04, 0.085, 0.74, 0.135]; // Trainer and Energy cards print the name lower

/** Read a straightened card. Returns { names: [...], lines: [...] } for /api/identify. */
export async function readCardText(card) {
  const { worker } = await ocrWorker();
  const read = async (canvas, whitelist = '') => {
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist });
    const { data } = await worker.recognize(canvas);
    return data.text.trim();
  };
  const line = `${UPPER}0123456789/ `;
  const lines = [
    await read(area(card, SET_LINE, { scale: 2 }), line),
    await read(area(card, SET_LINE, { scale: 3 }), line),
    await read(area(card, SET_LINE, { scale: 3, binary: true }), line),
    await read(area(card, CODE_BOX, { scale: 3, invert: true }), `${UPPER} `),
    await read(area(card, CODE_BOX, { scale: 3, invert: true, binary: true }), `${UPPER} `),
  ];
  const names = [
    await read(area(card, NAME_LINE, { scale: 1.5 })),
    await read(area(card, NAME_LINE, { scale: 2.5, binary: true })),
    await read(area(card, NAME_TIGHT, { scale: 2 })),
    await read(area(card, TRAINER_NAME, { scale: 1.5 })),
  ];
  return { names: names.filter(Boolean), lines: lines.filter(Boolean) };
}
