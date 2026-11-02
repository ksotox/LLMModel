// Collection management: duplicate check, copies grouped as ×N, pages, combined filters and
// presets, bulk changes, the trash with undo, and CSV export.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('collection management', () => {
  let mock;
  let catalog;
  let dataDir;
  let server;
  let base;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: res.status === 204 ? null : type.includes('json') ? await res.json() : await res.text() };
  };
  const add = async (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards));
    return (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
  };
  let ids;

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-collection-'));
    catalog = mockCatalog(mock);
    const app = createApp({ requireLogin: false, dataDir, catalog });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
    const cards = await add([
      { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo', condition: 'NM', purchase_price: 0.5 },
      { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo', condition: 'LP' },
      { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'normal' },
      { tcg_id: 'sv03-168', name: 'Linoone', grade_company: 'psa', grade: '10' },
      { name: 'Typed Pikachu', set_code: 'PAL', number: '063' },
    ]);
    ids = cards.map((c) => c.id);
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('duplicate check: same card and printing, including cards not linked yet', async () => {
    const { owned } = (await call('POST', '/api/cards/duplicates', { cards: [
      { tcg_id: 'sv02-066', variant: 'reverse-holo' },
      { tcg_id: 'sv02-066', variant: 'holo' },
      { name: 'typed pikachu', set_code: 'pal', number: '63/193' },
      { tcg_id: 'sv01-066', variant: 'normal' },
    ] })).body;
    assert.deepEqual(owned, [2, 0, 1, 0]);
  });

  test('copies are grouped as ×N, each row knows how many are owned, and pages work', async () => {
    const grouped = (await call('GET', '/api/cards?page=1&pageSize=2&group=1&sort=quantity')).body;
    assert.equal(grouped.total, 4, 'four different cards');
    assert.equal(grouped.cards.length, 2);
    assert.deepEqual([grouped.cards[0].name, grouped.cards[0].quantity, grouped.cards[0].ids.length], ['Voltorb', 2, 2]);
    const page2 = (await call('GET', '/api/cards?page=2&pageSize=2&group=1&sort=quantity')).body;
    assert.equal(page2.cards.length, 2);
    const flat = (await call('GET', '/api/cards?page=1&pageSize=50')).body;
    assert.equal(flat.total, 5);
    assert.equal(flat.cards.find((c) => c.condition === 'LP').owned, 2);
    const card = (await call('GET', `/api/cards/${ids[0]}`)).body;
    assert.deepEqual(card.copies.map((c) => c.condition), ['NM', 'LP'], 'the card page lists every copy');
    assert.deepEqual([card.purchase_price, card.grade_company], [0.5, null]);
    assert.equal((await call('GET', `/api/cards/${ids[3]}`)).body.grade_company, 'PSA');
  });

  test('filters combine, and the presets work', async () => {
    const q = async (qs) => (await call('GET', `/api/cards?${qs}`)).body.cards.map((c) => c.id).sort((a, b) => a - b);
    assert.deepEqual(await q('variant=reverse-holo&condition=LP'), [ids[1]]);
    assert.deepEqual(await q('duplicates=1'), [ids[0], ids[1]], 'duplicates: owned at least twice');
    assert.deepEqual(await q('duplicates=1&setCode=PAL&rarity=common&minValue=0.2'), [ids[0], ids[1]], 'set + rarity + value + duplicates together');
    assert.deepEqual(await q('graded=yes'), [ids[3]]);
    assert.deepEqual(await q('unmatched=1'), [ids[4]]);
    assert.deepEqual(await q('missingPrice=1'), [ids[4]]);
    assert.deepEqual(await q('type=Lightning&maxValue=0.1'), [ids[2]]);
    assert.deepEqual(await q(`addedFrom=${new Date().toISOString().slice(0, 10)}`), ids);
  });

  test('bulk changes: condition, storage place, trade plans and pack, only for the chosen cards', async () => {
    const pack = (await (await fetch(`${base}/api/packs`, { method: 'POST', body: (() => { const f = new FormData(); f.append('packs', JSON.stringify([{ name: 'Binder 1', kind: 'other' }])); return f; })() })).json()).packs[0];
    const r = await call('POST', '/api/cards/bulk', { ids: [ids[2], ids[4]], action: 'set', set: { condition: 'MP', storage_location: 'Binder 1, page 3', status: 'trade', pack_id: pack.id, name: 'not allowed' } });
    assert.equal(r.body.changed, 2);
    const changed = (await call('GET', `/api/cards?ids=${ids[2]},${ids[4]}`)).body.cards;
    assert.ok(changed.every((c) => c.condition === 'MP' && c.storage_location === 'Binder 1, page 3' && c.status === 'trade' && c.pack_id === pack.id));
    assert.equal(changed.find((c) => c.id === ids[4]).name, 'Typed Pikachu', 'only the allowed fields change');
    assert.deepEqual((await call('GET', '/api/cards?status=trade')).body.cards.length, 2);
    assert.equal((await call('POST', '/api/cards/bulk', { ids: [ids[2]], action: 'set', set: { condition: 'MINT-ISH' } })).body.changed, 1);
    assert.equal((await call('GET', `/api/cards/${ids[2]}`)).body.condition, null, 'unknown conditions are cleared, not stored');
  });

  test('the filter choices offered are the rarities, types and storage places in use', async () => {
    const { facets } = (await call('GET', '/api/meta')).body;
    assert.ok(facets.rarities.includes('Common'));
    assert.ok(facets.types.includes('Lightning'), `types split from "Lightning, …" lists: ${facets.types}`);
    assert.ok(facets.storage.includes('Binder 1, page 3'));
  });

  test('deleting goes to the trash, with undo; the trash can be listed', async () => {
    const r = await call('POST', '/api/cards/bulk', { ids: [ids[0], ids[1]], action: 'trash' });
    assert.deepEqual([r.body.changed, r.body.stats.cards, r.body.stats.in_trash], [2, 3, 2]);
    assert.equal((await call('GET', `/api/cards/${ids[0]}`)).status, 404);
    assert.deepEqual((await call('GET', '/api/cards?trash=1')).body.cards.map((c) => c.id).sort(), [ids[0], ids[1]].sort());
    assert.equal((await call('POST', '/api/cards/bulk', { ids: [ids[0], ids[1]], action: 'restore' })).body.changed, 2);
    assert.equal((await call('GET', `/api/cards/${ids[0]}`)).status, 200);
    assert.equal((await call('DELETE', `/api/cards/${ids[4]}`)).status, 204);
    assert.equal((await call('GET', '/api/meta')).body.stats.in_trash, 1);
  });

  test('copies of the same card and printing share one price lookup a day', async () => {
    await call('POST', `/api/cards/${ids[0]}/refresh-market`);
    const market = catalog.market;
    let lookups = 0;
    catalog.market = (...args) => { lookups++; return market.apply(catalog, args); };
    try {
      const second = (await call('POST', `/api/cards/${ids[1]}/refresh-market`)).body;
      assert.equal(lookups, 0, 'the second copy reuses today’s price');
      assert.equal(second.market_price, 0.25);
      await call('POST', `/api/cards/${ids[2]}/refresh-market`);
      assert.equal(lookups, 1, 'a different printing (normal) is looked up');
    } finally {
      catalog.market = market;
    }
  });

  test('CSV export of chosen cards, safe for spreadsheets', async () => {
    await call('PATCH', `/api/cards/${ids[3]}`, { notes: '=HYPERLINK("evil")' });
    const csv = (await call('GET', `/api/cards/export?ids=${ids[0]},${ids[3]}`)).body;
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^name,set_code,set_name,number/);
    assert.ok(lines.some((l) => l.startsWith('Linoone,OBF') && l.includes(`"'=HYPERLINK(""evil"")"`)), 'formulas are neutralised');
  });
});
