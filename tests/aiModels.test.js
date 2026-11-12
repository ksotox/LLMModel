// AI model files (server/aiModels.js): listed names only, downloaded once, size and checksum
// checked (or pinned on first download), served behind sign-in; and onnxruntime-web is served.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { AiModels } from '../server/aiModels.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('AI model files', () => {
  let host;
  let hostUrl;
  let served; // name -> Buffer the fake model host returns
  let hits;
  let mock;
  let dataDir;
  let server;
  let base;

  before(async () => {
    served = { 'good.onnx': bytes(4096, 1), 'pinme.onnx': bytes(3000, 2), 'big.onnx': bytes(9000, 3), 'tiny.onnx': bytes(10, 4) };
    hits = [];
    host = http.createServer((req, res) => {
      const name = req.url.slice(1);
      hits.push(name);
      if (!served[name]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served[name]);
    });
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    hostUrl = `http://127.0.0.1:${host.address().port}`;
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-ai-'));
  });
  after(async () => {
    await new Promise((r) => server?.close(r) ?? r());
    await new Promise((r) => host.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The manifest needs https addresses; the test host is http, so its fetch is redirected.
  const viaHost = (url, init) => fetch(url.replace(/^https:\/\/models\.test/, hostUrl), init);
  const entry = (name, extra = {}) => ({ name, file: `${name}.onnx`, url: `https://models.test/${name}.onnx`, license: 'Apache-2.0', purpose: 'test', ...extra });

  test('a listed model is downloaded once, checked against its hash, and served', async () => {
    const models = new AiModels({ dataDir, fetchImpl: viaHost, manifest: [entry('good', { sha256: sha(served['good.onnx']), size: 4096 })] });
    const app = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock), aiModels: models });
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;

    const list = await (await fetch(`${base}/api/ai/models`)).json();
    assert.deepEqual(list.models, [{ name: 'good', purpose: 'test', license: 'Apache-2.0', size: 4096, ready: false }]);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/api/ai/models/good`);
      assert.equal(res.status, 200);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(served['good.onnx']));
    }
    assert.deepEqual(hits.filter((h) => h === 'good.onnx'), ['good.onnx'], 'downloaded once');
    assert.equal((await (await fetch(`${base}/api/ai/models`)).json()).models[0].ready, true);
    assert.equal((await fetch(`${base}/api/ai/models/..%2Fcollection.db`)).status, 404);
    assert.equal((await fetch(`${base}/api/ai/models/unknown`)).status, 404);
  });

  test('a wrong hash, an oversized or a tiny file is refused and nothing is kept', async () => {
    const models = new AiModels({
      dataDir,
      fetchImpl: viaHost,
      manifest: [entry('good2', { url: 'https://models.test/good.onnx', sha256: '0'.repeat(64) }), entry('big', { size: 4000 }), entry('tiny')],
    });
    await assert.rejects(models.file('good2'), (e) => e.status === 502 && /checksum mismatch/.test(e.message));
    await assert.rejects(models.file('big'), (e) => e.status === 502 && /larger than expected/.test(e.message));
    await assert.rejects(models.file('tiny'), (e) => e.status === 502 && /too small/.test(e.message));
    const left = fs.readdirSync(path.join(dataDir, 'ai-models')).filter((f) => f !== 'good.onnx' && f !== 'pins.json');
    assert.deepEqual(left, [], 'no partial or rejected files');
  });

  test('without a hash in the manifest, the first download is pinned and later ones must match', async () => {
    const make = () => new AiModels({ dataDir, fetchImpl: viaHost, manifest: [entry('pinme')] });
    const first = make();
    await first.file('pinme');
    assert.equal(first.pins().pinme, sha(served['pinme.onnx']));
    fs.rmSync(path.join(dataDir, 'ai-models', 'pinme.onnx'));
    served['pinme.onnx'] = bytes(3000, 9); // the host now serves something else
    await assert.rejects(make().file('pinme'), /checksum mismatch/);
  });

  test('offline: a clear error, and a later try works', async () => {
    let online = false;
    const models = new AiModels({ dataDir, fetchImpl: (u, i) => (online ? viaHost(u, i) : Promise.reject(new Error('offline'))), manifest: [entry('late', { url: 'https://models.test/big.onnx' })] });
    await assert.rejects(models.file('late'), (e) => e.status === 503);
    online = true;
    assert.ok(fs.existsSync(await models.file('late')));
  });

  test('bad manifest entries are rejected at start-up', () => {
    assert.throws(() => new AiModels({ dataDir, manifest: [entry('x', { url: 'http://insecure.test/x.onnx' })] }), /Bad AI model entry/);
    assert.throws(() => new AiModels({ dataDir, manifest: [entry('x', { file: '../x.onnx' })] }), /Bad AI model entry/);
  });

  test('the ONNX runtime is served locally', async () => {
    const res = await fetch(`${base}/vendor/ort/ort.wasm.min.mjs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const wasm = await fetch(`${base}/vendor/ort/ort-wasm-simd-threaded.wasm`, { method: 'HEAD' });
    assert.equal(wasm.status, 200);
  });
});
