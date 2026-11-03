// PokéBattles on the server: battle data from the cards (TCGdex, dataset, Japanese), 3D model
// forms, and the model download proxy/cache (only files the model list names, checked as glTF).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { parseDamage, parseModifier } from '../server/battle.js';
import { cleanName, Models3D, preferredForm } from '../server/models3d.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('PokéBattles: battle data and 3D models', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  let store;
  let models;
  const get = async (p) => {
    const res = await fetch(base + p);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const add = async (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards));
    return (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
  };

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-battle-'));
    models = new Models3D({ dataDir, indexUrl: mock.models3dIndexUrl, assetPrefix: mock.models3dAssetPrefix });
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock), models3d: models });
    store = app.locals.store;
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => { mock.state.modelsDown = false; });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('printed damage and weakness/resistance values are read the way cards print them', () => {
    assert.deepEqual(parseDamage(30), { base: 30, mod: null, text: '30' });
    assert.deepEqual(parseDamage('70+'), { base: 70, mod: '+', text: '70+' });
    assert.deepEqual(parseDamage('20×'), { base: 20, mod: 'x', text: '20×' });
    assert.deepEqual(parseDamage('10x'), { base: 10, mod: 'x', text: '10x' });
    assert.deepEqual(parseDamage(''), { base: 0, mod: null, text: '' });
    assert.deepEqual(parseModifier('×2'), { mult: 2 });
    assert.deepEqual(parseModifier('+20'), { add: 20 });
    assert.deepEqual(parseModifier('-30'), { sub: 30 });
  });

  test('model forms follow the card: Mega, regional, VMAX, shiny rarities; names without card suffixes', () => {
    const forms = ['regular', 'shiny', 'mega', 'megaShiny', 'gmax', 'alolan', 'hisuian'].map((form) => ({ form }));
    assert.equal(preferredForm({ name: 'Mega Lucario ex' }, forms), 'mega');
    assert.equal(preferredForm({ name: 'M Charizard-EX', rarity: 'Shiny Ultra Rare' }, forms), 'megaShiny');
    assert.equal(preferredForm({ name: 'Alolan Vulpix' }, forms), 'alolan');
    assert.equal(preferredForm({ name: 'Galarian Ponyta' }, forms), 'regular', 'falls back when the form has no model');
    assert.equal(preferredForm({ name: 'Pikachu VMAX' }, forms), 'gmax');
    assert.equal(preferredForm({ name: 'Charizard', rarity: 'Shiny Rare' }, forms), 'shiny');
    assert.equal(cleanName("Misty's Psyduck"), 'psyduck');
    assert.equal(cleanName('Charizard ex'), 'charizard');
    assert.equal(cleanName('Radiant Greninja'), 'greninja');
    assert.equal(cleanName('Mr. Mime'), 'mr. mime');
  });

  test('a card ready for battle: its printed attacks, ability, weakness and 3D model forms', async () => {
    const [linoone, voltorb] = await add([{ tcg_id: 'sv03-168', name: 'Linoone' }, { tcg_id: 'sv02-066', name: 'Voltorb' }]);
    const { status, body } = await get(`/api/battles/cards/${linoone.id}`);
    assert.equal(status, 200);
    assert.equal(body.battle.fromCard, true);
    assert.equal(body.battle.hp, 110);
    assert.deepEqual(body.battle.types, ['Colorless']);
    assert.deepEqual(body.battle.attacks.map((a) => [a.name, a.cost.length, a.damage.base, a.damage.mod]), [['Headbutt', 1, 30, null], ['Gutsy Charge', 3, 70, '+']]);
    assert.equal(body.battle.abilities[0].name, 'Quick Search');
    assert.deepEqual(body.battle.weaknesses, [{ type: 'Fighting', value: '×2', mult: 2 }]);
    assert.deepEqual(body.models.forms.map((f) => [f.form, f.url]), [['regular', '/api/battles/models/regular/264.glb']], 'a model outside the Pokémon 3D API address is left out');
    const v = (await get(`/api/battles/cards/${voltorb.id}`)).body;
    assert.deepEqual([v.models.dexId, v.models.default, v.models.forms.map((f) => f.form)], [100, 'regular', ['regular', 'hisuian', 'shiny']]);
  });

  test('Japanese cards, unlinked cards and cards without attack data still battle; Trainers can’t', async () => {
    const [jp, typed, froakie, helmet] = await add([
      { tcg_id: 'ja:SV2a-100', name: 'ビリリダマ' },
      { name: 'Voltorb', hp: 70, types: 'Lightning' },
      { tcg_id: 'mep-060', name: 'Froakie' },
      { tcg_id: 'me02-092', name: 'Punk Helmet' },
    ]);
    const j = (await get(`/api/battles/cards/${jp.id}`)).body;
    assert.equal(j.battle.attacks[0].name, 'ころがる');
    assert.equal(j.models.dexId, 100, 'found by its Pokédex number, not its Japanese name');
    const t = (await get(`/api/battles/cards/${typed.id}`)).body;
    assert.equal(t.battle.fromCard, false);
    assert.deepEqual(t.battle.attacks.map((a) => a.name), ['Tackle']);
    assert.deepEqual([t.battle.hp, t.battle.types], [70, ['Lightning']]);
    assert.equal(t.models.dexId, 100, 'an unlinked card finds its model by name');
    const f = (await get(`/api/battles/cards/${froakie.id}`)).body;
    assert.equal(f.battle.fromCard, false, 'no attacks in the data: a basic attack');
    assert.equal(f.models.dexId, 656);
    assert.equal((await get(`/api/battles/cards/${helmet.id}`)).status, 400);
    const fighters = (await get('/api/battles/fighters')).body.cards.map((c) => c.name);
    assert.ok(fighters.includes('Voltorb') && !fighters.includes('Punk Helmet'));
  });

  test('models are downloaded once, checked, cached and served; only listed files', async () => {
    mock.state.modelDownloads.length = 0;
    const first = await get('/api/battles/models/regular/100.glb');
    assert.equal(first.status, 200);
    assert.equal(first.type, 'model/gltf-binary');
    assert.equal(first.body.toString('latin1', 0, 4), 'glTF');
    assert.ok(fs.existsSync(path.join(dataDir, 'models3d', 'regular', '100.glb')));
    assert.equal((await get('/api/battles/models/regular/100.glb')).status, 200);
    assert.deepEqual(mock.state.modelDownloads, ['regular/100'], 'the second view comes from the cache');
    assert.equal((await get('/api/battles/models/regular/923.glb')).status, 502, 'not a glTF file: refused');
    assert.ok(!fs.existsSync(path.join(dataDir, 'models3d', 'regular', '923.glb')));
    for (const bad of ['/api/battles/models/regular/9999.glb', '/api/battles/models/regular/..%2F..%2Fcollection.db', '/api/battles/models/..%2Fofficial/100.glb', '/api/battles/models/regular/101.png']) {
      assert.equal((await get(bad)).status, 404, bad);
    }
    // Offline: the list on disk and the cached models still work.
    const offline = new Models3D({ dataDir, indexUrl: mock.models3dIndexUrl, assetPrefix: mock.models3dAssetPrefix });
    mock.state.modelsDown = true;
    assert.ok((await offline.file('regular', '100.glb')).endsWith(path.join('regular', '100.glb')));
    await assert.rejects(offline.file('regular', '101.glb'), (err) => err.status === 502);
  });

  test('another profile’s cards and cards in the trash aren’t available', async () => {
    const other = store.createUser({ username: 'rival', display_name: 'Rival', password_hash: '!' });
    const theirs = store.insertCard({ name: 'Voltorb', tcg_id: 'sv02-066', user_id: other });
    assert.equal((await get(`/api/battles/cards/${theirs}`)).status, 404);
    const [mine] = await add([{ tcg_id: 'sv02-067', name: 'Electrode' }]);
    await fetch(`${base}/api/cards/${mine.id}`, { method: 'DELETE' });
    assert.equal((await get(`/api/battles/cards/${mine.id}`)).status, 404);
    assert.ok(!(await get('/api/battles/fighters')).body.cards.some((c) => c.id === mine.id || c.id === theirs));
  });
});
