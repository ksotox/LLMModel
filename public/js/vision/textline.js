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
