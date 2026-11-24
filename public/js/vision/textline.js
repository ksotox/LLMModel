// Finding a line of small print by its text, not by a fixed position: a fixed band (the set line is
// only ~3% of a card's height) clips the letters when the card was cut a pixel or two differently.
// Plain maths on grey values, so it runs anywhere and is unit-tested.

/**
 * How "texty" each row of a grey image (W × H, row-major) is: the summed left-right contrast
 * along the row. Text strokes give many strong changes; plain borders and backgrounds give few.
 */
export function rowEnergy(gray, W, H) {
  const out = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let e = 0;
    const row = y * W;
    for (let x = 1; x < W; x++) e += Math.abs(gray[row + x] - gray[row + x - 1]);
    out[y] = e;
  }
  return out;
}

/**
 * The band of `lineH` rows with the most text, as [top, bottom] rows, padded by `pad` × lineH on
 * each side (clamped to the image). When several bands are close in strength (within `near` of the
 * best), the one nearest `expected` (a row) wins: the set line sits between the illustrator line
 * and the copyright line, both smaller print.
 */
export function textBand(gray, W, H, { lineH, expected = H / 2, pad = 0.3, near = 0.85 } = {}) {
  const h = Math.max(2, Math.min(H, Math.round(lineH)));
  const e = rowEnergy(gray, W, H);
  const sums = [];
  let s = 0;
  for (let y = 0; y < H; y++) {
    s += e[y];
    if (y >= h) s -= e[y - h];
    if (y >= h - 1) sums.push({ top: y - h + 1, score: s });
  }
  if (!sums.length) return [0, H];
  const best = Math.max(...sums.map((b) => b.score));
  const pick = sums.filter((b) => b.score >= best * near)
    .sort((a, b) => Math.abs(a.top + h / 2 - expected) - Math.abs(b.top + h / 2 - expected))[0];
  const p = Math.round(h * pad);
  return [Math.max(0, pick.top - p), Math.min(H, pick.top + h + p)];
}

/**
 * Every line of text in a grey image, for a close-up photo where nothing says where the print is:
 * runs of rows with clearly more left–right contrast than most rows, each padded by `pad` × its height.
 * Returns up to `max` bands [{ top, bottom, energy }], strongest first. Bands taller than `maxShare`
 * of the image are a busy picture, not a line of print, and are left out.
 */
export function textBands(gray, W, H, { max = 8, minRows = 3, maxShare = 0.22, pad = 0.35, cut = 0.6 } = {}) {
  const e = rowEnergy(gray, W, H);
  const s = new Float32Array(H);
  for (let y = 0; y < H; y++) s[y] = (e[Math.max(0, y - 1)] + e[y] + e[Math.min(H - 1, y + 1)]) / 3;
  const sorted = [...s].sort((a, b) => a - b);
  const threshold = sorted[Math.min(H - 1, Math.floor(H * cut))];
  const bands = [];
  for (let y = 0; y < H;) {
    if (s[y] <= threshold) { y++; continue; }
    const top = y;
    let sum = 0;
    while (y < H && s[y] > threshold) sum += s[y++];
    const rows = y - top;
    if (rows >= minRows && rows <= H * maxShare) {
      const p = Math.round(rows * pad);
      bands.push({ top: Math.max(0, top - p), bottom: Math.min(H, y + p), energy: sum / rows });
    }
  }
  return bands.sort((a, b) => b.energy - a.energy).slice(0, max);
}
