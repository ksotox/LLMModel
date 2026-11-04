// 3D Pop-out in the gallery: matching prepared art to printings, the effect colour, which 3D model
// each card has, and saving / serving the drawn model pictures.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { Models3D } from '../server/models3d.js';
import { artworkForCard, cardArtworkKey, hasPokemon, registerArtwork } from '../public/js/pokemon-popout.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

// A tiny real WebP header (RIFF....WEBP) and a PNG signature, padded.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);

describe('3D Pop-out: prepared art and effects', () => {
  test('a printing is matched by set and number however the number is written', () => {
    assert.equal(cardArtworkKey({ set_code: 'dri', number: '190/182' }), 'DRI:190');
    assert.equal(cardArtworkKey({ set_code: 'DRI', number: '020' }), 'DRI:20');
    assert.equal(cardArtworkKey({ set_code: 'SWSH', number: 'TG05' }), 'SWSH:TG05');
  });

  test('prepared scenes for the four sample cards; everything else gets a glow from its type', () => {
    assert.deepEqual(artworkForCard({ set_code: 'DRI', number: '190', types: 'Fire' }), { effect: 'fire', scene: '/popout-art/scenes/DRI-190.webp' });
    assert.equal(artworkForCard({ set_code: 'PBL', number: '031/084' }).scene, '/popout-art/scenes/PBL-031.webp');
    assert.deepEqual(artworkForCard({ set_code: 'SV2', number: '66', types: 'Lightning' }), { effect: 'electric' });
    assert.equal(artworkForCard({ types: 'Grass, Psychic' }).effect, 'grass');
    assert.equal(artworkForCard({ types: ['Darkness'] }).effect, 'dark');
    assert.equal(artworkForCard({}).effect, 'holo');
    registerArtwork('MEG:7', { background: '/bg.webp', foreground: '/fg.webp', effect: 'water' });
    assert.deepEqual(artworkForCard({ set_code: 'MEG', number: '007' }), { effect: 'water', background: '/bg.webp', foreground: '/fg.webp' });
    assert.throws(() => registerArtwork('MEG-7', { scene: '/x.webp' }));
    assert.throws(() => registerArtwork('MEG:8', { foreground: '/fg.webp' }));
    assert.equal(hasPokemon({ category: 'Trainer' }), false);
    assert.equal(hasPokemon({ category: 'Pokemon' }), true);
    assert.equal(hasPokemon({}), true);
  });
});

describe('3D Pop-out: models and pictures', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  let store;
  const call = async (method, p, body, type) => {
    const init = { method, headers: {} };
    if (Buffer.isBuffer(body)) { init.body = body; init.headers['content-type'] = type ?? 'image/webp'; }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(base + p, init);
    const ctype = res.headers.get('content-type') ?? '';
    return { status: res.status, type: ctype, body: ctype.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const add = async (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards));
    return (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
  };

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-popout-'));
    const models3d = new Models3D({ dataDir, indexUrl: mock.models3dIndexUrl, assetPrefix: mock.models3dAssetPrefix });
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock), models3d });
    store = app.locals.store;
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('each card’s model (by name, or Pokédex number for Japanese cards); none for Trainers or other profiles', async () => {
    const [voltorb, linoone, jp, helmet] = await add([
      { tcg_id: 'sv02-066', name: 'Voltorb' }, { tcg_id: 'sv03-168', name: 'Linoone' },
      { tcg_id: 'ja:SV2a-100', name: 'ビリリダマ' }, { tcg_id: 'me02-092', name: 'Punk Helmet' },
    ]);
    const other = store.createUser({ username: 'friend', display_name: 'Friend', password_hash: '!' });
    const theirs = store.insertCard({ name: 'Voltorb', tcg_id: 'sv02-066', user_id: other });
    const { status, body } = await call('POST', '/api/popout/models', { ids: [voltorb.id, linoone.id, jp.id, helmet.id, theirs, 99999] });
    assert.equal(status, 200);
    assert.deepEqual(body.models[voltorb.id], { form: 'regular', id: '100', model: '/api/battles/models/regular/100.glb', picture: '/api/popout/pictures/regular/100', has: false });
    assert.equal(body.models[linoone.id].id, '264');
    assert.equal(body.models[jp.id].id, '100', 'a Japanese name is matched by its Pokédex number');
    assert.equal(body.models[helmet.id], null);
    assert.equal(body.models[theirs], null);
    assert.equal(body.models[99999], null);
    assert.equal((await call('POST', '/api/popout/models', { ids: 'all' })).status, 400);
  });

  test('a drawn picture is saved once per model and served; only pictures of listed models', async () => {
    assert.equal((await call('GET', '/api/popout/pictures/regular/100')).status, 404, 'not drawn yet');
    assert.equal((await call('PUT', '/api/popout/pictures/regular/100', Buffer.from('<svg></svg>'.padEnd(60)), 'image/webp')).status, 400, 'not a picture');
    assert.equal((await call('PUT', '/api/popout/pictures/regular/100', WEBP)).status, 204);
    const got = await call('GET', '/api/popout/pictures/regular/100');
    assert.equal(got.status, 200);
    assert.equal(got.type, 'image/webp');
    assert.ok(got.body.equals(WEBP));
    assert.equal((await call('PUT', '/api/popout/pictures/regular/100', PNG, 'image/png')).status, 204);
    assert.ok((await call('GET', '/api/popout/pictures/regular/100')).body.equals(WEBP), 'the first picture is kept');
    assert.equal((await call('PUT', '/api/popout/pictures/regular/264', PNG, 'image/png')).status, 204);
    assert.equal((await call('GET', '/api/popout/pictures/regular/264')).type, 'image/png');
    const [voltorb] = await add([{ tcg_id: 'sv02-066', name: 'Voltorb' }]);
    assert.equal((await call('POST', '/api/popout/models', { ids: [voltorb.id] })).body.models[voltorb.id].has, true, 'other Voltorb cards reuse it');
    for (const bad of ['/api/popout/pictures/regular/9999', '/api/popout/pictures/regular/..%2F..%2Fcollection', '/api/popout/pictures/..%2Fofficial/100']) {
      assert.equal((await call('PUT', bad, WEBP)).status, 404, bad);
    }
    assert.equal((await call('PUT', '/api/popout/pictures/shiny/100', Buffer.concat([WEBP, Buffer.alloc(1024 * 1024)]))).status, 413, 'over 1 MB');
    assert.ok(!fs.existsSync(path.join(dataDir, 'popout', 'shiny')));
  });
});
