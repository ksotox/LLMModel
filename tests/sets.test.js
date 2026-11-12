// Set completion: checklists from TCGdex with what the user owns, goals, duplicates, missing value.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('set completion', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  const get = async (p) => (await fetch(base + p)).json();
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-sets-'));
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    form.append('cards', JSON.stringify([
      { tcg_id: 'sv02-066', name: 'Voltorb' }, { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo' },
      { tcg_id: 'sv02-200', name: 'Bellibolt ex' }, { tcg_id: 'ja:SV2a-100', name: 'ビリリダマ' },
    ]));
    await fetch(`${base}/api/cards`, { method: 'POST', body: form });
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('your sets, with main-set completion, English and Japanese', async () => {
    const { sets } = await get('/api/sets');
    const pal = sets.find((s) => s.code === 'PAL');
    assert.deepEqual([pal.lang, pal.setId, pal.owned, pal.total, pal.copies], ['en', 'sv02', 1, 193, 3], 'the secret rare #200 isn’t in the 193');
    const jp = sets.find((s) => s.lang === 'ja');
    assert.deepEqual([jp.code, jp.owned, jp.total], ['SV2a', 1, 165]);
  });

  test('a checklist: owned and missing, duplicates, secret rares, goals', async () => {
    const c = await get('/api/sets/en/sv02');
    assert.equal(c.code, 'PAL');
    const voltorb = c.cards.find((x) => x.number === '066');
    assert.deepEqual([voltorb.owned, voltorb.ownedReverse, voltorb.variants.sort()], [2, 1, ['normal', 'reverse-holo']]);
    assert.equal(c.cards.find((x) => x.number === '200').secret, true);
    assert.deepEqual([c.goals.main.owned, c.goals.main.total], [1, 3], 'Pawmot, Voltorb, Electrode; Bellibolt is a secret rare');
    assert.deepEqual([c.goals.master.owned, c.goals.master.total], [2, 4]);
    assert.equal(c.duplicates, 1);
    assert.equal(c.missing, 2);
    assert.equal(c.missingValue, null, 'only when asked');
  });

  test('estimated value of the missing cards, on request', async () => {
    const c = await get('/api/sets/en/sv02?values=1');
    assert.equal(c.missingPriced, 0, 'the mock has no prices for Pawmot or Electrode');
    const jp = await get('/api/sets/ja/SV2a?values=1');
    assert.equal(jp.cards.find((x) => x.number === '100').owned, 1);
    assert.equal(jp.missing, 2);
  });

  test('a set the dataset doesn’t have gets its rarities from TCGdex', async () => {
    const c = await get('/api/sets/en/me01');
    assert.equal(c.code, 'MEG');
    assert.equal(c.cards.find((x) => x.number === '086').rarity, 'Double rare');
  });

  test('browse every set; unknown sets are a 404', async () => {
    const { sets } = await get('/api/sets/en/all');
    assert.ok(sets.some((s) => s.setId === 'sv02' && s.code === 'PAL' && s.total === 193));
    assert.equal((await fetch(`${base}/api/sets/en/nope`)).status, 404);
  });
});
