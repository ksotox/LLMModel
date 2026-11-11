// Colour helpers for the card finder: the photo in Lab colour space, the table's colours learned from
// the photo's outer ring, and how far each pixel is from them. Plain arrays, no OpenCV, so the maths
// is unit-testable; the RGB → Lab conversion itself is done with OpenCV by the caller.

/**
 * A few representative colours of `samples` (a flat [L, a, b, L, a, b, …] array) by k-means with a
 * deterministic start (farthest-point seeding from the first sample), so results never vary.
 */
export function palette(samples, k = 5, rounds = 8) {
  const n = samples.length / 3;
  if (!n) return [];
  const at = (i) => [samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]];
  const d2 = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  const centres = [at(0)];
  const near = new Float64Array(n).fill(Infinity);
  while (centres.length < Math.min(k, n)) {
    let far = 0;
    for (let i = 0; i < n; i++) {
      near[i] = Math.min(near[i], d2(at(i), centres[centres.length - 1]));
      if (near[i] > near[far]) far = i;
    }
    if (near[far] === 0) break; // fewer distinct colours than k
    centres.push(at(far));
  }
  const label = new Int32Array(n);
  for (let r = 0; r < rounds; r++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const p = at(i);
      let best = 0;
      for (let c = 1; c < centres.length; c++) if (d2(p, centres[c]) < d2(p, centres[best])) best = c;
      label[i] = best;
      sum[best][0] += p[0]; sum[best][1] += p[1]; sum[best][2] += p[2]; sum[best][3]++;
    }
    sum.forEach((s, c) => { if (s[3]) centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  // Drop colours that only a stray sample or two belong to (a card touching the photo's edge).
  const counts = centres.map(() => 0);
  for (let i = 0; i < n; i++) counts[label[i]]++;
  const kept = centres.filter((_, c) => counts[c] >= n * 0.03);
  return kept.length ? kept : centres;
}

/**
 * Distance of each pixel of an 8-bit Lab image (OpenCV layout: 3 bytes a pixel, L scaled to 0–255,
 * a and b offset by 128) to the nearest of `colours`. Lightness counts for less than colour, so
 * shadows and uneven light on the table stay close to the table. Returns a Float32Array.
 */
export function distanceTo(lab, colours, { lightWeight = 0.35 } = {}) {
  const n = lab.length / 3;
  const out = new Float32Array(n);
  const w = lightWeight * lightWeight;
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3];
    const a = lab[i * 3 + 1];
    const b = lab[i * 3 + 2];
    let best = Infinity;
    for (const c of colours) {
      const d = w * (L - c[0]) ** 2 + (a - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < best) best = d;
    }
    out[i] = Math.sqrt(best);
  }
  return out;
}

/** The pixels in the photo's outer ring (`ring` = fraction of the shorter side), every `step`th. */
export function ringSamples(lab, W, H, { ring = 0.03, step = 3 } = {}) {
  const r = Math.max(2, Math.round(Math.min(W, H) * ring));
  const out = [];
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (x >= r && x < W - r && y >= r && y < H - r) continue;
      const i = (y * W + x) * 3;
      out.push(lab[i], lab[i + 1], lab[i + 2]);
    }
  }
  return out;
}

/** The value below which `share` of the values lie. */
export function percentile(values, share) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}
