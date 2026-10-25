import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { TcgClient } from '../server/tcg.js';
import { startMockTcgdex } from './helpers/mock-tcgdex.js';

const PHOTO = fs.readFileSync(new URL('../docs/reference/voltorb-reverse-holo.jpg', import.meta.url));

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function start(dataDir, tcgUrl) {
  const app = createApp({ dataDir, tcg: new TcgClient({ baseUrl: tcgUrl, timeoutMs: 2000 }) });
  const { server, base } = await listen(app);
  return {
    base,
    async stop() {
      await new Promise((r) => server.close(r));
      app.locals.store.close();
    },
  };
}

function multipart(key, items) {
  const form = new FormData();
  const meta = items.map(({ photo, ...rest }, i) => {
    if (!photo) return rest;
    form.append(`photo_${i}`, new Blob([photo], { type: 'image/jpeg' }), `p${i}.jpg`);
    return { ...rest, photoField: `photo_${i}` };
  });
  form.append(key, JSON.stringify(meta));
  return form;
}

describe('collection API', () => {
  let mock;
  let dataDir;
  let srv;

  const get = async (p) => {
    const res = await fetch(srv.base + p);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const send = async (method, p, body) => {
    const init = { method };
    if (body instanceof FormData) init.body = body;
    else if (body) Object.assign(init, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const res = await fetch(srv.base + p, init);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  before(async () => {
    mock = await startMockTcgdex();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-test-'));
    srv = await start(dataDir, mock.url);
  });

  after(async () => {
    await srv.stop();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('looks up a card from its printed set code and number', async () => {
    const { status, body } = await get('/api/lookup?setCode=PAL&number=066/193');
    assert.equal(status, 200);
    assert.equal(body.results.length, 1);
    assert.deepEqual(
      { tcgId: body.results[0].tcgId, name: body.results[0].name, setCode: body.results[0].setCode, setTotal: body.results[0].setTotal },
      { tcgId: 'sv02-066', name: 'Voltorb', setCode: 'PAL', setTotal: '193' },
    );
    assert.match(body.results[0].image, /\/sv02\/066\/high\.png$/);
  });

  test('finds the set from the printed total when no set code is given', async () => {
    const { body } = await get('/api/lookup?number=168/197');
    assert.deepEqual(body.results.map((r) => r.tcgId), ['sv03-168']);
  });

  test('accepts numbers without leading zeros', async () => {
    const { body } = await get('/api/lookup?setCode=pfl&number=92');
    assert.deepEqual(body.results.map((r) => r.name), ['Punk Helmet']);
    assert.equal(body.results[0].setTotal, '094', 'total padded the way it is printed');
  });

  test('searches by name across sets', async () => {
    const { body } = await get('/api/lookup?name=voltorb');
    assert.deepEqual(body.results.map((r) => r.tcgId).sort(), ['sv01-066', 'sv02-066']);
  });

  test('requires something to look up', async () => {
    const { status } = await get('/api/lookup');
    assert.equal(status, 400);
  });

  let packIds;
  let cards;

  test('adds several packs at once, with photos and a date added', async () => {
    const before = Date.now();
    const { status, body } = await send('POST', '/api/packs', multipart('packs', [
      { name: 'Phantasmal Flames booster', kind: 'booster-pack', set_name: 'Phantasmal Flames', photo: PHOTO },
      { name: 'Holiday tin', kind: 'tin' },
    ]));
    assert.equal(status, 201);
    assert.equal(body.packs.length, 2);
    assert.match(body.packs[0].photo_url, /^\/media\/uploads\/packs\/.+\.jpg$/);
    assert.equal(body.packs[1].photo_url, null);
    assert.ok(Date.parse(body.packs[0].created_at) >= before - 1000);
    packIds = body.packs.map((p) => p.id);

    const img = await fetch(srv.base + body.packs[0].photo_url);
    assert.equal(img.status, 200);
    assert.equal(Buffer.from(await img.arrayBuffer()).length, PHOTO.length);
  });

  test('adds several cards at once, linking packs and downloading official images', async () => {
    const { status, body } = await send('POST', '/api/cards', multipart('cards', [
      { name: 'voltorb', set_code: 'pal', number: '066', set_total: '193', variant: 'reverse-holo', tcg_id: 'sv02-066', photo: PHOTO, pack_id: packIds[0] },
      { name: 'Punk Helmet', tcg_id: 'me02-092', photo: PHOTO, pack_id: packIds[0] },
      { name: 'Linoone', set_code: 'OBF', number: '168', set_total: '197', photo: PHOTO },
    ]));
    assert.equal(status, 201, JSON.stringify(body));
    cards = body.cards;
    const [voltorb, helmet, linoone] = cards;

    // Official details override what was typed; user choices (variant, pack) are kept.
    assert.equal(voltorb.name, 'Voltorb');
    assert.equal(voltorb.set_code, 'PAL');
    assert.equal(voltorb.set_name, 'Paldea Evolved');
    assert.equal(voltorb.rarity, 'Common');
    assert.equal(voltorb.hp, 70);
    assert.equal(voltorb.types, 'Lightning');
    assert.equal(voltorb.variant, 'reverse-holo');
    assert.equal(voltorb.pack_name, 'Phantasmal Flames booster');
    assert.equal(voltorb.official_url, '/media/official/sv02-066.png');
    assert.match(voltorb.photo_url, /^\/media\/uploads\/cards\//);
    assert.equal(helmet.category, 'Trainer');
    assert.equal(helmet.set_code, 'PFL');
    assert.equal(`${helmet.number}/${helmet.set_total}`, '092/094');

    // Not linked to an online card: still saved with the user's photo.
    assert.equal(linoone.official_url, null);
    assert.equal(linoone.pack_id, null);

    // One upload batch shares a single date added.
    assert.ok(cards.every((c) => c.created_at === voltorb.created_at));

    const png = await fetch(srv.base + voltorb.official_url);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
  });

  test('searches the whole collection', async () => {
    const names = async (qs) => (await get(`/api/cards?${qs}`)).body.cards.map((c) => c.name).sort();
    assert.deepEqual(await names(''), ['Linoone', 'Punk Helmet', 'Voltorb']);
    assert.deepEqual(await names('q=volt'), ['Voltorb']);
    assert.deepEqual(await names('q=066/193'), ['Voltorb']);
    assert.deepEqual(await names('q=obsidian'), []); // Linoone was saved without set name
    assert.deepEqual(await names('q=OBF'), ['Linoone']);
    assert.deepEqual(await names('q=reverse'), ['Voltorb']);
    assert.deepEqual(await names('q=phantasmal'), ['Punk Helmet', 'Voltorb']); // matches pack name too
    assert.deepEqual(await names('q=lightning common'), ['Voltorb']);
    assert.deepEqual(await names('q=100%25'), []);
  });

  test('filters by pack, by "no pack" and by set', async () => {
    const names = async (qs) => (await get(`/api/cards?${qs}`)).body.cards.map((c) => c.name).sort();
    assert.deepEqual(await names(`packId=${packIds[0]}`), ['Punk Helmet', 'Voltorb']);
    assert.deepEqual(await names(`packId=${packIds[0]}&q=helmet`), ['Punk Helmet']);
    assert.deepEqual(await names(`packId=${packIds[1]}`), []);
    assert.deepEqual(await names('packId=none'), ['Linoone']);
    assert.deepEqual(await names('setCode=pal'), ['Voltorb']);
  });

  test('packs list card counts and are searchable', async () => {
    const { body } = await get('/api/packs');
    const counts = Object.fromEntries(body.packs.map((p) => [p.name, p.card_count]));
    assert.deepEqual(counts, { 'Phantasmal Flames booster': 2, 'Holiday tin': 0 });
    const tins = await get('/api/packs?q=tin');
    assert.deepEqual(tins.body.packs.map((p) => p.name), ['Holiday tin']);
  });

  test('links a card to its official version later', async () => {
    const linoone = cards[2];
    const { status, body } = await send('PATCH', `/api/cards/${linoone.id}`, { tcg_id: 'sv03-168', pack_id: packIds[1] });
    assert.equal(status, 200);
    assert.equal(body.set_name, 'Obsidian Flames');
    assert.equal(body.official_url, '/media/official/sv03-168.png');
    assert.equal(body.pack_name, 'Holiday tin');
    assert.equal(body.created_at, linoone.created_at, 'date added does not change on edit');
  });

  test('rejects cards without a name and unknown packs', async () => {
    const noName = await send('POST', '/api/cards', multipart('cards', [{ name: '  ' }]));
    assert.equal(noName.status, 400);
    const badPack = await send('POST', '/api/cards', multipart('cards', [{ name: 'Pikachu', pack_id: 9999 }]));
    assert.equal(badPack.status, 400);
    const notJson = await fetch(`${srv.base}/api/cards`, { method: 'POST', body: (() => { const f = new FormData(); f.append('cards', '{'); return f; })() });
    assert.equal(notJson.status, 400);
  });

  test('never serves the database file', async () => {
    for (const p of ['/media/collection.db', '/media/uploads/../collection.db', '/collection.db']) {
      const res = await fetch(srv.base + p);
      assert.notEqual(res.status, 200, p);
    }
  });

  test('keeps the collection across restarts', async () => {
    await srv.stop();
    srv = await start(dataDir, mock.url);
    const { body } = await get('/api/cards');
    assert.equal(body.cards.length, 3);
    const photo = await fetch(srv.base + body.cards[0].photo_url);
    assert.equal(photo.status, 200);
    const meta = await get('/api/meta');
    assert.deepEqual({ cards: meta.body.stats.cards, packs: meta.body.stats.packs }, { cards: 3, packs: 2 });
  });

  test('deleting a pack keeps its cards unless asked to delete them too', async () => {
    const res = await send('DELETE', `/api/packs/${packIds[1]}`);
    assert.equal(res.status, 204);
    const linoone = await get(`/api/cards/${cards[2].id}`);
    assert.equal(linoone.body.pack_id, null);

    await send('DELETE', `/api/packs/${packIds[0]}?withCards=1`);
    const { body } = await get('/api/cards');
    assert.deepEqual(body.cards.map((c) => c.name), ['Linoone']);
    assert.equal((await fetch(srv.base + cards[0].photo_url)).status, 404, 'photo file removed');
  });
});

describe('when the online card database is unreachable', () => {
  test('lookups fail softly and cards can still be saved', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-offline-'));
    const srv = await start(dataDir, 'http://127.0.0.1:9/v2/en');
    try {
      const lookup = await fetch(`${srv.base}/api/lookup?name=voltorb`);
      assert.equal(lookup.status, 502);
      assert.match((await lookup.json()).error, /could not be reached/);

      const form = multipart('cards', [{ name: 'Voltorb', tcg_id: 'sv02-066', set_name: 'Paldea Evolved', official_image_url: 'http://127.0.0.1:9/x/high.png', photo: PHOTO }]);
      const res = await fetch(`${srv.base}/api/cards`, { method: 'POST', body: form });
      assert.equal(res.status, 201);
      const [card] = (await res.json()).cards;
      assert.equal(card.set_name, 'Paldea Evolved');
      assert.equal(card.official_image_path, null);
      assert.equal(card.official_url, 'http://127.0.0.1:9/x/high.png', 'falls back to the remote URL');
    } finally {
      await srv.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
