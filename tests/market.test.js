import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { priceFromTcgdex } from '../server/prices.js';
import { normaliseRarity, pullChance } from '../server/pullRates.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

// Rarity counts straight from the real Pokémon TCG dataset files in tests/fixtures.
function profile(setId, setCode, series) {
  const cards = JSON.parse(fs.readFileSync(new URL(`./fixtures/ptcg/cards/en/${setId}.json`, import.meta.url)));
  const counts = {};
  for (const c of cards) counts[normaliseRarity(c.rarity)] = (counts[normaliseRarity(c.rarity)] ?? 0) + 1;
  return { setCode, series, counts };
}
const PAL = profile('sv2', 'PAL', 'Scarlet & Violet');
const SVI = profile('sv1', 'SVI', 'Scarlet & Violet');
const TEF = profile('sv5', 'TEF', 'Scarlet & Violet');
const PFL = profile('me2', 'PFL', 'Mega Evolution');

describe('pull chance estimates', () => {
  test('a specific common: 4 commons per pack shared by every common in the set', () => {
    const p = pullChance({ rarity: 'Common', variant: 'normal', profile: PAL });
    assert.equal(PAL.counts.common, 81);
    assert.ok(Math.abs(p.chance - 4 / 81) < 1e-9);
    assert.equal(p.oneIn, 20);
    assert.match(p.source, /Scarlet & Violet/);
  });

  test('a reverse holo common shares the reverse slots with every common, uncommon and rare', () => {
    const p = pullChance({ rarity: 'Common', variant: 'reverse-holo', profile: PAL });
    const expected = (2 - 1 / 13 - 1 / 32) / (81 + 70 + 25);
    assert.ok(Math.abs(p.chance - expected) < 1e-9);
    assert.equal(p.oneIn, 93);
  });

  test('a regular rare gets what is left of the rare slot after the bigger hits', () => {
    const p = pullChance({ rarity: 'Rare', variant: 'holo', profile: PAL });
    assert.ok(Math.abs(p.chance - (1 - 1 / 7 - 1 / 15 - 1 / 54) / 25) < 1e-9);
  });

  test('matches TCGplayer’s per-card figures for special rarities', () => {
    assert.equal(pullChance({ rarity: 'Double Rare', profile: SVI }).oneIn, 84); // TCGplayer measured ~1 in 87
    assert.equal(pullChance({ rarity: 'ACE SPEC Rare', profile: TEF }).oneIn, 140); // ~1 in 140
    assert.equal(pullChance({ rarity: 'Special Illustration Rare', profile: PFL }).oneIn, 400); // ~1 in 400
    assert.equal(pullChance({ rarity: 'Mega Hyper Rare', profile: PFL }).oneIn, 1260);
    assert.match(pullChance({ rarity: 'Special Illustration Rare', profile: TEF }).source, /Temporal Forces/);
  });

  test('accepts TCGdex rarity spelling', () => {
    assert.equal(pullChance({ rarity: 'Double rare', profile: SVI }).oneIn, 84);
  });

  test('gives no estimate when it cannot be worked out', () => {
    assert.equal(pullChance({ rarity: 'Common', profile: { ...PAL, setCode: 'PRE' } }), null, 'special set layout');
    assert.equal(pullChance({ rarity: 'Common', profile: { ...PAL, setCode: 'DAA', series: 'Sword & Shield' } }), null, 'older era');
    assert.equal(pullChance({ rarity: 'ACE SPEC Rare', profile: PAL }), null, 'rarity not in the set');
    assert.equal(pullChance({ rarity: null, profile: PAL }), null);
    assert.equal(pullChance({ rarity: 'Common', profile: null }), null);
  });
});

describe('market price from TCGdex pricing', () => {
  const pricing = {
    tcgplayer: {
      unit: 'USD', updated: '2026-10-28',
      normal: { lowPrice: 0.02, midPrice: 0.1, highPrice: 2, marketPrice: 0.08 },
      'reverse-holofoil': { lowPrice: 0.1, midPrice: 0.3, marketPrice: 0.25 },
    },
    cardmarket: { unit: 'EUR', trend: 0.06, avg: 0.05, low: 0.02, 'trend-holo': 0.22 },
  };

  test('uses the TCGplayer line for the variant', () => {
    assert.deepEqual(
      { ...priceFromTcgdex(pricing, 'reverse-holo') },
      { value: 0.25, currency: 'USD', low: 0.1, high: null, source: 'TCGplayer market price (reverse holo)', updated: '2026-10-28' },
    );
    assert.equal(priceFromTcgdex(pricing, 'normal').value, 0.08);
  });

  test('falls back to another TCGplayer line, then to Cardmarket', () => {
    assert.equal(priceFromTcgdex({ tcgplayer: { unit: 'USD', holofoil: { midPrice: 4 } } }, 'normal').value, 4);
    const cm = priceFromTcgdex({ tcgplayer: null, cardmarket: pricing.cardmarket }, 'reverse-holo');
    assert.deepEqual([cm.value, cm.currency], [0.22, 'EUR']);
    assert.equal(priceFromTcgdex({ cardmarket: pricing.cardmarket }, 'normal').value, 0.06);
  });

  test('no pricing, no price', () => {
    assert.equal(priceFromTcgdex(undefined), null);
    assert.equal(priceFromTcgdex({ tcgplayer: { unit: 'USD', normal: { marketPrice: 0 } } }), null);
  });
});

describe('card catalog with a second source', () => {
  let mock;
  let catalog;

  before(async () => {
    mock = await startMockSources();
    catalog = mockCatalog(mock);
  });
  after(() => mock.close());

  test('finds cards in the Pokémon TCG dataset by set code and number', async () => {
    const [hit] = await catalog.ptcg.search({ setCode: 'PAL', number: '066/193' });
    assert.deepEqual(
      { id: hit.tcgId, name: hit.name, number: hit.number, total: hit.setTotal, rarity: hit.rarity, source: hit.source },
      { id: 'ptcg:sv2-66', name: 'Voltorb', number: '066', total: '193', rarity: 'Common', source: 'pokemontcg' },
    );
  });

  test('finds the set from the printed total, and by name alone', async () => {
    assert.deepEqual((await catalog.ptcg.search({ number: '168/197' })).map((r) => r.tcgId), ['ptcg:sv3-168']);
    // The real set has two Punk Helmet prints: the regular #92 and the full-art #121.
    const helmets = await catalog.ptcg.search({ name: 'punk helmet' });
    assert.deepEqual(helmets.map((r) => [r.tcgId, r.rarity]), [['ptcg:me2-92', 'Uncommon'], ['ptcg:me2-121', 'Ultra Rare']]);
  });

  test('details from the Pokémon TCG dataset are normalised like TCGdex ones', async () => {
    const d = await catalog.details('ptcg:me2-92');
    assert.deepEqual(
      { name: d.name, set: d.set_name, code: d.set_code, number: `${d.number}/${d.set_total}`, category: d.category, rarity: d.rarity },
      { name: 'Punk Helmet', set: 'Phantasmal Flames', code: 'PFL', number: '092/094', category: 'Trainer', rarity: 'Uncommon' },
    );
    assert.match(d.official_image_url, /\/ptcg-images\/me2\/92_hires\.png$/);
  });

  test('borrows the image when TCGdex has none', async () => {
    const [hit] = await catalog.search({ setCode: 'PFL', number: '092/094' });
    assert.equal(hit.tcgId, 'me02-092');
    assert.equal(hit.imageSource, 'pokemontcg');
    assert.match(hit.image, /\/ptcg-images\/me2\/92_hires\.png$/);
    const details = await catalog.details('me02-092');
    assert.match(details.official_image_url, /\/ptcg-images\//);
  });

  test('falls back to the Pokémon TCG dataset when TCGdex is down', async () => {
    mock.state.tcgdexDown = true;
    try {
      const fresh = mockCatalog(mock);
      const results = await fresh.search({ setCode: 'OBF', number: '168/197' });
      assert.deepEqual(results.map((r) => [r.tcgId, r.source]), [['ptcg:sv3-168', 'pokemontcg']]);
    } finally {
      mock.state.tcgdexDown = false;
    }
  });

  test('promos: TCGplayer’s picture and dollar price when the other sources have none', async () => {
    const froakie = await catalog.details('mep-060');
    assert.equal(froakie.official_image_url, null, 'no picture on TCGdex or in the dataset');
    const images = await catalog.fallbackImages(froakie);
    assert.deepEqual(images.map((u) => new URL(u).pathname), [
      '/tcgplayer-cdn/product/77060_in_1000x1000.jpg', '/tcgplayer-cdn/product/77060_400w.jpg', '/tcgplayer-cdn/product/77060_200w.jpg',
    ], 'found by the set’s TCGplayer group and the digits of "MEP 060"');
    const { price } = await catalog.market({ ...froakie, variant: 'promo' });
    assert.deepEqual([price.value, price.currency], [6.89, 'USD']);
    assert.match(price.source, /tcgcsv/);

    // A listing with the number only in its name.
    const fennekin = await catalog.fallbackImages({ set_code: 'MEP', set_name: 'MEP Black Star Promos', number: '059', name: 'Fennekin' });
    assert.ok(fennekin.some((u) => u.endsWith('/77059_in_1000x1000.jpg')));
    assert.deepEqual(await catalog.fallbackImages({ set_code: 'MEP', number: '059', name: 'Chespin' }), [], 'wrong name, no picture');
  });

  test('market info: rarity, pull chance and price for each reference card', async () => {
    const voltorb = await catalog.market({ ...(await catalog.details('sv02-066')), variant: 'reverse-holo' });
    assert.equal(voltorb.rarity, 'Common');
    assert.equal(voltorb.pull.oneIn, 93);
    assert.deepEqual([voltorb.price.value, voltorb.price.currency], [0.25, 'USD']);

    const helmet = await catalog.market({ ...(await catalog.details('me02-092')), variant: 'normal' });
    // Only a Cardmarket price (€0.15): shown in dollars at the day's rate (1.20 in the mock).
    assert.deepEqual([helmet.price.value, helmet.price.currency, helmet.price.source], [0.18, 'USD', 'Cardmarket price trend, converted from €0.15']);
    assert.equal(helmet.pull.oneIn, Math.round(31 / 3)); // 3 uncommons per pack, 31 uncommons in the set

    // TCGdex has no price for Linoone: the tcgcsv.com backup is used.
    const linoone = await catalog.market({ ...(await catalog.details('sv03-168')), variant: 'normal' });
    assert.deepEqual([linoone.price.value, linoone.price.currency], [0.12, 'USD']);
    assert.match(linoone.price.source, /tcgcsv/);
    const reverse = await catalog.market({ ...(await catalog.details('sv03-168')), variant: 'reverse-holo' });
    assert.equal(reverse.price.value, 0.3);
  });
});

describe('market API', () => {
  let mock;
  let dataDir;
  let app;
  let server;
  let base;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const addCards = (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards));
    return fetch(`${base}/api/cards`, { method: 'POST', body: form }).then(async (r) => ({ status: r.status, body: await r.json() }));
  };

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-market-'));
    app = createApp({ dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.store.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('looks up any card with its rarity, pull chance and price', async () => {
    const { status, body } = await call('GET', '/api/catalog/cards/sv02-066?variant=reverse-holo');
    assert.equal(status, 200);
    assert.equal(body.card.name, 'Voltorb');
    assert.equal(body.market.rarity, 'Common');
    assert.equal(body.market.pull.oneIn, 93);
    assert.equal(body.market.price.value, 0.25);
    assert.equal(body.owned, 0);
    assert.equal((await call('GET', '/api/catalog/cards/ptcg:me2-92')).body.card.set_code, 'PFL');
    assert.equal((await call('GET', '/api/catalog/cards/sv02-999')).status, 404);
  });

  test('cards added without a photo get rarity, pull chance and price saved', async () => {
    const { status, body } = await addCards([
      { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo' },
      { tcg_id: 'ptcg:me2-92', name: 'Punk Helmet' },
      { name: 'Linoone', set_code: 'OBF', number: '168', set_total: '197' }, // typed in, not linked
    ]);
    assert.equal(status, 201);
    const [voltorb, helmet, linoone] = body.cards;
    assert.deepEqual(
      [voltorb.rarity, voltorb.market_price, voltorb.market_currency, Math.round(1 / voltorb.pull_chance)],
      ['Common', 0.25, 'USD', 93],
    );
    assert.match(voltorb.pull_source, /TCGplayer/);
    assert.equal(voltorb.official_url, '/media/official/sv02-066.png');
    assert.equal(helmet.official_url, '/media/official/ptcg_me2-92.png', 'image from the second source, kept locally');
    assert.equal(helmet.rarity, 'Uncommon');
    assert.equal(linoone.rarity, 'Uncommon', 'rarity found from set code + number');
    assert.equal(linoone.market_price, 0.12);

    const lookup = await call('GET', '/api/lookup?setCode=PAL&number=066/193');
    assert.equal(lookup.body.results[0].owned, 1);
  });

  test('changing the variant re-prices the card', async () => {
    const [voltorb] = (await call('GET', '/api/cards?q=voltorb')).body.cards;
    const { body } = await call('PATCH', `/api/cards/${voltorb.id}`, { variant: 'normal' });
    assert.equal(body.market_price, 0.08);
    assert.equal(Math.round(1 / body.pull_chance), 20);
  });

  test('collection value and sorting by value', async () => {
    const meta = (await call('GET', '/api/meta')).body;
    assert.equal(meta.stats.value_usd, 0.38); // 0.08 + 0.12 + 0.18 (Punk Helmet's €0.15 in dollars)
    assert.equal(meta.stats.value_eur, 0);
    const names = (await call('GET', '/api/cards?sort=value')).body.cards.map((c) => c.name);
    assert.deepEqual(names, ['Punk Helmet', 'Linoone', 'Voltorb']);
  });

  test('refreshes prices for one card or the whole collection', async () => {
    const [card] = (await call('GET', '/api/cards?q=linoone')).body.cards;
    const one = await call('POST', `/api/cards/${card.id}/refresh-market`);
    assert.equal(one.body.market_price, 0.12);
    const all = await call('POST', '/api/cards/refresh-market');
    assert.equal(all.body.updated, 3);
  });

  test('links cards saved without their official card and fetches the image', async () => {
    const { body } = await addCards([
      { name: 'Froakie', number: '060/000', variant: 'promo' }, // promo typed with a "/000" total
      { name: 'Electrode', number: '067', set_total: '193' }, // no set code: the total and name find it
      { name: 'Pikachu', set_code: 'PAL', number: '066', set_total: '193' }, // number is Voltorb's: name disagrees
    ]);
    const [froakie, electrode, pikachu] = body.cards;
    assert.deepEqual([froakie.number, froakie.set_total], ['060', null], 'a zero total is no total');

    const one = (await call('POST', `/api/cards/${froakie.id}/refresh-market`)).body;
    assert.equal(one.tcg_id, 'mep-060');
    assert.equal(one.official_url, '/media/official/mep-060.png');
    assert.equal(one.name, 'Froakie');

    const all = (await call('POST', '/api/cards/refresh-market')).body;
    assert.ok(all.linked >= 1);
    const after = (id) => call('GET', `/api/cards/${id}`).then((r) => r.body);
    const e = await after(electrode.id);
    assert.deepEqual([e.tcg_id, e.set_code, e.official_url], ['sv02-067', 'PAL', '/media/official/sv02-067.png']);
    const p = await after(pikachu.id);
    assert.equal(p.tcg_id, null, 'not linked when the name doesn’t match');
    assert.equal(p.official_url, null);
    await call('DELETE', `/api/cards/${pikachu.id}`);
  });

  test('keeps the last known price when the sources are unreachable', async () => {
    mock.state.tcgdexDown = true;
    try {
      const [card] = (await call('GET', '/api/cards?q=voltorb')).body.cards;
      const { body } = await call('POST', `/api/cards/${card.id}/refresh-market`);
      assert.equal(body.market_price, 0.08);
    } finally {
      mock.state.tcgdexDown = false;
    }
  });
});
