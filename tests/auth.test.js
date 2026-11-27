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
    assert.deepEqual((await anon('GET', '/api/auth/state')).body, { setupNeeded: true, setupCode: false, signup: false, requireLogin: true, user: null });
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

describe('a public site: anyone can sign up; the owner needs the setup code; fair-use limits', () => {
  let mock;
  let dataDir;
  let server;
  let app;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-public-'));
    app = createApp({ dataDir, catalog: mockCatalog(mock), allowSignup: true, setupCode: 'grape-7-sky', userStorageMb: 0.01, userPriceLookups: 2 });
    app.set('trust proxy', 'loopback'); // (behind cloudflared on the same machine)
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const browser = (ip = '203.0.113.7') => {
    let cookie = '';
    return async (method, p, body, { form } = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}) },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };

  test('the owner profile needs the setup code', async () => {
    const stranger = browser();
    assert.deepEqual((await stranger('GET', '/api/auth/state')).body, { setupNeeded: true, setupCode: true, signup: true, requireLogin: true, user: null });
    assert.equal((await stranger('POST', '/api/auth/setup', { username: 'sneaky', password: 'secret123' })).status, 403);
    assert.equal((await stranger('POST', '/api/auth/setup', { username: 'sneaky', password: 'secret123', setup_code: 'grape-7-skz' })).status, 403);
    assert.equal((await stranger('POST', '/api/auth/register', { username: 'early', password: 'secret123' })).status, 409, 'no accounts before the owner');
    const owner = browser('198.51.100.1');
    assert.equal((await owner('POST', '/api/auth/setup', { username: 'ash', password: 'pikachu123', setup_code: 'grape-7-sky' })).status, 201);
  });

  test('anyone can create an account: signed in, not the owner, with a collection of their own', async () => {
    const misty = browser('203.0.113.8');
    const r = await misty('POST', '/api/auth/register', { username: 'misty', display_name: 'Misty', password: 'staryu123' });
    assert.equal(r.status, 201);
    const me = (await misty('GET', '/api/auth/me')).body;
    assert.equal(me.username, 'misty');
    assert.ok(!me.is_owner);
    assert.deepEqual((await misty('GET', '/api/cards')).body.cards ?? (await misty('GET', '/api/cards')).body, []);
    assert.equal((await misty('GET', '/api/users')).status, 403, 'not the owner');
    assert.equal((await browser('203.0.113.9')('POST', '/api/auth/register', { username: 'misty', password: 'another12' })).status, 409, 'names are taken once');
    assert.equal((await browser('203.0.113.9')('POST', '/api/auth/register', { username: 'x', password: 'short' })).status, 400);
  });

  test('sign-ups are limited per visitor (the real address, behind the proxy)', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await browser('192.0.2.50')('POST', '/api/auth/register', { username: `bot${i}`, password: 'password1' })).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
    assert.equal((await browser('192.0.2.51')('POST', '/api/auth/register', { username: 'brock', password: 'onix12345' })).status, 201, 'another visitor still can');
  });

  test('accounts have a photo storage cap and a daily cap on live price lookups; the owner has neither', async () => {
    const gary = browser('203.0.113.20');
    await gary('POST', '/api/auth/register', { username: 'gary', password: 'eevee12345' });
    const photo = (kb) => {
      const form = new FormData();
      form.append('cards', JSON.stringify([{ name: 'Pidgey', photoField: 'photo_0' }]));
      form.append('photo_0', new Blob([Buffer.alloc(kb * 1024, 1)], { type: 'image/jpeg' }), 'p.jpg');
      return form;
    };
    assert.equal((await gary('POST', '/api/cards', null, { form: photo(6) })).status, 201, 'under the cap');
    const full = await gary('POST', '/api/cards', null, { form: photo(6) });
    assert.equal(full.status, 413, 'over the cap');
    assert.match(full.body.error, /storage is full/);
    const cardId = (await gary('GET', '/api/cards')).body.cards?.[0]?.id ?? (await gary('GET', '/api/cards')).body[0].id;
    const lookups = [];
    for (let i = 0; i < 3; i++) lookups.push((await gary('POST', `/api/cards/${cardId}/pricetracker/refresh`)).status);
    assert.equal(lookups[2], 429, 'the third live lookup today is refused');
    assert.notEqual(lookups[0], 429);
  });
});

describe('behind a proxy that passes no visitor address (a free Tailscale Funnel address)', () => {
  let mock;
  let dataDir;
  let server;
  let base;
  before(async () => {
    mock = await startMockSources();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-funnel-'));
    const app = createApp({ dataDir, catalog: mockCatalog(mock), allowSignup: true, setupCode: 'kiwi-42' });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    server.on('close', () => app.locals.store.close());
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.status;
  };

  test('every visitor looks like 127.0.0.1: limits go by username and the total, not by that one address', async () => {
    assert.equal(await call('POST', '/api/auth/setup', { username: 'owner', password: 'owner12345', setup_code: 'kiwi-42' }), 201);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push(await call('POST', '/api/auth/register', { username: `trainer${i}`, password: 'password1' }));
    assert.deepEqual(statuses, Array(7).fill(201), 'seven people sign up in the same hour');
    for (let i = 0; i < 6; i++) await call('POST', '/api/auth/login', { username: 'trainer0', password: 'wrong-one' });
    assert.equal(await call('POST', '/api/auth/login', { username: 'trainer0', password: 'password1' }), 429, 'guessing at one account locks that account for a while');
    assert.equal(await call('POST', '/api/auth/login', { username: 'trainer1', password: 'password1' }), 200, 'but not everyone else');
  });

  test('visitorKey: loopback addresses are no visitor', async () => {
    const { visitorKey } = await import('../server/auth.js');
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '', undefined]) assert.equal(visitorKey(ip), null, String(ip));
    assert.equal(visitorKey('203.0.113.7'), '203.0.113.7');
  });
});
