// Real detector + Tesseract + API, plus live camera lifecycle with a controllable video stream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../../server/app.js';
import { mockCatalog, startMockSources } from '../helpers/mock-sources.js';

const mock = await startMockSources();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-scanner-e2e-'));
const app = createApp({ dataDir, catalog: mockCatalog(mock), requireLogin: false });
const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  console.log('Open scanner');
  await page.goto(`${base}/#/scan`);
  await page.getByRole('heading', { name: 'Scan a deck' }).waitFor();
  await page.evaluate(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
  console.log('Upload three-card photo');
  await page.getByLabel('Upload deck photos').setInputFiles('docs/reference/three-cards.jpg');
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 3 && !document.querySelector('[aria-label="Upload deck photos"]').disabled, null, { timeout: 120000 });
  assert.equal(await page.locator('.scan-card').count(), 3);
  console.log('Photo scan complete');
  // Corrected identity is permitted; all cards still need explicit printing review.
  const first = page.locator('.scan-card').first();
  await first.getByLabel('Finish type').selectOption('reverse-holo');
  await first.getByLabel('Foil Pattern').selectOption('master-ball');
  await first.getByRole('button', { name: '+ Copy', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.page')?.dataset.sessionSaved === 'true');
  assert.ok((await page.locator('.scan-card').first().innerText()).includes('2 physical copies'));
  console.log('Reload for recovery');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 3);
  assert.equal(await page.locator('.scan-card').first().getByLabel('Foil Pattern').inputValue(), 'master-ball');
  await page.locator('.scan-card').first().getByLabel('I checked the card, finish and physical copy count').check();
  // Interrupt the response after the server committed; retry must return the same rows.
  console.log('Saving with dropped response');
  let interrupted = false;
  await page.route('**/api/cards', async (route) => {
    if (route.request().method() !== 'POST' || interrupted) return route.continue();
    interrupted = true; await route.fetch(); await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Save reviewed cards' }).click();
  await page.getByText('Save awaiting confirmation;', { exact: false }).waitFor();
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Save reviewed cards' }).click();
  await page.getByRole('button', { name: 'Add copies', exact: true }).click();
  await page.getByText('Saved to collection', { exact: true }).waitFor();
  const saved = await (await page.request.get(`${base}/api/cards`)).json();
  assert.equal(saved.cards.length, 2);
  assert.ok(saved.cards.every((c) => c.foil_pattern === 'master-ball' && c.market_price === null));
  console.log('Retry saved without duplication');
  // Move off page while waiting for permission: late camera stream must be stopped.
  await page.evaluate(() => {
    window.cameraStopped = false;
    navigator.mediaDevices.getUserMedia = async () => new Promise((resolve) => { window.resolveCamera = () => resolve({ getTracks: () => [{ stop: () => { window.cameraStopped = true; } }] }); });
  });
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.getByRole('link', { name: 'Collection', exact: true }).first().click();
  await page.evaluate(() => window.resolveCamera());
  await page.waitForFunction(() => window.cameraStopped);
  // Live stream of a real reference photo exercises stability, quality and repeated sightings.
  console.log('Open scanner');
  await page.goto(`${base}/#/scan`);
  await page.getByRole('heading', { name: 'Scan a deck' }).waitFor();
  console.log('Live camera stream');
  const photo = fs.readFileSync('docs/reference/three-cards.jpg').toString('base64');
  await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/jpeg;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; canvas.getContext('2d').drawImage(img, 0, 0);
    window.frameTimer = setInterval(() => canvas.getContext('2d').drawImage(img, 0, 0), 200);
    const stream = canvas.captureStream(2); window.testTrack = stream.getVideoTracks()[0]; window.testCanvas = canvas;
    navigator.mediaDevices.getUserMedia = async () => stream;
  }, photo);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((e) => e.textContent.includes('repeated sightings ignored')), null, { timeout: 120000 });
  assert.equal(await page.locator('.scan-card').count(), 3, 'repeated camera sightings do not duplicate the recovered scans');
  await page.getByRole('button', { name: 'Pause camera' }).click();
  assert.equal(await page.evaluate(() => window.testTrack.readyState), 'ended');
  console.log('Fresh live capture');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Upload deck photos"]').disabled);
  await page.getByRole('button', { name: 'Clear session', exact: true }).click();
  await page.getByRole('button', { name: 'Clear session', exact: true }).last().click();
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 0);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { const stream = window.testCanvas.captureStream(2); window.testTrack = stream.getVideoTracks()[0]; return stream; }; });
  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.scan-card').length === 3, null, { timeout: 120000 });
  await page.getByRole('button', { name: 'Pause camera' }).click();
  if (process.env.SCREENSHOTS) {
    for (const [name, width, dark] of [['desktop', 1440, false], ['phone', 390, false], ['phone-dark', 390, true]]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate((d) => document.documentElement.dataset.theme = d ? 'dark' : 'light', dark);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `docs/screenshots/25-scanner-${name}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    }
  }
  const packResponse = await page.request.post(`${base}/api/packs`, { multipart: { packs: JSON.stringify([{ name: 'Scanner test pack' }]) } });
  assert.equal(packResponse.status(), 201);
  const packId = (await packResponse.json()).packs[0].id;
  await page.goto(`${base}/#/packs/${packId}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('heading', { name: 'Edit pack', exact: true }).waitFor();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Updated scanner test pack');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Updated scanner test pack', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Scanner browser checks passed: real multi-card OCR, recovery, reviewed save, dropped-response retry, live capture, repeat protection and camera cleanup.');
} catch (err) { console.error('Scanner state:', await page.locator('body').innerText()); throw err; } finally {
  await browser.close(); await new Promise((r) => server.close(r)); app.locals.store.close(); await mock.close(); fs.rmSync(dataDir, { recursive: true, force: true });
}
