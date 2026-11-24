// Trainer models for the Sanctuary and battles (glTF binary, .glb). Three come with the app (Ash, Iris,
// May: public/assets/trainers/, CC-BY-4.0 on Sketchfab, shipped at the owner's choice) and are listed
// first; anyone can add their own, kept in their data folder (data/trainers/<user id>/), never in the
// repository. The credit a model carries (glTF asset.extras: title, author, licence, source, as
// Sketchfab writes them) is kept and shown.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

export const MAX_TRAINER_BYTES = 25 * 1024 * 1024;
const ID = /^[a-z0-9]{6,40}$/;
const BUILTIN_DIR = new URL('../public/assets/trainers/', import.meta.url);

/** The trainers that come with the app ({ id: 'builtin-ash', name, file, credit…, builtin: true }). */
export function builtinTrainers() {
  try {
    const { trainers } = JSON.parse(fs.readFileSync(new URL('manifest.json', BUILTIN_DIR), 'utf8'));
    // A model without a skeleton gets one in the browser (creature/autoRig.js), so all of them walk.
    return trainers.map((t) => ({ ...t, rigged: true, builtin: true }));
  } catch {
    return [];
  }
}

/**
 * Read a .glb's header and JSON chunk: { title, author, licence, source, rigged, clips }, or null when
 * the bytes aren't a glTF binary. Pure, for the tests.
 */
export function readGlbInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') return null;
  const version = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  if (version !== 2 || buf.toString('ascii', 16, 20) !== 'JSON' || 20 + jsonLength > buf.length) return null;
  let json;
  try { json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength)); } catch { return null; }
  const extras = json.asset?.extras ?? {};
  const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    title: text(extras.title, 80),
    author: text(extras.author),
    licence: text(extras.license ?? extras.licence),
    source: /^https?:\/\//.test(text(extras.source)) ? text(extras.source) : '',
    rigged: Array.isArray(json.skins) && json.skins.length > 0,
    clips: Array.isArray(json.animations) ? json.animations.length : 0,
  };
}

/** The /api/trainers router. `dataDir`: the app's data folder. */
export function createTrainersRouter({ dataDir }) {
  const root = path.join(dataDir, 'trainers');
  const dirOf = (req) => path.join(root, String(req.user.id));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TRAINER_BYTES, files: 1 } });
  const router = express.Router();
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

  const list = (req) => {
    const dir = dirOf(req);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.added.localeCompare(b.added));
  };

  router.get('/', (req, res) => res.json({ trainers: [...builtinTrainers(), ...list(req)] }));

  router.post('/', upload.single('model'), (req, res) => {
    const file = req.file;
    if (!file) throw fail(400, 'Choose a .glb file');
    const info = readGlbInfo(file.buffer);
    if (!info) throw fail(400, 'That file is not a glTF binary (.glb) model');
    const id = crypto.randomBytes(8).toString('hex');
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || info.title || file.originalname.replace(/\.glb$/i, '').slice(0, 60) || 'Trainer';
    const entry = { id, name, ...info, bytes: file.size, added: new Date().toISOString() };
    fs.mkdirSync(dirOf(req), { recursive: true });
    fs.writeFileSync(path.join(dirOf(req), `${id}.glb`), file.buffer);
    fs.writeFileSync(path.join(dirOf(req), `${id}.json`), JSON.stringify(entry));
    res.status(201).json(entry);
  });

  router.get('/:id.glb', (req, res) => {
    const builtin = builtinTrainers().find((t) => t.id === req.params.id);
    if (builtin) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.type('model/gltf-binary').sendFile(fileURLToPath(new URL(builtin.file, BUILTIN_DIR)));
    }
    if (!ID.test(req.params.id)) throw fail(404, 'No such model');
    const file = path.join(dirOf(req), `${req.params.id}.glb`);
    if (!fs.existsSync(file)) throw fail(404, 'No such model');
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('model/gltf-binary').sendFile(file);
  });

  router.delete('/:id', (req, res) => {
    if (builtinTrainers().some((t) => t.id === req.params.id)) throw fail(400, 'The trainers that come with the app can’t be removed');
    if (!ID.test(req.params.id)) throw fail(404, 'No such model');
    for (const ext of ['.glb', '.json']) fs.rmSync(path.join(dirOf(req), `${req.params.id}${ext}`), { force: true });
    res.status(204).end();
  });

  return router;
}
