// Card dioramas for 3D Pop-out: a finished picture of the card standing on a glowing pedestal with
// its Pokémon (or trainer) bursting out of it. One per physical copy (`cards.id`), kept in
// <data>/card-effects/.
//
// - The owner's 27 delivered dioramas ship in assets/card-effects/ and are imported for the cards
//   they were made for (same id, and the same name or card id), never for any other card.
// - New cards get one made for free on the owner's own device: the browser draws it from the card's
//   official picture (public/js/dioramaMaker.js) and uploads it here. The server keeps the job
//   state (pending → working → ready | failed), so a card is made once per identity: editing the
//   price or storage never makes it again; relinking it to another card does.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const TYPES = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg' };
const LEASE_MS = 3 * 60 * 1000; // a job a tab claimed but never finished is offered again after this
const MAX_BYTES = 4 * 1024 * 1024;

const error = (status, message) => Object.assign(new Error(message), { status, expose: true });

/** What a diorama depends on: the card's identity and picture, never its price or storage. */
export function dioramaFingerprint(card) {
  const identity = {
    name: String(card.name ?? '').trim().toLowerCase(),
    tcg_id: card.tcg_id ?? null,
    category: card.category ?? null,
    types: card.types ?? null,
    picture: card.official_image_url ?? card.official_image_path ?? card.photo_path ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

/** Cards a diorama can be made for: one with a picture, and not an Energy card (nothing to pop out). */
export const canHaveDiorama = (card) => Boolean(card && (card.official_image_path || card.photo_path) && !/energy|エネルギー/i.test(String(card.category ?? '')));

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export class CardDioramas {
  constructor({ db, dataDir, assetsDir = null, log = console.log }) {
    this.db = db;
    this.dir = path.join(dataDir, 'card-effects');
    this.assetsDir = assetsDir;
    this.log = log;
    fs.mkdirSync(this.dir, { recursive: true });
    db.exec(`CREATE TABLE IF NOT EXISTS card_dioramas (
      card_id      INTEGER PRIMARY KEY,
      status       TEXT    NOT NULL,           -- pending | working | ready | failed
      file         TEXT,
      fingerprint  TEXT    NOT NULL,
      source       TEXT,                       -- bundled | generated
      error        TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      lease_until  TEXT,
      updated_at   TEXT    NOT NULL
    )`);
  }

  #card(id) {
    return this.db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(id)) ?? null;
  }

  #row(id) {
    return this.db.prepare('SELECT * FROM card_dioramas WHERE card_id = ?').get(Number(id)) ?? null;
  }

  #set(id, fields) {
    const row = this.#row(id);
    const next = { ...(row ?? {}), ...fields, card_id: Number(id), updated_at: new Date().toISOString() };
    this.db.prepare(`INSERT INTO card_dioramas (card_id, status, file, fingerprint, source, error, attempts, lease_until, updated_at)
      VALUES (:card_id, :status, :file, :fingerprint, :source, :error, :attempts, :lease_until, :updated_at)
      ON CONFLICT(card_id) DO UPDATE SET status = :status, file = :file, fingerprint = :fingerprint, source = :source,
        error = :error, attempts = :attempts, lease_until = :lease_until, updated_at = :updated_at`).run({
      file: null, source: null, error: null, attempts: 0, lease_until: null, ...next,
    });
  }

  #removeFile(file) {
    if (file) fs.rmSync(path.join(this.dir, path.basename(file)), { force: true });
  }

  /**
   * Keep a card's diorama in step with the card: a new card (`{ create: true }`) or a card whose
   * identity changed gets a job; anything else (price, storage, notes) changes nothing.
   */
  sync(cardId, { create = false } = {}) {
    const card = this.#card(cardId);
    const row = this.#row(cardId);
    if (!card || card.deleted_at) return row;
    if (!row && !create) return null;
    if (!canHaveDiorama(card)) return row;
    const fingerprint = dioramaFingerprint(card);
    if (row && row.fingerprint === fingerprint) return row;
    this.#set(cardId, { status: 'pending', fingerprint, error: null, attempts: 0, lease_until: null, source: row?.source ?? null, file: row?.file ?? null });
    return this.#row(cardId);
  }

  /** The user's dioramas: { cardId: { status, url, source, error } }. */
  list(userId) {
    const rows = this.db.prepare(`SELECT d.* FROM card_dioramas d JOIN cards c ON c.id = d.card_id
      WHERE c.user_id IS ? AND c.deleted_at IS NULL`).all(userId);
    return Object.fromEntries(rows.map((r) => [r.card_id, {
      status: r.status === 'working' ? 'pending' : r.status,
      url: r.file ? `/api/card-effects/images/${encodeURIComponent(r.file)}` : null,
      source: r.source,
      error: r.status === 'failed' ? r.error : null,
    }]));
  }

  /** Hand out up to `limit` jobs for this user's cards (the browser makes them). */
  claim(userId, limit = 1) {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`SELECT d.* FROM card_dioramas d JOIN cards c ON c.id = d.card_id
      WHERE c.user_id IS ? AND c.deleted_at IS NULL
        AND (d.status = 'pending' OR (d.status = 'working' AND d.lease_until < ?))
      ORDER BY d.updated_at LIMIT ?`).all(userId, now, Math.max(1, Math.min(5, Number(limit) || 1)));
    return rows.map((r) => {
      this.#set(r.card_id, { status: 'working', lease_until: new Date(Date.now() + LEASE_MS).toISOString() });
      const c = this.#card(r.card_id);
      return {
        cardId: r.card_id,
        fingerprint: r.fingerprint,
        card: {
          name: c.name, category: c.category, types: c.types, rarity: c.rarity, variant: c.variant, set_code: c.set_code, number: c.number,
          picture: c.official_image_path ? `/media/${c.official_image_path}` : c.photo_path ? `/media/${c.photo_path}` : null,
        },
      };
    });
  }

  #owned(userId, cardId) {
    const card = this.#card(cardId);
    if (!card || card.user_id !== userId || card.deleted_at) throw error(404, 'Card not found');
    return card;
  }

  /** A finished diorama from the browser, for the job with this fingerprint. */
  complete(userId, cardId, fingerprint, buffer, type) {
    this.#owned(userId, cardId);
    const row = this.#row(cardId);
    if (!row) throw error(404, 'No diorama job for this card');
    if (row.fingerprint !== fingerprint) throw error(409, 'The card changed while its diorama was being made');
    if (!TYPES[type]) throw error(415, 'A diorama must be a WebP, PNG or JPEG picture');
    if (!buffer?.length || buffer.length > MAX_BYTES) throw error(413, 'The diorama picture is empty or too large');
    const file = `${cardId}-${fingerprint}${TYPES[type]}`;
    fs.writeFileSync(path.join(this.dir, file), buffer);
    if (row.file && row.file !== file) this.#removeFile(row.file);
    this.#set(cardId, { status: 'ready', file, source: 'generated', error: null, lease_until: null });
    return this.#row(cardId);
  }

  fail(userId, cardId, fingerprint, message) {
    this.#owned(userId, cardId);
    const row = this.#row(cardId);
    if (!row || row.fingerprint !== fingerprint) return row;
    this.#set(cardId, { status: 'failed', error: String(message || 'Unknown error').slice(0, 300), attempts: row.attempts + 1, lease_until: null });
    return this.#row(cardId);
  }

  /** Make (or make again) a card's diorama: a retry after a failure, or one for an older card. */
  request(userId, cardId) {
    const card = this.#owned(userId, cardId);
    if (!canHaveDiorama(card)) throw error(400, 'This card has no picture to make a diorama from');
    const row = this.#row(cardId);
    if (row?.status === 'ready' && row.fingerprint === dioramaFingerprint(card)) return row;
    this.#set(cardId, { status: 'pending', fingerprint: dioramaFingerprint(card), error: null, lease_until: null, file: row?.file ?? null, source: row?.source ?? null, attempts: row?.attempts ?? 0 });
    return this.#row(cardId);
  }

  imageFile(userId, file) {
    const name = path.basename(String(file));
    const row = this.db.prepare(`SELECT d.card_id FROM card_dioramas d JOIN cards c ON c.id = d.card_id
      WHERE d.file = ? AND c.user_id IS ?`).get(name, userId);
    if (!row) throw error(404, 'No such diorama');
    return path.join(this.dir, name);
  }

  /** Remove dioramas of cards that are gone for good (purged from the trash). */
  sweep() {
    const gone = this.db.prepare('SELECT d.* FROM card_dioramas d LEFT JOIN cards c ON c.id = d.card_id WHERE c.id IS NULL').all();
    for (const r of gone) {
      this.#removeFile(r.file);
      this.db.prepare('DELETE FROM card_dioramas WHERE card_id = ?').run(r.card_id);
    }
    return gone.length;
  }

  /**
   * Import the delivered dioramas (assets/card-effects/manifest.json) for the cards they were made
   * for: the card with that id, if it has the same name or card id. Never overwrites a diorama the
   * card already has. Returns { imported, skipped }.
   */
  importBundled() {
    const out = { imported: 0, skipped: [] };
    if (!this.assetsDir) return out;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(this.assetsDir, 'manifest.json'), 'utf8'));
    } catch {
      return out;
    }
    for (const entry of manifest.cards ?? []) {
      const card = this.#card(entry.id);
      if (!card || card.deleted_at) continue; // not this collection's card (or not yet added)
      if (!(sameName(card.name, entry.name) || (card.tcg_id && card.tcg_id === entry.tcg_id))) {
        out.skipped.push(`#${entry.id} ${entry.name} (the collection's #${entry.id} is ${card.name})`);
        continue;
      }
      const row = this.#row(entry.id);
      if (row?.status === 'ready') continue;
      const file = `bundled-${entry.id}${path.extname(entry.file)}`;
      fs.copyFileSync(path.join(this.assetsDir, path.basename(entry.file)), path.join(this.dir, file));
      this.#set(entry.id, { status: 'ready', file, fingerprint: dioramaFingerprint(card), source: 'bundled', error: null, lease_until: null });
      out.imported++;
    }
    if (out.imported) this.log(`Card dioramas: imported ${out.imported} delivered picture(s).`);
    if (out.skipped.length) {
      const more = out.skipped.length > 2 ? ` and ${out.skipped.length - 2} more` : '';
      this.log(`Card dioramas: ${out.skipped.length} delivered picture(s) not imported, made for a different card: ${out.skipped.slice(0, 2).join('; ')}${more}.`);
    }
    return out;
  }
}

export function cardDioramasRouter(dioramas) {
  const router = express.Router();
  router.get('/', (req, res) => res.json({ cards: dioramas.list(req.user.id) }));
  router.post('/jobs', (req, res) => res.json({ jobs: dioramas.claim(req.user.id, req.body?.limit) }));
  router.put('/:id', express.raw({ type: Object.keys(TYPES), limit: MAX_BYTES }), (req, res) => {
    const row = dioramas.complete(req.user.id, Number(req.params.id), String(req.get('x-fingerprint') ?? ''), req.body, req.get('content-type')?.split(';')[0].trim());
    res.json({ status: row.status });
  });
  router.post('/:id/failed', (req, res) => {
    dioramas.fail(req.user.id, Number(req.params.id), String(req.body?.fingerprint ?? ''), req.body?.error);
    res.json({ ok: true });
  });
  router.post('/:id/request', (req, res) => res.json({ status: dioramas.request(req.user.id, Number(req.params.id)).status }));
  router.get('/images/:file', (req, res) => {
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(dioramas.imageFile(req.user.id, req.params.file));
  });
  return router;
}
