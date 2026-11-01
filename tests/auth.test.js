// Profiles and signing in: setup, sign-in, sessions, separate collections, owner-only management.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

describe('profiles and signing in', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-auth-'));
    // A collection made before profiles existed: it should end up with the first profile.
    const old = createApp({ requireLogin: false, dataDir, catalog: mockCatalog(mock) });
    old.locals.store.insertCard({ name: 'Old Voltorb', set_code: 'PAL', number: '066' });
    old.locals.store.db.exec("UPDATE cards SET user_id = NULL; DELETE FROM users WHERE username = 'local'");
    old.locals.store.close();
    const app = createApp({ dataDir, catalog: mockCatalog(mock) });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** A browser: keeps its session cookie. */
  const browser = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), setCookie: set };
    };
  };
  const owner = browser();
  const guest = browser();

  test('before setup: nothing but the setup screen is reachable', async () => {
    const anon = browser();
    assert.deepEqual((await anon('GET', '/api/auth/state')).body, { setupNeeded: true, requireLogin: true, user: null });
    assert.equal((await anon('GET', '/api/cards')).status, 401);
    assert.equal((await anon('GET', '/api/meta')).status, 200, 'public: the desktop launcher checks it');
    assert.equal((await anon('GET', '/api/meta')).body.stats, null, 'but without collection details');
  });

  test('setup creates the owner profile, signs in, and takes over the old collection', async () => {
    assert.equal((await owner('POST', '/api/auth/setup', { username: 'ash', password: 'short' })).status, 400);
    const r = await owner('POST', '/api/auth/setup', { username: 'ash', display_name: 'Ash', password: 'pikachu123' });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /HttpOnly; SameSite=Lax/);
    assert.deepEqual([r.body.user.username, r.body.user.is_owner], ['ash', true]);
    const cards = (await owner('GET', '/api/cards')).body.cards;
    assert.deepEqual(cards.map((c) => c.name), ['Old Voltorb']);
    assert.equal((await browser()('POST', '/api/auth/setup', { username: 'gary', password: 'eevee12345' })).status, 409, 'only once');
  });

  test('the owner adds a profile; it signs in and has its own, separate collection', async () => {
    assert.equal((await owner('POST', '/api/users', { username: 'misty', display_name: 'Misty', password: 'staryu123' })).status, 201);
    assert.equal((await guest('POST', '/api/auth/login', { username: 'misty', password: 'wrong' })).status, 401);
    const login = await guest('POST', '/api/auth/login', { username: 'MISTY', password: 'staryu123' });
    assert.equal(login.body.user.display_name, 'Misty');
    assert.deepEqual((await guest('GET', '/api/cards')).body.cards, [], 'not Ash’s cards');
    const ashCard = (await owner('GET', '/api/cards')).body.cards[0];
    assert.equal((await guest('GET', `/api/cards/${ashCard.id}`)).status, 404, 'can’t open someone else’s card');
    assert.equal((await guest('DELETE', `/api/cards/${ashCard.id}`)).status, 404);
    assert.equal((await guest('GET', '/api/users')).status, 403, 'only the owner manages profiles');
  });

  test('preferences and password changes; signing out ends the session', async () => {
    const me = (await guest('PATCH', '/api/auth/me', { settings: { theme: 'dark', view: 'table' } })).body;
    assert.deepEqual(me.settings, { theme: 'dark', view: 'table' });
    assert.equal((await guest('PATCH', '/api/auth/me', { current_password: 'nope', new_password: 'togepi123' })).status, 403);
    assert.equal((await guest('PATCH', '/api/auth/me', { current_password: 'staryu123', new_password: 'togepi123' })).status, 200);
    await guest('POST', '/api/auth/logout');
    assert.equal((await guest('GET', '/api/cards')).status, 401);
    assert.equal((await guest('POST', '/api/auth/login', { username: 'misty', password: 'togepi123' })).status, 200);
  });

  test('photos need a signed-in profile too, and repeated wrong passwords are slowed down', async () => {
    assert.equal((await fetch(`${base}/media/uploads/cards/anything.jpg`)).status, 401);
    const thief = browser();
    for (let i = 0; i < 5; i++) await thief('POST', '/api/auth/login', { username: 'ash', password: `guess${i}` });
    assert.equal((await thief('POST', '/api/auth/login', { username: 'ash', password: 'pikachu123' })).status, 429);
  });

  test('the owner can remove a profile with its collection', async () => {
    const users = (await owner('GET', '/api/users')).body.users;
    const misty = users.find((u) => u.username === 'misty');
    assert.equal((await owner('DELETE', `/api/users/${misty.id}`)).status, 204);
    assert.equal((await guest('GET', '/api/cards')).status, 401, 'its session is gone');
    assert.equal((await owner('DELETE', `/api/users/${users.find((u) => u.username === 'ash').id}`)).status, 400, 'not yourself');
  });
});
