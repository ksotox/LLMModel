// End-to-end walkthrough in a real browser, using the reference photos in docs/reference:
// add a pack, upload a photo of three cards (auto-split) plus a single card, match them to their
// official versions, save, search, open a card, and confirm everything survives a server restart.
//
//   npm run test:e2e            (set SCREENSHOTS=1 to refresh docs/screenshots)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { mockCatalog, startMockSources } from '../helpers/mock-sources.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REF = (f) => path.join(ROOT, 'docs', 'reference', f);
const SHOTS = process.env.SCREENSHOTS ? path.join(ROOT, 'docs', 'screenshots') : null;

async function startServer(dataDir, mock, port = 0) {
  const app = createApp({ dataDir, catalog: mockCatalog(mock) });
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-e2e-'));
let srv = await startServer(dataDir, mock);
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

try {
  step('empty collection');
  await page.goto(base);
  await page.getByText('Your Pokédex is empty').waitFor();
  await shot('01-empty');

  step('choose a new pack and upload its photo');
  await page.getByRole('link', { name: '+ Add', exact: true }).click();
  await page.getByLabel('Pulled from').selectOption('new');
  await page.locator('.new-packs input[type=file]:not([capture])').setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await page.locator('.pack-item input[type=text]').first().fill('Paldea Evolved booster pack');

  step('upload a photo with three cards: they are detected and split automatically');
  const cardInput = page.locator('section.panel').nth(1).locator('input[type=file]:not([capture])');
  await cardInput.setInputFiles(REF('three-cards.jpg'));
  await page.getByText('3 cards found in this photo').waitFor();
  assert.equal(await page.locator('.card-item').count(), 3);

  const item = (i) => page.locator('.card-item').nth(i);
  const fill = async (i, { name, code, number }) => {
    if (name) await item(i).getByLabel('Name').fill(name);
    if (code) await item(i).getByLabel('Set code').fill(code);
    if (number) await item(i).getByLabel('Number').fill(number);
  };

  step('identify each card from the set code and number printed on it');
  await fill(0, { code: 'PAL', number: '066/193' });
  await fill(1, { code: 'PFL', number: '092/094' });
  await fill(2, { name: 'Linoone', number: '168/197' });
  for (const [i, name] of ['Voltorb', 'Punk Helmet', 'Linoone'].entries()) {
    await item(i).locator('.match-note', { hasText: `Official card: ${name}` }).waitFor();
  }
  assert.equal(await item(0).getByLabel('Name').inputValue(), 'Voltorb', 'name filled in from the match');

  step('add a single-card photo and pick between several name matches');
  await cardInput.setInputFiles(REF('voltorb-reverse-holo.jpg'));
  await page.locator('.source').nth(1).getByText('1 card in this photo').waitFor();
  await fill(3, { name: 'voltorb' });
  await item(3).locator('.lookup-result').nth(1).waitFor();
  assert.equal(await item(3).locator('.lookup-result').count(), 2);
  await item(3).locator('.lookup-result', { hasText: 'PAL' }).click();
  await item(3).getByLabel('Variant').selectOption('reverse-holo');
  await page.getByText('4 of 4 matched to an official card').waitFor();
  await shot('02-add-cards');

  step('adjust the split in the crop editor');
  await page.locator('.source').first().getByRole('button', { name: 'Adjust cards' }).click();
  await page.locator('.crop-box').nth(2).waitFor();
  assert.equal(await page.locator('.crop-box').count(), 3);
  await shot('03-crop-editor');
  await page.getByRole('button', { name: 'Use these 3 cards' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(await item(0).getByLabel('Name').inputValue(), 'Voltorb', 'entries kept after re-cropping');

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
  assert.match(await voltorbTile.locator('.card-pull').textContent(), /1\.\d% per pack · 1 in 93/);
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

  step('add packs on their own: several at once');
  await page.goto(`${base}/#/add-packs`);
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

  step('restart the server: everything is still there');
  await srv.stop();
  srv = await startServer(dataDir, mock, srv.port);
  await page.goto(base);
  await page.locator('.card-tile').nth(4).waitFor();
  assert.equal(await page.locator('.card-tile').count(), 5);
  const broken = await page.$$eval('.card-tile img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
  assert.equal(broken, 0, 'all card images load');

  step('mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.card-tile').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll on phones (overflow ${overflow}px)`);
  await shot('08-mobile');

  assert.deepEqual(errors, [], 'no browser errors');
  console.log('\nE2E passed');
} finally {
  await browser.close();
  await srv.stop();
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
