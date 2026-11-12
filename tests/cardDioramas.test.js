// Card dioramas for 3D Pop-out (server/cardDioramas.js): delivered pictures for the owner's cards,
// and one free in-browser job per new card, made once per card identity.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { CardDioramas, dioramaFingerprint } from '../server/cardDioramas.js';
import { openDb } from '../server/db.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

const WEBP = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');

describe('card dioramas: the delivered pictures', () => {
  test('imported only for the card they were made for (same id, and same name or card id)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dioramas-'));
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets);
    for (const id of [1, 2, 3]) fs.writeFileSync(path.join(assets, `${id}.webp`), WEBP);
    fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify({ cards: [
      { id: 1, name: 'Meowstic', tcg_id: 'me04-037', file: '1.webp' },
      { id: 2, name: 'Chespin', tcg_id: 'mep-058', file: '2.webp' }, // this collection's #2 is another card
      { id: 3, name: 'Froakie', tcg_id: 'mep-060', file: '3.webp' }, // no #3 in this collection
    ] }));
    const store = openDb(':memory:');
    try {
      const a = store.insertCard({ name: 'Meowstic', tcg_id: 'me04-037', official_image_path: 'official/me04-037.png', user_id: 1 });
      const b = store.insertCard({ name: 'Voltorb', tcg_id: 'sv02-066', official_image_path: 'official/sv02-066.png', user_id: 1 });
      assert.deepEqual([a, b], [1, 2]);
      const logs = [];
      const dioramas = new CardDioramas({ db: store.db, dataDir: dir, assetsDir: assets, log: (m) => logs.push(m) });
      const result = dioramas.importBundled();
      assert.equal(result.imported, 1);
      assert.match(result.skipped[0], /#2 Chespin/);
      const list = dioramas.list(1);
      assert.deepEqual(Object.keys(list), ['1']);
      assert.equal(list[1].status, 'ready');
      assert.equal(list[1].source, 'bundled');
      assert.ok(fs.existsSync(path.join(dir, 'card-effects', 'bundled-1.webp')));
      assert.equal(dioramas.importBundled().imported, 0, 'never imported twice');
      // A price or storage change keeps it; nothing is queued.
      store.updateCard(1, { purchase_price: 3, storage_location: 'Binder 1' });
      assert.equal(dioramas.sync(1).status, 'ready');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fingerprint follows identity and picture, not price', () => {
    const card = { name: 'Voltorb', tcg_id: 'sv02-066', types: 'Lightning', official_image_url: 'https://x/high.png', market_price: 1 };
    assert.equal(dioramaFingerprint(card), dioramaFingerprint({ ...card, market_price: 9, notes: 'mint' }));
    assert.notEqual(dioramaFingerprint(card), dioramaFingerprint({ ...card, tcg_id: 'sv01-066' }));
  });
});

describe('card dioramas: one free job per new card', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  let app;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-dioramas-'));
    app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const json = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  test('adding a card queues exactly one job; the browser makes it; price edits never repeat it', async () => {
    const form = new FormData();
    form.append('cards', JSON.stringify([{ tcg_id: 'sv02-066', name: 'Voltorb' }]));
    const [card] = (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
    assert.equal((await json('GET', '/api/card-effects')).body.cards[card.id].status, 'pending', 'saving the card didn’t wait for it');

    const { jobs } = (await json('POST', '/api/card-effects/jobs', { limit: 3 })).body;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].cardId, card.id);
    assert.match(jobs[0].card.picture, /^\/media\/official\//, 'made from the official picture, served by the app itself');
    assert.equal((await json('POST', '/api/card-effects/jobs')).body.jobs.length, 0, 'a claimed job isn’t handed out twice');

    // A stale result (made for an older identity) is refused.
    const stale = await fetch(`${base}/api/card-effects/${card.id}`, { method: 'PUT', headers: { 'content-type': 'image/webp', 'x-fingerprint': 'old' }, body: WEBP });
    assert.equal(stale.status, 409);
    const done = await fetch(`${base}/api/card-effects/${card.id}`, { method: 'PUT', headers: { 'content-type': 'image/webp', 'x-fingerprint': jobs[0].fingerprint }, body: WEBP });
    assert.equal(done.status, 200);
    const entry = (await json('GET', '/api/card-effects')).body.cards[card.id];
    assert.deepEqual([entry.status, entry.source], ['ready', 'generated']);
    const picture = await fetch(base + entry.url);
    assert.equal(picture.status, 200);
    assert.equal(picture.headers.get('content-type'), 'image/webp');

    // Editing the price or storage doesn't make it again; relinking to another card does.
    await json('PATCH', `/api/cards/${card.id}`, { purchase_price: 2.5, storage_location: 'Box' });
    assert.equal((await json('GET', '/api/card-effects')).body.cards[card.id].status, 'ready');
    await json('PATCH', `/api/cards/${card.id}`, { tcg_id: 'sv01-066' });
    assert.equal((await json('GET', '/api/card-effects')).body.cards[card.id].status, 'pending');
  });

  test('a failed job leaves the card usable and can be retried on purpose', async () => {
    const form = new FormData();
    form.append('cards', JSON.stringify([{ tcg_id: 'sv03-168', name: 'Linoone' }]));
    const [card] = (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
    const job = (await json('POST', '/api/card-effects/jobs', { limit: 5 })).body.jobs.find((j) => j.cardId === card.id);
    await json('POST', `/api/card-effects/${card.id}/failed`, { fingerprint: job.fingerprint, error: 'Canvas blocked' });
    const failed = (await json('GET', '/api/card-effects')).body.cards[card.id];
    assert.deepEqual([failed.status, failed.error], ['failed', 'Canvas blocked']);
    assert.equal((await json('GET', `/api/cards/${card.id}`)).status, 200, 'the card itself is fine');
    assert.equal((await json('POST', '/api/card-effects/jobs', { limit: 5 })).body.jobs.some((j) => j.cardId === card.id), false, 'not retried by itself');
    assert.equal((await json('POST', `/api/card-effects/${card.id}/request`)).body.status, 'pending');
    assert.ok((await json('POST', '/api/card-effects/jobs', { limit: 5 })).body.jobs.some((j) => j.cardId === card.id));
  });

  test('other people’s cards and files are out of reach', async () => {
    assert.equal((await json('POST', '/api/card-effects/99999/request')).status, 404);
    assert.equal((await fetch(`${base}/api/card-effects/images/..%2Fcollection.db`)).status, 404);
  });
});
