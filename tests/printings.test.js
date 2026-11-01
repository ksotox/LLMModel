import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { printingsFor } from '../server/printings.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('which printings a card exists in', () => {
  test('TCGdex’s variant list: a common is normal or reverse holo', () => {
    const p = printingsFor({ variantsDetailed: [{ type: 'normal' }, { type: 'reverse' }], rarity: 'Common', number: '066', setTotal: '193' });
    assert.deepEqual(p.allowed, ['normal', 'reverse-holo']);
    assert.equal(p.fixed, null);
    assert.equal(p.source, 'TCGdex');
  });

  test('the older yes/no form, and TCGplayer price lines when there is no list', () => {
    assert.deepEqual(printingsFor({ variants: { normal: false, reverse: true, holo: true, firstEdition: false } }).allowed, ['reverse-holo', 'holo']);
    assert.deepEqual(printingsFor({ priceLines: ['holofoil', 'reverseHolofoil'] }).allowed, ['holo', 'reverse-holo']);
    assert.deepEqual(printingsFor({}).allowed, [], 'unknown: anything goes');
  });

  test('a single printing is fixed', () => {
    const p = printingsFor({ variantsDetailed: [{ type: 'holo' }], rarity: 'Rare' });
    assert.equal(p.fixed, 'holo');
    assert.match(p.reason, /only printed as holo/);
  });

  test('ex cards are holo; Illustration Rares and secret rares are full art; promos are Promo', () => {
    assert.equal(printingsFor({ rarity: 'Double Rare' }).fixed, 'holo');
    assert.equal(printingsFor({ rarity: 'Special Illustration Rare', variantsDetailed: [{ type: 'holo' }] }).fixed, 'full-art');
    const secret = printingsFor({ rarity: 'Rare', number: '190', setTotal: '182' });
    assert.equal(secret.fixed, 'full-art');
    assert.match(secret.reason, /190\/182/);
    assert.equal(printingsFor({ setName: 'MEP Black Star Promos', setId: 'mep', number: '060' }).fixed, 'promo');
  });

  test('pattern foils and stamps are pointed out', () => {
    const p = printingsFor({ variantsDetailed: [{ type: 'normal' }, { type: 'reverse' }, { type: 'reverse', foil: 'masterball' }, { type: 'normal', stamp: ['pre-release'] }] });
    assert.deepEqual(p.allowed, ['normal', 'reverse-holo']);
    assert.ok(p.notes.some((n) => /Master Ball pattern reverse holo/.test(n)));
    assert.ok(p.notes.some((n) => /pre release/.test(n)));
  });
});

describe('printings API', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-printings-'));
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const get = async (id) => { const r = await fetch(`${base}/api/catalog/cards/${id}/printings`); return { status: r.status, body: await r.json() }; };

  test('from TCGdex, from rarity, for promos, for a card only in the second source, and unknown cards', async () => {
    assert.deepEqual((await get('sv02-066')).body.allowed, ['normal', 'reverse-holo']);
    assert.deepEqual((await get('sv02-065')).body.allowed, ['holo', 'reverse-holo']);
    assert.equal((await get('sv02-200')).body.fixed, 'full-art');
    assert.equal((await get('mep-060')).body.fixed, 'promo');
    const pattern = (await get('sv01-066')).body;
    assert.ok(pattern.notes.some((n) => /Poké Ball pattern/.test(n)));
    assert.deepEqual((await get('ptcg:sv2-66')).body.allowed, ['normal', 'reverse-holo'], 'looked up on TCGdex');
    assert.equal((await get('sv02-999')).status, 404);
  });
});
