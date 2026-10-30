import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'booster-pack',
  set_name    TEXT,
  notes       TEXT,
  photo_path  TEXT,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  set_code             TEXT,
  set_id               TEXT,
  set_name             TEXT,
  number               TEXT,
  set_total            TEXT,
  variant              TEXT    NOT NULL DEFAULT 'normal',
  rarity               TEXT,
  category             TEXT,
  hp                   INTEGER,
  types                TEXT,
  tcg_id               TEXT,
  official_image_url   TEXT,
  official_image_path  TEXT,
  photo_path           TEXT,
  pack_id              INTEGER REFERENCES packs(id) ON DELETE SET NULL,
  notes                TEXT,
  created_at           TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_pack ON cards(pack_id);
CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at);
`;

// Columns added after the first release; created on start-up for existing collections.
const CARD_MIGRATIONS = {
  market_price: 'REAL',
  market_currency: 'TEXT',
  market_low: 'REAL',
  market_high: 'REAL',
  market_source: 'TEXT',
  market_updated: 'TEXT',
  pull_chance: 'REAL',
  pull_source: 'TEXT',
};

export const PACK_KINDS = ['booster-pack', 'tin', 'kit', 'bundle', 'elite-trainer-box', 'collection-box', 'blister', 'booster-box', 'other'];
export const VARIANTS = ['normal', 'reverse-holo', 'holo', 'full-art', 'promo', 'other'];

const CARD_FIELDS = ['name', 'set_code', 'set_id', 'set_name', 'number', 'set_total', 'variant', 'rarity', 'category', 'hp', 'types',
  'tcg_id', 'official_image_url', 'official_image_path', 'photo_path', 'pack_id', 'notes', ...Object.keys(CARD_MIGRATIONS)];
const PACK_FIELDS = ['name', 'kind', 'set_name', 'notes', 'photo_path'];

const CARD_SELECT = `
  SELECT c.*, p.name AS pack_name, p.kind AS pack_kind
  FROM cards c LEFT JOIN packs p ON p.id = c.pack_id`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const existing = new Set(db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(CARD_MIGRATIONS)) {
    if (!existing.has(col)) db.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`);
  }
  return new Store(db);
}

const now = () => new Date().toISOString();

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f] === '' ? null : obj[f];
  return out;
}

class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #insert(table, fields, data) {
    const row = pick(data, fields);
    row.created_at = data.created_at || now();
    const cols = Object.keys(row);
    const stmt = this.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    return Number(stmt.run(...cols.map((c) => row[c])).lastInsertRowid);
  }

  #update(table, fields, id, data) {
    const row = pick(data, fields);
    const cols = Object.keys(row);
    if (!cols.length) return;
    this.db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => row[c]), id);
  }

  // ---- cards ----

  insertCard(data) {
    return this.#insert('cards', CARD_FIELDS, data);
  }

  updateCard(id, data) {
    this.#update('cards', CARD_FIELDS, id, data);
  }

  getCard(id) {
    return this.db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) ?? null;
  }

  deleteCard(id) {
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  }

  /**
   * Search the collection. Every whitespace-separated term must match at least one
   * of the card's text fields (name, set, number, rarity, pack, notes...).
   */
  listCards({ q, packId, setCode, category, sort } = {}) {
    const where = [];
    const params = [];
    for (const term of String(q ?? '').trim().split(/\s+/).filter(Boolean)) {
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const cols = ['c.name', 'c.set_code', 'c.set_name', 'c.number', "c.number || '/' || IFNULL(c.set_total, '')", 'c.rarity',
        'c.category', 'c.types', 'c.variant', 'c.notes', 'p.name', 'p.set_name'];
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...cols.map(() => like));
    }
    if (packId === 'none') {
      where.push('c.pack_id IS NULL');
    } else if (packId) {
      where.push('c.pack_id = ?');
      params.push(Number(packId));
    }
    if (setCode) {
      where.push('UPPER(c.set_code) = UPPER(?)');
      params.push(setCode);
    }
    if (category) {
      where.push('c.category = ?');
      params.push(category);
    }
    const order = {
      oldest: 'c.created_at ASC, c.id ASC',
      name: 'c.name COLLATE NOCASE ASC, c.id DESC',
      set: "c.set_code COLLATE NOCASE ASC, CAST(c.number AS INTEGER) ASC, c.id DESC",
      value: 'c.market_price IS NULL, c.market_price DESC, c.id DESC',
      rarity: 'c.pull_chance IS NULL, c.pull_chance ASC, c.id DESC',
    }[sort] ?? 'c.created_at DESC, c.id DESC';
    const sql = `${CARD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
    return this.db.prepare(sql).all(...params);
  }

  /** How many copies of each online card id are in the collection. */
  ownedCounts(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const rows = this.db.prepare(`SELECT tcg_id, COUNT(*) AS n FROM cards WHERE tcg_id IN (${unique.map(() => '?').join(', ')}) GROUP BY tcg_id`).all(...unique);
    return Object.fromEntries(rows.map((r) => [r.tcg_id, r.n]));
  }

  // ---- packs ----

  insertPack(data) {
    return this.#insert('packs', PACK_FIELDS, data);
  }

  updatePack(id, data) {
    this.#update('packs', PACK_FIELDS, id, data);
  }

  getPack(id) {
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.pack_id = p.id) AS card_count
      FROM packs p WHERE p.id = ?`).get(id) ?? null;
  }

  deletePack(id) {
    this.db.prepare('DELETE FROM packs WHERE id = ?').run(id);
  }

  listPacks({ q } = {}) {
    const params = [];
    let where = '';
    if (q && q.trim()) {
      where = "WHERE p.name LIKE ? OR p.set_name LIKE ? OR p.kind LIKE ? OR p.notes LIKE ?";
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like);
    }
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.pack_id = p.id) AS card_count
      FROM packs p ${where} ORDER BY p.created_at DESC, p.id DESC`).all(...params);
  }

  // ---- misc ----

  stats() {
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM cards) AS cards,
        (SELECT COUNT(DISTINCT IFNULL(tcg_id, LOWER(name) || '|' || IFNULL(set_code, '') || '|' || IFNULL(number, ''))) FROM cards) AS unique_cards,
        (SELECT COUNT(*) FROM packs) AS packs,
        (SELECT COUNT(*) FROM cards WHERE official_image_url IS NOT NULL) AS with_official,
        (SELECT ROUND(IFNULL(SUM(market_price), 0), 2) FROM cards WHERE market_currency = 'USD') AS value_usd,
        (SELECT ROUND(IFNULL(SUM(market_price), 0), 2) FROM cards WHERE market_currency = 'EUR') AS value_eur,
        (SELECT COUNT(*) FROM cards WHERE market_price IS NOT NULL) AS priced`).get();
  }

  setCodes() {
    return this.db.prepare(`
      SELECT UPPER(set_code) AS code, MAX(set_name) AS name, COUNT(*) AS count
      FROM cards WHERE set_code IS NOT NULL AND set_code <> ''
      GROUP BY UPPER(set_code) ORDER BY code`).all();
  }
}
