import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { PriceTrackerClient, gradeLabel, normalizeCard } from '../server/priceTracker.js';
import { createScheduler } from '../server/scheduler.js';
import { PPT_CARDS, mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('reading PokemonPriceTracker answers', () => {
  test('grade keys become readable grades', () => {
    assert.equal(gradeLabel('psa10'), 'PSA 10');
    assert.equal(gradeLabel('cgc9_5'), 'CGC 9.5');
    assert.equal(gradeLabel('cgc9.5'), 'CGC 9.5');
    assert.equal(gradeLabel('bgs10'), 'BGS 10');
    assert.equal(gradeLabel('ungraded'), 'Ungraded');
  });

  test('layout with history per condition, graded sales, population and sales', () => {
    const card = normalizeCard(PPT_CARDS[0], { printing: 'Reverse Holofoil' });
    assert.equal(card.tcgPlayerId, '497654');
    assert.deepEqual(card.market, { price: 0.24, low: 0.05, condition: 'Near Mint', printing: 'Reverse Holofoil', updated: '2026-10-29T08:00:00.000Z' });
    assert.deepEqual(card.history, [{ day: '2026-10-27', price: 0.22 }, { day: '2026-10-28', price: 0.23 }, { day: '2026-10-29', price: 0.24 }]);
    assert.equal(card.historyLabel, 'Near Mint', 'Near Mint is preferred over Lightly Played');
    assert.deepEqual(card.gradedSales.map((g) => [g.grade, g.count, g.average]), [['PSA 10', 12, 24.5], ['CGC 9.5', 2, 12], ['PSA 9', 8, 9.75]]);
    assert.equal(card.gradedSales[1].market, 11.5, 'smartMarketPrice');
    assert.deepEqual(card.population, [{ grade: 'PSA 10', count: 143 }, { grade: 'PSA 9', count: 210 }, { grade: 'PSA 8', count: 40 }]);
    assert.equal(card.sales.length, 2);
    assert.deepEqual(card.sales[0], { title: 'Voltorb 066/193 PSA 10 GEM MINT Paldea Evolved', price: 25, soldAt: '2026-10-25', grade: 'PSA 10', url: 'https://www.ebay.com/itm/880001', itemId: null });
  });

  test('layout with a plain history list, string prices and nested set', () => {
    const card = normalizeCard(PPT_CARDS[1]);
    assert.equal(card.market.price, 0.14);
    assert.equal(card.setName, 'Obsidian Flames');
    assert.equal(card.number, '168/197');
    assert.deepEqual(card.history.map((p) => p.day), ['2026-10-28', '2026-10-29']);
    assert.deepEqual(card.gradedSales, []);
  });

  test('history keyed by printing: the card’s own printing wins', () => {
    const card = normalizeCard({
      priceHistory: {
        Normal: { 'Near Mint': [{ date: '2026-10-29', market: 0.1 }] },
        'Reverse Holofoil': { 'Near Mint': [{ date: '2026-10-29', market: 0.3 }] },
      },
    }, { printing: 'Reverse Holofoil' });
    assert.deepEqual(card.history, [{ day: '2026-10-29', price: 0.3 }]);
    assert.equal(card.historyLabel, 'Reverse Holofoil · Near Mint');
  });

  test('credit cost: 1 per card, +1 history, +1 eBay', () => {
    assert.equal(PriceTrackerClient.cost({ limit: 1, includeHistory: true, includeEbay: true }), 3);
    assert.equal(PriceTrackerClient.cost({ limit: 3 }), 3);
  });
});

describe('PokemonPriceTracker within the free tier', () => {
  let mock;
  let dataDir;
  let app;
  let server;
  let base;
  let ids;
  const call = async (method, p) => {
    const res = await fetch(base + p, { method });
    return { status: res.status, body: await res.json() };
  };
  const start = async (options = {}) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ppt-'));
    app = createApp({
      dataDir,
      catalog: mockCatalog(mock),
      priceTracker: new PriceTrackerClient({ apiKey: 'test-key', baseUrl: mock.pptUrl }),
      trackerOptions: options,
    });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    form.append('cards', JSON.stringify([
      { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo' },
      { tcg_id: 'sv03-168', name: 'Linoone' },
      { tcg_id: 'sv01-066', name: 'Voltorb' }, // not on the mock PokemonPriceTracker
    ]));
    ids = (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards.map((c) => c.id);
  };
  const stop = async () => {
    await new Promise((r) => server.close(r));
    app.locals.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  before(async () => { mock = await startMockSources(); });
  after(() => mock.close());
  beforeEach(() => { mock.state.pptRequests.length = 0; mock.state.pptRemaining = null; });

  test('a card with a TCGplayer id from TCGdex costs 3 credits, then comes from the cache', async () => {
    await start();
    try {
      const first = await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh`);
      assert.equal(first.status, 200);
      assert.equal(first.body.fromCache, false);
      assert.equal(first.body.tcgPlayerId, '497654', 'from TCGdex price data — no search needed');
      assert.equal(first.body.market.price, 0.24);
      assert.deepEqual(first.body.gradedSales.map((g) => g.grade), ['PSA 10', 'CGC 9.5', 'PSA 9']);
      assert.equal(first.body.population.length, 3);
      assert.equal(first.body.usage.used, 3);
      assert.equal(mock.state.pptRequests.length, 1);
      assert.match(mock.state.pptRequests[0], /tcgPlayerId=497654.*includeHistory=true.*days=3.*includeEbay=true/);

      const again = await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh`);
      assert.equal(again.body.fromCache, true);
      assert.equal(again.body.usage.used, 3, 'no credits for a fresh cache');
      assert.equal(mock.state.pptRequests.length, 1);

      const forced = await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh?force=1`);
      assert.equal(forced.body.fromCache, false);
      assert.equal(forced.body.usage.used, 6);
    } finally {
      await stop();
    }
  });

  test('everything fetched lands in the price history and the eBay sales list', async () => {
    await start();
    try {
      await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh`);
      const { body } = await call('GET', `/api/cards/${ids[0]}/price-history`);
      const series = Object.fromEntries(body.series.map((s) => [`${s.source}|${s.label}`, s]));
      assert.deepEqual(series['pokemonpricetracker|Market price'].points.slice(0, 3).map((p) => p.price), [0.22, 0.23, 0.24]);
      assert.equal(series['pokemonpricetracker|Market price'].direction, 'up');
      assert.equal(series['ebay-graded|PSA 10'].last, 24.5);
      assert.equal(series['tcgplayer|Market price'].last, 0.25, 'the free TCGplayer price recorded when the card was added');
      const sales = (await call('GET', `/api/cards/${ids[0]}/ebay`)).body.listings;
      assert.deepEqual(sales.map((s) => [s.title, s.source, s.grade]), [['Voltorb 066/193 PSA 10 GEM MINT Paldea Evolved', 'pokemonpricetracker', 'PSA 10']], 'the lot is skipped');
    } finally {
      await stop();
    }
  });

  test('a card without a known id is searched once (3 results max) and the id remembered', async () => {
    await start();
    try {
      const first = await call('POST', `/api/cards/${ids[1]}/pricetracker/refresh`);
      assert.equal(first.body.tcgPlayerId, '512345');
      assert.equal(first.body.market.price, 0.14);
      assert.match(mock.state.pptRequests[0], /search=Linoone.*limit=3/);
      assert.equal(first.body.usage.used, 1 + 3, 'one card found by the search + the full lookup');
      await call('POST', `/api/cards/${ids[1]}/pricetracker/refresh?force=1`);
      assert.equal(mock.state.pptRequests.length, 3, 'no second search');
      assert.match(mock.state.pptRequests[2], /tcgPlayerId=512345/);
    } finally {
      await stop();
    }
  });

  test('a card that isn’t found is not retried (and charged) again the same day', async () => {
    await start();
    try {
      const first = await call('POST', `/api/cards/${ids[2]}/pricetracker/refresh`);
      assert.match(first.body.error, /wasn’t found/);
      const requests = mock.state.pptRequests.length;
      await call('POST', `/api/cards/${ids[2]}/pricetracker/refresh`);
      assert.equal(mock.state.pptRequests.length, requests);
    } finally {
      await stop();
    }
  });

  test('never spends past the daily budget, and background refreshes leave a reserve', async () => {
    await start({ dailyCredits: 9, reserveShare: 0.34 });
    try {
      const tracker = app.locals.tracker;
      assert.equal(tracker.status().reservedForViewing, 4);
      // Background: 9 credits with 4 kept back → one 3-credit refresh (9 − 3 = 6 ≥ 4), not two (6 − 3 = 3 < 4).
      const refreshed = await tracker.runBackground();
      assert.equal(refreshed, 1);
      assert.equal(tracker.status().used, 3);
      // Viewing a card may use the reserve (Linoone: 1-credit search + 3-credit lookup)…
      const linoone = await call('POST', `/api/cards/${ids[1]}/pricetracker/refresh`);
      assert.equal(linoone.body.fromCache, false);
      assert.equal(linoone.body.usage.used, 7);
      // …but not more than the day's credits.
      const forced = await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh?force=1`);
      assert.equal(forced.body.budgetExceeded, true);
      assert.equal(forced.body.usage.used, 7);
      assert.equal(forced.body.market.price, 0.24, 'the cached answer is still shown');
    } finally {
      await stop();
    }
  });

  test('the service’s own remaining-credits count is respected', async () => {
    await start();
    try {
      mock.state.pptRemaining = 4;
      await call('POST', `/api/cards/${ids[0]}/pricetracker/refresh`);
      const { body } = await call('GET', '/api/pricetracker/status');
      assert.equal(body.used, 3);
      assert.equal(body.remaining, 1, 'PokemonPriceTracker said 1 credit is left');
      const linoone = await call('POST', `/api/cards/${ids[1]}/pricetracker/refresh`);
      assert.equal(linoone.body.budgetExceeded, true);
    } finally {
      await stop();
    }
  });

  test('switched off without an API key: no requests, clear status', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ppt-'));
    app = createApp({ dataDir, catalog: mockCatalog(mock), priceTracker: new PriceTrackerClient({ apiKey: '', baseUrl: mock.pptUrl }) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await call('GET', '/api/pricetracker/status')).body.configured, false);
      assert.equal(mock.state.pptRequests.length, 0);
    } finally {
      await stop();
    }
  });

  test('a wrong API key is reported, not retried in a loop', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ppt-'));
    app = createApp({ dataDir, catalog: mockCatalog(mock), priceTracker: new PriceTrackerClient({ apiKey: 'wrong', baseUrl: mock.pptUrl }) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      const form = new FormData();
      form.append('cards', JSON.stringify([{ tcg_id: 'sv02-066', name: 'Voltorb' }]));
      const [card] = (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
      const { body } = await call('POST', `/api/cards/${card.id}/pricetracker/refresh`);
      assert.match(body.error, /rejected the API key/);
    } finally {
      await stop();
    }
  });

  test('the hourly job prices cards with no reading today and tops up PokemonPriceTracker', async () => {
    await start({ dailyCredits: 100 });
    try {
      const { store, refreshCardMarket, tracker } = app.locals;
      const today = new Date().toISOString().slice(0, 10);
      assert.equal(store.cardsNeedingSnapshot(today).length, 0, 'cards are priced when added');
      // Pretend they were last checked long ago.
      store.db.prepare("UPDATE cards SET market_checked_at = '2000-01-01T00:00:00.000Z'").run();
      assert.equal(store.cardsNeedingSnapshot(today).length, 3);
      const scheduler = createScheduler({ store, refreshCardMarket, tracker, log: { log() {}, warn() {} } });
      const summary = await scheduler.runOnce();
      assert.equal(summary.priced, 3);
      assert.equal(summary.tracked, 2, 'Voltorb and Linoone; the unknown card is skipped');
      assert.equal(store.cardsNeedingSnapshot(today).length, 0);
      const again = await scheduler.runOnce();
      assert.deepEqual(again, { priced: 0, tracked: 0 }, 'nothing to do until tomorrow');
    } finally {
      await stop();
    }
  });
});
