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

-- eBay sold listings found for a card (from eBay's API or pasted from eBay.com).
CREATE TABLE IF NOT EXISTS ebay_sales (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  item_key    TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  price       REAL    NOT NULL,
  currency    TEXT    NOT NULL DEFAULT 'USD',
  sold_at     TEXT    NOT NULL,
  condition   TEXT,
  grade       TEXT,
  url         TEXT,
  source      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE (card_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_ebay_sales_card ON ebay_sales(card_id, sold_at);

-- One price per card, source, line and day: the app's own long-term price history.
CREATE TABLE IF NOT EXISTS price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source       TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  currency     TEXT    NOT NULL DEFAULT 'USD',
  price        REAL    NOT NULL,
  day          TEXT    NOT NULL,
  recorded_at  TEXT    NOT NULL,
  UNIQUE (card_id, source, label, day)
);
CREATE INDEX IF NOT EXISTS idx_price_history_card ON price_history(card_id, day);

-- Last PokemonPriceTracker answer for each card (graded sales, population…), reused for a day.
CREATE TABLE IF NOT EXISTS pricetracker_cache (
  card_id         INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  tcg_player_id   TEXT,
  fetched_at      TEXT,
  attempted_at    TEXT,
  data            TEXT,
  error           TEXT
);

-- Credits spent per day on metered APIs, so the app stays inside free-tier limits.
CREATE TABLE IF NOT EXISTS api_usage (
  day       TEXT    NOT NULL,
  provider  TEXT    NOT NULL,
  credits   INTEGER NOT NULL DEFAULT 0,
  requests  INTEGER NOT NULL DEFAULT 0,
  reported_remaining INTEGER,
  PRIMARY KEY (day, provider)
);
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
  market_checked_at: 'TEXT', // when the app last looked for a price (found or not)
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

  // ---- eBay sold listings ----

  /** Store sold listings for a card, ignoring ones already stored. Returns how many were new. */
  addSales(cardId, sales, source) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO ebay_sales
      (card_id, item_key, title, price, currency, sold_at, condition, grade, url, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const createdAt = new Date().toISOString();
    return this.transaction(() => sales.reduce((added, s) => {
      const key = s.itemId ?? s.url ?? `${s.title}|${s.soldAt}|${s.price}`;
      const r = stmt.run(cardId, String(key), s.title, s.price, s.currency ?? 'USD', s.soldAt, s.condition ?? null, s.grade ?? null, s.url ?? null, source, createdAt);
      return added + Number(r.changes);
    }, 0));
  }

  listSales(cardId) {
    return this.db.prepare('SELECT * FROM ebay_sales WHERE card_id = ? ORDER BY sold_at DESC, id DESC').all(cardId);
  }

  deleteSale(cardId, saleId) {
    return Number(this.db.prepare('DELETE FROM ebay_sales WHERE card_id = ? AND id = ?').run(cardId, saleId).changes);
  }

  // ---- price history ----

  /** Record a price for today (or `day`); a second reading on the same day replaces the first. */
  recordPrice(cardId, { source, label, price, currency = 'USD', day }) {
    if (!(price > 0)) return;
    this.db.prepare(`INSERT INTO price_history (card_id, source, label, currency, price, day, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (card_id, source, label, day) DO UPDATE SET price = excluded.price, currency = excluded.currency, recorded_at = excluded.recorded_at`)
      .run(cardId, source, label, currency, Math.round(price * 100) / 100, day ?? new Date().toISOString().slice(0, 10), new Date().toISOString());
  }

  priceHistory(cardId, { since } = {}) {
    return this.db.prepare(`SELECT source, label, currency, price, day FROM price_history
      WHERE card_id = ? AND day >= ? ORDER BY source, label, day`).all(cardId, since ?? '0000-00-00');
  }

  /** Cards whose price hasn't been checked yet on `day` (YYYY-MM-DD), least recently checked first. */
  cardsNeedingSnapshot(day) {
    return this.db.prepare(`SELECT * FROM cards
      WHERE (tcg_id IS NOT NULL OR (set_code IS NOT NULL AND number IS NOT NULL))
        AND (market_checked_at IS NULL OR substr(market_checked_at, 1, 10) < ?)
      ORDER BY market_checked_at IS NOT NULL, market_checked_at, id`).all(day);
  }

  // ---- PokemonPriceTracker cache ----

  getTrackerCache(cardId) {
    const row = this.db.prepare('SELECT * FROM pricetracker_cache WHERE card_id = ?').get(cardId);
    return row ? { ...row, data: row.data ? JSON.parse(row.data) : null } : null;
  }

  saveTrackerCache(cardId, { tcgPlayerId, data, error = null }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO pricetracker_cache (card_id, tcg_player_id, fetched_at, attempted_at, data, error) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (card_id) DO UPDATE SET tcg_player_id = COALESCE(excluded.tcg_player_id, tcg_player_id),
        fetched_at = COALESCE(excluded.fetched_at, fetched_at), attempted_at = excluded.attempted_at,
        data = COALESCE(excluded.data, data), error = excluded.error`)
      .run(cardId, tcgPlayerId ?? null, data ? now : null, now, data ? JSON.stringify(data) : null, error);
  }

  /** Cards with no PokemonPriceTracker data, or the oldest data, first. */
  cardsByTrackerAge() {
    return this.db.prepare(`SELECT c.*, t.attempted_at AS tracker_attempted_at FROM cards c
      LEFT JOIN pricetracker_cache t ON t.card_id = c.id
      WHERE c.tcg_id IS NOT NULL OR (c.name IS NOT NULL AND c.number IS NOT NULL)
      ORDER BY t.attempted_at IS NOT NULL, t.attempted_at, c.id`).all();
  }

  // ---- API usage ----

  usage(provider, day) {
    return this.db.prepare('SELECT credits, requests, reported_remaining FROM api_usage WHERE day = ? AND provider = ?').get(day, provider)
      ?? { credits: 0, requests: 0, reported_remaining: null };
  }

  addUsage(provider, day, credits, reportedRemaining = null) {
    this.db.prepare(`INSERT INTO api_usage (day, provider, credits, requests, reported_remaining) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (day, provider) DO UPDATE SET credits = credits + excluded.credits, requests = requests + 1,
        reported_remaining = COALESCE(excluded.reported_remaining, reported_remaining)`).run(day, provider, credits, reportedRemaining);
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
