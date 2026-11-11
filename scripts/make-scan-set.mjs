#!/usr/bin/env node
// Write the scan benchmark's synthetic photos to a folder, to look at them:
//   node scripts/make-scan-set.mjs [folder]   (default data/scan-bench/synthetic)
// Each photo is a JPEG; labels.json lists every card's true corners and identity (same format
// as tests/fixtures/scan/reference.json).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, labelledSets, startHarness } from './scan-bench/harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'data', 'scan-bench', 'synthetic'));
const harness = await startHarness();
try {
  const { reference } = labelledSets();
  const scenes = await harness.page.evaluate(async (ref) => {
    const { exportSynthetic } = await import('/__bench/mod/run.js');
    return exportSynthetic({ reference: ref, fileUrl: (f) => `/__bench/file/${f}` });
  }, reference);
  fs.mkdirSync(out, { recursive: true });
  const photos = [];
  for (const s of scenes) {
    const file = `${s.name}.jpg`;
    fs.writeFileSync(path.join(out, file), Buffer.from(s.image.split(',')[1], 'base64'));
    photos.push({ file, group: s.group, cards: s.cards });
  }
  fs.writeFileSync(path.join(out, 'labels.json'), `${JSON.stringify({ about: 'Synthetic scan benchmark photos (scripts/scan-bench/synth.js).', photos }, null, 2)}\n`);
  console.log(`Wrote ${scenes.length} photos and labels.json to ${path.relative(ROOT, out) || out}`);
} finally {
  await harness.close();
}
