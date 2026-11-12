// The owner's own scanner tests (server/scanLabels.js): photos with their cards marked, kept in
// <data>/scan-bench/ for npm run bench:scan.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { createApp } from '../server/app.js';
import { scanLabelsRouter, validLabel } from '../server/scanLabels.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const card = { name: 'Voltorb', tcgIds: ['sv02-066'], corners: [[10, 10], [70, 12], [72, 98], [8, 96]] };

describe('scanner tests: the owner’s labelled photos', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-labels-'));
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const save = (labels, photo = JPEG) => {
    const form = new FormData();
    form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'mine.jpg');
    form.append('labels', JSON.stringify(labels));
    return fetch(`${base}/api/scan-labels`, { method: 'POST', body: form });
  };

  test('a photo and its marked cards are saved for bench:scan, listed, shown and deleted', async () => {
    const res = await save({ width: 100, height: 120, cards: [card] });
    assert.equal(res.status, 201);
    const { file } = await res.json();
    const labels = JSON.parse(fs.readFileSync(path.join(dataDir, 'scan-bench', 'labels.json'), 'utf8'));
    assert.deepEqual(labels.photos[0], { file, width: 100, height: 120, cards: [card] }, 'the format bench:scan reads');
    assert.ok(fs.existsSync(path.join(dataDir, 'scan-bench', file)));

    const list = await (await fetch(`${base}/api/scan-labels`)).json();
    assert.equal(list.photos.length, 1);
    const photo = await fetch(`${base}/api/scan-labels/photos/${file}`);
    assert.equal(photo.status, 200);
    assert.equal((await fetch(`${base}/api/scan-labels/photos/..%2Fcollection.db`)).status, 404, 'only listed photos');

    assert.equal((await fetch(`${base}/api/scan-labels/${file}`, { method: 'DELETE' })).status, 204);
    assert.equal((await (await fetch(`${base}/api/scan-labels`)).json()).photos.length, 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'scan-bench', file)), false);
  });

  test('cards need a name and four corners inside the photo', async () => {
    assert.equal((await save({ width: 100, height: 120, cards: [{ ...card, name: ' ' }] })).status, 400);
    assert.equal((await save({ width: 100, height: 120, cards: [{ ...card, corners: [[0, 0], [1, 1]] }] })).status, 400);
    assert.equal((await save({ width: 50, height: 50, cards: [card] })).status, 400, 'corners outside the photo');
    assert.equal((await save({ width: 100, height: 120, cards: [] })).status, 400);
    assert.deepEqual(validLabel({ ...card, tcgIds: ['ok-1', 'bad id!'] }, 100, 120).tcgIds, ['ok-1']);
  });

  test('only the owner can keep scanner tests', async () => {
    const app = express();
    app.use('/x', scanLabelsRouter({ dataDir, isOwner: () => false }));
    app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
    const s = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/x`);
      assert.equal(res.status, 403);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
