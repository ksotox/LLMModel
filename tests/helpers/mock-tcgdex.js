// A stand-in for the TCGdex API so tests (and offline demos) don't need the internet.
// Serves the three cards from the reference photos plus a few neighbours, with generated PNG art.

import http from 'node:http';
import zlib from 'node:zlib';

const CARDS = {
  sv02: {
    name: 'Paldea Evolved', series: 'sv', official: 193,
    cards: [
      ['065', 'Pawmot', { hp: 130, types: ['Lightning'], rarity: 'Rare' }],
      ['066', 'Voltorb', { hp: 70, types: ['Lightning'], rarity: 'Common' }],
      ['067', 'Electrode', { hp: 90, types: ['Lightning'], rarity: 'Uncommon' }],
    ],
  },
  sv03: {
    name: 'Obsidian Flames', series: 'sv', official: 197,
    cards: [
      ['167', 'Zigzagoon', { hp: 70, types: ['Colorless'], rarity: 'Common' }],
      ['168', 'Linoone', { hp: 110, types: ['Colorless'], rarity: 'Uncommon' }],
    ],
  },
  me02: {
    name: 'Phantasmal Flames', series: 'me', official: 94,
    cards: [['092', 'Punk Helmet', { category: 'Trainer', rarity: 'Uncommon' }]],
  },
  sv01: {
    name: 'Scarlet & Violet', series: 'sv', official: 198,
    cards: [['066', 'Voltorb', { hp: 60, types: ['Lightning'], rarity: 'Common' }]],
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

const COLORS = { Lightning: [250, 204, 21], Colorless: [214, 211, 209], Trainer: [148, 163, 184] };

export function startMockTcgdex() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url.pathname + url.search);
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const image = (setId, localId) => `${base}/assets/en/${CARDS[setId].series}/${setId}/${localId}`;
    const brief = (setId, [localId, name]) => ({ id: `${setId}-${localId}`, localId, name, image: image(setId, localId) });

    let m;
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
        id: `${setId}-${localId}`, localId, name, image: image(setId, localId),
        category: extra.category ?? 'Pokemon', hp: extra.hp, types: extra.types, rarity: extra.rarity,
        set: { id: setId, name: s.name, cardCount: { official: s.official, total: s.official + 20 } },
      });
    }
    if ((m = url.pathname.match(/^\/assets\/en\/\w+\/([^/]+)\/([^/]+)\/high\.png$/))) {
      const c = CARDS[m[1]]?.cards.find((x) => x[0] === m[2]);
      if (!c) return json(404, { error: 'not found' });
      const color = COLORS[c[2].category ?? c[2].types?.[0]] ?? [200, 200, 200];
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(solidPng(63, 88, color));
    }
    if ((m = url.pathname.match(/^\/assets\/.*\/low\.webp$/))) {
      // No webp encoder here: send a PNG, browsers sniff the format.
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(solidPng(63, 88, [180, 180, 180]));
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v2/en`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
