// 3D models for PokéBattles, from the open-source Pokémon 3D API (github.com/Pokemon-3D-api).
//
// Its model list (MergedOpt.json) maps each National Pokédex number to its forms (regular, shiny,
// mega, gmax, regional…) and a .glb file on GitHub. The list is cached for a day in memory and
// kept on disk so it works offline. Models are downloaded on first use, checked (glTF, ≤ 15 MB)
// and cached under data/models3d, then served by this app — only files the list names, and only
// from the Pokémon 3D API's own GitHub address, are ever downloaded.
//
// The models are © Nintendo / Creatures / GAME FREAK, shared by a non-commercial fan project; they
// are downloaded for personal use and never stored in this repository.

import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_INDEX_URL = 'https://raw.githubusercontent.com/Pokemon-3D-api/api-server/main/server/json/MergedOpt.json';
export const DEFAULT_ASSET_PREFIX = 'https://raw.githubusercontent.com/Pokemon-3D-api/';
const MAX_MODEL_BYTES = 15 * 1024 * 1024;
const MODEL_PATH = /\/models\/opt\/([A-Za-z][\w-]{0,30})\/([\w-]{1,60}\.glb)$/;

// Words on cards that aren't part of the Pokémon's name.
const SUFFIXES = /\s+(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.?\s?X|Prime|LEGEND|δ|☆|◇|Star|Prism Star)$/;
const PREFIXES = /^(Mega|M|Dark|Light|Radiant|Shining|Alolan|Galarian|Hisuian|Paldean|Team Rocket's|Rocket's|Shadow|Ancient|Origin Forme?)\s+/i;
const OWNER = /^[A-Z][\w.]*(?:\s[A-Z][\w.]*)?['’]s\s+/; // "Misty's Psyduck", "Lt. Surge's Raichu"

export function cleanName(name) {
  let s = String(name ?? '').normalize('NFKC').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(SUFFIXES, '').replace(OWNER, '').replace(PREFIXES, '').trim();
    if (s === before) break;
  }
  return s.toLowerCase();
}

/** Which form fits the card best: "Mega …" → mega, "Alolan …" → alolan, VMAX → gmax, shiny rarities → shiny. */
export function preferredForm(card, forms) {
  const name = String(card?.name ?? '');
  const shiny = /shiny|radiant/i.test(String(card?.rarity ?? '')) || /^shining\s/i.test(name);
  const wants = [];
  if (/^(mega|m)\s/i.test(name)) wants.push(shiny ? 'megaShiny' : 'mega', 'mega');
  if (/^alolan\s/i.test(name)) wants.push('alolan');
  if (/^galarian\s/i.test(name)) wants.push('galar');
  if (/^hisuian\s/i.test(name)) wants.push('hisuian');
  if (/\bvmax\b/i.test(name)) wants.push('gmax');
  if (shiny) wants.push('shiny');
  wants.push('regular');
  const have = new Set(forms.map((f) => f.form));
  return wants.find((w) => have.has(w)) ?? forms[0]?.form ?? null;
}

export class Models3D {
  constructor({ dataDir, indexUrl = process.env.MODELS3D_INDEX_URL || DEFAULT_INDEX_URL, assetPrefix = process.env.MODELS3D_ASSET_PREFIX || DEFAULT_ASSET_PREFIX, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.dir = path.resolve(dataDir, 'models3d');
    this.indexUrl = indexUrl;
    this.assetPrefix = assetPrefix;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.loaded = null; // { at, byId: Map, byFile: Map, byName: Map }
    this.pending = new Map();
  }

  #build(json) {
    const byId = new Map();
    const byFile = new Map();
    const byName = new Map();
    for (const p of Array.isArray(json?.pokemon) ? json.pokemon : []) {
      const id = Number(p?.id);
      if (!Number.isInteger(id) || id < 1) continue;
      const forms = [];
      for (const f of Array.isArray(p.forms) ? p.forms : []) {
        const url = String(f?.model ?? '');
        const m = url.match(MODEL_PATH);
        if (!m || !url.startsWith(this.assetPrefix)) continue;
        const [, form, file] = m;
        const key = `${form}/${file}`;
        if (byFile.has(key) && byFile.get(key).id !== id) continue;
        byFile.set(key, { id, url });
        forms.push({ form, name: String(f.name ?? '').slice(0, 60), file, url: `/api/battles/models/${form}/${file}` });
        if (form === 'regular') byName.set(cleanName(f.name), id);
      }
      if (forms.length) byId.set(id, forms);
    }
    return { byId, byFile, byName };
  }

  /** The model list (memory → network → the copy on disk). */
  async index() {
    if (this.loaded && Date.now() - this.loaded.at < DAY) return this.loaded;
    const disk = path.join(this.dir, 'index.json');
    try {
      const res = await this.fetch(this.indexUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`model list responded ${res.status}`);
      const text = await res.text();
      const built = this.#build(JSON.parse(text));
      if (!built.byId.size) throw new Error('empty model list');
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(`${disk}.tmp`, text);
      fs.renameSync(`${disk}.tmp`, disk);
      this.loaded = { at: Date.now(), ...built };
    } catch (err) {
      if (!this.loaded) {
        try {
          this.loaded = { at: Date.now() - DAY + 10 * 60 * 1000, ...this.#build(JSON.parse(fs.readFileSync(disk, 'utf8'))) }; // retry online in 10 min
        } catch {
          throw new Error(`The 3D model list isn't available (${err.message})`);
        }
      }
    }
    return this.loaded;
  }

  /** The forms for a card: by its Pokédex number, else by its (English) name. */
  async forCard(card, dexIds = []) {
    let idx;
    try { idx = await this.index(); } catch { return { dexId: dexIds[0] ?? null, forms: [], default: null, available: false }; }
    const dexId = dexIds.find((d) => idx.byId.has(d)) ?? idx.byName.get(cleanName(card.name)) ?? dexIds[0] ?? null;
    const forms = (dexId && idx.byId.get(dexId)) || [];
    return { dexId, forms, default: preferredForm(card, forms), available: forms.length > 0 };
  }

  /**
   * The local path of a model file, downloading it once if needed. Only files the model list
   * names are allowed. Throws an error with `status` for the route.
   */
  async file(form, file) {
    const idx = await this.index();
    const entry = idx.byFile.get(`${form}/${file}`);
    if (!entry || !/^[A-Za-z][\w-]{0,30}$/.test(form) || !/^[\w-]{1,60}\.glb$/.test(file)) {
      throw Object.assign(new Error('No such model'), { status: 404 });
    }
    const local = path.join(this.dir, form, file);
    if (fs.existsSync(local)) return local;
    const key = `${form}/${file}`;
    if (!this.pending.has(key)) {
      this.pending.set(key, this.#download(entry.url, local).finally(() => this.pending.delete(key)));
    }
    await this.pending.get(key);
    return local;
  }

  async #download(url, local) {
    if (!url.startsWith(this.assetPrefix)) throw Object.assign(new Error('Model address not allowed'), { status: 404 });
    let res;
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw Object.assign(new Error('Couldn’t download the 3D model (offline?)'), { status: 503 });
    }
    if (!res.ok) throw Object.assign(new Error(`The 3D model isn’t available (${res.status})`), { status: res.status === 404 ? 404 : 502 });
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_MODEL_BYTES) throw Object.assign(new Error('The 3D model is too large'), { status: 502 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_MODEL_BYTES || buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') {
      throw Object.assign(new Error('That download isn’t a 3D model'), { status: 502 });
    }
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const tmp = `${local}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, local);
  }
}
