import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { CardCatalog } from './catalog.js';
import { EbayClient, EbayNotApproved, searchQuery, soldSearchUrl } from './ebay.js';
import { gradeFromTitle, listingMatchesCard, soldStats } from './soldStats.js';
import { openDb, PACK_KINDS, VARIANTS } from './db.js';
import { identifyCard } from './identify.js';
import { SET_CODES } from './setCodes.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const require = createRequire(import.meta.url);
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
// Image tools that run in the browser, served from this app so they work without any CDN.
const VENDOR = {
  '/vendor/opencv': path.join(packageDir('@techstark/opencv-js'), 'dist'),
  '/vendor/tesseract': path.join(packageDir('tesseract.js'), 'dist'),
  '/vendor/tesseract-core': packageDir('tesseract.js-core'),
  '/vendor/tessdata': path.join(packageDir('@tesseract.js-data/eng'), '4.0.0_best_int'),
};
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' };
const MAX_FILE_BYTES = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ dataDir, catalog = new CardCatalog(), ebay = new EbayClient() } = {}) {
  const dirs = {
    cards: path.join(dataDir, 'uploads', 'cards'),
    packs: path.join(dataDir, 'uploads', 'packs'),
    official: path.join(dataDir, 'official'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const store = openDb(path.join(dataDir, 'collection.db'));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 200 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype in IMAGE_EXT),
  });

  // ---- file helpers ----

  const saveUpload = (file, kind) => {
    const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${IMAGE_EXT[file.mimetype]}`;
    fs.writeFileSync(path.join(dirs[kind], name), file.buffer);
    return `uploads/${kind}/${name}`;
  };

  const removeFile = (rel) => {
    if (!rel) return;
    const abs = path.join(dataDir, rel);
    if (abs.startsWith(dataDir)) fs.rmSync(abs, { force: true });
  };

  /**
   * Download the official image once and keep a local copy, so it survives the sources being offline.
   * If the main image can't be downloaded, the same card's picture from the second source is tried.
   */
  const cacheOfficialImage = async (card) => {
    const base = `official/${card.tcg_id.replace(/[^\w.-]/g, '_')}`;
    const existing = ['.png', '.jpg', '.webp'].map((ext) => base + ext).find((rel) => fs.existsSync(path.join(dataDir, rel)));
    if (existing) return existing;
    const urls = [card.official_image_url, await catalog.fallbackImage(card).catch(() => null)].filter(Boolean);
    for (const url of [...new Set(urls)]) {
      try {
        const img = await catalog.download(url);
        if (!img) continue;
        const ext = { 'image/jpeg': '.jpg', 'image/webp': '.webp' }[img.contentType.split(';')[0]] ?? '.png';
        fs.writeFileSync(path.join(dataDir, base + ext), img.buffer);
        return base + ext;
      } catch {
        // try the next source
      }
    }
    return null;
  };

  /** Rarity, estimated pull chance and market price. Never throws; missing parts stay empty. */
  const withMarket = async (card) => {
    let market;
    try {
      market = await catalog.market(card);
    } catch {
      return card;
    }
    return {
      ...card,
      rarity: card.rarity ?? market.rarity,
      pull_chance: market.pull?.chance ?? null,
      pull_source: market.pull?.source ?? null,
      ...(market.price
        ? {
          market_price: market.price.value,
          market_currency: market.price.currency,
          market_low: market.price.low,
          market_high: market.price.high,
          market_source: market.price.source,
          market_updated: market.price.updated ?? new Date().toISOString(),
        }
        : {}),
    };
  };

  /**
   * Fill a card with its official details and image when it is linked to an online card.
   * Never throws: if the online database is unreachable the card keeps what the client sent.
   */
  const withOfficial = async (card) => {
    if (!card.tcg_id) return card.set_code && card.number ? withMarket(card) : card;
    let details = null;
    try {
      details = await catalog.details(card.tcg_id);
    } catch {
      // offline: fall through with the client-provided brief
    }
    const merged = { ...card };
    if (details) {
      for (const [k, v] of Object.entries(details)) if (v != null) merged[k] = v;
    }
    merged.official_image_path = await cacheOfficialImage(merged);
    return withMarket(merged);
  };

  const toJson = (card) => card && {
    ...card,
    photo_url: card.photo_path ? `/media/${card.photo_path}` : null,
    official_url: card.official_image_path ? `/media/${card.official_image_path}` : card.official_image_url,
  };
  const packJson = (pack) => pack && { ...pack, photo_url: pack.photo_path ? `/media/${pack.photo_path}` : null };

  const parseList = (raw, field) => {
    let list;
    try {
      list = JSON.parse(raw ?? '[]');
    } catch {
      throw new HttpError(400, `"${field}" must be a JSON array`);
    }
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, `"${field}" must be a non-empty JSON array`);
    return list;
  };

  const cleanCard = (c) => {
    const name = String(c.name ?? '').trim();
    if (!name && !c.tcg_id) throw new HttpError(400, 'Every card needs a name (or a matched online card)');
    const card = { ...c, name };
    if (card.variant && !VARIANTS.includes(card.variant)) card.variant = 'other';
    if (card.set_code) card.set_code = String(card.set_code).trim().toUpperCase();
    if (card.pack_id != null && card.pack_id !== '') {
      if (!store.getPack(Number(card.pack_id))) throw new HttpError(400, `Pack ${card.pack_id} does not exist`);
      card.pack_id = Number(card.pack_id);
    } else {
      card.pack_id = null;
    }
    return card;
  };

  const cleanPack = (p) => {
    const name = String(p.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Every pack needs a name');
    return { ...p, name, kind: PACK_KINDS.includes(p.kind) ? p.kind : 'other' };
  };

  const filesByField = (req) => new Map((req.files ?? []).map((f) => [f.fieldname, f]));

  /** Save each item's photo (referenced by `photoField`) and insert all rows with one shared date added. */
  const insertWithPhotos = (items, files, kind, insert) => {
    const createdAt = new Date().toISOString();
    const photos = items.map((item) => {
      const file = item.photoField && files.get(item.photoField);
      return file ? saveUpload(file, kind) : null;
    });
    try {
      return store.transaction(() => items.map((item, i) => insert({ ...item, photo_path: photos[i], created_at: createdAt })));
    } catch (err) {
      photos.forEach(removeFile);
      throw err;
    }
  };
  const findCard = (id) => {
    const card = store.getCard(Number(id));
    if (!card) throw new HttpError(404, 'Card not found');
    return card;
  };
  const findPack = (id) => {
    const pack = store.getPack(Number(id));
    if (!pack) throw new HttpError(404, 'Pack not found');
    return pack;
  };

  // ---- routes ----

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/media/uploads', express.static(path.join(dataDir, 'uploads'), { maxAge: '30d', immutable: true }));
  app.use('/media/official', express.static(dirs.official, { maxAge: '30d' }));
  for (const [url, dir] of Object.entries(VENDOR)) app.use(url, express.static(dir, { maxAge: '30d' }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/meta', (_req, res) => {
    res.json({
      packKinds: PACK_KINDS,
      variants: VARIANTS,
      setCodes: SET_CODES,
      collectionSets: store.setCodes(),
      stats: store.stats(),
    });
  });

  app.get('/api/lookup', async (req, res) => {
    const { name, setCode, number } = req.query;
    if (!name && !setCode && !number) throw new HttpError(400, 'Give a name, set code or number to look up');
    try {
      const results = await catalog.search({ name, setCode, number });
      const owned = store.ownedCounts(results.map((r) => r.tcgId));
      res.json({ results: results.map((r) => ({ ...r, owned: owned[r.tcgId] ?? 0 })) });
    } catch (err) {
      res.status(502).json({ error: 'The online card database could not be reached. You can still save the card and look it up later.', detail: err.message });
    }
  });

  // Work out which card a photo shows from the text the browser read off it (see public/js/ocr.js).
  app.post('/api/identify', async (req, res) => {
    const texts = (v) => (Array.isArray(v) ? v : []).filter((t) => typeof t === 'string').slice(0, 12).map((t) => t.slice(0, 200));
    const result = await identifyCard(catalog, { names: texts(req.body?.names), lines: texts(req.body?.lines) });
    const owned = store.ownedCounts(result.candidates.map((c) => c.tcgId));
    const withOwned = (c) => c && { ...c, owned: owned[c.tcgId] ?? 0 };
    res.json({ ...result, match: withOwned(result.match), candidates: result.candidates.map(withOwned) });
  });

  // Any card from the online sources, with rarity, pull chance and price (for the card search page).
  app.get('/api/catalog/cards/:id', async (req, res) => {
    let card;
    try {
      card = await catalog.details(req.params.id);
    } catch {
      throw new HttpError(502, 'The online card database could not be reached. Try again later.');
    }
    if (!card) throw new HttpError(404, 'Card not found');
    const variant = typeof req.query.variant === 'string' ? req.query.variant : 'normal';
    const market = await catalog.market({ ...card, variant }).catch(() => ({ rarity: card.rarity, pull: null, price: null }));
    res.json({ card, market, owned: store.ownedCounts([card.tcg_id])[card.tcg_id] ?? 0 });
  });

  // Cards

  app.get('/api/cards', (req, res) => {
    res.json({ cards: store.listCards(req.query).map(toJson) });
  });

  app.get('/api/cards/:id', (req, res) => {
    res.json(toJson(findCard(req.params.id)));
  });

  // Batch create: multipart with `cards` (JSON array) and one image per card, referenced by `photoField`.
  app.post('/api/cards', upload.any(), async (req, res) => {
    const files = filesByField(req);
    const input = parseList(req.body.cards, 'cards').map(cleanCard);
    const prepared = [];
    for (const card of input) prepared.push(await withOfficial(card));
    const ids = insertWithPhotos(prepared, files, 'cards', (card) => store.insertCard(card));
    res.status(201).json({ cards: ids.map((id) => toJson(store.getCard(id))) });
  });

  app.patch('/api/cards/:id', async (req, res) => {
    const existing = findCard(req.params.id);
    let card = cleanCard({ ...existing, ...req.body });
    const relink = req.body.tcg_id !== undefined && req.body.tcg_id !== existing.tcg_id;
    const repriced = ['variant', 'set_code', 'number'].some((k) => req.body[k] !== undefined && req.body[k] !== existing[k]);
    if (relink) {
      card = card.tcg_id ? await withOfficial(card) : { ...card, official_image_url: null, official_image_path: null };
    } else if (repriced) {
      card = await withMarket(card);
    }
    store.updateCard(existing.id, card);
    res.json(toJson(store.getCard(existing.id)));
  });

  // Re-fetch the official details/image for a card that is already linked (e.g. it was added offline).
  app.post('/api/cards/:id/refresh-official', async (req, res) => {
    const existing = findCard(req.params.id);
    if (!existing.tcg_id) throw new HttpError(400, 'This card is not linked to an online card yet');
    const card = await withOfficial({ ...existing });
    store.updateCard(existing.id, card);
    res.json(toJson(store.getCard(existing.id)));
  });

  // Refresh rarity, pull chance and price for one card, or for the whole collection.
  app.post('/api/cards/refresh-market', async (_req, res) => {
    let updated = 0;
    for (const card of store.listCards()) {
      const next = await withMarket(card);
      store.updateCard(card.id, next);
      if (next.market_price != null || next.pull_chance != null) updated++;
    }
    res.json({ updated, stats: store.stats() });
  });

  app.post('/api/cards/:id/refresh-market', async (req, res) => {
    const existing = findCard(req.params.id);
    store.updateCard(existing.id, await withMarket(existing));
    res.json(toJson(store.getCard(existing.id)));
  });

  // eBay sold listings for a card: average sold price, price trend and the listings themselves.

  const CONDITION_FILTERS = {
    all: () => true,
    raw: (s) => !s.grade,
    graded: (s) => Boolean(s.grade),
  };

  const ebayView = (card, filter = 'all') => {
    const stored = store.listSales(card.id);
    const keep = CONDITION_FILTERS[filter] ?? CONDITION_FILTERS.all;
    const listings = stored.filter(keep);
    return {
      query: searchQuery(card),
      searchUrl: soldSearchUrl(card),
      apiConfigured: ebay.configured,
      filter,
      counts: { all: stored.length, raw: stored.filter(CONDITION_FILTERS.raw).length, graded: stored.filter(CONDITION_FILTERS.graded).length },
      lastAdded: stored.reduce((latest, s) => (s.created_at > latest ? s.created_at : latest), '') || null,
      stats: soldStats(listings.map((s) => ({ price: s.price, currency: s.currency, soldAt: s.sold_at }))),
      listings,
    };
  };

  /** Keep only well-formed listings that look like this exact card; add the grade from the title. */
  const cleanSales = (card, sales) => {
    const valid = sales.filter((s) => s && typeof s.title === 'string' && Number(s.price) > 0 && !Number.isNaN(Date.parse(s.soldAt)))
      .map((s) => ({
        itemId: s.itemId ? String(s.itemId).slice(0, 64) : null,
        title: s.title.slice(0, 300),
        price: Math.round(Number(s.price) * 100) / 100,
        currency: /^[A-Z]{3}$/.test(s.currency ?? '') ? s.currency : 'USD',
        soldAt: new Date(s.soldAt).toISOString(),
        condition: s.condition ? String(s.condition).slice(0, 80) : null,
        url: /^https:\/\/(www\.)?ebay\.[a-z.]+\//.test(s.url ?? '') ? s.url.slice(0, 500) : null,
        grade: gradeFromTitle(s.title),
      }));
    const matching = valid.filter((s) => listingMatchesCard(s.title, card));
    return { matching, skipped: sales.length - matching.length };
  };

  app.get('/api/cards/:id/ebay', (req, res) => {
    res.json(ebayView(findCard(req.params.id), req.query.condition));
  });

  // Fetch the last 90 days of sold listings from eBay's official API (needs EBAY_CLIENT_ID/SECRET).
  app.post('/api/cards/:id/ebay/refresh', async (req, res) => {
    const card = findCard(req.params.id);
    if (!ebay.configured) throw new HttpError(400, 'The eBay API is not set up. Paste listings from eBay instead, or see the README to connect it.');
    let sales;
    try {
      sales = await ebay.soldListings(card);
    } catch (err) {
      throw new HttpError(err instanceof EbayNotApproved ? 403 : 502, err instanceof EbayNotApproved ? err.message : 'eBay could not be reached right now. Try again later.');
    }
    const { matching, skipped } = cleanSales(card, sales);
    const added = store.addSales(card.id, matching, 'ebay-api');
    res.json({ added, skipped, ...ebayView(card, req.query.condition) });
  });

  // Listings the user copied from eBay.com and pasted into the app (parsed in the browser).
  app.post('/api/cards/:id/ebay/import', (req, res) => {
    const card = findCard(req.params.id);
    const listings = Array.isArray(req.body?.listings) ? req.body.listings.slice(0, 1000) : null;
    if (!listings) throw new HttpError(400, 'Send the listings as { listings: [...] }');
    const { matching, skipped } = cleanSales(card, listings);
    const added = store.addSales(card.id, matching, 'pasted');
    res.json({ added, skipped, ...ebayView(card, req.query.condition) });
  });

  app.delete('/api/cards/:id/ebay/:saleId', (req, res) => {
    const card = findCard(req.params.id);
    if (!store.deleteSale(card.id, Number(req.params.saleId))) throw new HttpError(404, 'Listing not found');
    res.json(ebayView(card, req.query.condition));
  });

  app.post('/api/cards/:id/photo', upload.single('photo'), (req, res) => {
    const existing = findCard(req.params.id);
    if (!req.file) throw new HttpError(400, 'Attach an image as "photo"');
    const photo_path = saveUpload(req.file, 'cards');
    store.updateCard(existing.id, { photo_path });
    removeFile(existing.photo_path);
    res.json(toJson(store.getCard(existing.id)));
  });

  app.delete('/api/cards/:id', (req, res) => {
    const existing = findCard(req.params.id);
    store.deleteCard(existing.id);
    removeFile(existing.photo_path);
    res.status(204).end();
  });

  // Packs / tins / kits / bundles

  app.get('/api/packs', (req, res) => {
    res.json({ packs: store.listPacks(req.query).map(packJson) });
  });

  app.get('/api/packs/:id', (req, res) => {
    res.json(packJson(findPack(req.params.id)));
  });

  app.post('/api/packs', upload.any(), (req, res) => {
    const files = filesByField(req);
    const input = parseList(req.body.packs, 'packs').map(cleanPack);
    const ids = insertWithPhotos(input, files, 'packs', (pack) => store.insertPack(pack));
    res.status(201).json({ packs: ids.map((id) => packJson(store.getPack(id))) });
  });

  app.patch('/api/packs/:id', (req, res) => {
    const existing = findPack(req.params.id);
    store.updatePack(existing.id, cleanPack({ ...existing, ...req.body }));
    res.json(packJson(store.getPack(existing.id)));
  });

  app.post('/api/packs/:id/photo', upload.single('photo'), (req, res) => {
    const existing = findPack(req.params.id);
    if (!req.file) throw new HttpError(400, 'Attach an image as "photo"');
    store.updatePack(existing.id, { photo_path: saveUpload(req.file, 'packs') });
    removeFile(existing.photo_path);
    res.json(packJson(store.getPack(existing.id)));
  });

  // Deleting a pack keeps its cards (they become "no pack") unless ?withCards=1.
  app.delete('/api/packs/:id', (req, res) => {
    const existing = findPack(req.params.id);
    const cards = req.query.withCards === '1' ? store.listCards({ packId: existing.id }) : [];
    store.transaction(() => {
      for (const c of cards) store.deleteCard(c.id);
      store.deletePack(existing.id);
    });
    for (const c of cards) removeFile(c.photo_path);
    removeFile(existing.photo_path);
    res.status(204).end();
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err instanceof multer.MulterError ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });

  app.locals.store = store;
  return app;
}
