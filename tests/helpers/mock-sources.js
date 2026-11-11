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
import { ExchangeRates } from '../../server/fx.js';
import { TcgCsvClient } from '../../server/prices.js';
import { PtcgDataClient } from '../../server/ptcgData.js';
import { TcgClient } from '../../server/tcg.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/ptcg', import.meta.url));

const CARDS = {
  sv02: {
    name: 'Paldea Evolved', series: 'sv', official: 193,
    cards: [
      ['065', 'Pawmot', { hp: 130, types: ['Lightning'], rarity: 'Rare', variants: [{ type: 'holo' }, { type: 'reverse' }] }],
      ['066', 'Voltorb', {
        hp: 70, types: ['Lightning'], rarity: 'Common', variants: [{ type: 'normal' }, { type: 'reverse' }],
        pricing: {
          tcgplayer: {
            unit: 'USD', updated: '2026-10-28T20:00:00.000Z',
            normal: { productId: 497654, lowPrice: 0.02, midPrice: 0.1, highPrice: 2, marketPrice: 0.08 },
            'reverse-holofoil': { productId: 497654, lowPrice: 0.1, midPrice: 0.3, highPrice: 3, marketPrice: 0.25 },
          },
          cardmarket: { unit: 'EUR', updated: '2026-10-28T20:00:00.000Z', avg: 0.05, low: 0.02, trend: 0.06, 'avg-holo': 0.2, 'trend-holo': 0.22 },
        },
      }],
      ['067', 'Electrode', { hp: 90, types: ['Lightning'], rarity: 'Uncommon' }],
      ['200', 'Bellibolt ex', { hp: 280, types: ['Lightning'], rarity: 'Special Illustration Rare', variants: [{ type: 'holo' }] }],
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
    // No picture on TCGdex or in the dataset: it comes from TCGplayer (tcgcsv.com).
    cards: [
      ['059', 'Fennekin', { hp: 70, types: ['Fire'], rarity: 'Promo', noImage: true }], // no picture anywhere
      ['060', 'Froakie', { hp: 70, types: ['Water'], rarity: 'Promo', noImage: true }],
    ],
  },
  sv01: {
    name: 'Scarlet & Violet', series: 'sv', official: 198,
    cards: [['066', 'Voltorb', { hp: 60, types: ['Lightning'], rarity: 'Common', variants: [{ type: 'normal' }, { type: 'reverse' }, { type: 'reverse', foil: 'pokeball' }] }]],
  },
};

// What TCGdex sends for battles (attacks, abilities, weakness, Pokédex number), for a few cards.
const BATTLE = {
  'en:sv02-066': { dexId: [100], stage: 'Basic', retreat: 1, attacks: [{ cost: ['Lightning'], name: 'Rollout', damage: 20 }, { cost: ['Lightning', 'Colorless'], name: 'Lightning Ball', damage: 30 }], weaknesses: [{ type: 'Fighting', value: '×2' }] },
  'en:sv02-067': { dexId: [101], stage: 'Stage1', retreat: 1, attacks: [{ cost: ['Lightning'], name: 'Thunder Jolt', damage: '30+', effect: 'Flip a coin. If heads, this attack does 30 more damage.' }, { cost: ['Lightning', 'Colorless', 'Colorless'], name: 'Explosion', damage: 120 }], weaknesses: [{ type: 'Fighting', value: '×2' }] },
  'en:sv03-168': { dexId: [264], stage: 'Stage1', retreat: 1, abilities: [{ type: 'Ability', name: 'Quick Search', effect: 'Once during your turn, you may search your deck for a card.' }], attacks: [{ cost: ['Colorless'], name: 'Headbutt', damage: 30 }, { cost: ['Colorless', 'Colorless', 'Colorless'], name: 'Gutsy Charge', damage: '70+', effect: 'Flip a coin. If heads, this attack does 70 more damage.' }], weaknesses: [{ type: 'Fighting', value: '×2' }] },
  'en:sv02-065': { dexId: [923], stage: 'Stage2', attacks: [{ cost: ['Lightning', 'Lightning'], name: 'Electro Paws', damage: 120 }], weaknesses: [{ type: 'Fighting', value: '×2' }], resistances: [{ type: 'Metal', value: '-30' }] },
  'ja:SV2a-100': { dexId: [100], stage: 'Basic', attacks: [{ cost: ['Lightning'], name: 'ころがる', damage: 20 }], weaknesses: [{ type: 'Fighting', value: '×2' }] },
};

/** A tiny, valid binary glTF (a coloured cube), standing in for a Pokémon 3D model. */
export function cubeGlb(color = [0.95, 0.3, 0.2]) {
  const p = [];
  for (const [x, y, z] of [[-1, 0, -1], [1, 0, -1], [1, 2, -1], [-1, 2, -1], [-1, 0, 1], [1, 0, 1], [1, 2, 1], [-1, 2, 1]]) p.push(x * 0.5, y * 0.5, z * 0.5);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const pos = Buffer.from(new Float32Array(p).buffer);
  const ind = Buffer.from(new Uint16Array(idx).buffer);
  const bin = Buffer.concat([pos, ind, Buffer.alloc((4 - ((pos.length + ind.length) % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: ind.length, target: 34963 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([header, chunk('JSON', text), chunk('BIN\0', bin)]);
}

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

// PokemonPriceTracker cards, in two of the layouts their docs show.
export const PPT_CARDS = [
  {
    id: 'ppt-voltorb', tcgPlayerId: 497654, name: 'Voltorb', setName: 'SV02: Paldea Evolved', cardNumber: '066/193', rarity: 'Common',
    prices: { market: 0.24, low: 0.05, primaryCondition: 'Near Mint', primaryPrinting: 'Reverse Holofoil', lastUpdated: '2026-10-29T08:00:00.000Z' },
    priceHistory: {
      conditions: {
        'Near Mint': { history: [{ date: '2026-10-27', market: 0.22 }, { date: '2026-10-28', market: 0.23 }, { date: '2026-10-29', market: 0.24 }] },
        'Lightly Played': { history: [{ date: '2026-10-29', market: 0.15 }] },
      },
    },
    ebay: {
      salesByGrade: {
        psa9: { count: 8, averagePrice: 9.75, medianPrice: 9.5, minPrice: 7, maxPrice: 13, lastSaleDate: '2026-10-20' },
        psa10: { count: 12, averagePrice: 24.5, medianPrice: 23, minPrice: 18, maxPrice: 35, lastSaleDate: '2026-10-25' },
        cgc9_5: { salesCount: 2, averagePrice: 12, smartMarketPrice: { price: 11.5, confidence: 'low' } },
      },
      sales: [
        { title: 'Voltorb 066/193 PSA 10 GEM MINT Paldea Evolved', price: 25, soldDate: '2026-10-25', grade: 'psa10', url: 'https://www.ebay.com/itm/880001' },
        { title: 'Pokemon mystery lot x20 incl Voltorb 066/193', price: 15, soldDate: '2026-10-24', url: 'https://www.ebay.com/itm/880002' },
      ],
    },
    population: { psa10: 143, psa9: 210, psa8: 40 },
  },
  {
    id: 'ppt-linoone', tcgPlayerId: '512345', name: 'Linoone', set: { name: 'Obsidian Flames' }, number: '168/197',
    price: { marketPrice: '0.14' },
    history: [{ date: '2026-10-28T00:00:00Z', price: 0.13 }, { date: '2026-10-29T00:00:00Z', price: 0.14 }],
    ebay: { salesByGrade: {} },
  },
  { id: 'ppt-zigzagoon', tcgPlayerId: 512344, name: 'Zigzagoon', setName: 'Obsidian Flames', cardNumber: '167/197', prices: { market: 0.1 } },
  // A promo, named the way TCGplayer names the set, with picture links (given the mock's address).
  {
    id: 'ppt-froakie-mep', tcgPlayerId: 709974, name: 'Froakie', setName: 'ME: Mega Evolution Promo', cardNumber: 'MEP 060',
    imageUrl: '/tcgplayer-cdn/product/709974_200w.jpg', imageCdnUrl800: '/tcgplayer-cdn/product/709974_800w.jpg', prices: { market: 6.89 },
  },
];

// Group ids are TCGplayer's real ones (see server/setCodes.js). Image paths get the mock's address.
const TCGCSV = {
  groups: [
    { groupId: 23228, name: 'SV03: Obsidian Flames', abbreviation: 'OBF' },
    { groupId: 23120, name: 'SV02: Paldea Evolved', abbreviation: 'PAL' },
    { groupId: 24451, name: 'ME: Mega Evolution Promo', abbreviation: 'MEP' },
  ],
  products: {
    24451: [
      { productId: 77059, name: 'Fennekin - 059', imageUrl: '/tcgplayer-cdn/product/77059_200w.jpg', extendedData: [] },
      { productId: 77060, name: 'Froakie', imageUrl: '/tcgplayer-cdn/product/77060_200w.jpg', extendedData: [{ name: 'Number', value: 'MEP 060' }] },
    ],
    23228: [
      { productId: 9002, name: 'Obsidian Flames Booster Pack', extendedData: [] },
      { productId: 9001, name: 'Linoone - 168/197', extendedData: [{ name: 'Number', value: '168/197' }, { name: 'Rarity', value: 'Uncommon' }] },
    ],
    23120: [],
  },
  prices: {
    24451: [{ productId: 77060, subTypeName: 'Holofoil', lowPrice: 4.5, midPrice: 7, highPrice: 12, marketPrice: 6.89 }],
    23228: [
      { productId: 9001, subTypeName: 'Normal', lowPrice: 0.05, midPrice: 0.2, highPrice: 1, marketPrice: 0.12 },
      { productId: 9001, subTypeName: 'Reverse Holofoil', lowPrice: 0.1, midPrice: 0.4, highPrice: 2, marketPrice: 0.3 },
    ],
    23120: [],
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

// TCGdex's Japanese database: Japanese names, the printed set id as the set code ("SV2a").
const CARDS_JA = {
  SV2a: {
    name: 'ポケモンカード151', series: 'SV', official: 165,
    cards: [
      ['025', 'ピカチュウ', { hp: 60, types: ['Lightning'], rarity: 'Common', variants: [{ type: 'normal' }, { type: 'reverse', foil: 'pokeball' }] }],
      ['100', 'ビリリダマ', {
        hp: 60, types: ['Lightning'], rarity: 'Common', variants: [{ type: 'normal' }, { type: 'reverse', foil: 'pokeball' }],
        pricing: { tcgplayer: null, cardmarket: { unit: 'EUR', updated: '2026-10-30T00:00:00.000Z', avg: 0.25, low: 0.1, trend: 0.3, 'trend-holo': 0.9 } },
      }],
      ['205', 'ミュウex', { hp: 180, types: ['Psychic'], rarity: 'Special Illustration Rare', variants: [{ type: 'holo' }] }],
    ],
  },
  'SV-P': { name: 'スカーレット&バイオレット プロモカード', series: 'SV', official: 0, cards: [['001', 'ピカチュウ', { hp: 60, types: ['Lightning'], rarity: 'Promo' }]] },
};

const COLORS = { Lightning: [250, 204, 21], Colorless: [214, 211, 209], Trainer: [148, 163, 184], Water: [56, 189, 248], Psychic: [192, 132, 252] };

export function startMockSources({ tcgdexDown = false, ebayApproved = true } = {}) {
  const requests = [];
  const state = { tcgdexDown, ebayApproved, pptRemaining: null, pptRequests: [], modelDownloads: [], modelsDown: false };
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
    // TCGdex, in English (/v2/en) and Japanese (/v2/ja).
    const lang = url.pathname.match(/^\/(?:v2|assets)\/(en|ja)\//)?.[1] ?? 'en';
    const DB = lang === 'ja' ? CARDS_JA : CARDS;
    const image = (setId, localId) => `${base}/assets/${lang}/${DB[setId].series}/${setId}/${localId}`;
    const brief = (setId, [localId, name, extra]) => ({ id: `${setId}-${localId}`, localId, name, image: extra.noImage ? undefined : image(setId, localId) });

    let m;
    if (url.pathname.startsWith('/v2/') && state.tcgdexDown) return json(503, { error: 'down' });
    if (url.pathname === `/v2/${lang}/sets`) {
      return json(200, Object.entries(DB).map(([id, s]) => ({ id, name: s.name, cardCount: { total: s.official + 20, official: s.official } })));
    }
    if ((m = url.pathname.match(/^\/v2\/\w+\/sets\/([^/]+)$/))) {
      const s = DB[decodeURIComponent(m[1])];
      if (!s) return json(404, { error: 'not found' });
      const id = decodeURIComponent(m[1]);
      return json(200, { id, name: s.name, cardCount: { total: s.official + 20, official: s.official }, cards: s.cards.map((c) => brief(id, c)) });
    }
    if (url.pathname === `/v2/${lang}/cards`) {
      const q = (url.searchParams.get('name') ?? '').toLowerCase();
      const out = [];
      for (const [id, s] of Object.entries(DB)) for (const c of s.cards) if (c[1].toLowerCase().includes(q)) out.push(brief(id, c));
      return json(200, out);
    }
    if ((m = url.pathname.match(/^\/v2\/\w+\/cards\/(.+)-([^/-]+)$/))) {
      const setId = decodeURIComponent(m[1]);
      const s = DB[setId];
      const c = s?.cards.find((x) => x[0] === m[2]);
      if (!c) return json(404, { error: 'not found' });
      const [localId, name, extra] = c;
      return json(200, {
        id: `${setId}-${localId}`, localId, name, image: extra.noImage ? undefined : image(setId, localId),
        category: extra.category ?? 'Pokemon', hp: extra.hp, types: extra.types, rarity: extra.rarity,
        set: { id: setId, name: s.name, cardCount: { official: s.official, total: s.official + 20 } },
        pricing: extra.pricing ?? { tcgplayer: null, cardmarket: null },
        ...(extra.variants ? { variants_detailed: extra.variants } : {}),
        ...(BATTLE[`${lang}:${setId}-${localId}`] ?? {}),
      });
    }
    if ((m = url.pathname.match(/^\/assets\/\w+\/\w+\/([^/]+)\/([^/]+)\/high\.png$/))) {
      const c = DB[decodeURIComponent(m[1])]?.cards.find((x) => x[0] === m[2]);
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

    // PokemonPriceTracker: Bearer key, 1 credit per card returned (+1 history, +1 eBay).
    if (url.pathname === '/ppt/api/v2/cards') {
      if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'Invalid API key' });
      state.pptRequests.push(url.search);
      const id = url.searchParams.get('tcgPlayerId');
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 10);
      let found = id ? PPT_CARDS.filter((c) => String(c.tcgPlayerId) === id) : PPT_CARDS.filter((c) => q.split(/\s+/).some((w) => w.length > 2 && c.name.toLowerCase().includes(w)));
      found = found.slice(0, limit).map((c) => {
        const out = { ...c };
        for (const k of Object.keys(out)) if (/^image/.test(k) && out[k].startsWith('/')) out[k] = `http://${req.headers.host}${out[k]}`;
        if (url.searchParams.get('includeHistory') !== 'true') { delete out.priceHistory; delete out.history; }
        if (url.searchParams.get('includeEbay') !== 'true') delete out.ebay;
        return out;
      });
      const per = 1 + (url.searchParams.get('includeHistory') === 'true' ? 1 : 0) + (url.searchParams.get('includeEbay') === 'true' ? 1 : 0);
      const headers = { 'content-type': 'application/json' };
      if (state.pptRemaining != null) {
        state.pptRemaining -= found.length * per;
        headers['x-ratelimit-remaining'] = String(state.pptRemaining);
      }
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ data: found, metadata: { total: found.length } }));
    }

    // Like the real tcgcsv.com, turn away requests that don't identify the app.
    if (url.pathname.startsWith('/tcgcsv/') && (state.tcgcsvBlocked || !/pokedex-collection/.test(req.headers['user-agent'] ?? ''))) return json(401, { error: 'unauthorized' });
    if (url.pathname === '/tcgcsv/tcgplayer/3/groups') return json(200, { success: true, results: TCGCSV.groups });
    if ((m = url.pathname.match(/^\/tcgcsv\/tcgplayer\/3\/(\d+)\/(products|prices)$/))) {
      const results = (TCGCSV[m[2]][m[1]] ?? []).map((r) => (r.imageUrl ? { ...r, imageUrl: `http://${req.headers.host}${r.imageUrl}` } : r));
      return json(200, { success: true, results });
    }
    // TCGplayer's image CDN (sky-blue placeholder art).
    if (url.pathname.startsWith('/tcgplayer-cdn/product/')) {
      return png([56, 189, 248]);
    }
    // The Pokémon 3D API: its model list and .glb files (cubes; Pawmot's file is broken on purpose).
    if (url.pathname.startsWith('/models3d/') && state.modelsDown) return json(503, { error: 'down' });
    if (url.pathname === '/models3d/index.json') {
      const model = (form, id) => `${base}/models3d/assets/models/opt/${form}/${id}.glb`;
      return json(200, { pokemon: [
        { id: 100, forms: [{ name: 'Voltorb', model: model('regular', 100), formName: 'regular' }, { name: 'Hisuian Voltorb', model: model('hisuian', 100), formName: 'hisuian' }, { name: 'Shiny Voltorb', model: model('shiny', 100), formName: 'shiny' }] },
        { id: 101, forms: [{ name: 'Electrode', model: model('regular', 101), formName: 'regular' }] },
        { id: 264, forms: [{ name: 'Linoone', model: model('regular', 264), formName: 'regular' }, { name: 'Elsewhere', model: 'https://example.com/models/opt/regular/9999.glb', formName: 'regular' }] },
        { id: 923, forms: [{ name: 'Pawmot', model: model('regular', 923), formName: 'regular' }] },
        { id: 656, forms: [{ name: 'Froakie', model: model('regular', 656), formName: 'regular' }] },
      ] });
    }
    if ((m = url.pathname.match(/^\/models3d\/assets\/models\/opt\/(\w+)\/(\d+)\.glb$/))) {
      state.modelDownloads.push(`${m[1]}/${m[2]}`);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      if (m[2] === '923') return res.end('<html>not a model</html>');
      return res.end(cubeGlb(m[1] === 'shiny' ? [0.95, 0.85, 0.2] : m[2] === '264' ? [0.85, 0.8, 0.7] : [0.95, 0.3, 0.2]));
    }
    // Frankfurter exchange rates: a fixed 1.20 dollars per euro.
    if (url.pathname === '/fx/v1/latest') {
      if (state.fxDown) return json(503, { error: 'down' });
      return json(200, { amount: 1, base: url.searchParams.get('base'), date: '2026-10-29', rates: { USD: 1.2 } });
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        tcgdexUrl: `${base}/v2/en`,
        tcgdexJaUrl: `${base}/v2/ja`,
        ptcgUrl: `${base}/ptcg`,
        tcgcsvUrl: `${base}/tcgcsv/tcgplayer/3`,
        fxUrl: `${base}/fx/v1`,
        ebayUrl: `${base}/ebay`,
        pptUrl: `${base}/ppt/api/v2`,
        models3dIndexUrl: `${base}/models3d/index.json`,
        models3dAssetPrefix: `${base}/models3d/`,
        requests,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * A CardCatalog wired to the mock sources. Picture downloads only reach the mock server: the
 * catalog's guessed image addresses (images.scrydex.com, images.pokemontcg.io) are real hosts,
 * and tests must give the same result offline and on a CI runner that can reach them.
 */
export function mockCatalog(mock, { timeoutMs = 3000 } = {}) {
  const catalog = new CardCatalog({
    tcgdex: new TcgClient({ baseUrl: mock.tcgdexUrl, timeoutMs }),
    tcgdexJa: new TcgClient({ baseUrl: mock.tcgdexJaUrl, lang: 'ja', timeoutMs }),
    ptcg: new PtcgDataClient({ baseUrl: mock.ptcgUrl, timeoutMs }),
    tcgcsv: new TcgCsvClient({ baseUrl: mock.tcgcsvUrl, timeoutMs }),
    fx: new ExchangeRates({ baseUrl: mock.fxUrl, timeoutMs }),
  });
  const local = new URL(mock.tcgdexUrl).host;
  const download = catalog.download.bind(catalog);
  catalog.download = (url) => (new URL(url, mock.tcgdexUrl).host === local ? download(url) : Promise.resolve(null));
  return catalog;
}
