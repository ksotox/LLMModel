// Versioned database changes (server/migrations.js) and the collection's own list (server/db.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { MIGRATIONS, openDb } from '../server/db.js';
import { addColumn, columnsOf, migrate } from '../server/migrations.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokedex-migrations-'));
let n = 0;
const file = () => path.join(dir, `db-${++n}.db`);
const version = (db) => db.prepare('PRAGMA user_version').get().user_version;

describe('database migrations', () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a new collection is created at the latest version with every column', () => {
    const store = openDb(file());
    assert.equal(version(store.db), MIGRATIONS.length);
    const cols = columnsOf(store.db, 'cards');
    for (const c of ['market_price', 'condition', 'storage_location', 'deleted_at', 'user_id']) assert.ok(cols.has(c), c);
    assert.ok(columnsOf(store.db, 'packs').has('user_id'));
    assert.ok(columnsOf(store.db, 'pricetracker_cache').has('picture_checked_at'));
    store.close();
  });

  test('a collection from before versioning gets its missing columns, keeps its cards, and is stamped', () => {
    const f = file();
    const old = new DatabaseSync(f);
    // The first release's cards table (no prices, conditions, profiles…) and a card in it.
    old.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, set_code TEXT, set_id TEXT, set_name TEXT,
      number TEXT, set_total TEXT, variant TEXT NOT NULL DEFAULT 'normal', rarity TEXT, category TEXT, hp TEXT, types TEXT, tcg_id TEXT,
      official_image_url TEXT, official_image_path TEXT, photo_path TEXT, pack_id INTEGER, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.exec("INSERT INTO cards (name, created_at, updated_at) VALUES ('Voltorb', '2026-01-01', '2026-01-01')");
    old.close();
    const store = openDb(f);
    assert.equal(version(store.db), MIGRATIONS.length);
    assert.ok(columnsOf(store.db, 'cards').has('market_price'));
    assert.equal(store.db.prepare('SELECT name FROM cards').get().name, 'Voltorb');
    store.close();
    // Opening it again changes nothing.
    const again = openDb(f);
    assert.equal(version(again.db), MIGRATIONS.length);
    again.close();
  });

  test('only the pending changes run, each once, in order', () => {
    const db = new DatabaseSync(':memory:');
    const ran = [];
    const list = [() => ran.push(1), () => ran.push(2), () => ran.push(3)];
    assert.deepEqual(migrate(db, list.slice(0, 2)), { from: 0, to: 2 });
    assert.deepEqual(migrate(db, list), { from: 2, to: 3 });
    assert.deepEqual(migrate(db, list), { from: 3, to: 3 });
    assert.deepEqual(ran, [1, 2, 3]);
  });

  test('a failing change is rolled back with its version number; earlier ones stay', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (a INTEGER)');
    const list = [
      (d) => addColumn(d, 't', 'b', 'TEXT'),
      (d) => { addColumn(d, 't', 'c', 'TEXT'); throw new Error('boom'); },
    ];
    assert.throws(() => migrate(db, list), /version 2 failed: boom/);
    assert.equal(version(db), 1);
    assert.deepEqual([...columnsOf(db, 't')], ['a', 'b'], 'the half-done change was undone');
  });

  test('a database from a newer app version is opened as it is (an older app after a rollback)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA user_version = 9');
    const warnings = [];
    assert.deepEqual(migrate(db, [() => { throw new Error('must not run'); }], { log: (m) => warnings.push(m) }), { from: 9, to: 9 });
    assert.match(warnings[0], /version 9/);
  });
});
