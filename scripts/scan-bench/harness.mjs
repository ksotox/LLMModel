// Shared by scripts/bench-scan.mjs and scripts/make-scan-set.mjs: starts the app (with the test
// mock card sources, so no network is needed) and a headless browser, and serves the benchmark's
// own browser modules and labelled photos at /__bench/ (never part of the app itself).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { mockCatalog, startMockSources } from '../../tests/helpers/mock-sources.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES = path.join(ROOT, 'scripts', 'scan-bench');
// The owner's own scanner tests (Profile → Scanner tests), where the app keeps them.
const OWN = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'), 'scan-bench');
// Folders whose files the benchmark may open: the reference photos and their labels.
const FILE_ROOTS = ['docs/reference', 'tests/fixtures/scan'].map((d) => path.join(ROOT, d));
const TYPES = { '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };

export async function startHarness() {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const mock = await startMockSources();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-bench-'));
  const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.route('**/__bench/**', async (route) => {
    const url = new URL(route.request().url());
    const [, kind, ...rest] = url.pathname.split('/').filter(Boolean);
    const rel = decodeURIComponent(rest.join('/'));
    const own = kind === 'file' && rel.startsWith('own/');
    const file = kind === 'mod' ? path.join(MODULES, rel) : own ? path.join(OWN, rel.slice(4)) : path.join(ROOT, rel);
    const allowed = kind === 'mod' ? file.startsWith(MODULES + path.sep)
      : own ? file.startsWith(OWN + path.sep) : FILE_ROOTS.some((r) => file.startsWith(r + path.sep));
    if (!allowed || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto(base);

  return {
    page,
    errors,
    async close() {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.store.close();
      await mock.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The labelled reference photos, and the owner's own labelled set when there is one. */
export function labelledSets() {
  const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/scan/reference.json'), 'utf8'));
  const sets = [{ group: 'reference', photos: reference.photos }];
  const own = path.join(OWN, 'labels.json');
  if (fs.existsSync(own)) {
    const labels = JSON.parse(fs.readFileSync(own, 'utf8'));
    if (labels.photos?.length) sets.push({ group: 'own', photos: labels.photos.map((p) => ({ ...p, file: `own/${p.file}` })) });
  }
  return { reference, sets };
}
