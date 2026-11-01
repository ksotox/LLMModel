// Foil detection on a cut-out, straightened card (ImageData-like { data, width, height }), for the
// variant suggestion. Two ways:
//
//  1. One photo: compare the art box with the body around it (the text area below the art).
//     Foil has a fine sparkle/pattern texture; printed ink is smooth. A textured body next to the
//     art means reverse holo, a smooth one means normal (or holo, which needs a tilt scan to tell).
//     Glossy cards can catch glare, so the answer is a probability, never certain.
//  2. Tilt scan: 2–3 photos of the same card at different angles. Foil changes brightness a lot
//     between angles, ink barely does, so this tells reverse holo, holo and normal apart reliably.
//
// Thresholds were calibrated on the reference photos in docs/reference (normal Voltorb, Punk
// Helmet and Linoone, a reverse holo Voltorb and a full-foil promo), measured at 360 px wide.

// Regions as fractions of the card [x0, y0, x1, y1] (modern layout: art box in the upper half).
export const REGIONS = {
  art: [0.08, 0.11, 0.92, 0.48],
  body: [0.07, 0.53, 0.93, 0.86],
};
const WIDTH = 360;
const BLOCK = 8;

/** Average-down to a fixed width so close-ups and group photos are measured alike: { lum, rgb, w, h }. */
export function normalise({ data, width, height }, w = WIDTH) {
  const h = Math.max(1, Math.round((w * height) / width));
  const lum = new Float32Array(w * h);
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          if (data[i + 3] < 128) continue; // transparent rounded corners
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = y * w + x;
      if (n) { r /= n * 255; g /= n * 255; b /= n * 255; }
      rgb[o * 3] = r; rgb[o * 3 + 1] = g; rgb[o * 3 + 2] = b;
      lum[o] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return { lum, rgb, w, h };
}

/** Box blur (radius r) of a w×h array, via a summed-area table. */
function blur(src, w, h, r) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r); const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r); const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

const median = (values) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The median, over 8×8 blocks of plain background in a region, of a per-pixel value. Blocks with
 * printed ink (dark pixels) or blown-out glare are skipped, so text and reflections don't count.
 */
function regionMedian(values, lum, w, h, [rx0, ry0, rx1, ry1]) {
  const x0 = Math.round(rx0 * w); const x1 = Math.round(rx1 * w);
  const y0 = Math.round(ry0 * h); const y1 = Math.round(ry1 * h);
  const blocks = [];
  for (let by = y0; by + BLOCK <= y1; by += BLOCK) {
    for (let bx = x0; bx + BLOCK <= x1; bx += BLOCK) {
      let sum = 0; let n = 0; let ink = 0; let glare = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const l = lum[y * w + x];
          if (l <= 0.45) { ink++; continue; }
          if (l > 0.93) glare++;
          sum += values[y * w + x]; n++;
        }
      }
      if (ink > BLOCK * BLOCK * 0.15 || glare > BLOCK * BLOCK * 0.5 || !n) continue;
      blocks.push(sum / n);
    }
  }
  return { value: median(blocks), blocks: blocks.length };
}

/** Fine texture (sparkle) of the art box and of the body, from one photo. */
export function analyseCard(image) {
  const { lum, w, h } = normalise(image);
  const smooth = blur(lum, w, h, 2);
  const detail = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) detail[i] = Math.abs(lum[i] - smooth[i]);
  const art = regionMedian(detail, lum, w, h, REGIONS.art);
  const body = regionMedian(detail, lum, w, h, REGIONS.body);
  return { art: art.value, body: body.value, ratio: art.value ? body.value / art.value : 0, blocks: { art: art.blocks, body: body.blocks } };
}

/**
 * How much each region changes between photos taken at different angles (tilt scan). Each photo
 * is evened out for overall brightness and slightly blurred, so a small misalignment between the
 * cut-outs doesn't count as change.
 */
export function compareAngles(images) {
  if (images.length < 2) throw new Error('A tilt scan needs at least two photos');
  const frames = images.map((img) => normalise(img));
  const { w, h } = frames[0];
  const prepared = frames.map((f) => {
    if (f.w !== w || f.h !== h) throw new Error('Tilt photos must be cut out at the same size');
    const level = median(Array.from(f.lum).filter((_, i) => i % 7 === 0)) || 1;
    const even = f.lum.map((v) => v / level);
    return blur(even, w, h, 2);
  });
  const change = new Float32Array(w * h);
  for (let a = 0; a < prepared.length; a++) {
    for (let b = a + 1; b < prepared.length; b++) {
      for (let i = 0; i < change.length; i++) change[i] = Math.max(change[i], Math.abs(prepared[a][i] - prepared[b][i]));
    }
  }
  const lum = frames[0].lum;
  return {
    art: regionMedian(change, lum, w, h, REGIONS.art).value,
    body: regionMedian(change, lum, w, h, REGIONS.body).value,
  };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Chance the body is foil, from one photo (calibrated: normal ≈ 0.004 / ratio ≈ 0.35, reverse ≈ 0.012 / ≈ 0.95). */
export function bodyFoilFromPhoto({ body, ratio }) {
  const absolute = Math.log(Math.max(body, 1e-5) / 0.0073) / Math.log(0.012 / 0.0073);
  const relative = (ratio - 0.65) / 0.3;
  return sigmoid(clamp((absolute + relative) / 2, -4, 4) * 2);
}

/** Chances the body and the art are foil, from a tilt scan (foil changes ≳ 0.12, ink ≲ 0.04). */
export function foilFromAngles({ art, body }) {
  const p = (change) => sigmoid((change - 0.07) / 0.015);
  return { body: p(body), art: p(art) };
}

const LABELS = { normal: 'Normal', 'reverse-holo': 'Reverse holo', holo: 'Holo', 'full-art': 'Full art', promo: 'Promo' };

/**
 * The suggested variant: { variant, confidence (0–1), method, reasons[], needsTilt }.
 * `printings` (from /api/catalog/cards/:id/printings) rules out what the card was never printed as.
 */
export function suggestVariant({ printings = null, photo = null, angles = null }) {
  if (printings?.fixed) {
    return { variant: printings.fixed, confidence: 0.99, method: 'printings', reasons: [printings.reason], needsTilt: false };
  }
  const candidates = printings?.allowed?.length ? printings.allowed : ['normal', 'reverse-holo', 'holo', 'full-art'];
  let bodyFoil = null;
  let artFoil = null;
  const reasons = [];
  if (angles) {
    ({ body: bodyFoil, art: artFoil } = foilFromAngles(angles));
    reasons.push(bodyFoil > 0.5 ? 'Around the attacks, the shine changed as the card tilted (foil).' : 'Around the attacks, the shine stayed the same as the card tilted (printed ink).');
    reasons.push(artFoil > 0.5 ? 'The artwork’s shine changed too (foil).' : 'The artwork stayed the same (no foil).');
  } else if (photo) {
    bodyFoil = bodyFoilFromPhoto(photo);
    reasons.push(bodyFoil > 0.5 ? 'The area around the attacks has a foil texture.' : 'The area around the attacks looks smooth, like plain printing.');
    if (photo.body > 0.02 && photo.ratio > 1.5) reasons.push('The whole card looks foil.');
  }
  if (bodyFoil == null) return null;

  // One photo: a card that is foil all over (body far more textured than any printed art) is full art.
  const allOver = artFoil == null && photo?.body > 0.02 && photo?.ratio > 1.5;
  const score = {
    normal: (1 - bodyFoil) * (artFoil == null ? 1 : 1 - artFoil),
    'reverse-holo': bodyFoil * (artFoil == null ? (allOver ? 0.3 : 1) : 1 - artFoil),
    holo: (1 - bodyFoil) * (artFoil == null ? 1 : artFoil),
    'full-art': bodyFoil * (artFoil == null ? (allOver ? 1 : 0.15) : artFoil),
  };
  const options = candidates.filter((c) => c in score);
  if (!options.length) return null;
  const total = options.reduce((s, c) => s + score[c], 0) || 1;
  const ranked = options.map((c) => [c, score[c] / total]).sort((a, b) => b[1] - a[1]);
  const [variant, share] = ranked[0];
  // One photo can be fooled by glare: never more than 85% sure without a tilt scan.
  const confidence = Math.min(share, angles ? 0.97 : 0.85);
  const tie = ranked[1] && Math.abs(ranked[1][1] - share) < 0.05;
  if (tie) reasons.push(`${LABELS[ranked[0][0]]} and ${LABELS[ranked[1][0]].toLowerCase()} look alike in one photo: a tilt scan tells them apart.`);
  return { variant, confidence, method: angles ? 'tilt' : 'photo', reasons, needsTilt: !angles && (confidence < 0.8 || tie) };
}

export { LABELS as VARIANT_NAMES };
