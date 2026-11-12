// End-to-end walkthrough in a real browser, using the reference photos in docs/reference:
// create the owner profile, add a pack, upload a photo of three cards (auto-split) plus a single
// card, match them to their official versions, save, search, open a card, catch a duplicate, use
// the gallery views, filters and bulk changes, check a set, and confirm everything survives a
// server restart.
//
//   npm run test:e2e            (set SCREENSHOTS=1 to refresh docs/screenshots)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { EbayClient } from '../../server/ebay.js';
import { Models3D } from '../../server/models3d.js';
import { PriceTrackerClient } from '../../server/priceTracker.js';
import { mockCatalog, startMockSources } from '../helpers/mock-sources.js';
import { addModel } from '../helpers/tiny-onnx.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REF = (f) => path.join(ROOT, 'docs', 'reference', f);
const SHOTS = process.env.SCREENSHOTS ? path.join(ROOT, 'docs', 'screenshots') : null;

async function startServer(dataDir, mock, port = 0) {
  const ebay = new EbayClient({ clientId: 'id', clientSecret: 'secret', baseUrl: mock.ebayUrl });
  const priceTracker = new PriceTrackerClient({ apiKey: 'test-key', baseUrl: mock.pptUrl });
  const models3d = new Models3D({ dataDir, indexUrl: mock.models3dIndexUrl, assetPrefix: mock.models3dAssetPrefix });
  const app = createApp({ dataDir, catalog: mockCatalog(mock), ebay, priceTracker, models3d });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    stop: async () => {
      await new Promise((r) => server.close(r));
      app.locals.store.close();
    },
  };
}

const step = (msg) => console.log(`• ${msg}`);

const mock = await startMockSources();
// A stand-in for the local Python grading service (the real one is optional and not needed here).
const grader = { online: false };
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAOAAoDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDfooor4U9k/9k=';
const scanSide = () => {
  const jpg = `data:image/jpeg;base64,${TINY_JPEG}`;
  const png = `data:image/png;base64,${PNG_1PX}`;
  const reg = (key, grade) => ({ key, grade, fraction: grade < 8 ? 0.12 : 0.01, severity: grade >= 9 ? 'none' : grade >= 8 ? 'minor' : 'moderate', white: grade < 8 ? 0.1 : 0.01, dark: 0.004, image: jpg, mask: png });
  return { flat: jpg, surface_map: png, corners: [reg('tl', 9), reg('tr', 7), reg('bl', 10), reg('br', 8)], edges: [reg('top', 10), reg('bottom', 8), reg('left', 9), reg('right', 10)] };
};
const graderServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (!grader.online) { res.statusCode = 503; return res.end(JSON.stringify({ detail: 'down' })); }
    if (req.url === '/health') return res.end(JSON.stringify({ ready: true, engine: 'viridian-cv' }));
    const side = (lr) => ({ centering: { ok: true, grade: 9, left_right: lr, top_bottom: '52/48', confidence: 'medium', axis_note: 'L/R is the reliable axis; T/B is approximate on modern layouts' }, corners: { grade: 7, confidence: 'low' }, edges: { grade: 8, confidence: 'low' }, surface: { grade: 8, confidence: 'low' }, experimental_overall: 8 });
    res.end(JSON.stringify({
      ok: true, engine: 'viridian-cv', status: 'complete', experimental_overall: 8, front: side('55/45'), back: side('51/49'),
      capture: { front: { ok: true, warnings: [] }, back: { ok: true, warnings: [] } }, reference_used: true,
      warnings: ['Corners, edges, and surface are unvalidated visual heuristics.'],
      front_overlay: `data:image/png;base64,${PNG_1PX}`, back_overlay: `data:image/png;base64,${PNG_1PX}`,
      precision: { front: scanSide(), back: scanSide() },
      findings: [{ side: 'front', area: 'Top-right corner', kind: 'possible whitening', severity: 'moderate', grade: 7, detail: '10.0% of the measured corner area is bright and colourless' }],
    }));
  });
});
await new Promise((r) => graderServer.listen(0, '127.0.0.1', r));
process.env.GRADER_SERVICE_URL = `http://127.0.0.1:${graderServer.address().port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-e2e-'));
let srv = await startServer(dataDir, mock);
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Tesseract's Japanese model logs "Parameter not found" for settings its engine doesn't use: harmless.
// Tesseract's engine logs its own diagnostics as errors ("Parameter not found", and on noisy text
// such as a blurry photo "Image too small to scale" / "Line cannot be recognized"): not app errors.
const TESSERACT_NOISE = /^(Warning: Parameter not found|Image too small to scale|Line cannot be recognized)/;
page.on('console', (m) => m.type() === 'error' && !TESSERACT_NOISE.test(m.text()) && errors.push(m.text()));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

try {
  step('first start: create the owner profile');
  await page.goto(base);
  await page.getByRole('heading', { name: 'Welcome!' }).waitFor();
  assert.ok(await page.locator('.nav').isHidden(), 'nothing but the setup until signed in');
  await page.getByLabel('Username').fill('kevin');
  await page.getByLabel('Display name').fill('Kevin');
  await page.getByLabel('Password (6+ characters)').fill('pikachu-123');
  await shot('00-setup');
  await page.getByRole('button', { name: 'Create my profile' }).click();

  step('empty collection');
  await page.getByText('Your Pokédex is empty').waitFor();
  await page.locator('.account-name', { hasText: 'Kevin' }).waitFor();
  await shot('01-empty');

  step('choose a new pack and upload its photo');
  await page.getByRole('link', { name: '+ Add', exact: true }).click();
  await page.getByLabel('Pulled from').selectOption('new');
  await page.locator('.new-packs input[type=file]:not([capture])').setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await page.locator('.pack-item input[type=text]').first().fill('Paldea Evolved booster pack');

  step('upload a photo with three cards: each is found, cut out and straightened');
  const cardInput = page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])');
  await cardInput.setInputFiles(REF('three-cards.jpg'));
  await page.getByText('3 cards found in this photo').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.card-item').count(), 3);

  const item = (i) => page.locator('.card-item').nth(i);
  const cutOut = await item(0).locator('.card-item-photo img').evaluate(async (img) => {
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  assert.ok(Math.abs(cutOut.w / cutOut.h - 63 / 88) < 0.01, `card picture is card-shaped (${cutOut.w}×${cutOut.h})`);

  step('each card is read from the photo and matched automatically — nothing typed');
  for (const [i, name] of ['Voltorb', 'Punk Helmet', 'Linoone'].entries()) {
    await item(i).locator('.match-note', { hasText: `Official card: ${name}` }).waitFor({ timeout: 90000 });
    await item(i).locator('.read-note', { hasText: 'Read from the photo' }).waitFor();
    await item(i).locator('.read-status.recognized', { hasText: 'Recognized' }).waitFor();
  }
  await page.locator('.batch-summary', { hasText: '3 recognized' }).waitFor();
  assert.equal(await item(0).getByLabel('Set code').inputValue(), 'PAL');
  assert.equal(await item(0).getByLabel('Number').inputValue(), '066/193');
  assert.equal(await item(1).getByLabel('Number').inputValue(), '092/094');
  assert.equal(await item(2).getByLabel('Set code').inputValue(), 'OBF');

  step('a close-up of a single card is read too');
  await cardInput.setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await page.locator('.source').nth(1).getByText('1 card in this photo').waitFor({ timeout: 60000 });
  await item(3).locator('.match-note', { hasText: 'Official card: Voltorb · PAL' }).waitFor({ timeout: 90000 });
  step('the variant is suggested from the foil in the photo and the card’s printings; “Use” confirms it');
  await item(0).locator('.variant-suggestion', { hasText: 'Suggested: Normal' }).waitFor({ timeout: 30000 });
  const tip = item(3).locator('.variant-suggestion', { hasText: 'Suggested: Reverse holo' });
  await tip.waitFor({ timeout: 30000 });
  assert.match(await tip.textContent(), /\d+% sure/);
  assert.equal(await item(3).getByLabel('Variant').inputValue(), 'normal', 'nothing changes until the user confirms');
  await tip.getByRole('button', { name: 'Use' }).click();
  assert.equal(await item(3).getByLabel('Variant').inputValue(), 'reverse-holo');
  await page.getByText('4 of 4 matched to an official card').waitFor();
  await shot('02-add-cards');

  step('tilt scan: more photos of the same card update the suggestion, but never change the choice');
  await item(3).locator('.variant-hint input[type=file]').setInputFiles([REF('voltorb-reverse-holo.jpg')]);
  // The same photo again shows no change in shine, so the scan reads "no foil": the user's choice stays.
  await item(3).locator('.variant-suggestion', { hasText: '(tilt scan)' }).waitFor({ timeout: 60000 });
  await item(3).getByRole('button', { name: /Add another angle \(2 photos\)/ }).waitFor();
  assert.equal(await item(3).getByLabel('Variant').inputValue(), 'reverse-holo');

  step('adjust the outlines in the crop editor');
  await page.locator('.source').first().getByRole('button', { name: 'Adjust cards' }).click();
  await page.locator('.crop-shape').nth(2).waitFor();
  assert.equal(await page.locator('.crop-shape').count(), 3);
  assert.equal(await page.locator('.crop-handle').count(), 12, 'four corner handles per card');
  await shot('03-crop-editor');
  await page.getByRole('button', { name: 'Use these 3 cards' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await item(0).locator('.match-note', { hasText: 'Official card: Voltorb' }).waitFor({ timeout: 90000 });
  await page.getByText('4 of 4 matched to an official card').waitFor({ timeout: 90000 });

  step('save: lands on the pack page with all four cards');
  await page.getByRole('button', { name: 'Save 4 cards' }).click();
  await page.getByRole('heading', { name: 'Paldea Evolved booster pack' }).waitFor();
  await page.locator('.card-tile').nth(3).waitFor();
  assert.equal(await page.locator('.card-tile').count(), 4);
  await shot('04-pack');

  step('search the pack');
  await page.getByLabel('Search cards in this pack').fill('helmet');
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 1);

  step('search the whole collection');
  await page.getByRole('link', { name: 'Collection' }).click();
  await page.locator('.card-tile').nth(3).waitFor();
  step('each card shows its rarity, estimated pull chance and market price');
  const voltorbTile = page.locator('.card-tile', { hasText: 'Reverse holo' });
  await voltorbTile.locator('.rarity', { hasText: 'Common' }).waitFor();
  assert.equal((await voltorbTile.locator('.price').textContent()).trim(), '$0.25');
  assert.equal(await voltorbTile.locator('.card-foot span').first().textContent(), '1 in 93 packs');
  assert.match(await voltorbTile.locator('.card-foot span').first().getAttribute('title'), /^1\.\d% per booster pack/);
  assert.equal(await voltorbTile.locator('.set-tag').textContent(), 'PAL');
  await page.locator('.stats', { hasText: 'Est. value' }).waitFor();
  await page.getByLabel('Sort').selectOption('value');
  await page.waitForFunction(() => document.querySelector('.card-tile .price')?.textContent === '$0.25');
  await page.getByLabel('Sort').selectOption('');

  await page.getByLabel('Search cards').fill('voltorb');
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 2);
  await page.getByLabel('Search cards').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 4);
  await shot('05-collection');

  step('open a card: user photo and official image side by side');
  await page.locator('.card-tile', { hasText: 'Linoone' }).click();
  const dialog = page.locator('dialog.modal');
  await dialog.getByText('Your photo').waitFor();
  await dialog.locator('img[alt^="Official card"]').waitFor();
  await dialog.getByText('Paldea Evolved booster pack').waitFor();
  await dialog.locator('dd', { hasText: /\d{4}/ }).first().waitFor();
  await dialog.locator('.market .rarity', { hasText: 'Uncommon' }).waitFor();
  await dialog.locator('.market', { hasText: 'per booster pack' }).waitFor();
  await dialog.locator('.market .price-big', { hasText: '$0.12' }).waitFor(); // tcgcsv backup price
  await shot('06-card-detail');
  await page.keyboard.press('Escape');

  step('price history and eBay graded sales from PokemonPriceTracker');
  await page.locator('.card-tile', { hasText: 'Reverse holo' }).click();
  const history = page.locator('dialog.modal .price-history');
  await history.locator('td', { hasText: 'PSA 10' }).waitFor();
  assert.match(await history.locator('tr', { hasText: 'PSA 10' }).textContent(), /12.*\$24\.50.*\$23\.00/);
  await history.getByText(/Population: PSA 10: 143/).waitFor();
  assert.match(await history.locator('.tracker-foot').textContent(), /updated just now · \d+ of 100 credits used today/);
  await history.getByLabel('Price line').selectOption('pokemonpricetracker|Market price');
  assert.ok(await history.locator('.trend-segment').count() >= 2, 'daily line drawn');
  if (SHOTS) {
    await page.setViewportSize({ width: 1280, height: 1900 });
    await history.screenshot({ path: path.join(SHOTS, '13-price-history.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  const pptCalls = mock.state.pptRequests.length;
  await page.keyboard.press('Escape');
  await page.locator('.card-tile', { hasText: 'Reverse holo' }).click();
  await history.locator('td', { hasText: 'PSA 10' }).waitFor();
  assert.equal(mock.state.pptRequests.length, pptCalls, 'opening the card again uses the cache — no credits');

  step('eBay sold prices: average, coloured trend chart and the sold listings');
  const ebay = page.locator('dialog.modal .ebay');
  // PokemonPriceTracker already contributed its one graded sale (a PSA 10 for $25).
  await ebay.locator('.stat', { hasText: '1 sale' }).waitFor();
  await ebay.getByRole('button', { name: 'Update from eBay' }).click();
  await ebay.locator('.stat', { hasText: 'Average sold' }).waitFor();
  await ebay.locator('.stat', { hasText: '13 sales' }).waitFor();
  assert.match(await ebay.locator('.stat', { hasText: 'Average sold' }).textContent(), /\$4\.48/); // (8.25 raw + 2 × $25 PSA 10) / 13
  await ebay.getByLabel('Which sales').selectOption('raw');
  await ebay.locator('.stat', { hasText: '11 sales' }).waitFor();
  const colours = await ebay.locator('.trend-segment').evaluateAll((els) => els.map((e) => [e.dataset.direction, e.getAttribute('stroke')]));
  assert.deepEqual([...new Set(colours.map(([d, c]) => `${d}:${c}`))].sort(), ['down:#dc2626', 'flat:#eab308', 'up:#16a34a']);
  assert.match(await ebay.locator('.stat', { hasText: 'Average sold' }).textContent(), /\$0\.75/);
  assert.deepEqual(await ebay.locator('.trend-segment').evaluateAll((els) => els.map((e) => e.dataset.direction)), ['up', 'up', 'down', 'down', 'flat', 'flat']);
  await ebay.getByRole('button', { name: 'Monthly' }).click();
  assert.deepEqual(await ebay.locator('.trend-segment').evaluateAll((els) => els.map((e) => e.dataset.direction)), ['down']);
  await ebay.getByRole('button', { name: 'Weekly' }).click();
  const firstListing = ebay.locator('.ebay-listings tbody tr').first();
  assert.match(await firstListing.getByRole('link').getAttribute('href'), /^https:\/\/www\.ebay\.com\/itm\//);
  if (SHOTS) {
    await page.setViewportSize({ width: 1280, height: 1900 }); // tall enough for the whole section
    await ebay.screenshot({ path: path.join(SHOTS, '12-ebay-sold-prices.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  step('paste sold listings copied from eBay.com');
  await ebay.getByLabel('Which sales').selectOption('all');
  await ebay.locator('summary', { hasText: 'Add sales from eBay.com' }).click();
  assert.match(await ebay.getByRole('link', { name: /Open the sold listings on eBay/ }).getAttribute('href'), /^https:\/\/www\.ebay\.com\/sch\/.*LH_Sold=1/);
  const pasted = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ebay', 'sold-page.html'), 'utf8');
  await ebay.locator('.paste-box').evaluate((box, html) => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', 'ignored');
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, pasted);
  await page.getByText('Added 3 sales · skipped 1 that weren’t this card').waitFor();
  // Phones usually copy plain text only: the same results must come out of it.
  const fromText = await page.evaluate(async (text) => (await import('/js/ebay.js')).parseEbayPaste({ text }),
    fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ebay', 'sold-page.txt'), 'utf8'));
  assert.deepEqual(fromText.map((l) => [l.price, l.soldAt.slice(0, 10)]), [[0.66, '2026-08-25'], [0.7, '2026-09-01'], [14.5, '2026-09-03']]);
  await ebay.getByLabel('Which sales').locator('option', { hasText: 'All sales (16)' }).waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');

  step('search any card online and add it to the collection');
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByLabel('Card name').fill('punk helmet');
  await page.locator('.card-tile', { hasText: 'Punk Helmet' }).first().waitFor();
  await page.locator('.card-tile', { hasText: 'Owned ×1' }).waitFor();
  await page.getByLabel('Card name').fill('');
  await page.getByLabel('Set code').fill('PAL');
  await page.getByLabel('Number').fill('067/193');
  await page.locator('.card-tile', { hasText: 'Electrode' }).click();
  const found = page.locator('dialog.modal');
  await found.locator('.market', { hasText: 'Pull chance' }).waitFor();
  await shot('09-search-card');
  await found.getByRole('button', { name: 'Add to my collection' }).click();
  await page.getByText('Added Electrode to your collection').waitFor();
  await page.locator('.card-tile', { hasText: 'Owned ×1' }).waitFor();
  await shot('10-search');

  step('second source: TCGdex down, search still works');
  mock.state.tcgdexDown = true;
  await page.getByLabel('Set code').fill('OBF');
  await page.getByLabel('Number').fill('167/197');
  await page.locator('.card-tile', { hasText: 'Zigzagoon' }).waitFor();
  mock.state.tcgdexDown = false;

  step('a promo card (number only, no set total) is read and matched');
  await page.goto(`${base}/#/add`);
  await page.getByRole('heading', { name: 'Add cards' }).waitFor();
  await page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])').setInputFiles(REF('froakie-promo.webp'));
  await page.locator('.card-item .match-note', { hasText: 'Official card: Froakie' }).waitFor({ timeout: 90000 });
  assert.equal(await page.locator('.card-item').getByLabel('Set code').inputValue(), 'MEP');
  assert.equal(await page.locator('.card-item').getByLabel('Number').inputValue(), '060');
  await page.locator('.card-item .variant-suggestion', { hasText: 'Suggested: Promo · certain' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.card-item').getByLabel('Variant').inputValue(), 'promo', 'a certain printing is filled in');
  await shot('11-read-promo');

  step('a blurry photo: the card is still found, and a retake is suggested');
  assert.equal(await page.locator('.card-item .retake-note').count(), 0, 'a sharp photo gets no advice');
  const blurry = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.filter = 'blur(9px)';
    ctx.drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, `data:image/jpeg;base64,${fs.readFileSync(REF('voltorb-reverse-holo.jpg')).toString('base64')}`);
  await page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])')
    .setInputFiles({ name: 'blurry.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(blurry, 'base64') });
  const blurredItem = page.locator('.source').nth(1).locator('.card-item');
  await blurredItem.locator('.retake-note', { hasText: 'Retake suggested: this card is blurry' }).waitFor({ timeout: 60000 });
  await shot('16-retake');

  step('a Japanese card is read (Japanese name + "SV2a 100/165"), matched and saved with its picture');
  await page.goto(`${base}/#/add`);
  await page.reload(); // a fresh Add page, without the promo from the step before
  await page.getByRole('heading', { name: 'Add cards' }).waitFor();
  await page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])')
    .setInputFiles(path.join(ROOT, 'tests', 'fixtures', 'photos', 'japanese-voltorb.jpg'));
  const jp = page.locator('.card-item');
  await jp.locator('.match-note', { hasText: 'Official card: ビリリダマ · JP · SV2a · 100/165' }).waitFor({ timeout: 120000 });
  await jp.locator('.read-note', { hasText: 'Read from the photo' }).waitFor();
  assert.equal(await jp.getByLabel('Name').inputValue(), 'ビリリダマ');
  await jp.locator('.variant-reasons', { hasText: 'Poké Ball pattern' }).waitFor({ timeout: 30000 });
  await shot('14-japanese-card');
  await page.getByRole('button', { name: 'Save 1 card' }).click();
  await page.getByRole('heading', { name: 'My collection' }).waitFor();
  const jpTile = page.locator('.card-tile', { hasText: 'ビリリダマ' });
  await jpTile.locator('.lang-tag', { hasText: 'JP' }).waitFor();
  assert.equal(await jpTile.locator('.price').textContent(), '$0.36', 'Cardmarket €0.30 shown in dollars');
  await page.getByLabel('Search cards').fill('japanese');
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 1);
  await page.getByLabel('Search cards').fill('');

  step('add packs on their own: several at once');
  await page.goto(`${base}/#/add-packs`);
  await page.getByRole('heading', { name: 'Add packs' }).waitFor();
  await page.locator('input[type=file]:not([capture])').setInputFiles([REF('three-cards.jpg'), REF('voltorb-reverse-holo.jpg')]);
  await page.locator('.pack-item').nth(1).waitFor();
  await page.locator('.pack-item').nth(0).locator('input[type=text]').first().fill('Obsidian Flames tin');
  await page.locator('.pack-item').nth(0).locator('select').selectOption('tin');
  await page.locator('.pack-item').nth(1).locator('input[type=text]').first().fill('Holiday bundle');
  await page.locator('.pack-item').nth(1).locator('select').selectOption('bundle');
  await page.getByRole('button', { name: 'Save 2 packs' }).click();
  await page.locator('.pack-tile').nth(2).waitFor();
  assert.equal(await page.locator('.pack-tile').count(), 3);
  await shot('07-packs');

  step('a card that is already in the collection: the duplicate check asks first');
  await page.goto(`${base}/#/add`);
  await page.reload();
  await page.getByRole('heading', { name: 'Add cards' }).waitFor();
  await page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])').setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await page.locator('.card-item .match-note', { hasText: 'Official card: Voltorb · PAL' }).waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Save 1 card' }).click();
  const dup = page.locator('dialog.modal .duplicate-check');
  await dup.getByRole('heading', { name: 'You already have this card' }).waitFor();
  await dup.getByText('1 already in your collection').waitFor();
  await shot('15-duplicate-check');
  await dup.getByRole('button', { name: 'No' }).click();
  await page.locator('.card-item.duplicate').waitFor();
  await page.getByRole('button', { name: 'Save 1 card' }).click();
  await dup.getByRole('button', { name: 'Yes, add anyway' }).click();
  await page.getByRole('heading', { name: 'My collection' }).waitFor();

  step('gallery: copies grouped (×2), compact and table views, and the duplicates preset');
  await page.locator('.card-tile .badge.qty', { hasText: '×2' }).waitFor();
  assert.equal(await page.locator('.card-tile').count(), 6, 'two Voltorbs in one tile');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Compact' }).click();
  await page.locator('.card-tile.compact').first().waitFor();
  await page.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
  await page.locator('.card-grid.density-compact').waitFor();
  await shot('16-compact-gallery');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Table' }).click();
  await page.locator('.collection-table tbody tr').nth(5).waitFor();
  await page.locator('.collection-table').getByRole('button', { name: 'Value' }).click();
  await page.waitForFunction(() => document.querySelector('.collection-table tbody tr td.num:last-child')?.textContent === '$0.36');
  await shot('17-table-view');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Detailed' }).click();
  await page.getByRole('button', { name: 'Duplicates', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 1);
  await page.getByRole('button', { name: 'Duplicates', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 6);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Language').selectOption('ja');
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 6);

  step('bulk changes: select cards, set their condition, move them to the trash and undo');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.locator('.card-tile', { hasText: 'Linoone' }).click();
  await page.locator('.card-tile', { hasText: 'Punk Helmet' }).click();
  await page.locator('.bulk-bar', { hasText: '2 selected' }).waitFor();
  await shot('18-bulk-select');
  await page.locator('.bulk-bar select').nth(1).selectOption('LP');
  await page.getByText('Condition updated').waitFor();
  await page.locator('.card-tile', { hasText: 'Linoone' }).locator('.chip', { hasText: 'LP' }).waitFor();
  await page.locator('.card-tile', { hasText: 'Linoone' }).click();
  await page.locator('.bulk-bar').getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog.modal').getByRole('button', { name: 'Move to trash' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 5);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 6);
  await page.getByRole('button', { name: 'Done selecting' }).click();

  step('the card page keeps each copy: condition, cost, storage');
  await page.locator('.card-tile', { hasText: 'Linoone' }).click();
  const cardDialog = page.locator('dialog.modal');
  await cardDialog.locator('dd', { hasText: 'LP — Lightly Played' }).waitFor();
  await cardDialog.getByRole('button', { name: 'Edit' }).click();
  await cardDialog.getByLabel('Paid (USD)').fill('1.50');
  await cardDialog.getByLabel('Stored in').fill('Binder 1, page 3');
  await cardDialog.getByRole('button', { name: 'Save changes' }).click();
  await cardDialog.locator('dd', { hasText: 'Binder 1, page 3' }).waitFor();
  await page.keyboard.press('Escape');

  step('sets: completion of each set and its full checklist');
  await page.getByRole('link', { name: 'Sets', exact: true }).click();
  const palTile = page.locator('.set-tile', { hasText: 'PAL' });
  await palTile.waitFor();
  await palTile.click();
  await page.locator('.metric', { hasText: 'Cards owned' }).waitFor();
  await page.locator('.check-tile.missing').first().waitFor();
  await page.locator('.check-tile.owned', { hasText: 'Voltorb' }).waitFor();
  await shot('19-set-checklist');
  await page.getByRole('button', { name: 'Missing', exact: true }).click();
  assert.equal(await page.locator('.check-tile.owned').count(), 0);

  step('dark mode from the account menu');
  await page.locator('.account-button').click();
  await page.getByRole('button', { name: /Dark mode/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.goto(base);
  await page.locator('.card-tile').first().waitFor();
  await shot('20-dark-mode');
  await page.locator('.account-button').click();
  await page.getByRole('button', { name: /Light mode/ }).click();

  step('pre-grade: offline service is shown calmly; with it running, a report is saved, reopened and deleted');
  await page.getByRole('link', { name: 'Pre-grade' }).click();
  await page.getByRole('heading', { name: 'Pre-grade' }).waitFor();
  await page.locator('.gr-notice', { hasText: 'Experimental CV estimate — not professional grading.' }).waitFor();
  await page.getByLabel('Search cards to pre-grade').fill('linoone');
  await page.locator('.gr-card-option').first().getByRole('button', { name: 'Pre-grade' }).click();
  let gr = page.locator('dialog.modal');
  await gr.locator('.gr-connection', { hasText: 'Grading service offline' }).waitFor();
  assert.ok(await gr.getByRole('button', { name: 'Analyze both photos' }).isDisabled(), 'no analysis while offline');
  await page.keyboard.press('Escape');
  grader.online = true;
  await page.locator('.card-tile, .gr-card-option').first().waitFor();
  await page.locator('.gr-card-option').first().getByRole('button', { name: 'Pre-grade' }).click();
  gr = page.locator('dialog.modal');
  await gr.locator('.gr-connection.gr-ready').waitFor();
  await gr.getByLabel('Front photo').setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await gr.getByLabel('Back photo').setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await gr.getByRole('button', { name: 'Analyze both photos' }).click();
  await gr.locator('.gr-report .gr-big', { hasText: '~8' }).waitFor();
  await gr.locator('.gr-report .gr-notice', { hasText: 'Experimental CV estimate — not professional grading.' }).waitFor();
  // The virtual slab: card name, estimate and the "not a pro grade" stamp, flips to the back.
  const slab = gr.locator('.slab-wrap');
  await slab.locator('.slab-face.front .slab-title', { hasText: 'Linoone' }).waitFor();
  await slab.locator('.slab-face.front .slab-grade', { hasText: '~8' }).waitFor();
  await slab.locator('.slab-face.front .slab-stamp', { hasText: 'EXPERIMENTAL' }).waitFor();
  await slab.getByRole('button', { name: '↻ Flip' }).click();
  await slab.locator('.slab-inner.flipped').waitFor();
  await slab.getByRole('button', { name: 'Original photo' }).click();
  assert.match(await slab.locator('.slab-face.front .slab-window img').getAttribute('src'), /\/front\.jpg$/);
  // Breakdown, precision scan with close-ups and view modes, and the list of findings.
  await gr.locator('.gr-cat', { hasText: 'Centering' }).locator('.gr-analysis', { hasText: 'L/R 55/45' }).waitFor();
  await gr.locator('.gr-cat', { hasText: 'Corners' }).locator('.gr-tag', { hasText: 'Screening only' }).waitFor();
  assert.equal(await gr.locator('.gr-corner-grid .gr-closeup').count(), 4);
  assert.equal(await gr.locator('.gr-edge-list .gr-closeup').count(), 4);
  const tr = gr.locator('.gr-closeup', { hasText: 'Top-right corner' });
  await tr.getByRole('button', { name: 'Map' }).click();
  await tr.locator('.gr-zoom.v-map').waitFor();
  await gr.getByRole('tab', { name: 'Back' }).click();
  await gr.locator('.gr-sub', { hasText: 'Back corners' }).waitFor();
  await gr.locator('.gr-findings tr', { hasText: 'possible whitening' }).waitFor();
  await gr.locator('.gr-history-item').first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Collection' }).click();
  await page.locator('.card-tile', { hasText: 'Linoone' }).click();
  await page.locator('dialog.modal').getByRole('button', { name: 'Pre-grade card' }).click();
  gr = page.locator('dialog.modal');
  await gr.locator('.gr-history-item').first().getByRole('button', { name: 'View' }).click();
  await gr.locator('.gr-report').waitFor();
  await gr.locator('.gr-history-item').first().getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog.modal').last().getByRole('button', { name: 'Delete' }).click();
  await gr.getByText('No inspections saved for this card yet.').waitFor();
  await page.keyboard.press('Escape');
  grader.online = false;

  // 3D steps get long time limits: the test browser draws without a graphics card.
  step('PokéBattles: one card pops out of its card in 3D and tries its moves (showcase)');
  await page.getByRole('link', { name: 'PokéBattles' }).click();
  await page.getByRole('heading', { name: 'PokéBattles' }).waitFor();
  await page.locator('.bt-tile').first().waitFor();
  assert.equal(await page.locator('.bt-tile', { hasText: 'Punk Helmet' }).count(), 0, 'Trainer cards can’t battle');
  await page.locator('.bt-tile', { hasText: 'Electrode' }).click();
  await page.locator('.bt-slot', { hasText: 'Electrode' }).locator('.bt-ok', { hasText: '3D model' }).waitFor();
  await page.getByRole('button', { name: '✨ Showcase' }).click();
  await page.locator('canvas.stage-canvas').waitFor();
  await page.locator('.card-info-panel.slot-0.in', { hasText: 'Thunder Jolt' }).waitFor({ timeout: 90000 });
  await page.locator('.bt-message', { hasText: 'Drag to turn it around' }).waitFor({ timeout: 90000 });
  // The stage fills the window: the app's menu is hidden, and the moves are on screen without scrolling.
  assert.ok(await page.locator('.topbar').isHidden(), 'the menu bar is hidden during a battle');
  const inView = (sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
  assert.ok(await inView('.move-btn'), 'the moves are in view');
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 0, 'nothing to scroll');
  await page.locator('.move-btn', { hasText: 'Thunder Jolt' }).click();
  await page.locator('.bt-message', { hasText: /It would deal (30|60) damage/ }).waitFor({ timeout: 90000 });

  step('PokéBattles: two cards battle the computer until one faints');
  await page.getByRole('button', { name: '← Back' }).click();
  await page.getByRole('heading', { name: 'PokéBattles' }).waitFor();
  assert.ok(await page.locator('.topbar').isVisible(), 'the menu bar is back after leaving');
  await page.locator('.bt-tile', { hasText: 'Voltorb' }).first().click();
  await page.locator('.bt-tile', { hasText: 'Linoone' }).click();
  await page.locator('.bt-slot .bt-ok').nth(1).waitFor();
  await page.getByRole('button', { name: '⚔ Battle!' }).click();
  await page.locator('.card-info-panel.slot-0.in').waitFor({ timeout: 90000 });
  await page.getByRole('button', { name: 'Skip intro ⏭' }).click();
  await page.locator('.hp-plate.side-0').waitFor({ timeout: 90000 });
  // A move's full card text opens from its ⓘ, above the message box, and closes again.
  await page.locator('.move-grid .move-btn').first().waitFor({ timeout: 90000 });
  if (await page.locator('.move-info').count()) {
    await page.locator('.move-info').first().click();
    await page.locator('.bt-detail:not([hidden])').waitFor();
    await page.locator('.bt-detail button').click();
    await page.locator('.bt-detail').waitFor({ state: 'hidden' });
  }
  for (let i = 0; i < 40 && !(await page.locator('.bt-result').count()); i++) {
    await page.waitForFunction(() => document.querySelector('.bt-result') || document.querySelector('.move-grid .move-btn:not(:disabled)'), null, { timeout: 90000 });
    const move = page.locator('.move-grid .move-btn:not(:disabled)').first();
    if (await page.locator('.bt-result').count()) break;
    await move.click();
  }
  await page.locator('.bt-result h3', { hasText: /wins|draw/ }).waitFor();
  assert.ok(await page.locator('.hp-text', { hasText: /^0\// }).count() >= 1, 'one side ends at 0 HP');
  // Then it asks: the same battle again, or a different opponent (keeping your Pokémon)?
  await page.locator('.bt-next', { hasText: 'Battle Linoone again, or choose a different opponent for Voltorb?' }).waitFor();
  assert.ok(await page.getByRole('button', { name: '↻ Same battle again' }).isVisible());
  await page.getByRole('button', { name: '⇄ Different opponent' }).click();
  await page.locator('.bt-slot.empty.wanted', { hasText: 'Pick a new opponent for Voltorb' }).waitFor();
  assert.equal(await page.locator('.bt-slot strong').first().textContent(), 'Voltorb', 'your Pokémon stays chosen');
  assert.equal(await page.locator('.bt-tile.picked').count(), 1);

  step('PokéBattles: two players take turns choosing moves; a card without a 3D model fights as its card');
  await page.locator('.bt-tile', { hasText: 'Voltorb' }).first().click(); // let go of the kept Pokémon
  await page.locator('.bt-tile', { hasText: 'Linoone' }).click();
  await page.locator('.bt-tile', { hasText: 'ビリリダマ' }).click();
  await page.getByRole('button', { name: 'Two players' }).click();
  // A form whose model isn't downloaded yet, with the model host down: the card itself fights.
  await page.getByLabel('3D form for ビリリダマ').selectOption('hisuian');
  mock.state.modelsDown = true;
  await page.getByRole('button', { name: '⚔ Battle!' }).click();
  await page.getByRole('button', { name: 'Skip intro ⏭' }).click();
  await page.waitForFunction(() => document.querySelector('.stage-frame')?.dataset.fighters === '3d,card', null, { timeout: 90000 });
  mock.state.modelsDown = false;
  // The browser logs the failed model download (503); that's the case being tested.
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 50[23]/.test(e)));
  const whose = page.locator('.bt-whose', { hasText: /^Player \d: choose/ });
  await whose.waitFor({ timeout: 90000 });
  const first = await whose.textContent();
  await page.locator('.move-grid .move-btn:not(:disabled)').first().click();
  await page.waitForFunction((t) => { const el = document.querySelector('.bt-whose'); return el && /^Player \d: choose/.test(el.textContent) && el.textContent !== t; }, first, { timeout: 90000 });
  assert.notEqual(first.slice(0, 8), (await page.locator('.bt-whose').textContent()).slice(0, 8), 'the other player’s turn');
  await page.getByRole('button', { name: '← Back' }).click();

  step('3D Pop-out: each Pokémon steps out of its card in 3D, drawn once; Trainers, My photos and Select stay plain');
  // (Cards without a diorama: the list of dioramas is emptied for this step; the next one has them.)
  await page.route('**/api/card-effects', (r) => r.fulfill({ json: { cards: {} } }));
  await page.goto(`${base}/#/`);
  await page.locator('.card-tile').nth(5).waitFor();
  await page.locator('.pfx-toggle').click();
  await page.locator('.card-grid.pfx-grid .card-tile.pfx-on').nth(5).waitFor();
  const popVoltorb = page.locator('.card-tile.pfx-on', { hasText: 'Voltorb' }).first();
  await popVoltorb.scrollIntoViewIfNeeded();
  await popVoltorb.locator('img.pfx-model.ready').waitFor({ timeout: 90000 }); // drawn with software WebGL here
  assert.equal(await page.locator('.card-tile.pfx-on', { hasText: 'Punk Helmet' }).locator('img.pfx-model').count(), 0, 'a Trainer has no Pokémon to pop out');
  const savedPicture = path.join(dataDir, 'popout', 'regular', '100.webp');
  for (let i = 0; i < 100 && !fs.existsSync(savedPicture); i++) await page.waitForTimeout(100);
  assert.ok(fs.existsSync(savedPicture), 'the picture is saved for every device');
  await shot('30-popout-gallery');
  let uploads = 0;
  // Voltorb's picture was saved above, so it isn't drawn again. (Other Pokémon may still have been drawing when the page reloaded.)
  const countUploads = (r) => { if (r.method() === 'PUT' && r.url().includes('/api/popout/pictures/regular/100')) uploads++; };
  page.on('request', countUploads);
  await page.reload();
  const again = page.locator('.card-tile.pfx-on', { hasText: 'Voltorb' }).first();
  await again.scrollIntoViewIfNeeded();
  await again.locator('img.pfx-model.ready').waitFor({ timeout: 90000 });
  page.off('request', countUploads);
  assert.equal(uploads, 0, 'drawn only once');
  await page.getByRole('group', { name: 'Card image' }).getByRole('button', { name: 'My photos' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 6 && !document.querySelector('.card-tile.pfx-on'));
  await page.getByRole('group', { name: 'Card image' }).getByRole('button', { name: 'Official' }).click();
  await page.locator('.card-tile.pfx-on').first().waitFor();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.card-tile.pfx-on'));
  await page.getByRole('button', { name: 'Done selecting' }).click();
  await page.locator('.pfx-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('.card-tile').length === 6 && !document.querySelector('.card-tile.pfx-on, .pfx-grid'));
  await page.unroute('**/api/card-effects');

  step('dioramas: each new card gets one made on this device (free), shown in 3D Pop-out and on its page');
  await page.locator('.pfx-toggle').click();
  const dioramaTile = page.locator('.card-tile.pfx-on.pfx-scene-mode', { hasText: 'Voltorb' }).first();
  await dioramaTile.locator('img.pfx-scene[src*="/api/card-effects/images/"]').waitFor({ timeout: 180000 });
  const made = fs.readdirSync(path.join(dataDir, 'card-effects')).filter((f) => f.endsWith('.webp'));
  assert.ok(made.length >= 1, 'saved in the data folder');
  await shot('31-dioramas');
  await dioramaTile.click();
  await page.locator('dialog .diorama-section img.diorama-thumb').waitFor({ timeout: 30000 });
  await page.keyboard.press('Escape');
  await page.locator('.pfx-toggle').click();
  await page.waitForFunction(() => !document.querySelector('.pfx-grid'));

  step('restart the server: everything is still there');
  await srv.stop();
  srv = await startServer(dataDir, mock, srv.port);
  await page.goto(base);
  await page.locator('.card-tile').nth(5).waitFor();
  assert.equal(await page.locator('.card-tile').count(), 6, 'four from the first photos, one from Search, one Japanese (the second Voltorb is grouped)');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'still signed in, with the saved theme');

  step('sign out and back in');
  await page.locator('.account-button').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Username').fill('kevin');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong username or password.').waitFor();
  // The browser logs the expected 401 of a wrong password as a console error: not a bug.
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 401/.test(e)));
  await page.getByLabel('Password').fill('pikachu-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.card-tile').nth(5).waitFor();
  const broken = await page.$$eval('.card-tile img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
  assert.equal(broken, 0, 'all card images load');

  step('scanner tests (owner): mark the cards in your own photo, save it for the benchmark, delete it');
  await page.goto(`${base}/#/profile`);
  await page.getByRole('link', { name: 'Open scanner tests' }).click();
  await page.getByRole('heading', { name: 'Scanner tests' }).waitFor();
  await page.getByText('No test photos yet.').waitFor();
  await page.locator('input[type=file]:not([capture])').setInputFiles(REF('three-cards.jpg'));
  await page.getByRole('button', { name: 'Use these 3 cards' }).click();
  await page.getByRole('heading', { name: 'Check each card' }).waitFor({ timeout: 120000 });
  const names = await page.locator('.scan-test-card').getByLabel('Name').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(names, ['Voltorb', 'Punk Helmet', 'Linoone'], 'pre-filled from the scanner’s reading');
  await page.getByRole('button', { name: 'Save to my scanner tests' }).click();
  await page.locator('.scan-test', { hasText: 'Voltorb, Punk Helmet, Linoone' }).waitFor();
  const labels = JSON.parse(fs.readFileSync(path.join(dataDir, 'scan-bench', 'labels.json'), 'utf8'));
  assert.equal(labels.photos[0].cards.length, 3, 'saved where bench:scan reads them');
  await shot('17-scanner-tests');
  await page.locator('.scan-test').getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByText('No test photos yet.').waitFor();
  await page.goto(`${base}/#/`);
  await page.locator('.card-tile').first().waitFor();

  step('AI runtime: a model runs in the page and in a background worker (served locally, no CDN)');
  const ai = await page.evaluate(async (model) => {
    const { loadOrt } = await import('/js/ai/runtime.js');
    const { connect } = await import('/js/workers/rpc.js');
    const { ort, providers } = await loadOrt();
    const t = (v) => new ort.Tensor('float32', Float32Array.from(v), [3]);
    const session = await ort.InferenceSession.create(Uint8Array.from(model), { executionProviders: providers });
    const onPage = [...(await session.run({ a: t([1, 2, 3]), b: t([10, 20, 30]) })).c.data];
    const src = `import { serve } from '${location.origin}/js/workers/rpc.js';
      import { loadOrt } from '${location.origin}/js/ai/runtime.js';
      serve({ async add({ model }) {
        const { ort, providers } = await loadOrt();
        const s = await ort.InferenceSession.create(model, { executionProviders: providers });
        const t = (v) => new ort.Tensor('float32', Float32Array.from(v), [3]);
        return [...(await s.run({ a: t([1, 1, 1]), b: t([2, 2, 2]) })).c.data];
      } });`;
    const worker = connect(new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' }));
    const inWorker = await worker.call('add', { model: Uint8Array.from(model) }, { timeout: 60000 });
    worker.close();
    return { onPage, inWorker };
  }, [...addModel(3)]);
  assert.deepEqual(ai, { onPage: [11, 22, 33], inWorker: [3, 3, 3] });

  step('mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.card-tile').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll on phones (overflow ${overflow}px)`);
  await shot('08-mobile');

  assert.deepEqual(errors, [], 'no browser errors');
  console.log('\nE2E passed');
} catch (err) {
  // FAIL_SHOT=path.png keeps a picture of the page at the moment a step failed.
  if (process.env.FAIL_SHOT) await page.screenshot({ path: process.env.FAIL_SHOT, fullPage: true }).catch(() => {});
  console.error('Browser errors so far:', errors);
  throw err;
} finally {
  await browser.close();
  await srv.stop();
  await mock.close();
  graderServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
