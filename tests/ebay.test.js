import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { EbayClient, EbayNotApproved, searchQuery, soldSearchUrl } from '../server/ebay.js';
import { gradeFromTitle, listingMatchesCard, priceSeries, soldStats } from '../server/soldStats.js';
import { EBAY_SALES, mockCatalog, startMockSources } from './helpers/mock-sources.js';

const VOLTORB = { name: 'Voltorb', number: '066', set_total: '193', set_name: 'Paldea Evolved' };
const sale = (date, price) => ({ soldAt: `${date}T12:00:00.000Z`, price, currency: 'USD' });

describe('sold price statistics', () => {
  const sales = [
    sale('2026-07-06', 0.5), sale('2026-07-08', 0.6), // week 1: 0.55
    sale('2026-07-14', 0.8), sale('2026-07-16', 0.9), // week 2: 0.85  up
    sale('2026-07-21', 1.2), sale('2026-07-23', 1.1), // week 3: 1.15  up
    sale('2026-07-29', 0.7), //                          week 4: 0.70  down
    sale('2026-08-04', 0.6), sale('2026-08-06', 0.62), // week 5: 0.61  down
    sale('2026-08-12', 0.61), //                         week 6: 0.61  same
    sale('2026-08-18', 0.62), //                         week 7: 0.62  +1.6% → same
  ];

  test('average and median sold price', () => {
    const s = soldStats(sales);
    assert.equal(s.count, 11);
    assert.equal(s.average, 0.75); // 8.25 / 11
    assert.equal(s.median, 0.62);
    assert.deepEqual([s.low, s.high], [0.5, 1.2]);
  });

  test('weekly averages, each step marked up / down / same', () => {
    const weeks = priceSeries(sales, 'week');
    assert.deepEqual(weeks.map((w) => w.average), [0.55, 0.85, 1.15, 0.7, 0.61, 0.61, 0.62]);
    assert.deepEqual(weeks.map((w) => w.direction), [null, 'up', 'up', 'down', 'down', 'flat', 'flat']);
    assert.equal(weeks[0].start, '2026-07-06T00:00:00.000Z', 'weeks start on Monday');
    assert.deepEqual(weeks.map((w) => w.count), [2, 2, 2, 1, 2, 1, 1]);
  });

  test('rolling 3-period average smooths single spikes', () => {
    const weeks = priceSeries(sales, 'week');
    assert.equal(weeks[2].rolling, 0.85); // (0.55 + 0.85 + 1.15) / 3
  });

  test('monthly averages', () => {
    const months = priceSeries(sales, 'month');
    assert.deepEqual(months.map((m) => [m.start.slice(0, 7), m.average, m.direction]), [
      ['2026-07', 0.83, null], // 5.80 / 7
      ['2026-08', 0.61, 'down'],
    ]);
  });

  test('overall trend: direction, change and rate per week', () => {
    const rising = soldStats([sale('2026-07-06', 1), sale('2026-07-13', 1.5), sale('2026-07-20', 2)]);
    assert.equal(rising.trend.direction, 'up');
    assert.equal(rising.trend.perWeek, 0.5);
    const flat = soldStats([sale('2026-07-06', 1), sale('2026-07-13', 1.01), sale('2026-07-20', 1)]);
    assert.equal(flat.trend.direction, 'flat');
    const falling = soldStats([sale('2026-07-06', 2), sale('2026-07-13', 1.5), sale('2026-07-20', 1)]);
    assert.equal(falling.trend.direction, 'down');
    assert.ok(falling.trend.perWeek < 0);
  });

  test('no sales, no numbers', () => {
    assert.deepEqual(soldStats([]), { count: 0, average: null, median: null, trend: null, weekly: [], monthly: [] });
  });
});

describe('reading listing titles', () => {
  test('grade from the title', () => {
    assert.equal(gradeFromTitle('Voltorb 066/193 PSA 10 GEM MINT'), 'PSA 10');
    assert.equal(gradeFromTitle('Charizard ex BGS 9.5 Pristine'), 'BGS 9.5');
    assert.equal(gradeFromTitle('Pikachu Beckett 9'), 'BGS 9');
    assert.equal(gradeFromTitle('CGC 8.5 Mew'), 'CGC 8.5');
    assert.equal(gradeFromTitle('Voltorb 066/193 Reverse Holo NM'), null);
  });

  test('only listings for this exact card count', () => {
    assert.ok(listingMatchesCard('Voltorb 066/193 Reverse Holo Paldea Evolved', VOLTORB));
    assert.ok(listingMatchesCard('Pokemon Voltorb 66/193 PAL', VOLTORB));
    assert.ok(!listingMatchesCard('Voltorb 066/198 Scarlet & Violet', VOLTORB), 'another set');
    assert.ok(!listingMatchesCard('Electrode 067/193', VOLTORB), 'another card');
    assert.ok(!listingMatchesCard('Pokemon lot x50 Voltorb 066/193', VOLTORB), 'a lot');
    assert.ok(!listingMatchesCard('Voltorb 166/193', VOLTORB), 'different number');
    assert.ok(listingMatchesCard('Froakie 060 MEP Black Star Promo', { name: 'Froakie', number: '060' }));
  });

  test('eBay search for the card', () => {
    assert.equal(searchQuery(VOLTORB), 'Voltorb 066/193');
    assert.equal(searchQuery({ name: 'Froakie', number: '060', set_name: 'MEP Black Star Promos' }), 'Froakie 060 promo');
    const url = new URL(soldSearchUrl(VOLTORB));
    assert.equal(url.hostname, 'www.ebay.com');
    assert.equal(url.searchParams.get('_nkw'), 'Voltorb 066/193');
    assert.equal(url.searchParams.get('LH_Sold'), '1');
  });
});

describe('eBay official API client', () => {
  let mock;
  before(async () => { mock = await startMockSources(); });
  after(() => mock.close());

  test('is off until credentials are set', () => {
    assert.equal(new EbayClient({ clientId: '', clientSecret: '' }).configured, false);
    assert.equal(new EbayClient({ clientId: 'a', clientSecret: 'b' }).configured, true);
  });

  test('fetches sold listings', async () => {
    const client = new EbayClient({ clientId: 'id', clientSecret: 'secret', baseUrl: mock.ebayUrl });
    const sales = await client.soldListings(VOLTORB);
    assert.equal(sales.length, EBAY_SALES.length);
    assert.deepEqual(sales[0], {
      itemId: 'v1|10000|0', title: 'Voltorb 66/193 Paldea Evolved Pokemon TCG Card', price: 0.5, currency: 'USD',
      soldAt: '2026-07-06T15:00:00.000Z', condition: 'Ungraded', url: 'https://www.ebay.com/itm/10000',
    });
  });

  test('explains when the eBay app is not approved yet', async () => {
    mock.state.ebayApproved = false;
    try {
      const client = new EbayClient({ clientId: 'id', clientSecret: 'secret', baseUrl: mock.ebayUrl });
      await assert.rejects(client.soldListings(VOLTORB), EbayNotApproved);
    } finally {
      mock.state.ebayApproved = true;
    }
  });
});

describe('eBay sold prices API', () => {
  let mock;
  let dataDir;
  let app;
  let server;
  let base;
  let cardId;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ebay-'));
    app = createApp({ dataDir, catalog: mockCatalog(mock), ebay: new EbayClient({ clientId: 'id', clientSecret: 'secret', baseUrl: mock.ebayUrl }) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    form.append('cards', JSON.stringify([{ tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo' }]));
    cardId = (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards[0].id;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    app.locals.store.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('before any data: the eBay search link and whether the API is set up', async () => {
    const { body } = await call('GET', `/api/cards/${cardId}/ebay`);
    assert.equal(body.query, 'Voltorb 066/193');
    assert.match(body.searchUrl, /LH_Sold=1/);
    assert.equal(body.apiConfigured, true);
    assert.equal(body.stats.count, 0);
  });

  test('fetches from eBay, keeping only this card’s listings', async () => {
    const { status, body } = await call('POST', `/api/cards/${cardId}/ebay/refresh`);
    assert.equal(status, 200);
    assert.equal(body.added, 12, '11 raw sales + 1 PSA 10');
    assert.equal(body.skipped, 3, 'the lot, the other set and Electrode');
    assert.deepEqual(body.counts, { all: 12, raw: 11, graded: 1 });
    assert.equal(body.listings[0].sold_at, '2026-08-18T15:00:00.000Z', 'newest first');
    assert.equal(body.listings.find((l) => l.grade).grade, 'PSA 10');
    assert.equal(body.stats.trend.direction, 'up', 'the late $25 PSA 10 pulls the all-sales trend up');
    assert.equal((await call('GET', `/api/cards/${cardId}/ebay?condition=raw`)).body.stats.trend.direction, 'down', 'ungraded: rose, then fell back');
  });

  test('filters ungraded and graded sales', async () => {
    const raw = (await call('GET', `/api/cards/${cardId}/ebay?condition=raw`)).body;
    assert.equal(raw.stats.count, 11);
    assert.equal(raw.stats.average, 0.75);
    assert.deepEqual(raw.stats.weekly.map((w) => w.direction), [null, 'up', 'up', 'down', 'down', 'flat', 'flat']);
    const graded = (await call('GET', `/api/cards/${cardId}/ebay?condition=graded`)).body;
    assert.equal(graded.stats.average, 25);
  });

  test('fetching again does not duplicate listings', async () => {
    const { body } = await call('POST', `/api/cards/${cardId}/ebay/refresh`);
    assert.equal(body.added, 0);
    assert.equal(body.counts.all, 12);
  });

  test('imports listings pasted from eBay.com', async () => {
    const { status, body } = await call('POST', `/api/cards/${cardId}/ebay/import`, {
      listings: [
        { title: 'Voltorb 066/193 Paldea Evolved Reverse', price: 0.75, soldAt: '2026-09-01', url: 'https://www.ebay.com/itm/5001', condition: 'Pre-Owned' },
        { title: 'Voltorb 066/193 Paldea Evolved Reverse', price: 0.75, soldAt: '2026-09-01', url: 'https://www.ebay.com/itm/5001' },
        { title: 'Pikachu 063/193', price: 3, soldAt: '2026-09-01' },
        { title: 'Voltorb 066/193', price: 'free', soldAt: '2026-09-01' },
        { title: 'Voltorb 066/193 evil link', price: 1, soldAt: '2026-09-02', url: 'javascript:alert(1)' },
      ],
    });
    assert.equal(status, 200);
    assert.equal(body.added, 2, 'the duplicate, the other card and the bad price are dropped');
    assert.equal(body.skipped, 2);
    const evil = body.listings.find((l) => l.title.includes('evil'));
    assert.equal(evil.url, null, 'only eBay links are kept');
    assert.equal(body.listings.find((l) => l.url === 'https://www.ebay.com/itm/5001').source, 'pasted');
  });

  test('a wrong listing can be removed', async () => {
    const { body: before } = await call('GET', `/api/cards/${cardId}/ebay`);
    const target = before.listings.find((l) => l.title.includes('evil'));
    const { body } = await call('DELETE', `/api/cards/${cardId}/ebay/${target.id}`);
    assert.equal(body.counts.all, before.counts.all - 1);
    assert.equal((await call('DELETE', `/api/cards/${cardId}/ebay/999999`)).status, 404);
  });

  test('says clearly when the eBay API is not approved or not set up', async () => {
    mock.state.ebayApproved = false;
    try {
      const fresh = new EbayClient({ clientId: 'id', clientSecret: 'secret', baseUrl: mock.ebayUrl });
      const app2 = createApp({ dataDir, catalog: mockCatalog(mock), ebay: fresh });
      const s2 = await new Promise((resolve) => { const s = app2.listen(0, '127.0.0.1', () => resolve(s)); });
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/cards/${cardId}/ebay/refresh`, { method: 'POST' });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /not approved/);
      await new Promise((r) => s2.close(r));
      app2.locals.store.close();
    } finally {
      mock.state.ebayApproved = true;
    }
    const app3 = createApp({ dataDir, catalog: mockCatalog(mock), ebay: new EbayClient({ clientId: '', clientSecret: '' }) });
    const s3 = await new Promise((resolve) => { const s = app3.listen(0, '127.0.0.1', () => resolve(s)); });
    const res3 = await fetch(`http://127.0.0.1:${s3.address().port}/api/cards/${cardId}/ebay/refresh`, { method: 'POST' });
    assert.equal(res3.status, 400);
    await new Promise((r) => s3.close(r));
    app3.locals.store.close();
  });

  test('a card’s listings are removed with the card', async () => {
    assert.equal((await fetch(`${base}/api/cards/${cardId}`, { method: 'DELETE' })).status, 204);
    const db = app.locals.store;
    assert.equal(db.listSales(cardId).length, 0);
  });
});
