// Stand-ins for every online source, so tests (and offline demos) don't need the internet:
//   /v2/en/...           TCGdex: the three cards from the reference photos plus neighbours, with prices
//   /ptcg/...            Pokémon TCG dataset: real data for a few sets (tests/fixtures/ptcg)
//   /tcgcsv/...          tcgcsv.com TCGplayer price mirror
//   /assets, /ptcg-images  generated PNG card art
// Punk Helmet deliberately has no TCGdex image, so the second source's picture is used for it.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { CardCatalog } from '../../server/catalog.js';
import { TcgCsvClient } from '../../server/prices.js';
import { PtcgDataClient } from '../../server/ptcgData.js';
import { TcgClient } from '../../server/tcg.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/ptcg', import.meta.url));

const CARDS = {
  sv02: {
    name: 'Paldea Evolved', series: 'sv', official: 193,
    cards: [
      ['065', 'Pawmot', { hp: 130, types: ['Lightning'], rarity: 'Rare' }],
      ['066', 'Voltorb', {
        hp: 70, types: ['Lightning'], rarity: 'Common',
        pricing: {
          tcgplayer: {
            unit: 'USD', updated: '2026-10-28T20:00:00.000Z',
            normal: { productId: 1, lowPrice: 0.02, midPrice: 0.1, highPrice: 2, marketPrice: 0.08 },
            'reverse-holofoil': { productId: 1, lowPrice: 0.1, midPrice: 0.3, highPrice: 3, marketPrice: 0.25 },
          },
          cardmarket: { unit: 'EUR', updated: '2026-10-28T20:00:00.000Z', avg: 0.05, low: 0.02, trend: 0.06, 'avg-holo': 0.2, 'trend-holo': 0.22 },
        },
      }],
      ['067', 'Electrode', { hp: 90, types: ['Lightning'], rarity: 'Uncommon' }],
    ],
  },
  sv03: {
    name: 'Obsidian Flames', series: 'sv', official: 197,
    cards: [
      ['167', 'Zigzagoon', { hp: 70, types: ['Colorless'], rarity: 'Common' }],
      ['168', 'Linoone', { hp: 110, types: ['Colorless'], rarity: 'Uncommon', pricing: { tcgplayer: null, cardmarket: null } }],
    ],
  },
  me02: {
    name: 'Phantasmal Flames', series: 'me', official: 94,
    cards: [['092', 'Punk Helmet', {
      category: 'Trainer', rarity: 'Uncommon', noImage: true,
      pricing: { cardmarket: { unit: 'EUR', updated: '2026-10-28T20:00:00.000Z', avg: 0.12, low: 0.02, trend: 0.15 } },
    }]],
  },
  mep: {
    name: 'MEP Black Star Promos', series: 'me', official: 0, // TCGdex really lists 0 for this promo set
    cards: [['060', 'Froakie', { hp: 70, types: ['Water'], rarity: 'Promo' }]],
  },
  sv01: {
    name: 'Scarlet & Violet', series: 'sv', official: 198,
    cards: [['066', 'Voltorb', { hp: 60, types: ['Lightning'], rarity: 'Common' }]],
  },
};

// eBay sold listings for Voltorb PAL 066/193 over ten weeks: up, then down, then flat, plus
// listings the app must ignore (a lot, another set's Voltorb, another card).
export const EBAY_SALES = [
  ['2026-07-06', 0.50], ['2026-07-08', 0.60],
  ['2026-07-14', 0.80], ['2026-07-16', 0.90],
  ['2026-07-21', 1.20], ['2026-07-23', 1.10],
  ['2026-07-29', 0.70],
  ['2026-08-04', 0.60], ['2026-08-06', 0.62],
  ['2026-08-12', 0.61],
  ['2026-08-18', 0.62],
].map(([date, price], i) => ({
  itemId: `v1|1000${i}|0`,
  title: i % 2 ? `Pokemon Voltorb 066/193 Reverse Holo Paldea Evolved NM` : `Voltorb 66/193 Paldea Evolved Pokemon TCG Card`,
  lastSoldPrice: { value: price.toFixed(2), currency: 'USD' },
  lastSoldDate: `${date}T15:00:00.000Z`,
  condition: 'Ungraded',
  itemWebUrl: `https://www.ebay.com/itm/1000${i}`,
})).concat([
  { itemId: 'v1|2001|0', title: 'Voltorb 066/193 PSA 10 GEM MINT Paldea Evolved', lastSoldPrice: { value: '25.00', currency: 'USD' }, lastSoldDate: '2026-08-10T12:00:00.000Z', condition: 'Graded', itemWebUrl: 'https://www.ebay.com/itm/2001' },
  { itemId: 'v1|3001|0', title: 'Pokemon card lot x50 Voltorb 066/193 commons', lastSoldPrice: { value: '9.99', currency: 'USD' }, lastSoldDate: '2026-08-01T12:00:00.000Z', condition: 'Ungraded', itemWebUrl: 'https://www.ebay.com/itm/3001' },
  { itemId: 'v1|3002|0', title: 'Voltorb 066/198 Scarlet & Violet base set', lastSoldPrice: { value: '0.40', currency: 'USD' }, lastSoldDate: '2026-08-02T12:00:00.000Z', condition: 'Ungraded', itemWebUrl: 'https://www.ebay.com/itm/3002' },
  { itemId: 'v1|3003|0', title: 'Electrode 067/193 Paldea Evolved', lastSoldPrice: { value: '0.30', currency: 'USD' }, lastSoldDate: '2026-08-03T12:00:00.000Z', condition: 'Ungraded', itemWebUrl: 'https://www.ebay.com/itm/3003' },
]);

const TCGCSV = {
  groups: [
    { groupId: 3001, name: 'SV03: Obsidian Flames', abbreviation: 'OBF' },
    { groupId: 3002, name: 'SV02: Paldea Evolved', abbreviation: 'PAL' },
  ],
  products: {
    3001: [
      { productId: 9002, name: 'Obsidian Flames Booster Pack', extendedData: [] },
      { productId: 9001, name: 'Linoone - 168/197', extendedData: [{ name: 'Number', value: '168/197' }, { name: 'Rarity', value: 'Uncommon' }] },
    ],
    3002: [],
  },
  prices: {
    3001: [
      { productId: 9001, subTypeName: 'Normal', lowPrice: 0.05, midPrice: 0.2, highPrice: 1, marketPrice: 0.12 },
      { productId: 9001, subTypeName: 'Reverse Holofoil', lowPrice: 0.1, midPrice: 0.4, highPrice: 2, marketPrice: 0.3 },
    ],
    3002: [],
  },
};

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal solid-colour PNG encoder. */
export function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COLORS = { Lightning: [250, 204, 21], Colorless: [214, 211, 209], Trainer: [148, 163, 184], Water: [56, 189, 248] };

export function startMockSources({ tcgdexDown = false, ebayApproved = true } = {}) {
  const requests = [];
  const state = { tcgdexDown, ebayApproved };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url.pathname + url.search);
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const png = (color) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(solidPng(63, 88, color));
    };
    const image = (setId, localId) => `${base}/assets/en/${CARDS[setId].series}/${setId}/${localId}`;
    const brief = (setId, [localId, name, extra]) => ({ id: `${setId}-${localId}`, localId, name, image: extra.noImage ? undefined : image(setId, localId) });

    let m;
    if (url.pathname.startsWith('/v2/') && state.tcgdexDown) return json(503, { error: 'down' });
    if (url.pathname === '/v2/en/sets') {
      return json(200, Object.entries(CARDS).map(([id, s]) => ({ id, name: s.name, cardCount: { total: s.official + 20, official: s.official } })));
    }
    if ((m = url.pathname.match(/^\/v2\/en\/sets\/([^/]+)$/))) {
      const s = CARDS[decodeURIComponent(m[1])];
      if (!s) return json(404, { error: 'not found' });
      const id = decodeURIComponent(m[1]);
      return json(200, { id, name: s.name, cardCount: { total: s.official + 20, official: s.official }, cards: s.cards.map((c) => brief(id, c)) });
    }
    if (url.pathname === '/v2/en/cards') {
      const q = (url.searchParams.get('name') ?? '').toLowerCase();
      const out = [];
      for (const [id, s] of Object.entries(CARDS)) for (const c of s.cards) if (c[1].toLowerCase().includes(q)) out.push(brief(id, c));
      return json(200, out);
    }
    if ((m = url.pathname.match(/^\/v2\/en\/cards\/([^/]+)-([^/-]+)$/))) {
      const setId = decodeURIComponent(m[1]);
      const s = CARDS[setId];
      const c = s?.cards.find((x) => x[0] === m[2]);
      if (!c) return json(404, { error: 'not found' });
      const [localId, name, extra] = c;
      return json(200, {
        id: `${setId}-${localId}`, localId, name, image: extra.noImage ? undefined : image(setId, localId),
        category: extra.category ?? 'Pokemon', hp: extra.hp, types: extra.types, rarity: extra.rarity,
        set: { id: setId, name: s.name, cardCount: { official: s.official, total: s.official + 20 } },
        pricing: extra.pricing ?? { tcgplayer: null, cardmarket: null },
      });
    }
    if ((m = url.pathname.match(/^\/assets\/en\/\w+\/([^/]+)\/([^/]+)\/high\.png$/))) {
      const c = CARDS[m[1]]?.cards.find((x) => x[0] === m[2]);
      if (!c || c[2].noImage) return json(404, { error: 'not found' });
      return png(COLORS[c[2].category ?? c[2].types?.[0]] ?? [200, 200, 200]);
    }
    if (url.pathname.match(/^\/assets\/.*\/low\.webp$/)) return png([180, 180, 180]); // browsers sniff the format

    // Pokémon TCG dataset: real fixture files, with image links pointed at this server.
    if ((m = url.pathname.match(/^\/ptcg\/((?:sets|cards)\/en(?:\/[\w.-]+)?\.json)$/))) {
      const file = path.join(FIXTURES, m[1]);
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(fs.readFileSync(file, 'utf8').replaceAll('https://images.pokemontcg.io/', `${base}/ptcg-images/`));
    }
    if (url.pathname.startsWith('/ptcg-images/')) return png([139, 92, 246]);

    // eBay's official API: OAuth token, then Marketplace Insights sold-item search.
    if (url.pathname === '/ebay/identity/v1/oauth2/token' && req.method === 'POST') {
      if (!state.ebayApproved) return json(400, { error: 'invalid_scope', error_description: 'The requested scope is invalid' });
      return json(200, { access_token: 'mock-token', expires_in: 7200, token_type: 'Application Access Token' });
    }
    if (url.pathname === '/ebay/buy/marketplace_insights/v1_beta/item_sales/search') {
      if (req.headers.authorization !== 'Bearer mock-token') return json(401, { errors: [{ message: 'unauthorized' }] });
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const hits = q.includes('voltorb') ? EBAY_SALES : [];
      return json(200, { total: hits.length, limit: 200, offset, itemSales: hits.slice(offset, offset + 200) });
    }

    if (url.pathname === '/tcgcsv/tcgplayer/3/groups') return json(200, { success: true, results: TCGCSV.groups });
    if ((m = url.pathname.match(/^\/tcgcsv\/tcgplayer\/3\/(\d+)\/(products|prices)$/))) {
      return json(200, { success: true, results: TCGCSV[m[2]][m[1]] ?? [] });
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        tcgdexUrl: `${base}/v2/en`,
        ptcgUrl: `${base}/ptcg`,
        tcgcsvUrl: `${base}/tcgcsv/tcgplayer/3`,
        ebayUrl: `${base}/ebay`,
        requests,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A CardCatalog wired to the mock sources. */
export function mockCatalog(mock, { timeoutMs = 3000 } = {}) {
  return new CardCatalog({
    tcgdex: new TcgClient({ baseUrl: mock.tcgdexUrl, timeoutMs }),
    ptcg: new PtcgDataClient({ baseUrl: mock.ptcgUrl, timeoutMs }),
    tcgcsv: new TcgCsvClient({ baseUrl: mock.tcgcsvUrl, timeoutMs }),
  });
}
