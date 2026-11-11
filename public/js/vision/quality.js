// Is a cut-out card good enough to read? Blur, glare and size, measured on its pixels (plain
// arrays, no OpenCV), so a weak photo gets "Retake: blurry" instead of a silent bad reading.

/** Thresholds, tuned on bench:scan (sharp vs blurred vs glared synthetic cards and the reference photos). */
export const QUALITY_LIMITS = {
  sharpness: 60, // variance of the Laplacian on a 360 px wide copy; sharp cards score in the hundreds
  glare: 0.06, // share of the card that is blown-out white
  minWidth: 260, // the card's width in the original photo, in pixels (text needs about this many)
};

/**
 * { sharpness, glare, width, problems: ['blurry' | 'glare' | 'too small'] } for a card's pixels
 * ({ data: RGBA bytes, width, height }, ideally about 360 px wide). `sourceWidth` is the card's
 * width in the original photo.
 */
export function cardQuality(image, { sourceWidth = Infinity, limits = QUALITY_LIMITS } = {}) {
  const { data, width: W, height: H } = image;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  // Only the inside of the card: its rounded corners and edge are transparent or background.
  const mx = Math.round(W * 0.06);
  const my = Math.round(H * 0.06);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let blown = 0;
  for (let y = my; y < H - my; y++) {
    for (let x = mx; x < W - mx; x++) {
      const i = y * W + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W];
      sum += lap;
      sumSq += lap * lap;
      n++;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      if (Math.min(r, g, b) >= 248) blown++;
    }
  }
  const sharpness = n ? sumSq / n - (sum / n) ** 2 : 0;
  const glare = n ? blown / n : 0;
  const problems = [];
  if (sharpness < limits.sharpness) problems.push('blurry');
  if (glare > limits.glare) problems.push('glare');
  if (sourceWidth < limits.minWidth) problems.push('too small');
  return { sharpness: Math.round(sharpness), glare: Math.round(glare * 1000) / 1000, width: Math.round(sourceWidth), problems };
}

/** "Retake: blurry, glare" (or null when the card looks fine). */
export const retakeAdvice = (quality) => (quality?.problems?.length ? `Retake: ${quality.problems.join(', ')}` : null);
