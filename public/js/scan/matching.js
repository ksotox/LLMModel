import { hashPixels, rankImages, imageEvidence } from './core.js';
export function artworkHash(canvas) {
  const small = document.createElement('canvas'); small.width = 36; small.height = 32;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  // Ordinary illustration window; full-art layouts may disagree and stay for review.
  ctx.drawImage(canvas, canvas.width * .08, canvas.height * .14, canvas.width * .84, canvas.height * .39, 0, 0, 36, 32);
  return hashPixels(ctx.getImageData(0, 0, 36, 32));
}
const cache = new Map();
export async function compareArtwork(hash, candidates) {
  const refs = [];
  const queue = candidates.slice(0, 12);
  const compare = async (candidate) => {
    try {
      const img = new Image();
      let blobPromise = cache.get(candidate.tcgId);
      if (!blobPromise) {
        blobPromise = fetch(`/api/catalog/cards/${encodeURIComponent(candidate.tcgId)}/scan-image`, { signal: AbortSignal.timeout(12000) }).then((r) => { if (!r.ok) throw new Error('Reference unavailable'); return r.blob(); });
        cache.set(candidate.tcgId, blobPromise);
        if (cache.size > 128) cache.delete(cache.keys().next().value);
      }
      const url = URL.createObjectURL(await blobPromise);
      try { img.src = url; await img.decode(); } finally { URL.revokeObjectURL(url); }
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      refs.push({ tcgId: candidate.tcgId, hash: artworkHash(c) });
    } catch { cache.delete(candidate.tcgId); /* No picture or offline: OCR result remains reviewable. */ }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await compare(queue.shift());
  }));
  const ranked = rankImages(hash, refs);
  return { evidence: imageEvidence(ranked), bestId: ranked[0]?.tcgId ?? null, ranked: ranked.map(({ tcgId, distance }) => ({ tcgId, distance })) };
}
