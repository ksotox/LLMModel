// The owner's own scanner tests: photos of their cards with each card's corners and identity marked,
// kept in <data>/scan-bench/ (labels.json + the photos) for `npm run bench:scan` to measure the card
// finder and reader on real photos.
//
// This is the one place a whole photo is stored on the server, by the owner's explicit choice
// ("Save to my scanner tests"). It stays on their PC: nothing here is sent anywhere else.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

const error = (status, message) => Object.assign(new Error(message), { status, expose: true });

/** A card label: { name, tcgIds: [...], corners: [[x, y] × 4] } within a photo of width × height. */
export function validLabel(card, width, height) {
  if (!card || typeof card.name !== 'string' || !card.name.trim()) return null;
  const corners = card.corners;
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const pts = corners.map((p) => (Array.isArray(p) ? p.map(Number) : [Number(p?.x), Number(p?.y)]));
  const inside = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= -2 && y >= -2 && x <= width + 2 && y <= height + 2;
  if (!pts.every(([x, y]) => inside(x, y))) return null;
  const tcgIds = (Array.isArray(card.tcgIds) ? card.tcgIds : []).map(String).filter((s) => /^[\w:.-]{1,40}$/.test(s)).slice(0, 4);
  return { name: card.name.trim().slice(0, 80), tcgIds, corners: pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) };
}

export function scanLabelsRouter({ dataDir, isOwner }) {
  const dir = path.join(dataDir, 'scan-bench');
  const file = path.join(dir, 'labels.json');
  const read = () => {
    try {
      const labels = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(labels.photos) ? labels : { photos: [] };
    } catch {
      return { photos: [] };
    }
  };
  const write = (labels) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ about: 'Your own scanner tests (Profile → Scanner tests); used by npm run bench:scan.', ...labels }, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
    fileFilter: (_req, f, cb) => cb(null, f.mimetype in IMAGE_EXT),
  });

  const router = express.Router();
  router.use((req, _res, next) => next(isOwner(req) ? undefined : error(403, 'Only the owner profile can keep scanner tests')));

  router.get('/', (_req, res) => {
    res.json({ photos: read().photos.map((p) => ({ file: p.file, cards: p.cards, width: p.width, height: p.height })) });
  });

  // The photos themselves, for the page's thumbnails.
  router.get('/photos/:file', (req, res) => {
    const name = path.basename(req.params.file);
    if (!read().photos.some((p) => p.file === name)) throw error(404, 'No such photo');
    res.sendFile(path.join(dir, name));
  });

  // Save one photo with its labelled cards: multipart { photo, labels: JSON { width, height, cards } }.
  router.post('/', upload.single('photo'), (req, res) => {
    if (!req.file) throw error(400, 'A photo (JPEG, PNG or WebP) is needed');
    let meta;
    try {
      meta = JSON.parse(req.body?.labels ?? '');
    } catch {
      throw error(400, 'The labels are not valid');
    }
    const width = Number(meta?.width);
    const height = Number(meta?.height);
    if (!(width > 0 && height > 0)) throw error(400, 'The photo size is missing');
    const cards = (Array.isArray(meta.cards) ? meta.cards : []).map((c) => validLabel(c, width, height));
    if (!cards.length || cards.some((c) => !c)) throw error(400, 'Each card needs a name and four corners inside the photo');
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${IMAGE_EXT[req.file.mimetype]}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), req.file.buffer);
    const labels = read();
    labels.photos.push({ file: name, width, height, cards });
    write(labels);
    res.status(201).json({ file: name, cards });
  });

  router.delete('/:file', (req, res) => {
    const name = path.basename(req.params.file);
    const labels = read();
    const before = labels.photos.length;
    labels.photos = labels.photos.filter((p) => p.file !== name);
    if (labels.photos.length === before) throw error(404, 'No such photo');
    write(labels);
    fs.rmSync(path.join(dir, name), { force: true });
    res.status(204).end();
  });
  return router;
}
