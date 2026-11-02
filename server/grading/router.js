/**
 * My Pokédex ↔ local Viridian computer-vision adapter (experimental pre-grading).
 * Not a PSA/BGS/CGC certification service, and no trained grade model is used.
 *
 * Based on the "Viridian Pre-Grading Integration Kit v0.1", adapted to this app: every card is
 * checked against the signed-in profile, trashed cards can't be graded, upload limits answer 413,
 * and report photos are cleaned up after any card deletion (single card, pack with its cards,
 * a deleted profile, or the 30-day trash purge) by sweeping folders no report points to.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { mimeFromMagic, normalizeAnalysis, pngDataUriToBuffer } from './normalize.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REPORTS = 50;
const IMG_ROOT = 'uploads/grading';
const REPORT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** The one new table. Rows go away with their card (ON DELETE CASCADE; foreign keys are on). */
export function initializeGradingTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS card_grading_reports (
    id TEXT PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    folder TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_card_grading_reports_card ON card_grading_reports(card_id, created_at DESC);`);
}

/** The grading service's address: only a loopback HTTP origin is allowed (no SSRF target). */
export function engineUrl(env = process.env) {
  const base = new URL(env.GRADER_SERVICE_URL || 'http://127.0.0.1:8765');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/') {
    throw new Error('GRADER_SERVICE_URL must be a local HTTP origin (e.g. http://127.0.0.1:8765)');
  }
  return base.origin;
}

// Errors carry `expose` so the app's error handler shows their message even for 5xx.
const routeError = (status, message) => Object.assign(new Error(message), { status, expose: true });

async function requestService(url, options = {}, timeout = 120_000) {
  let res;
  let raw;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    raw = await res.text();
  } catch {
    throw routeError(503, 'The local grading service isn’t running. Start it with scripts/grading-start.ps1 (see the user guide).');
  }
  if (raw.length > 13_000_000) throw routeError(502, 'The grading service’s answer was too large');
  let result;
  try { result = JSON.parse(raw); } catch { throw routeError(502, 'The grading service returned an invalid answer'); }
  if (!res.ok) {
    const reason = typeof result.detail === 'string' ? result.detail : (result.message ?? `HTTP ${res.status}`);
    throw routeError([413, 415, 422, 429].includes(res.status) ? res.status : 503, String(reason).slice(0, 220));
  }
  return result;
}

const gradingRoot = (dataDir) => path.join(dataDir, IMG_ROOT);
function reportFolder(dataDir, reportId) {
  if (!REPORT_ID.test(String(reportId))) throw routeError(400, 'Invalid report id');
  return path.join(gradingRoot(dataDir), reportId);
}
const imageUrl = (relative) => `/media/${relative}`;

/** The card's locally cached official picture, sent along for reference alignment. */
function officialReference(card, dataDir) {
  const rel = card?.official_image_path;
  if (!/^official\/[a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(rel ?? '')) return null;
  const abs = path.join(dataDir, rel);
  try {
    if (!fs.lstatSync(abs).isFile()) return null; // never follow a symlink
    const buf = fs.readFileSync(abs);
    const type = mimeFromMagic(buf);
    if (buf.length > MAX_IMAGE_BYTES || !type) return null;
    return { buffer: buf, type: type.mime };
  } catch {
    return null;
  }
}

function savedReports(db, cardId) {
  return db.prepare('SELECT id, created_at, result_json FROM card_grading_reports WHERE card_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(cardId, MAX_REPORTS).map((row) => ({ id: row.id, created_at: row.created_at, ...JSON.parse(row.result_json) }));
}

function removeReportFolder(dataDir, folder) {
  if (!REPORT_ID.test(String(folder ?? ''))) return;
  fs.rmSync(reportFolder(dataDir, folder), { recursive: true, force: true });
}

/**
 * Delete report-photo folders that no saved report points to any more (their card was deleted
 * for good). Only folders named like a report id inside uploads/grading are ever touched, and
 * only after the database change is done, so a failed deletion never loses photos of live reports.
 */
export function sweepGradingOrphans(db, dataDir) {
  const root = gradingRoot(dataDir);
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const live = new Set(db.prepare('SELECT folder FROM card_grading_reports').all().map((r) => r.folder));
  let removed = 0;
  for (const entry of names) {
    if (!entry.isDirectory() || !REPORT_ID.test(entry.name) || live.has(entry.name)) continue;
    removeReportFolder(dataDir, entry.name);
    removed++;
  }
  return removed;
}

export function createGradingRouter({ store, dataDir }) {
  initializeGradingTable(store.db);
  fs.mkdirSync(gradingRoot(dataDir), { recursive: true });
  const router = express.Router();
  let busy = false;

  const checkCard = (req) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id) || Number(id) < 1) throw routeError(400, 'Invalid card id');
    const card = store.getCard(Number(id), req.user.id); // only this profile's cards, not in the trash
    if (!card) throw routeError(404, 'Card not found');
    return card;
  };

  const multerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 2, fileSize: MAX_IMAGE_BYTES, fields: 0, parts: 2 },
    fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
  }).fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]);
  const upload = (req, res, next) => multerUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(routeError(413, 'Each photo must be 8 MB or smaller.'));
    return next(routeError(400, 'Send exactly one front and one back photo.'));
  });

  router.get('/health', async (_req, res) => {
    try {
      const status = await requestService(`${engineUrl()}/health`, {}, 2500);
      res.json({
        configured: true, ready: status.ready === true, engine: status.engine || null,
        detail: status.ready ? 'Ready for card photos' : (status.detail || 'Viridian isn’t installed'),
      });
    } catch {
      res.json({ configured: true, ready: false, detail: 'The local grading service isn’t running.' });
    }
  });

  router.get('/cards/:id', (req, res) => {
    const card = checkCard(req);
    res.set('Cache-Control', 'no-store').json({ reports: savedReports(store.db, card.id) });
  });

  router.post('/cards/:id', (req, _res, next) => { checkCard(req); next(); }, upload, async (req, res) => {
    const card = checkCard(req);
    const front = req.files?.front?.[0];
    const back = req.files?.back?.[0];
    if (!front || !back) throw routeError(400, 'Upload both an original front and back photo (JPEG, PNG or WebP).');
    const fm = mimeFromMagic(front.buffer);
    const bm = mimeFromMagic(back.buffer);
    if (!fm || !bm || fm.mime !== front.mimetype || bm.mime !== back.mimetype) {
      throw routeError(415, 'Only real JPEG, PNG and WebP photos are supported.');
    }
    if (busy) throw routeError(429, 'Another card is being inspected. Try again in a moment.');
    busy = true;
    try {
      const form = new FormData();
      form.set('front', new Blob([front.buffer], { type: fm.mime }), `front${fm.ext}`);
      form.set('back', new Blob([back.buffer], { type: bm.mime }), `back${bm.ext}`);
      const ref = officialReference(card, dataDir);
      if (ref) form.set('reference', new Blob([ref.buffer], { type: ref.type }), 'reference');
      const answer = await requestService(`${engineUrl()}/analyze`, { method: 'POST', body: form });
      let result;
      try { result = normalizeAnalysis(answer); } catch { throw routeError(502, 'Unexpected answer from the grading service'); }

      // From here on everything is synchronous, so no other request can run in between.
      const reportId = crypto.randomUUID();
      const folder = reportFolder(dataDir, reportId);
      const media = {};
      fs.mkdirSync(folder, { recursive: true });
      try {
        for (const [name, file, info] of [['front', front, fm], ['back', back, bm]]) {
          const filename = `${name}${info.ext}`;
          fs.writeFileSync(path.join(folder, filename), file.buffer, { flag: 'wx' });
          media[name] = imageUrl(`${IMG_ROOT}/${reportId}/${filename}`);
        }
        for (const name of ['front_overlay', 'back_overlay']) {
          const img = pngDataUriToBuffer(answer[name]);
          if (img) {
            fs.writeFileSync(path.join(folder, `${name}.png`), img, { flag: 'wx' });
            media[name] = imageUrl(`${IMG_ROOT}/${reportId}/${name}.png`);
          }
        }
        const stored = { ...result, media };
        const created_at = new Date().toISOString();
        store.db.prepare('INSERT INTO card_grading_reports (id, card_id, created_at, folder, result_json) VALUES (?,?,?,?,?)')
          .run(reportId, card.id, created_at, reportId, JSON.stringify(stored));
        res.status(201).set('Cache-Control', 'no-store').json({ report: { id: reportId, created_at, ...stored } });
      } catch (err) {
        fs.rmSync(folder, { recursive: true, force: true }); // only this new report's folder
        throw err;
      }
    } finally {
      busy = false;
    }
  });

  router.delete('/cards/:id/reports/:reportId', (req, res) => {
    const card = checkCard(req);
    if (!REPORT_ID.test(req.params.reportId)) throw routeError(400, 'Invalid report id');
    const row = store.db.prepare('SELECT folder FROM card_grading_reports WHERE id = ? AND card_id = ?').get(req.params.reportId, card.id);
    if (!row) throw routeError(404, 'Report not found');
    store.db.prepare('DELETE FROM card_grading_reports WHERE id = ? AND card_id = ?').run(req.params.reportId, card.id);
    removeReportFolder(dataDir, row.folder);
    res.status(204).end();
  });

  return router;
}
