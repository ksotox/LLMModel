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
CREATE INDEX IF NOT EXISTS idx_cards_tcg ON cards(tcg_id);

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

-- People who use the app, each with their own collection, and their signed-in sessions.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  is_owner       INTEGER NOT NULL DEFAULT 0,
  settings       TEXT,
  created_at     TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
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
  language: 'TEXT', // 'ja' for Japanese cards; empty means English
  user_id: 'INTEGER', // whose collection; filled in for older collections when the first profile is made
  // Each row is one physical copy: its own condition, grading, cost, storage place and plans.
  condition: 'TEXT', // NM, LP, MP, HP, DMG
  grade_company: 'TEXT', // PSA, BGS, CGC… (graded copies)
  grade: 'TEXT', // "10", "9.5"
  purchase_price: 'REAL',
  storage_location: 'TEXT',
  status: 'TEXT', // keep (default), trade, sell
  deleted_at: 'TEXT', // in the trash since (restorable for 30 days)
};

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const STATUSES = ['keep', 'trade', 'sell'];

// The same card (official card + printing), for grouping copies and spotting duplicates: the
// official card id, or for cards not linked yet their name, set code and number.
const keyOf = (a) => `COALESCE(${a}.tcg_id, LOWER(${a}.name) || '|' || IFNULL(UPPER(${a}.set_code), '') || '|' || IFNULL(LTRIM(${a}.number, '0'), '')) || '#' || IFNULL(${a}.variant, 'normal')`;
const keyFromValues = () => "COALESCE(?, LOWER(?) || '|' || IFNULL(UPPER(?), '') || '|' || IFNULL(LTRIM(?, '0'), '')) || '#' || IFNULL(?, 'normal')";
const keyValues = (c) => [c.tcg_id || null, c.name ?? '', c.set_code || null, c.number ? String(c.number).split('/')[0] : null, c.variant || null];
const truthy = (v) => v === true || v === '1' || v === 1 || v === 'true';

export const PACK_KINDS = ['booster-pack', 'tin', 'kit', 'bundle', 'elite-trainer-box', 'collection-box', 'blister', 'booster-box', 'other'];
export const VARIANTS = ['normal', 'reverse-holo', 'holo', 'full-art', 'promo', 'other'];

const CARD_FIELDS = ['name', 'set_code', 'set_id', 'set_name', 'number', 'set_total', 'variant', 'rarity', 'category', 'hp', 'types',
  'tcg_id', 'official_image_url', 'official_image_path', 'photo_path', 'pack_id', 'notes', ...Object.keys(CARD_MIGRATIONS)];
const PACK_FIELDS = ['name', 'kind', 'set_name', 'notes', 'photo_path', 'user_id'];

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
  const packCols = new Set(db.prepare('PRAGMA table_info(packs)').all().map((c) => c.name));
  if (!packCols.has('user_id')) db.exec('ALTER TABLE packs ADD COLUMN user_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id, deleted_at)');
  const trackerCols = new Set(db.prepare('PRAGMA table_info(pricetracker_cache)').all().map((c) => c.name));
  if (!trackerCols.has('picture_checked_at')) db.exec('ALTER TABLE pricetracker_cache ADD COLUMN picture_checked_at TEXT');
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

  /** One card, optionally only if it belongs to `userId` (and isn't in the trash unless asked). */
  getCard(id, userId, { trash = false } = {}) {
    const row = this.db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) ?? null;
    if (!row || (userId != null && row.user_id !== userId) || (!trash && row.deleted_at)) return null;
    return row;
  }

  deleteCard(id) {
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  }

  /**
   * WHERE clause for a collection query. Every filter combines with the others (AND):
   * text search, pack, set, rarity, type, variant, language, condition, status, value range, date
   * added, graded, duplicates, unmatched, missing price, grading candidates, chosen ids, trash.
   */
  #cardFilters(f = {}) {
    const where = [];
    const params = [];
    const add = (sql, ...values) => { where.push(sql); params.push(...values); };
    if (f.userId != null) add('c.user_id = ?', f.userId);
    where.push(f.trash ? 'c.deleted_at IS NOT NULL' : 'c.deleted_at IS NULL');
    for (const term of String(f.q ?? '').trim().split(/\s+/).filter(Boolean)) {
      if (/^(jp|japan|japanese)$/i.test(term)) {
        where.push("c.language = 'ja'");
        continue;
      }
      const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const cols = ['c.name', 'c.set_code', 'c.set_name', 'c.number', "c.number || '/' || IFNULL(c.set_total, '')", 'c.rarity', 'c.language',
        'c.category', 'c.types', 'c.variant', 'c.notes', 'c.storage_location', 'c.condition', 'p.name', 'p.set_name'];
      add(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`, ...cols.map(() => like));
    }
    if (f.packId === 'none') where.push('c.pack_id IS NULL');
    else if (f.packId) add('c.pack_id = ?', Number(f.packId));
    if (f.setCode) add('UPPER(c.set_code) = UPPER(?)', f.setCode);
    if (f.category) add('c.category = ?', f.category);
    if (f.rarity) add('LOWER(c.rarity) = LOWER(?)', f.rarity);
    if (f.type) add("(', ' || c.types || ', ') LIKE ?", `%, ${f.type}, %`);
    if (f.variant) add('c.variant = ?', f.variant);
    if (f.language === 'ja') where.push("c.language = 'ja'");
    else if (f.language === 'en') where.push("IFNULL(c.language, 'en') <> 'ja'");
    if (f.condition) add('c.condition = ?', f.condition);
    if (f.status) add("IFNULL(c.status, 'keep') = ?", f.status);
    if (f.minValue !== undefined && f.minValue !== '') add("c.market_price >= ? AND c.market_currency = 'USD'", Number(f.minValue));
    if (f.maxValue !== undefined && f.maxValue !== '') add("c.market_price <= ? AND c.market_currency = 'USD'", Number(f.maxValue));
    if (f.addedFrom) add('substr(c.created_at, 1, 10) >= ?', String(f.addedFrom).slice(0, 10));
    if (f.addedTo) add('substr(c.created_at, 1, 10) <= ?', String(f.addedTo).slice(0, 10));
    if (f.graded === 'yes') where.push('c.grade_company IS NOT NULL');
    else if (f.graded === 'no') where.push('c.grade_company IS NULL');
    if (truthy(f.unmatched)) where.push('c.tcg_id IS NULL');
    if (truthy(f.missingPrice)) where.push('c.market_price IS NULL');
    // Worth sending to grading: valuable, raw, and not known to be played.
    if (truthy(f.gradingCandidates)) where.push("c.market_price >= 20 AND c.grade_company IS NULL AND IFNULL(c.condition, 'NM') = 'NM'");
    if (truthy(f.duplicates)) {
      where.push(`(SELECT COUNT(*) FROM cards d WHERE d.user_id IS c.user_id AND d.deleted_at IS NULL AND ${keyOf('d')} = ${keyOf('c')}) >= ${Math.max(2, Number(f.minCopies) || 2)}`);
    }
    if (Array.isArray(f.ids) && f.ids.length) add(`c.id IN (${f.ids.map(() => '?').join(', ')})`, ...f.ids.map(Number));
    return { sql: `WHERE ${where.join(' AND ')}`, params };
  }

  #order(sort, grouped) {
    return {
      oldest: 'c.created_at ASC, c.id ASC',
      name: 'c.name COLLATE NOCASE ASC, c.id DESC',
      // "TG05", "GG12" and "SV001" sort by their prefix, then their digits.
      set: "c.set_code COLLATE NOCASE ASC, RTRIM(c.number, '0123456789') COLLATE NOCASE ASC, CAST(LTRIM(c.number, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') AS INTEGER) ASC, c.id DESC",
      value: 'c.market_price IS NULL, c.market_price DESC, c.id DESC',
      rarity: 'c.pull_chance IS NULL, c.pull_chance ASC, c.id DESC',
      quantity: `${grouped ? 'g.quantity' : 'owned'} DESC, c.name COLLATE NOCASE ASC`,
      condition: "CASE c.condition WHEN 'NM' THEN 1 WHEN 'LP' THEN 2 WHEN 'MP' THEN 3 WHEN 'HP' THEN 4 WHEN 'DMG' THEN 5 ELSE 6 END, c.name COLLATE NOCASE",
    }[sort] ?? 'c.created_at DESC, c.id DESC';
  }

  /** All matching cards (each copy), as an array. */
  listCards(filters = {}) {
    const { sql, params } = this.#cardFilters(filters);
    return this.db.prepare(`${CARD_SELECT} ${sql} ORDER BY ${this.#order(filters.sort)}`).all(...params);
  }

  /**
   * A page of the collection: { cards, total }. With `group`, copies of the same card (official
   * card + printing) come back as one row with `quantity` and their `ids`. Every row carries
   * `owned`: how many copies of that card the user has in all.
   */
  queryCards({ group = false, page = 1, pageSize = 60, ...filters } = {}) {
    const { sql, params } = this.#cardFilters(filters);
    const size = Math.min(500, Math.max(1, Number(pageSize) || 60));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const owned = `(SELECT COUNT(*) FROM cards d WHERE d.user_id IS c.user_id AND d.deleted_at IS NULL AND ${keyOf('d')} = ${keyOf('c')}) AS owned`;
    if (group) {
      const groups = `SELECT MIN(c.id) AS id, COUNT(*) AS quantity, GROUP_CONCAT(c.id) AS ids FROM cards c LEFT JOIN packs p ON p.id = c.pack_id ${sql} GROUP BY ${keyOf('c')}`;
      const total = this.db.prepare(`SELECT COUNT(*) AS n FROM (${groups})`).get(...params).n;
      const cards = this.db.prepare(`SELECT c.*, p.name AS pack_name, p.kind AS pack_kind, g.quantity, g.ids, ${owned}
        FROM (${groups}) g JOIN cards c ON c.id = g.id LEFT JOIN packs p ON p.id = c.pack_id
        ORDER BY ${this.#order(filters.sort, true)} LIMIT ? OFFSET ?`).all(...params, size, offset)
        .map((r) => ({ ...r, ids: String(r.ids).split(',').map(Number) }));
      return { cards, total };
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM cards c LEFT JOIN packs p ON p.id = c.pack_id ${sql}`).get(...params).n;
    const cards = this.db.prepare(`SELECT c.*, p.name AS pack_name, p.kind AS pack_kind, 1 AS quantity, ${owned}
      FROM cards c LEFT JOIN packs p ON p.id = c.pack_id ${sql} ORDER BY ${this.#order(filters.sort)} LIMIT ? OFFSET ?`).all(...params, size, offset);
    return { cards, total };
  }

  /** The other copies of the same card (official card + printing) in this user's collection. */
  copiesOf(card) {
    return this.db.prepare(`${CARD_SELECT} WHERE c.user_id IS ? AND c.deleted_at IS NULL AND ${keyOf('c')} = (SELECT ${keyOf('k')} FROM cards k WHERE k.id = ?)
      ORDER BY c.created_at, c.id`).all(card.user_id, card.id);
  }

  /** How many copies of each card (official card + printing) the user owns, for duplicate warnings. */
  ownedByKey(userId, cards) {
    const stmt = this.db.prepare(`SELECT COUNT(*) AS n FROM cards c WHERE c.user_id IS ? AND c.deleted_at IS NULL AND ${keyOf('c')} = ${keyFromValues()}`);
    return cards.map((card) => stmt.get(userId ?? null, ...keyValues(card)).n);
  }

  /** Change the same fields on several cards at once (only this user's). Returns how many changed. */
  updateCards(ids, userId, fields) {
    const row = pick(fields, CARD_FIELDS);
    const cols = Object.keys(row);
    if (!cols.length || !ids.length) return 0;
    return Number(this.db.prepare(`UPDATE cards SET ${cols.map((c) => `${c} = ?`).join(', ')}
      WHERE id IN (${ids.map(() => '?').join(', ')}) AND user_id IS ? AND deleted_at IS NULL`)
      .run(...cols.map((c) => row[c]), ...ids.map(Number), userId ?? null).changes);
  }

  /** Move cards to the trash (restorable) or back out of it. */
  trashCards(ids, userId, restore = false) {
    if (!ids.length) return 0;
    return Number(this.db.prepare(`UPDATE cards SET deleted_at = ? WHERE id IN (${ids.map(() => '?').join(', ')}) AND user_id IS ?
      AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'}`).run(restore ? null : now(), ...ids.map(Number), userId ?? null).changes);
  }

  /** Cards in the trash for longer than `days`: removed for good (returned so their photos can go too). */
  purgeTrash(days = 30) {
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare('SELECT id, photo_path FROM cards WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(before);
    this.db.prepare('DELETE FROM cards WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(before);
    return rows;
  }

  /** How many copies of each online card id are in the collection. */
  ownedCounts(ids, userId) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const rows = this.db.prepare(`SELECT tcg_id, COUNT(*) AS n FROM cards WHERE deleted_at IS NULL AND (? IS NULL OR user_id = ?)
      AND tcg_id IN (${unique.map(() => '?').join(', ')}) GROUP BY tcg_id`).all(userId ?? null, userId ?? null, ...unique);
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
      WHERE deleted_at IS NULL AND (tcg_id IS NOT NULL OR (number IS NOT NULL AND (set_code IS NOT NULL OR name IS NOT NULL)))
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

  /** Today's price of the same card and printing, if another copy was already priced today. */
  sharedPrice(card, day) {
    if (!card.tcg_id) return null;
    return this.db.prepare(`SELECT rarity, pull_chance, pull_source, market_price, market_currency, market_low, market_high, market_source, market_updated
      FROM cards WHERE tcg_id = ? AND IFNULL(variant, 'normal') = ? AND id <> ? AND substr(market_checked_at, 1, 10) = ? AND market_price IS NOT NULL
      ORDER BY market_checked_at DESC LIMIT 1`).get(card.tcg_id, card.variant || 'normal', card.id ?? -1, day) ?? null;
  }

  /** Remember that PokemonPriceTracker was searched for a card's picture (searches cost credits). */
  markPictureSearch(cardId) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO pricetracker_cache (card_id, picture_checked_at) VALUES (?, ?)
      ON CONFLICT (card_id) DO UPDATE SET picture_checked_at = excluded.picture_checked_at`).run(cardId, now);
  }

  /** Cards with no PokemonPriceTracker data, or the oldest data, first. */
  cardsByTrackerAge() {
    return this.db.prepare(`SELECT c.*, t.attempted_at AS tracker_attempted_at FROM cards c
      LEFT JOIN pricetracker_cache t ON t.card_id = c.id
      WHERE c.deleted_at IS NULL AND (c.tcg_id IS NOT NULL OR (c.name IS NOT NULL AND c.number IS NOT NULL))
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

  getPack(id, userId) {
    const pack = this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.pack_id = p.id AND c.deleted_at IS NULL) AS card_count
      FROM packs p WHERE p.id = ?`).get(id) ?? null;
    return pack && (userId == null || pack.user_id === userId) ? pack : null;
  }

  deletePack(id) {
    this.db.prepare('DELETE FROM packs WHERE id = ?').run(id);
  }

  listPacks({ q, userId } = {}) {
    const where = [];
    const params = [];
    if (userId != null) { where.push('p.user_id = ?'); params.push(userId); }
    if (q && q.trim()) {
      where.push('(p.name LIKE ? OR p.set_name LIKE ? OR p.kind LIKE ? OR p.notes LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like);
    }
    return this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.pack_id = p.id AND c.deleted_at IS NULL) AS card_count
      FROM packs p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC, p.id DESC`).all(...params);
  }

  // ---- misc ----

  stats(userId) {
    const mine = 'deleted_at IS NULL AND (? IS NULL OR user_id = ?)';
    const u = [userId ?? null, userId ?? null];
    return this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM cards WHERE ${mine}) AS cards,
        (SELECT COUNT(DISTINCT ${keyOf('cards')}) FROM cards WHERE ${mine}) AS unique_cards,
        (SELECT COUNT(*) FROM packs WHERE (? IS NULL OR user_id = ?)) AS packs,
        (SELECT COUNT(*) FROM cards WHERE ${mine} AND official_image_path IS NOT NULL) AS with_official,
        (SELECT ROUND(IFNULL(SUM(market_price), 0), 2) FROM cards WHERE ${mine} AND market_currency = 'USD') AS value_usd,
        (SELECT ROUND(IFNULL(SUM(market_price), 0), 2) FROM cards WHERE ${mine} AND market_currency = 'EUR') AS value_eur,
        (SELECT COUNT(*) FROM cards WHERE ${mine} AND market_price IS NOT NULL) AS priced,
        (SELECT COUNT(*) FROM cards WHERE deleted_at IS NOT NULL AND (? IS NULL OR user_id = ?)) AS in_trash`).get(...u, ...u, ...u, ...u, ...u, ...u, ...u, ...u);
  }

  setCodes(userId) {
    return this.db.prepare(`
      SELECT UPPER(set_code) AS code, MAX(set_name) AS name, COUNT(*) AS count, MAX(language) AS language
      FROM cards WHERE set_code IS NOT NULL AND set_code <> '' AND deleted_at IS NULL AND (? IS NULL OR user_id = ?)
      GROUP BY UPPER(set_code) ORDER BY code`).all(userId ?? null, userId ?? null);
  }

  /** This user's copies in a set (by printed set code), for the set-completion checklist. */
  cardsInSet(userId, setCode) {
    return this.db.prepare(`SELECT id, name, number, variant, tcg_id, market_price, market_currency, official_image_path, photo_path FROM cards
      WHERE deleted_at IS NULL AND (? IS NULL OR user_id = ?) AND UPPER(set_code) = UPPER(?)`).all(userId ?? null, userId ?? null, setCode);
  }

  // ---- users and sessions ----

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  createUser({ username, display_name, password_hash, is_owner = 0 }) {
    return Number(this.db.prepare('INSERT INTO users (username, display_name, password_hash, is_owner, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, display_name, password_hash, is_owner ? 1 : 0, '{}', now()).lastInsertRowid);
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  }

  getUserByName(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) ?? null;
  }

  listUsers() {
    return this.db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, u.created_at,
      (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.deleted_at IS NULL) AS cards FROM users u ORDER BY u.id`).all();
  }

  updateUser(id, { display_name, password_hash, settings }) {
    const sets = [];
    const params = [];
    if (display_name !== undefined) { sets.push('display_name = ?'); params.push(display_name); }
    if (password_hash !== undefined) { sets.push('password_hash = ?'); params.push(password_hash); }
    if (settings !== undefined) { sets.push('settings = ?'); params.push(JSON.stringify(settings)); }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  /** Remove a profile and everything in its collection; returns the photos to delete. */
  deleteUser(id) {
    const photos = this.db.prepare('SELECT photo_path FROM cards WHERE user_id = ? UNION ALL SELECT photo_path FROM packs WHERE user_id = ?').all(id, id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM cards WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM packs WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    return photos.map((r) => r.photo_path).filter(Boolean);
  }

  /** A collection made before profiles existed belongs to the first profile. */
  claimUnowned(userId) {
    this.db.prepare('UPDATE cards SET user_id = ? WHERE user_id IS NULL').run(userId);
    this.db.prepare('UPDATE packs SET user_id = ? WHERE user_id IS NULL').run(userId);
  }

  createSession(tokenHash, userId, days) {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, now(), new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString());
  }

  userForSession(tokenHash) {
    return this.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(tokenHash, now()) ?? null;
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteSessionsOf(userId, exceptHash = null) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?').run(userId, exceptHash);
  }

  purgeSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  }
}
