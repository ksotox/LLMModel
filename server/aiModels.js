// Free AI model files (ONNX) that the browser runs on this device with onnxruntime-web: finding
// cards in cluttered photos, reading text, and cutting a card's artwork out with depth for 3D
// Pop-out. Each file is downloaded once from the address in MANIFEST, checked and kept in
// data/ai-models, then served by this app at /api/ai/models/<name>. Every feature that uses a
// model also works without it (a classic image-processing fallback), so a missing or failed
// download only means the simpler result.
//
// Checks: only names in the manifest; https only; a size cap; and the file's SHA-256. When the
// manifest gives the hash it must match. When it doesn't yet (a new entry whose hash couldn't be
// worked out where it was written), the first download's hash is pinned in data/ai-models/pins.json
// and every later download must match it; `npm run check:live` prints pinned hashes so they can be
// copied into the manifest.
//
// Only models whose code and weights are under a permissive licence (MIT, Apache-2.0, BSD) belong
// here: no AGPL (e.g. Ultralytics YOLO) and no non-commercial weights.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/**
 * The model files the app may use. An entry:
 *   { name: 'u2netp', file: 'u2netp.onnx', url: 'https://…', sha256: '…' (or null until known),
 *     size: 4_574_861 (expected bytes, for the progress bar and the cap), license: 'Apache-2.0',
 *     purpose: 'Cut the subject out of card artwork (3D Pop-out)' }
 * Entries are added by the milestones that first use them (docs/ROADMAP.md, M1 and M5).
 */
export const MANIFEST = [];

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE = /^[A-Za-z0-9][\w.-]{0,100}\.onnx$/;
const HARD_CAP = 400 * 1024 * 1024;

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

export class AiModels {
  constructor({ dataDir, manifest = MANIFEST, fetchImpl = globalThis.fetch, timeoutMs = 10 * 60 * 1000, log = () => {} } = {}) {
    this.dir = path.resolve(dataDir, 'ai-models');
    this.byName = new Map();
    for (const m of manifest) {
      if (!NAME.test(m.name) || !FILE.test(m.file) || !/^https:\/\//.test(m.url)) throw new Error(`Bad AI model entry: ${m.name}`);
      this.byName.set(m.name, m);
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.pending = new Map();
  }

  #pinsFile() { return path.join(this.dir, 'pins.json'); }

  /** Hashes pinned on first download, by model name. */
  pins() {
    try { return JSON.parse(fs.readFileSync(this.#pinsFile(), 'utf8')); } catch { return {}; }
  }

  #local(m) { return path.join(this.dir, m.file); }

  /** What the browser needs to decide: each model, whether it is here already, and its size. */
  list() {
    return [...this.byName.values()].map((m) => ({
      name: m.name, purpose: m.purpose ?? '', license: m.license ?? '', size: m.size ?? null,
      ready: fs.existsSync(this.#local(m)),
    }));
  }

  /** The local path of a model file, downloading and checking it the first time. Throws with `status`. */
  async file(name) {
    const m = this.byName.get(name);
    if (!m) throw fail(404, 'No such AI model');
    const local = this.#local(m);
    if (fs.existsSync(local)) return local;
    if (!this.pending.has(name)) this.pending.set(name, this.#download(m, local).finally(() => this.pending.delete(name)));
    await this.pending.get(name);
    return local;
  }

  async #download(m, local) {
    const cap = Math.min(HARD_CAP, m.size ? Math.ceil(m.size * 1.05) + 1024 : HARD_CAP);
    let res;
    try {
      res = await this.fetch(m.url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    } catch {
      throw fail(503, `Couldn’t download the AI model “${m.name}” (offline?)`);
    }
    if (!res.ok || !res.body) throw fail(502, `The AI model “${m.name}” isn’t available (${res.status})`);
    if (Number(res.headers.get('content-length')) > cap) throw fail(502, `The AI model “${m.name}” is larger than expected`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${local}.${process.pid}.${Date.now()}.tmp`;
    const out = fs.openSync(tmp, 'w');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > cap) throw fail(502, `The AI model “${m.name}” is larger than expected`);
        hash.update(chunk);
        fs.writeSync(out, chunk);
      }
    } catch (err) {
      fs.closeSync(out);
      fs.rmSync(tmp, { force: true });
      throw err.status ? err : fail(503, `The download of the AI model “${m.name}” was interrupted`);
    }
    fs.closeSync(out);
    const sha = hash.digest('hex');
    const pins = this.pins();
    const expected = m.sha256 ?? pins[m.name] ?? null;
    if (bytes < 1024 || (expected && sha !== expected)) {
      fs.rmSync(tmp, { force: true });
      throw fail(502, `The AI model “${m.name}” didn’t pass its check (checksum ${expected ? 'mismatch' : 'too small'})`);
    }
    if (!expected) {
      pins[m.name] = sha;
      fs.writeFileSync(this.#pinsFile(), `${JSON.stringify(pins, null, 2)}\n`);
      this.log(`AI model ${m.name}: first download, pinned sha256 ${sha}`);
    }
    fs.renameSync(tmp, local);
  }
}

/**
 * GET /api/ai/models: the list (name, purpose, licence, size, ready).
 * GET /api/ai/models/:name: the file (downloaded and checked the first time). Both need sign-in
 * (mounted under /api, after the sign-in check).
 */
export function aiModelsRouter(models) {
  const router = express.Router();
  router.get('/', (req, res) => res.json({ models: models.list() }));
  router.get('/:name', async (req, res, next) => {
    try {
      const file = await models.file(req.params.name);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('application/octet-stream').sendFile(file);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
