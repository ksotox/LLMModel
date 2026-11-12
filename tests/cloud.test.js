// The free cloud server (scripts/cloud-setup.sh): the launcher as a headless server that installs
// updates by itself and backs the collection up every night, the desktop app opening a server
// elsewhere, and the app behind `tailscale serve` (a proxy on the same machine).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mirrorFiles, nightlyBackup, openRemote } from '../desktop/launcher.mjs';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = () => {};

describe('cloud server: nightly backups', () => {
  let dir;
  let appDir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-cloud-backup-'));
    appDir = path.join(dir, 'LLMModel-main');
    fs.mkdirSync(path.join(appDir, 'data', 'uploads'), { recursive: true });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('no collection yet: nothing to back up', async () => {
    assert.equal(await nightlyBackup({ appDir, log }), null);
  });

  test('a consistent copy of the database while it is in use, and the photos alongside, once a day', async () => {
    const db = new DatabaseSync(path.join(appDir, 'data', 'collection.db'));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE cards (name TEXT); INSERT INTO cards VALUES ('Voltorb'), ('Froakie');");
    fs.writeFileSync(path.join(appDir, 'data', 'uploads', 'photo.jpg'), 'photo');
    try {
      const day = new Date('2026-11-12T03:00:00Z');
      const file = await nightlyBackup({ appDir, log, now: day });
      assert.equal(file, path.join(`${appDir}.backups`, 'nightly', 'collection-2026-11-12.db'));
      db.exec("INSERT INTO cards VALUES ('Pikachu')"); // after the snapshot
      const copy = new DatabaseSync(file, { readOnly: true });
      assert.equal(copy.prepare('SELECT count(*) AS n FROM cards').get().n, 2);
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      copy.close();
      const files = path.join(`${appDir}.backups`, 'files');
      assert.equal(fs.readFileSync(path.join(files, 'uploads', 'photo.jpg'), 'utf8'), 'photo');
      assert.equal(fs.existsSync(path.join(files, 'collection.db')), false, 'the database is only in the snapshots');
      assert.equal(await nightlyBackup({ appDir, log, now: day }), null, 'one a day');
    } finally {
      db.close();
    }
  });

  test('only the last two weeks of snapshots are kept', async () => {
    for (let d = 13; d <= 30; d++) await nightlyBackup({ appDir, log, now: new Date(`2026-11-${d}T03:00:00Z`) });
    const kept = fs.readdirSync(path.join(`${appDir}.backups`, 'nightly')).sort();
    assert.equal(kept.length, 14);
    assert.equal(kept[0], 'collection-2026-11-17.db');
    assert.equal(kept.at(-1), 'collection-2026-11-30.db');
  });

  test('files are copied when new or changed, and never deleted from the copy', () => {
    const src = path.join(dir, 'src');
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(path.join(src, 'a'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a', 'one.txt'), '1');
    fs.writeFileSync(path.join(src, 'two.txt'), '2');
    assert.equal(mirrorFiles(src, dest), 2);
    assert.equal(mirrorFiles(src, dest), 0, 'unchanged');
    fs.writeFileSync(path.join(src, 'two.txt'), '22');
    fs.rmSync(path.join(src, 'a', 'one.txt'));
    assert.equal(mirrorFiles(src, dest), 1);
    assert.equal(fs.readFileSync(path.join(dest, 'two.txt'), 'utf8'), '22');
    assert.equal(fs.readFileSync(path.join(dest, 'a', 'one.txt'), 'utf8'), '1', 'kept');
  });
});

describe('desktop app opening the cloud server', () => {
  test('opens the address in the app window when it answers', async () => {
    const opened = [];
    await openRemote('https://pokedex.example.ts.net/', log, { up: async () => true, open: (url) => opened.push(url) });
    assert.deepEqual(opened, ['https://pokedex.example.ts.net']);
  });

  test('says what to check when it doesn’t answer', async () => {
    await assert.rejects(openRemote('https://pokedex.example.ts.net', log, { up: async () => false, open: () => assert.fail('no window') }), /isn't answering\. Check that Tailscale is connected/);
  });
});

describe('the app behind tailscale serve (a proxy on the same machine)', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-cloud-proxy-'));
    const app = createApp({ dataDir, catalog: mockCatalog(mock) });
    app.set('trust proxy', 'loopback'); // what TRUST_PROXY=loopback does in server/index.js
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'pokedex.example.ts.net', 'content-type': 'application/json' };

  test('the page’s own address is accepted, and the session cookie is Secure', async () => {
    const res = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { ...proxied, origin: 'https://pokedex.example.ts.net' },
      body: JSON.stringify({ username: 'owner', password: 'secret123' }),
    });
    assert.equal(res.status, 201);
    assert.match(res.headers.get('set-cookie'), /; Secure/);
  });

  test('another website is still refused', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { ...proxied, origin: 'https://evil.example.com' },
      body: JSON.stringify({ username: 'owner', password: 'secret123' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('cloud server: the launcher with --server', () => {
  // A stand-in GitHub serving a tiny app (as in desktop.test.js), and the launcher run for real.
  let github;
  let dir;
  let launcher;
  const versions = {};
  let head = null;

  const zip = (files, top) => {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files).map(([n, t]) => [`${top}/${n}`, Buffer.from(t)])) {
      const nameBuf = Buffer.from(name);
      const body = zlib.deflateRawSync(text);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(zlib.crc32(text), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBuf.length, 26);
      const headBuf = Buffer.alloc(46);
      headBuf.writeUInt32LE(0x02014b50, 0); headBuf.writeUInt16LE(20, 4); headBuf.writeUInt16LE(20, 6); headBuf.writeUInt16LE(8, 10);
      headBuf.writeUInt32LE(zlib.crc32(text), 16); headBuf.writeUInt32LE(body.length, 20); headBuf.writeUInt32LE(text.length, 24); headBuf.writeUInt16LE(nameBuf.length, 28);
      headBuf.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, body);
      central.push(headBuf, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  };
  // The app: answers with its version; /crash makes it stop on its own.
  const SERVER = `import fs from 'node:fs';
import http from 'node:http';
const version = JSON.parse(fs.readFileSync('.pokedex-version', 'utf8')).sha;
const server = http.createServer((req, res) => {
  if (req.url === '/crash') process.exit(5);
  res.end(JSON.stringify({ version, cards: fs.existsSync('data/collection.db') }));
}).listen(process.env.PORT);
process.on('message', (m) => { if (m?.type === 'shutdown') { server.close(); process.exit(0); } });`;
  const publish = (sha, server = SERVER) => {
    versions[sha] = zip({
      'package.json': '{ "name": "fake-pokedex", "type": "module" }',
      'package-lock.json': '{ "name": "fake-pokedex", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "fake-pokedex" } } }',
      'server/index.js': server,
      // Stands in for express, so no packages need installing.
      'node_modules/express/package.json': '{}',
    }, `LLMModel-${sha}`);
    head = { sha, commit: { message: `Version ${sha.slice(0, 1)}` } };
  };

  before(async () => {
    github = http.createServer((req, res) => {
      if (req.url === '/ksotox/LLMModel.git/info/refs?service=git-upload-pack') return res.end(`${head.sha} refs/heads/main\n`);
      if (req.url === `/repos/ksotox/LLMModel/commits/${head.sha}`) return res.end(JSON.stringify(head));
      const m = req.url.match(/^\/ksotox\/LLMModel\/zip\/([0-9a-f]{40})$/);
      if (m && versions[m[1]]) return res.end(versions[m[1]]);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => github.listen(0, '127.0.0.1', r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-cloud-server-'));
    fs.mkdirSync(path.join(dir, 'pokedex'));
    launcher = path.join(dir, 'pokedex', 'launcher.mjs');
    fs.copyFileSync(path.join(ROOT, 'desktop', 'launcher.mjs'), launcher);
  });
  after(async () => {
    await new Promise((r) => github.close(r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const until = async (check, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = await check().catch(() => null);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };

  test('installs, serves, installs merged updates by itself (rolling back a broken one), and stops when the app does', async () => {
    const base = `http://127.0.0.1:${github.address().port}`;
    const port = 4100 + Math.floor(Math.random() * 400);
    const appDir = path.join(dir, 'LLMModel-main');
    fs.writeFileSync(path.join(dir, 'pokedex', 'config.json'), JSON.stringify({
      appDir, repo: 'ksotox/LLMModel', branch: 'main', port, mode: 'server', git: base, api: base, codeload: base,
      checkEveryMinutes: 0.01, startGrading: false,
    }));
    const v1 = '1'.repeat(40);
    const v2 = '2'.repeat(40);
    publish(v1);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', launcher, '--server'], { cwd: path.dirname(launcher), stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    try {
      const answer = () => fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
      assert.equal((await until(async () => (await answer()).version === v1 && 1)), 1, 'first version installed and running');
      fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'data', 'collection.db'), 'my cards');

      publish(v2);
      const logText = () => fs.readFileSync(path.join(dir, 'pokedex', 'launcher.log'), 'utf8');
      assert.ok(await until(async () => logText().includes(`server is up (${v2.slice(0, 7)})`)), 'updated without anyone restarting it');
      assert.deepEqual(await answer(), { version: v2, cards: true }, 'collection kept');

      publish('3'.repeat(40), 'process.exit(3);'); // a broken version
      assert.ok(await until(async () => logText().includes('server is up again (2222222)')), 'rolled back to the working version');
      await new Promise((r) => setTimeout(r, 2000)); // several update checks
      assert.equal(logText().match(/updating 2222222 → 3333333/g).length, 1, 'the broken version isn’t installed again and again');
      assert.equal((await answer()).version, v2);

      await fetch(`http://127.0.0.1:${port}/crash`).catch(() => {});
      assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 10000))]), 1,
        'exits with an error so the service manager starts it again');
    } finally {
      child.kill();
    }
    assert.match(fs.readFileSync(path.join(dir, 'pokedex', 'launcher.log'), 'utf8'), /starting as a server[\s\S]*installing the update/);
  });
});
