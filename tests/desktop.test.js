// The desktop launcher against a stand-in GitHub: installing, updating (keeping the collection),
// rolling back a version that won't start, and running the server.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import {
  ensurePackages, gradingPython, installedVersion, isUp, latestCommit, rollback, startGrading, startServer, stopGrading, stopServer, unzip, update, waitUntilUp,
} from '../desktop/launcher.mjs';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

/** A zip like GitHub's: every path under "<repo>-<sha>/", deflated. */
function makeZip(files, top) {
  const locals = [];
  const central = [];
  let offset = 0;
  const entries = [[`${top}/`, null], ...Object.entries(files).map(([name, text]) => [`${top}/${name}`, Buffer.from(text)])];
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const body = data ? zlib.deflateRawSync(data) : Buffer.alloc(0);
    const crc = data ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(data ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data?.length ?? 0, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(data ? 8 : 0, 10);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(data?.length ?? 0, 24); head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A tiny stand-in for the app: answers with its version and whether it can see the collection.
const SERVER = `import fs from 'node:fs';
import http from 'node:http';
const version = JSON.parse(fs.readFileSync('.pokedex-version', 'utf8')).sha;
const server = http.createServer((req, res) => res.end(JSON.stringify({ version, cards: fs.existsSync('data/collection.db') }))).listen(process.env.PORT);
process.on('message', (m) => { if (m?.type === 'shutdown') { server.close(); process.exit(0); } });`;
const app = (lock, { server = SERVER, launcher = '// launcher' } = {}) => ({
  'package.json': '{ "name": "fake-pokedex", "type": "module" }',
  'package-lock.json': lock,
  'server/index.js': server,
  'desktop/launcher.mjs': launcher,
});

describe('desktop app: installing and updating from GitHub', () => {
  let github;
  let base;
  let dir;
  let appDir;
  let selfDir;
  const versions = {};
  let head = null;
  let apiLimited = false;
  const npmCalls = [];
  const npm = async (cmd, args, cwd) => {
    npmCalls.push([cmd, args.join(' '), path.basename(cwd)]);
    fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'installed.txt'), 'fresh');
  };
  const publish = (sha, message, files) => {
    versions[sha] = makeZip(files, `LLMModel-${sha}`);
    head = { sha, commit: { message: `${message}\n\nmore details`, committer: { date: '2026-10-30T12:00:00Z' } } };
  };
  const config = () => ({ appDir, repo: 'ksotox/LLMModel', branch: 'main', git: base, api: base, codeload: base });
  const log = () => {};

  before(async () => {
    github = http.createServer((req, res) => {
      // What `git` reads: one line per branch, then the API for the message (unless rate-limited).
      if (req.url === '/ksotox/LLMModel.git/info/refs?service=git-upload-pack') {
        return res.end(`001e# service=git-upload-pack\n0000${'0'.repeat(4)}${head.sha} HEAD\0side-band-64k\n003f${head.sha} refs/heads/main\n0042${'f'.repeat(40)} refs/heads/main-old\n0000`);
      }
      if (req.url === `/repos/ksotox/LLMModel/commits/${head.sha}`) {
        if (apiLimited) { res.statusCode = 403; return res.end('{"message":"API rate limit exceeded"}'); }
        return res.end(JSON.stringify(head));
      }
      const m = req.url.match(/^\/ksotox\/LLMModel\/zip\/([0-9a-f]{40})$/);
      if (m && versions[m[1]]) return res.end(versions[m[1]]);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => github.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${github.address().port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-desktop-'));
    appDir = path.join(dir, 'LLMModel-main');
    selfDir = path.join(dir, 'Pokedex');
    fs.mkdirSync(selfDir);
  });
  after(async () => {
    await new Promise((r) => github.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const v1 = 'a'.repeat(40);
  const v2 = 'b'.repeat(40);
  const v3 = 'c'.repeat(40);

  test('first start: downloads the newest version and installs its packages', async () => {
    publish(v1, 'First version', app('lock-1'));
    const latest = await latestCommit(config());
    assert.deepEqual(latest, { sha: v1, message: 'First version', date: '2026-10-30T12:00:00Z' });
    const result = await update({ ...config(), latest, log, npm, selfDir });
    assert.deepEqual(result, { updated: true, from: null, to: v1 });
    assert.equal(installedVersion(appDir).sha, v1);
    assert.ok(fs.existsSync(path.join(appDir, 'server', 'index.js')), 'the top "LLMModel-<sha>" folder is dropped');
    assert.deepEqual(npmCalls, [['npm', 'ci --omit=dev --no-audit --no-fund', 'LLMModel-main.new']]);
  });

  test('already up to date: nothing is downloaded', async () => {
    const result = await update({ ...config(), latest: await latestCommit(config()), log, npm });
    assert.equal(result.updated, false);
  });

  test('a merged change replaces the folder, keeps the collection and reuses the packages', async () => {
    fs.mkdirSync(path.join(appDir, 'data', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'data', 'collection.db'), 'my cards');
    fs.writeFileSync(path.join(appDir, 'data', 'uploads', 'photo.jpg'), 'photo');
    npmCalls.length = 0;
    publish(v2, 'Promo pictures', app('lock-1', { launcher: '// launcher v2' }));
    const result = await update({ ...config(), latest: await latestCommit(config()), log, npm, selfDir });
    assert.deepEqual(result, { updated: true, from: v1, to: v2 });
    assert.equal(installedVersion(appDir).sha, v2);
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'uploads', 'photo.jpg'), 'utf8'), 'photo');
    assert.equal(npmCalls.length, 0, 'same package-lock.json: no install');
    assert.ok(fs.existsSync(path.join(appDir, 'node_modules', 'installed.txt')), 'packages copied across');
    assert.equal(installedVersion(`${appDir}.previous`).sha, v1, 'the replaced code is kept');
    assert.equal(fs.readFileSync(path.join(selfDir, 'launcher.mjs'), 'utf8'), '// launcher v2', 'the launcher updates itself');
  });

  test('the server starts from the app folder, sees the collection, and stops cleanly', async () => {
    const port = 3900 + Math.floor(Math.random() * 90);
    const url = `http://127.0.0.1:${port}`;
    const server = startServer({ appDir, port, log });
    try {
      assert.equal(await waitUntilUp(url, { child: server, timeoutMs: 15000 }), true);
      const body = await (await fetch(url)).json();
      assert.deepEqual(body, { version: v2, cards: true });
    } finally {
      await stopServer(server);
    }
    assert.equal(server.exitCode, 0, 'shut down on request, not killed');
    assert.equal(await isUp(url), false);
  });

  test('a version that won’t start is rolled back, collection included', async () => {
    publish(v3, 'Broken', app('lock-2', { server: 'process.exit(3);' }));
    npmCalls.length = 0;
    await update({ ...config(), latest: await latestCommit(config()), log, npm });
    assert.equal(npmCalls.length, 1, 'package-lock.json changed: clean install');
    const port = 3990 + Math.floor(Math.random() * 9);
    const server = startServer({ appDir, port, log });
    assert.equal(await waitUntilUp(`http://127.0.0.1:${port}`, { child: server, timeoutMs: 15000 }), false, 'gives up as soon as the server exits');
    assert.equal(rollback({ appDir, log }), true);
    assert.equal(installedVersion(appDir).sha, v2);
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
    assert.equal(installedVersion(`${appDir}.failed`).sha, v3);
  });

  test('GitHub’s API rate limit doesn’t stop updates: only the message is missing', async () => {
    apiLimited = true;
    try {
      assert.deepEqual(await latestCommit(config()), { sha: v3, message: '', date: null });
    } finally {
      apiLimited = false;
    }
  });

  test('a folder without its packages gets them installed before starting', async () => {
    fs.rmSync(path.join(appDir, 'node_modules'), { recursive: true, force: true });
    npmCalls.length = 0;
    assert.equal(await ensurePackages(appDir, log, { npm }), true);
    assert.deepEqual(npmCalls, [['npm', 'ci --omit=dev --no-audit --no-fund', 'LLMModel-main']]);
    fs.mkdirSync(path.join(appDir, 'node_modules', 'express'), { recursive: true });
    assert.equal(await ensurePackages(appDir, log, { npm }), false, 'nothing to do when they are there');
  });

  test('if the collection can’t be moved, the current version is kept, cards included', async () => {
    // A version that (wrongly) ships its own data/ folder makes moving the collection fail.
    const v4 = '4'.repeat(40);
    publish(v4, 'Ships a data folder', { ...app('lock-1'), 'data/collection.db': 'empty' });
    await assert.rejects(update({ ...config(), latest: await latestCommit(config()), log, npm }), /could not move the collection/);
    assert.equal(installedVersion(appDir).sha, v2, 'old version back in place');
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
  });

  test('a collection left in .previous is set aside, never deleted, and each update backs up the database', async () => {
    fs.mkdirSync(path.join(`${appDir}.previous`, 'data'), { recursive: true });
    fs.writeFileSync(path.join(`${appDir}.previous`, 'data', 'collection.db'), 'stranded cards');
    const v5 = '5'.repeat(40);
    publish(v5, 'Next', app('lock-1'));
    await update({ ...config(), latest: await latestCommit(config()), log, npm });
    const rescued = fs.readdirSync(dir).filter((f) => f.startsWith('LLMModel-main.rescued-data-'));
    assert.equal(rescued.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, rescued[0], 'collection.db'), 'utf8'), 'stranded cards');
    const backups = fs.readdirSync(`${appDir}.backups`).filter((f) => f.endsWith('.db'));
    assert.ok(backups.length >= 1);
    assert.equal(fs.readFileSync(path.join(`${appDir}.backups`, backups.sort().at(-1)), 'utf8'), 'my cards');
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
  });

  test('a failed download leaves the current version alone', async () => {
    head = { sha: 'd'.repeat(40), commit: { message: 'Not downloadable' } };
    await assert.rejects(update({ ...config(), latest: await latestCommit(config()), log, npm }), /download failed: 404/);
    assert.notEqual(installedVersion(appDir).sha, 'd'.repeat(40));
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
  });

  test('zip entries can’t write outside the app folder', () => {
    const evil = makeZip({ '../../evil.txt': 'x' }, 'LLMModel-x');
    assert.throws(() => unzip(evil, path.join(dir, 'unzip-test')), /unsafe path/);
    assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);
  });

  test('the optional pre-grading setup survives an update and a rollback', async () => {
    const venv = path.join(appDir, '.venv-grading', 'marker.txt');
    const viridian = path.join(appDir, 'third_party', 'viridian', 'LICENSE');
    for (const f of [venv, viridian]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'set up');
    }
    const v5 = 'e'.repeat(40);
    publish(v5, 'Keeps grading', app('lock-1'));
    await update({ ...config(), latest: await latestCommit(config()), log, npm });
    assert.equal(installedVersion(appDir).sha, v5);
    assert.equal(fs.readFileSync(venv, 'utf8'), 'set up', 'Python environment carried across');
    assert.equal(fs.readFileSync(viridian, 'utf8'), 'set up', 'Viridian source carried across');
    assert.equal(fs.existsSync(path.join(`${appDir}.previous`, '.venv-grading')), false, 'moved, not left behind to be deleted');
    assert.equal(rollback({ appDir, log }), true);
    assert.equal(fs.readFileSync(venv, 'utf8'), 'set up', 'and back again after a rollback');
    assert.equal(fs.readFileSync(viridian, 'utf8'), 'set up');
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'collection.db'), 'utf8'), 'my cards');
  });
});

describe('desktop app: optional pre-grading service', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-grading-launch-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const log = (...parts) => lines.push(parts.join(' '));

  test('not set up (no Python): skipped quietly, the app starts as usual', async () => {
    assert.equal(gradingPython(dir), null);
    assert.equal(await startGrading({ appDir: dir, log }), null);
    assert.match(lines.at(-1), /not set up/);
  });

  test('set up: started on 127.0.0.1 with the app, stopped with it; skipped when already running', { skip: process.platform === 'win32' }, async () => {
    for (const f of ['services/grading/app.py', 'third_party/viridian/src/grading.py']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    // A stand-in "python" that records how it was started and keeps running.
    const python = path.join(dir, '.venv-grading', 'bin', 'python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '#!/bin/sh\necho "$@" > started.txt\nexec sleep 30\n', { mode: 0o755 });
    assert.equal(gradingPython(dir), python);
    assert.equal(gradingPython(dir, 'win32'), null, 'on Windows it looks for .venv-grading\\Scripts\\python.exe');

    const port = 4900 + Math.floor(Math.random() * 90);
    const child = await startGrading({ appDir: dir, gradingPort: port, log });
    assert.ok(child);
    const until = Date.now() + 5000;
    while (!fs.existsSync(path.join(dir, 'started.txt')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(path.join(dir, 'started.txt'), 'utf8').trim(), `-m uvicorn services.grading.app:app --host 127.0.0.1 --port ${port}`);
    await stopGrading(child);
    assert.ok(child.exitCode != null || child.signalCode != null, 'stopped');

    // Started by hand already: the launcher leaves it alone.
    const running = http.createServer((_req, res) => res.end('{"ready":true}'));
    await new Promise((r) => running.listen(port, '127.0.0.1', r));
    try {
      assert.equal(await startGrading({ appDir: dir, gradingPort: port, log }), null);
      assert.match(lines.at(-1), /already running/);
    } finally {
      running.close();
    }
  });
});

describe('desktop app: update banner API', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  let restarts = 0;
  const desktop = { update: null, version: () => ({ sha: 'b'.repeat(40) }), restart: () => { restarts++; } };

  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-desktop-api-'));
    const appWithDesktop = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock), desktop });
    server = await new Promise((resolve) => { const s = appWithDesktop.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    server.on('close', () => appWithDesktop.locals.store.close());
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('reports the version and a waiting update, and restarts on request', async () => {
    let status = await (await fetch(`${base}/api/desktop`)).json();
    assert.deepEqual(status, { desktop: true, version: { sha: 'b'.repeat(40) }, update: null });
    desktop.update = { sha: 'e'.repeat(40), message: 'Promo pictures' };
    status = await (await fetch(`${base}/api/desktop`)).json();
    assert.equal(status.update.message, 'Promo pictures');
    const res = await fetch(`${base}/api/desktop/restart`, { method: 'POST' });
    assert.deepEqual(await res.json(), { restarting: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(restarts, 1);
  });
});
