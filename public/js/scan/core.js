// Pure scanner decisions. Similar artwork never proves that there is another physical copy.
export function hashPixels({ data, width, height }) {
  const gray = (x, y) => { const i = (y * width + x) * 4; return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114; };
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const yy = Math.min(height - 1, Math.floor((y + .5) * height / 8));
    bits += gray(Math.floor(x * width / 9), yy) > gray(Math.floor((x + 1) * width / 9), yy) ? '1' : '0';
  }
  return bits;
}
export const hashDistance = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === 64 && b.length === 64
  ? [...a].reduce((n, v, i) => n + (v !== b[i]), 0) : 64;
export function rankImages(hash, candidates) {
  return candidates.map((c) => ({ ...c, distance: hashDistance(hash, c.hash) })).sort((a, b) => a.distance - b.distance);
}
export function imageEvidence(ranked) {
  if (!ranked.length || ranked[0].distance > 10) return 'unavailable';
  if (ranked.length > 1 && ranked[1].distance - ranked[0].distance < 6) return 'ambiguous';
  return 'supports';
}
export function repeatOf(entries, hash, match) {
  return entries.find((e) => hashDistance(e.hash, hash) <= 8 || (match?.tcgId && e.match?.tcgId === match.tcgId));
}
export function recognitionStatus(result, image) {
  if (!result.match) return 'needs review';
  if (image?.evidence === 'supports' && image.bestId !== result.match.tcgId) return 'conflicting evidence';
  return result.confidence === 'high' ? 'suggested match' : 'needs review';
}
export function validationReport(entries) {
  const labelled = entries.filter((e) => e.expectedId?.trim());
  return {
    version: 1, total: entries.length, labelled: labelled.length,
    correct: labelled.filter((e) => e.predictedId === e.expectedId.trim()).length,
    confidentWrong: labelled.filter((e) => e.confidence === 'high' && e.predictedId !== e.expectedId.trim()).length,
    results: entries.map(({ id, predictedId, expectedId, confidence, image, elapsedMs, readings, attempts, match, quantity, variant, foil_pattern, texture, stamp, edition, quality }) => ({ id, predictedId, expectedId, confidence, image, elapsedMs, readings, attempts, quantity, variant, foil_pattern, texture, stamp, edition, quality, finalId: match?.tcgId ?? null })),
  };
}

/**
 * Several readings of the same card (live scanning reads it on more than one frame): the match they
 * agree on, and whether that is enough to trust it. One high-confidence reading whose artwork doesn't
 * point elsewhere is enough; otherwise two readings must agree on the same card. A card the artwork
 * clearly contradicts is never confirmed. Pure, for the tests.
 * `readings`: [{ tcgId, confidence: 'high'|'medium'|'low', evidence?, bestId? }].
 * Returns { tcgId, votes, confirmed }.
 */
export function agreedMatch(readings) {
  const votes = new Map();
  for (const r of readings) if (r?.tcgId && r.confidence !== 'low') votes.set(r.tcgId, (votes.get(r.tcgId) ?? 0) + 1);
  const [tcgId, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!tcgId) return { tcgId: null, votes: 0, confirmed: false };
  const mine = readings.filter((r) => r?.tcgId === tcgId);
  const contradicted = mine.some((r) => r.evidence === 'supports' && r.bestId && r.bestId !== tcgId);
  const strong = mine.some((r) => r.confidence === 'high');
  const rival = [...votes.values()].filter((v) => v === count).length > 1;
  return { tcgId, votes: count, confirmed: !contradicted && !rival && (strong || count >= 2) };
}
