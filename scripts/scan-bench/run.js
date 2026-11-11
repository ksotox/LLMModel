// The scan benchmark itself (runs in the browser; served only by scripts/bench-scan.mjs): every
// photo goes through the app's real pipeline (card finder, straightening, text reading, and the
// server's /api/identify), and the result is scored against the labels.

import { findCards } from '/js/vision.js';
import { cutCard } from '/js/images.js';
import { readCardText } from '/js/ocr.js';
import { matchQuads, sameCard } from './metrics.js';
import { asImage, cardFaces, drawScene, sceneList } from './synth.js';

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Couldn’t load ${src}`));
  img.src = src;
});

async function identify(canvas) {
  const text = await readCardText(canvas);
  const res = await fetch('/api/identify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(text) });
  return res.ok ? res.json() : { match: null, confidence: 'low' };
}

/** Score one photo: detection against the labels, then reading each card that was found. */
async function scorePhoto({ name, group, img, cards }, { read, tolerance }) {
  const t0 = performance.now();
  let found = [];
  try {
    found = await findCards(img);
  } catch (err) {
    console.warn('Card finder failed on', name, err);
  }
  const ms = performance.now() - t0;
  const truths = cards.map((c) => c.corners);
  const { pairs, missed, extra } = matchQuads(truths, found.map((q) => q.map((p) => [p.x, p.y])), tolerance);
  const reads = [];
  if (read) {
    for (const p of pairs) {
      const r0 = performance.now();
      const { canvas } = await cutCard(img, found[p.found]);
      const result = await identify(canvas);
      reads.push({
        card: cards[p.truth].name,
        got: result.match ? `${result.match.name} (${result.match.tcgId})` : null,
        correct: sameCard(cards[p.truth], result.match),
        confidence: result.confidence,
        ms: performance.now() - r0,
      });
    }
  }
  return { name, group, truths: truths.length, found: found.length, pairs, missed, extra, ms, reads };
}

/**
 * Run the benchmark. `sets`: [{ group, photos: [{ file, cards }] }] of labelled photos;
 * `fileUrl(file)` gives each photo's address. Options: read (default true), synthetic
 * (default true), tolerance (default 0.02 of a card's width), progress(text).
 */
export async function runBench({ sets, fileUrl, reference, read = true, synthetic = true, tolerance = 0.02, progress = () => {} }) {
  const results = [];
  for (const set of sets) {
    for (const photo of set.photos) {
      progress(`${set.group}: ${photo.file}`);
      const img = await loadImage(fileUrl(photo.file));
      const cards = photo.cards.map((c) => ({ ...c, corners: c.corners }));
      results.push(await scorePhoto({ name: photo.file, group: set.group, img, cards }, { read, tolerance }));
    }
  }
  if (synthetic) {
    const faces = await cardFaces(reference, fileUrl);
    const scenes = sceneList();
    for (const [i, scene] of scenes.entries()) {
      progress(`${scene.name} (${i + 1}/${scenes.length})`);
      const { canvas, cards } = await drawScene(scene, faces, 1000 + i);
      const img = await asImage(canvas);
      results.push(await scorePhoto({ name: scene.name, group: scene.group, img, cards }, { read, tolerance }));
    }
  }
  return results;
}

/** The synthetic set as JPEG data URLs plus labels (scripts/make-scan-set.mjs writes them to disk). */
export async function exportSynthetic({ reference, fileUrl }) {
  const faces = await cardFaces(reference, fileUrl);
  const out = [];
  for (const [i, scene] of sceneList().entries()) {
    const { canvas, cards } = await drawScene(scene, faces, 1000 + i);
    out.push({ name: scene.name, group: scene.group, image: canvas.toDataURL('image/jpeg', 0.9), cards: cards.map((c) => ({ ...c, corners: c.corners.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) })) });
  }
  return out;
}
