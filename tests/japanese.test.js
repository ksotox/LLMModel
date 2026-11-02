// Japanese cards: recognised from their printed code ("SV2a 100/165") and Japanese name, found in
// TCGdex's Japanese database, saved with their picture, a price in dollars and their printings.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { findJapaneseSetCode, identifyCard, nameCandidates, nameSimilarity } from '../server/identify.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('reading Japanese cards', () => {
  test('Japanese set codes, including OCR’s usual slips', () => {
    assert.equal(findJapaneseSetCode(['G SV2a 100/165 C']), 'SV2A');
    assert.equal(findJapaneseSetCode(['5V4a 190/190', 'SV4a 190/190']), 'SV4A');
    assert.equal(findJapaneseSetCode(['M1L 063/063']), 'M1L');
    assert.equal(findJapaneseSetCode(['001/SV-P']), 'SV-P');
    assert.equal(findJapaneseSetCode(['PAL EN 066/193']), null, 'English codes are not Japanese');
  });

  test('Japanese names are kept and compared in Japanese', () => {
    assert.ok(nameCandidates(['ビリリダマ HP60']).includes('ビリリダマ'));
    assert.equal(nameSimilarity('ビリリダマ', 'ビリリダマ'), 1);
    assert.ok(nameSimilarity('ビリリダマ', 'ピカチュウ') < 0.3);
    assert.ok(nameSimilarity('ﾋﾟｶﾁｭｳ', 'ピカチュウ') === 1, 'half-width katakana counts as the same');
  });
});

describe('Japanese cards in the app', () => {
  let mock;
  let catalog;
  let dataDir;
  let server;
  let base;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const addCards = async (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards));
    return (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
  };

  before(async () => {
    mock = await startMockSources();
    catalog = mockCatalog(mock);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ja-'));
    const app = createApp({ requireLogin: false, dataDir, catalog });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('identified from the code and number, with or without the name read in Japanese', async () => {
    const withName = await identifyCard(catalog, { names: ['ビリリダマ'], lines: ['G SV2a 100/165 C'] });
    assert.deepEqual([withName.match?.tcgId, withName.confidence], ['ja:SV2a-100', 'high']);
    // English OCR of a Japanese name is noise: code + number + total are enough on their own.
    const noName = await identifyCard(catalog, { names: ['Bkg +7 HP60'], lines: ['SV2a 100/165'] });
    assert.deepEqual([noName.match?.tcgId, noName.confidence], ['ja:SV2a-100', 'high']);
    assert.equal(noName.match.language, 'ja');
    // As read off a real-looking photo: the corner alone ("SV") must not turn it into English SVI.
    const photo = await identifyCard(catalog, { names: ['EYy§<'], lines: ['l SV2a 100/165 C', 'SV', 'SV'] });
    assert.deepEqual([photo.read.setCode, photo.match?.tcgId, photo.confidence], ['SV2A', 'ja:SV2a-100', 'high']);
    // Not the English 151 card with the same number (it's also /165).
    assert.ok(!noName.candidates.some((c) => c.language !== 'ja'));
  });

  test('a name that disagrees wins over the number (to be checked), and a number alone isn’t enough', async () => {
    // The name says Pikachu, the number says Voltorb: Pikachu from that set, flagged "please check".
    const wrongName = await identifyCard(catalog, { names: ['ピカチュウ'], lines: ['SV2a 100/165'] });
    assert.deepEqual([wrongName.match?.tcgId, wrongName.confidence], ['ja:SV2a-025', 'medium']);
    const noTotal = await identifyCard(catalog, { names: [], lines: ['SV2a 100'] });
    assert.notEqual(noTotal.confidence, 'high');
  });

  test('looked up by code + number, by Japanese name, or with the language set', async () => {
    const byCode = (await call('GET', '/api/lookup?setCode=SV2a&number=100/165')).body.results;
    assert.deepEqual(byCode.map((r) => [r.tcgId, r.name, r.setCode, r.setTotal, r.language]), [['ja:SV2a-100', 'ビリリダマ', 'SV2a', '165', 'ja']]);
    assert.match(byCode[0].image, /\/assets\/ja\/SV\/SV2a\/100\/high\.png$/);
    const byName = (await call('GET', `/api/lookup?name=${encodeURIComponent('ピカチュウ')}`)).body.results;
    assert.deepEqual(byName.map((r) => r.tcgId).sort(), ['ja:SV-P-001', 'ja:SV2a-025']);
    const english = (await call('GET', '/api/lookup?name=voltorb')).body.results;
    assert.ok(english.every((r) => r.language === 'en'), 'English names still find English cards');
    const forcedJa = (await call('GET', '/api/lookup?setCode=SV2a&number=025&lang=ja')).body.results;
    assert.equal(forcedJa[0].tcgId, 'ja:SV2a-025');
  });

  test('saved with its Japanese picture, a price in dollars, no pull chance, and its printings', async () => {
    const [card] = await addCards([{ tcg_id: 'ja:SV2a-100', name: 'ビリリダマ' }]);
    assert.deepEqual([card.language, card.set_code, card.number, card.set_total], ['ja', 'SV2a', '100', '165']);
    assert.equal(card.official_url, '/media/official/ja_SV2a-100.png');
    assert.equal((await fetch(base + card.official_url)).status, 200);
    assert.deepEqual([card.market_price, card.market_currency], [0.36, 'USD'], 'Cardmarket €0.30 at 1.20');
    assert.equal(card.pull_chance, null, 'Japanese packs differ: no estimate');
    const printings = (await call('GET', '/api/catalog/cards/ja:SV2a-100/printings')).body;
    assert.deepEqual(printings.allowed, ['normal', 'reverse-holo']);
    assert.ok(printings.notes.some((n) => /Poké Ball pattern/.test(n)));
    assert.equal((await call('GET', '/api/catalog/cards/ja:SV2a-205/printings')).body.fixed, 'full-art');
    assert.equal((await call('GET', '/api/catalog/cards/ja:SV-P-001/printings')).body.fixed, 'promo');
    const found = (await call('GET', '/api/cards?q=japanese')).body.cards;
    assert.deepEqual(found.map((c) => c.id), [card.id], '"japanese" finds Japanese cards');
  });

  test('a Japanese card typed in by hand is matched on the next price update', async () => {
    const [typed] = await addCards([{ name: 'ピカチュウ', set_code: 'SV2a', number: '025/165' }]);
    assert.equal(typed.tcg_id, null);
    const linked = (await call('POST', `/api/cards/${typed.id}/refresh-market`)).body;
    assert.deepEqual([linked.tcg_id, linked.language], ['ja:SV2a-025', 'ja']);
    assert.equal(linked.official_url, '/media/official/ja_SV2a-025.png');
  });
});
