// Experimental pre-grading through the local Viridian service, with a mock service in its place:
// success, offline service, retakes, history, upload limits, path tricks, card access, and the
// report photos following the card when it's deleted (alone, with a pack, or with a profile).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { engineUrl } from '../server/grading/router.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

const JPEG = fs.readFileSync(new URL('../docs/reference/voltorb-reverse-holo.jpg', import.meta.url));
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OVERLAY = `data:image/png;base64,${PNG_1PX.toString('base64')}`;

const engineAnswer = (overrides = {}) => ({
  ok: true, engine: 'viridian-cv', status: 'complete', experimental_overall: 8,
  front: { centering: { ok: true, grade: 9, left_right: '55/45', top_bottom: '52/48', confidence: 'medium' }, corners: { grade: 7, confidence: 'low' }, edges: { grade: 8, confidence: 'low' }, surface: { grade: 8, confidence: 'low' }, experimental_overall: 8 },
  back: { centering: { ok: false, grade: null, note: 'Couldn’t align the back to the reference.' }, corners: { grade: 8 }, edges: { grade: 8 }, surface: { grade: 9 }, experimental_overall: 9 },
  capture: { front: { ok: true, blur: 700, warnings: [] }, back: { ok: true, blur: 650, warnings: [] } },
  reference_used: false,
  warnings: ['Reference alignment unavailable.'],
  front_overlay: OVERLAY, back_overlay: OVERLAY,
  ...overrides,
});

describe('experimental pre-grading', () => {
  let mock;
  let engine;
  let dataDir;
  let server;
  let base;
  let store;
  const state = { mode: 'ok', calls: [] };
  const savedUrl = process.env.GRADER_SERVICE_URL;

  const add = async (cards) => {
    const form = new FormData();
    form.append('cards', JSON.stringify(cards.map((c, i) => ({ ...c, photoField: `photo_${i}` }))));
    cards.forEach((_, i) => form.append(`photo_${i}`, new Blob([JPEG], { type: 'image/jpeg' }), 'card.jpg'));
    return (await (await fetch(`${base}/api/cards`, { method: 'POST', body: form })).json()).cards;
  };
  const photos = ({ front = JPEG, back = JPEG, frontType = 'image/jpeg', backType = 'image/jpeg', omitBack = false } = {}) => {
    const form = new FormData();
    form.append('front', new Blob([front], { type: frontType }), 'front.jpg');
    if (!omitBack) form.append('back', new Blob([back], { type: backType }), 'back.jpg');
    return form;
  };
  const grade = (id, form = photos()) => fetch(`${base}/api/grading/cards/${id}`, { method: 'POST', body: form });
  const reports = async (id) => (await (await fetch(`${base}/api/grading/cards/${id}`)).json()).reports;
  const gradingDir = () => path.join(dataDir, 'uploads', 'grading');
  const folders = () => fs.readdirSync(gradingDir()).sort();

  before(async () => {
    mock = await startMockSources();
    // The stand-in for the Python service: records what it was sent and answers per `state.mode`.
    engine = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        if (req.url === '/health') return res.end(JSON.stringify({ ready: true, engine: 'viridian-cv' }));
        state.calls.push({ url: req.url, parts: [...body.matchAll(/; name="(\w+)"/g)].map((m) => m[1]) });
        res.setHeader('content-type', 'application/json');
        if (state.mode === 'unreadable') { res.statusCode = 422; return res.end(JSON.stringify({ detail: 'Could not find the full card in both photographs.' })); }
        if (state.mode === 'garbage') return res.end('<html>not json</html>');
        if (state.mode === 'wrong-engine') return res.end(JSON.stringify({ ...engineAnswer(), engine: 'something-else' }));
        if (state.mode === 'retake') return res.end(JSON.stringify(engineAnswer({ status: 'retake', experimental_overall: null, capture: { front: { ok: false, warnings: ['Photo looks blurry'] }, back: { ok: true, warnings: [] } } })));
        res.end(JSON.stringify(engineAnswer()));
      });
    });
    await new Promise((r) => engine.listen(0, '127.0.0.1', r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-grading-'));
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    store = app.locals.store;
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => {
    process.env.GRADER_SERVICE_URL = `http://127.0.0.1:${engine.address().port}`;
    state.mode = 'ok';
    state.calls = [];
  });
  after(async () => {
    if (savedUrl === undefined) delete process.env.GRADER_SERVICE_URL; else process.env.GRADER_SERVICE_URL = savedUrl;
    await new Promise((r) => server.close(r));
    await new Promise((r) => engine.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('only a loopback HTTP address is accepted for the grading service', () => {
    assert.equal(engineUrl({}), 'http://127.0.0.1:8765');
    assert.equal(engineUrl({ GRADER_SERVICE_URL: 'http://localhost:9000' }), 'http://localhost:9000');
    for (const bad of ['http://192.168.1.5:8765', 'https://127.0.0.1:8765', 'http://evil.example', 'http://user:pw@127.0.0.1:8765', 'http://127.0.0.1:8765/admin']) {
      assert.throws(() => engineUrl({ GRADER_SERVICE_URL: bad }), /local HTTP origin/, bad);
    }
  });

  test('health: ready when the service answers, a calm "offline" when it doesn’t', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/grading/health`)).json(), { configured: true, ready: true, engine: 'viridian-cv', detail: 'Ready for card photos' });
    process.env.GRADER_SERVICE_URL = 'http://127.0.0.1:1';
    const off = await fetch(`${base}/api/grading/health`);
    assert.equal(off.status, 200);
    assert.equal((await off.json()).ready, false);
  });

  test('a report is saved with the card: original photos, overlays, history, and the official picture as reference', async () => {
    const [card] = await add([{ tcg_id: 'sv02-066', name: 'Voltorb' }]);
    assert.ok(store.getCard(card.id).official_image_path, 'the mock catalog cached an official picture');
    const res = await grade(card.id);
    assert.equal(res.status, 201);
    const { report } = await res.json();
    assert.equal(report.engine, 'viridian-cv');
    assert.equal(report.screening_only, true);
    assert.equal(report.front.centering.left_right, '55/45');
    assert.equal(report.back.centering.note, 'Couldn’t align the back to the reference.');
    assert.deepEqual(Object.keys(report.media).sort(), ['back', 'back_overlay', 'front', 'front_overlay']);
    assert.deepEqual(state.calls[0].parts, ['front', 'back', 'reference']);
    for (const url of Object.values(report.media)) {
      assert.match(url, /^\/media\/uploads\/grading\/[0-9a-f-]{36}\/(front|back)(_overlay)?\.(jpg|png)$/);
      assert.equal((await fetch(base + url)).status, 200, url);
    }
    // The original photo is stored byte for byte, apart from the collection's card picture.
    assert.deepEqual(fs.readFileSync(path.join(dataDir, report.media.front.replace('/media/', ''))), JPEG);
    assert.notEqual(store.getCard(card.id).photo_path, report.media.front.replace('/media/', ''));
    const list = await reports(card.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, report.id);
  });

  test('a retake keeps no overall estimate; two reports stay independent; deleting one leaves the other', async () => {
    const [card] = await add([{ name: 'Retake Pikachu', set_code: 'PAL', number: '063' }]);
    state.mode = 'retake';
    const first = (await (await grade(card.id)).json()).report;
    assert.equal(first.status, 'retake');
    assert.equal(first.experimental_overall, null);
    assert.deepEqual(first.capture.front.warnings, ['Photo looks blurry']);
    state.mode = 'ok';
    const second = (await (await grade(card.id)).json()).report;
    assert.deepEqual((await reports(card.id)).map((r) => r.id), [second.id, first.id], 'newest first');

    const del = await fetch(`${base}/api/grading/cards/${card.id}/reports/${first.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.ok(!fs.existsSync(path.join(gradingDir(), first.id)));
    assert.ok(fs.existsSync(path.join(gradingDir(), second.id, 'front.jpg')));
    assert.deepEqual((await reports(card.id)).map((r) => r.id), [second.id]);
    assert.ok(store.getCard(card.id), 'the card itself stays');
    assert.ok(fs.existsSync(path.join(dataDir, store.getCard(card.id).photo_path)), 'and so does its collection photo');
  });

  test('uploads are checked: size, real image type, both sides, valid card', async () => {
    const [card] = await add([{ name: 'Upload Test' }]);
    const before = folders();
    const big = Buffer.concat([JPEG.subarray(0, 3), Buffer.alloc(8 * 1024 * 1024)]);
    assert.equal((await grade(card.id, photos({ front: big }))).status, 413);
    assert.equal((await grade(card.id, photos({ front: Buffer.from('<svg onload=alert(1)>…padding…') }))).status, 415);
    assert.equal((await grade(card.id, photos({ front: PNG_1PX, frontType: 'image/jpeg' }))).status, 415, 'type must match the content');
    assert.equal((await grade(card.id, photos({ omitBack: true }))).status, 400);
    assert.equal((await grade(card.id, photos({ frontType: 'text/plain' }))).status, 400, 'non-images are dropped, so a side is missing');
    assert.equal((await grade('abc')).status, 400);
    assert.equal((await grade('0')).status, 400);
    assert.equal((await grade(999999)).status, 404);
    assert.equal(state.calls.length, 0, 'nothing reached the grading service');
    assert.deepEqual(folders(), before, 'no folders left behind');
  });

  test('report ids can’t point outside the grading folder', async () => {
    const [card] = await add([{ name: 'Path Test' }]);
    const { report } = await (await grade(card.id)).json();
    for (const bad of ['..%2F..%2Fcollection.db', '..', 'not-a-uuid', `${report.id}x`]) {
      const res = await fetch(`${base}/api/grading/cards/${card.id}/reports/${bad}`, { method: 'DELETE' });
      assert.ok([400, 404].includes(res.status), `${bad} → ${res.status}`);
    }
    assert.equal((await fetch(`${base}/api/grading/cards/${card.id}/reports/00000000-0000-4000-8000-000000000000`, { method: 'DELETE' })).status, 404);
    assert.ok(fs.existsSync(path.join(dataDir, 'collection.db')));
    assert.ok(fs.existsSync(path.join(gradingDir(), report.id, 'front.jpg')));
    // A report can only be deleted through its own card.
    const [other] = await add([{ name: 'Other Card' }]);
    assert.equal((await fetch(`${base}/api/grading/cards/${other.id}/reports/${report.id}`, { method: 'DELETE' })).status, 404);
    assert.ok(fs.existsSync(path.join(gradingDir(), report.id)));
  });

  test('another profile’s card, or a card in the trash, can’t be graded or read', async () => {
    const owner = store.createUser({ username: 'someone', display_name: 'Someone', password_hash: '!' });
    const theirs = store.insertCard({ name: 'Not Yours', user_id: owner });
    assert.equal((await fetch(`${base}/api/grading/cards/${theirs}`)).status, 404);
    assert.equal((await grade(theirs)).status, 404);
    const [card] = await add([{ name: 'Trashed' }]);
    await fetch(`${base}/api/cards/${card.id}`, { method: 'DELETE' });
    assert.equal((await grade(card.id)).status, 404);
    assert.equal(state.calls.length, 0);
  });

  test('errors from the service: offline, unreadable photo, bad answers — nothing saved, collection untouched', async () => {
    const [card] = await add([{ name: 'Error Test' }]);
    const before = folders();
    const photo = path.join(dataDir, store.getCard(card.id).photo_path);
    process.env.GRADER_SERVICE_URL = 'http://127.0.0.1:1';
    let res = await grade(card.id);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /isn’t running/);
    process.env.GRADER_SERVICE_URL = `http://127.0.0.1:${engine.address().port}`;
    state.mode = 'unreadable';
    res = await grade(card.id);
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /full card/);
    for (const mode of ['garbage', 'wrong-engine']) {
      state.mode = mode;
      res = await grade(card.id);
      assert.equal(res.status, 502, mode);
    }
    assert.deepEqual(folders(), before);
    assert.deepEqual(await reports(card.id), []);
    assert.ok(fs.existsSync(photo), 'the card’s own photo is never touched');
  });

  test('deleting a card for good, a pack with its cards, or a profile removes their report photos; the trash keeps them', async () => {
    const [kept, gone] = await add([{ name: 'Keeper' }, { name: 'Goner' }]);
    const keptReport = (await (await grade(kept.id)).json()).report;
    const goneReport = (await (await grade(gone.id)).json()).report;

    await fetch(`${base}/api/cards/${gone.id}`, { method: 'DELETE' }); // to the trash: restorable, report kept
    assert.ok(fs.existsSync(path.join(gradingDir(), goneReport.id)));
    await fetch(`${base}/api/cards/${gone.id}?permanent=1`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(path.join(gradingDir(), goneReport.id)));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM card_grading_reports WHERE card_id = ?').get(gone.id).n, 0);
    assert.ok(fs.existsSync(path.join(gradingDir(), keptReport.id)), 'other cards’ reports stay');

    const packForm = new FormData();
    packForm.append('packs', JSON.stringify([{ name: 'Graded pack', kind: 'other' }]));
    const pack = (await (await fetch(`${base}/api/packs`, { method: 'POST', body: packForm })).json()).packs[0];
    const [inPack] = await add([{ name: 'In a pack', pack_id: pack.id }]);
    const packReport = (await (await grade(inPack.id)).json()).report;
    await fetch(`${base}/api/packs/${pack.id}?withCards=1`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(path.join(gradingDir(), packReport.id)));
    assert.ok(fs.existsSync(path.join(gradingDir(), keptReport.id)));

    // A folder no report points to (e.g. left over from a crash) is swept on the next deletion.
    const stray = path.join(gradingDir(), '11111111-2222-4333-8444-555555555555');
    fs.mkdirSync(stray);
    const notAReport = path.join(gradingDir(), 'keep-me');
    fs.mkdirSync(notAReport);
    const [temp] = await add([{ name: 'Temp' }]);
    await fetch(`${base}/api/cards/${temp.id}?permanent=1`, { method: 'DELETE' });
    assert.ok(!fs.existsSync(stray));
    assert.ok(fs.existsSync(notAReport), 'only report-id folders are ever removed');
    assert.ok(fs.existsSync(path.join(gradingDir(), keptReport.id)));

    // Deleting a profile deletes its cards, and with them their report photos.
    const userId = store.createUser({ username: 'leaving', display_name: 'Leaving', password_hash: '!' });
    const theirCard = store.insertCard({ name: 'Their card', user_id: userId });
    const theirReport = '99999999-8888-4777-8666-555555555555';
    fs.mkdirSync(path.join(gradingDir(), theirReport));
    fs.writeFileSync(path.join(gradingDir(), theirReport, 'front.jpg'), JPEG);
    store.db.prepare('INSERT INTO card_grading_reports (id, card_id, created_at, folder, result_json) VALUES (?,?,?,?,?)')
      .run(theirReport, theirCard, new Date().toISOString(), theirReport, '{}');
    assert.equal((await fetch(`${base}/api/users/${userId}`, { method: 'DELETE' })).status, 204);
    assert.ok(!fs.existsSync(path.join(gradingDir(), theirReport)));
    assert.ok(fs.existsSync(path.join(gradingDir(), keptReport.id)));
  });
});
