import crypto from 'node:crypto';
import { PRINTING_OPTIONS, PRINTING_DEFAULTS, normalizeStamp } from '../public/js/printing.js';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { CardCatalog } from './catalog.js';
import { EbayClient, EbayNotApproved, searchQuery, soldSearchUrl } from './ebay.js';
import { PriceTrackerClient } from './priceTracker.js';
import { PriceTrackerService } from './priceTrackerService.js';
import { direction, gradeFromTitle, listingMatchesCard, soldStats } from './soldStats.js';
import { createAuth, hashPassword, checkPassword, publicUser, validateProfile } from './auth.js';
import { CONDITIONS, openDb, PACK_KINDS, STATUSES, VARIANTS } from './db.js';
import { identifyCard } from './identify.js';
import { createGradingRouter, initializeGradingTable, sweepGradingOrphans } from './grading/router.js';
import { SET_CODES } from './setCodes.js';
import { allSets, setChecklist, userSets } from './sets.js';
import { battleData, isPokemonCard } from './battle.js';
import { Models3D } from './models3d.js';
import { AiModels, aiModelsRouter } from './aiModels.js';
import { scanLabelsRouter } from './scanLabels.js';
import { CardDioramas, cardDioramasRouter } from './cardDioramas.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const CARD_EFFECTS_DIR = fileURLToPath(new URL('../assets/card-effects', import.meta.url));
const require = createRequire(import.meta.url);
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
// Image tools that run in the browser, served from this app so they work without any CDN.
const VENDOR = {
  '/vendor/opencv': path.join(packageDir('@techstark/opencv-js'), 'dist'),
  '/vendor/tesseract': path.join(packageDir('tesseract.js'), 'dist'),
  '/vendor/tesseract-core': packageDir('tesseract.js-core'),
  '/vendor/tessdata': path.join(packageDir('@tesseract.js-data/eng'), '4.0.0_best_int'),
  '/vendor/tessdata-jpn': path.join(packageDir('@tesseract.js-data/jpn'), '4.0.0_best_int'),
  '/vendor/heic2any': path.join(packageDir('heic2any'), 'dist'),
  '/vendor/three': path.resolve(path.dirname(require.resolve('three')), '..'), // three hides package.json behind its exports
  '/vendor/ort': path.dirname(require.resolve('onnxruntime-web')), // onnxruntime-web's dist folder (also hides package.json)
};
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' };
const MAX_FILE_BYTES = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({
  dataDir,
  catalog = new CardCatalog(),
  ebay = new EbayClient(),
  priceTracker = new PriceTrackerClient(),
  trackerOptions = {},
  desktop = null, // { version(), update, restart() } when run by the desktop launcher
  models3d = null, // PokéBattles 3D models (default: the Pokémon 3D API on GitHub, cached in dataDir)
  aiModels = null, // AI model files for the browser (default: server/aiModels.js MANIFEST, cached in dataDir)
  requireLogin = true, // false: one built-in profile, no sign-in (tests, scripts)
  secureCookie = false,
} = {}) {
  const dirs = {
    cards: path.join(dataDir, 'uploads', 'cards'),
    packs: path.join(dataDir, 'uploads', 'packs'),
    official: path.join(dataDir, 'official'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const store = openDb(path.join(dataDir, 'collection.db'));
  const auth = createAuth(store, { secureCookie });
  store.purgeSessions();
  initializeGradingTable(store.db);
  for (const { photo_path } of store.purgeTrash(30)) if (photo_path) fs.rmSync(path.join(dataDir, photo_path), { force: true });
  // Card dioramas for 3D Pop-out (server/cardDioramas.js): the delivered ones are imported for the
  // cards they were made for; a card's job state follows every change to the card (identity only).
  const dioramas = new CardDioramas({ db: store.db, dataDir, assetsDir: CARD_EFFECTS_DIR });
  dioramas.sweep();
  dioramas.importBundled();
  const updateCard = store.updateCard.bind(store);
  store.updateCard = (id, data) => {
    const result = updateCard(id, data);
    dioramas.sync(id);
    return result;
  };
  // Pre-grading photos of cards deleted for good (their report rows went with the card).
  const sweepGrading = () => sweepGradingOrphans(store.db, dataDir);
  sweepGrading();
  // Without sign-in, everything belongs to one built-in profile.
  let localUser = null;
  if (!requireLogin) {
    localUser = store.getUserByName('local');
    if (!localUser) {
      store.createUser({ username: 'local', display_name: 'Me', password_hash: '!', is_owner: 1 });
      localUser = store.getUserByName('local');
    }
    store.claimUnowned(localUser.id);
  }
  const tracker = new PriceTrackerService({ client: priceTracker, store, catalog, ...trackerOptions });

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
   * If the main image can't be downloaded, the same card's picture is tried from the other sources,
   * and finally through PokemonPriceTracker when a key is set.
   */
  const cacheOfficialImage = async (card) => {
    const base = `official/${card.tcg_id.replace(/[^\w.-]/g, '_')}`;
    const existing = [...new Set(Object.values(IMAGE_EXT))].map((ext) => base + ext).find((rel) => fs.existsSync(path.join(dataDir, rel)));
    if (existing) return existing;
    const tried = new Set();
    const save = async (urls) => {
      for (const url of urls) {
        if (!url || tried.has(url)) continue;
        tried.add(url);
        try {
          const img = await catalog.download(url);
          if (!img || !/^image\//.test(img.contentType)) continue;
          const ext = IMAGE_EXT[img.contentType.split(';')[0].trim().toLowerCase()] ?? '.png';
          fs.writeFileSync(path.join(dataDir, base + ext), img.buffer);
          return base + ext;
        } catch {
          // try the next source
        }
      }
      return null;
    };
    return await save([card.official_image_url, ...await catalog.fallbackImages(card).catch(() => [])])
      // Last: PokemonPriceTracker (with a key) knows the card's TCGplayer product, and so its picture.
      ?? await save(await tracker.pictureUrls(card).catch(() => []));
  };

  /** Rarity, estimated pull chance and market price. Never throws; missing parts stay empty. */
  const withMarket = async (card) => {
    // Broad catalog prices cannot price a particular pattern, stamp or edition.
    if (['metallic', 'lenticular', 'mirror'].includes(card.variant) || Object.entries(PRINTING_DEFAULTS).some(([k, v]) => card[k] && card[k] !== v)) return { ...card, market_price: null, market_low: null, market_high: null, market_currency: null, market_source: null, market_updated: null, market_checked_at: new Date().toISOString(), pull_chance: null, pull_source: null };
    let market;
    const checked = new Date().toISOString();
    try {
      market = await catalog.market(card);
    } catch {
      return { ...card, market_checked_at: checked };
    }
    return {
      ...card,
      market_checked_at: checked,
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

  /**
   * Add a card's current market price to its price history, dated by when the source last
   * updated it. Called whenever a card is priced, so every card builds up its own history.
   */
  const snapshotPrice = (card) => {
    if (!card?.market_price) return;
    store.recordPrice(card.id, {
      // Cardmarket prices converted to dollars get their own line, apart from older euro readings.
      source: /cardmarket/i.test(card.market_source ?? '') ? (card.market_currency === 'EUR' ? 'cardmarket' : 'cardmarket-usd') : 'tcgplayer',
      label: 'Market price',
      price: card.market_price,
      currency: card.market_currency ?? 'USD',
      day: card.market_updated && !Number.isNaN(Date.parse(card.market_updated)) ? new Date(card.market_updated).toISOString().slice(0, 10) : undefined,
    });
  };

  /**
   * Link a card saved without its official card (typed in by hand, or added while offline) when
   * its name, number and set point to exactly one card. Uses the same checks as reading a card
   * from a photo, and only links when it is sure. Returns the card's tcg_id, or null.
   */
  const findOfficialCard = async (card) => {
    if (card.tcg_id || !card.name || !card.number) return null;
    const number = card.set_total ? `${card.number}/${card.set_total}` : card.number;
    const result = await identifyCard(catalog, { names: [card.name], lines: [[card.set_code, number].filter(Boolean).join(' ')] })
      .catch(() => null);
    return result?.confidence === 'high' ? result.match.tcgId : null;
  };

  /**
   * Re-price a stored card and record the price in its history. A card that isn't linked to its
   * official card yet is linked first, and a linked card whose official image is missing (e.g. the
   * source was offline when it was added) gets the image now.
   */
  const refreshing = new Map();
  const refreshCardMarket = (card) => {
    if (refreshing.has(card.id)) return refreshing.get(card.id);
    const job = refreshCardMarketNow(card).finally(() => refreshing.delete(card.id));
    refreshing.set(card.id, job);
    return job;
  };
  const refreshCardMarketNow = async (card) => {
    card = { ...card, ...cleanNumber(card) };
    const tcgId = card.tcg_id ?? await findOfficialCard(card);
    const needsOfficial = tcgId && (!card.tcg_id || !card.official_image_path);
    // Copies of the same card and printing share one price lookup a day.
    const today = new Date().toISOString().slice(0, 10);
    const shared = !needsOfficial && store.sharedPrice(card, today);
    store.updateCard(card.id, needsOfficial ? await withOfficial({ ...card, tcg_id: tcgId })
      : shared ? { ...card, ...shared, rarity: card.rarity ?? shared.rarity, market_checked_at: new Date().toISOString() } : await withMarket(card));
    const updated = store.getCard(card.id);
    snapshotPrice(updated);
    return updated;
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

  /** "060/000" typed into the number box → number 060; promos print no total, so a total of 0 is none. */
  const cleanNumber = (card) => {
    let number = card.number == null ? card.number : String(card.number).trim();
    let total = card.set_total == null || card.set_total === '' ? null : String(card.set_total).trim();
    const split = number?.match(/^(\S+?)\s*\/\s*(\d+)$/);
    if (split) {
      number = split[1];
      total ??= split[2];
    }
    if (total != null && !/[1-9]/.test(total)) total = null;
    return { number: number || null, set_total: total };
  };

  const cleanCard = (c, userId) => {
    const name = String(c.name ?? '').trim();
    if (!name && !c.tcg_id) throw new HttpError(400, 'Every card needs a name (or a matched online card)');
    const card = { ...c, name };
    for (const [key, values] of Object.entries(PRINTING_OPTIONS)) {
      if (key === 'stamp' && card.stamp != null) { card.stamp = normalizeStamp(card.stamp); if (!card.stamp) throw new HttpError(400, 'Invalid stamp'); }
      if (key !== 'stamp' && card[key] != null && !values.includes(card[key])) throw new HttpError(400, `Invalid ${key}`);
      card[key] ??= PRINTING_DEFAULTS[key];
    }
    if (card.scan_token != null && !/^[a-zA-Z0-9-]{16,80}$/.test(card.scan_token)) throw new HttpError(400, 'Invalid scan token');
    if (card.variant && !VARIANTS.includes(card.variant)) card.variant = 'other';
    if (card.set_code) card.set_code = String(card.set_code).trim().toUpperCase();
    // Per-copy details: only known values, prices as numbers.
    if (card.condition !== undefined && card.condition !== null && !CONDITIONS.includes(card.condition)) card.condition = null;
    if (card.status !== undefined && card.status !== null && !STATUSES.includes(card.status)) card.status = null;
    if (card.purchase_price !== undefined && card.purchase_price !== null && card.purchase_price !== '') {
      const n = Number(card.purchase_price);
      card.purchase_price = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    }
    if (card.grade_company !== undefined && card.grade_company) card.grade_company = String(card.grade_company).trim().toUpperCase().slice(0, 12);
    Object.assign(card, cleanNumber(card));
    // Picture addresses come from the browser: only plain web addresses (never "javascript:" etc.).
    if (card.official_image_url != null && !/^https?:\/\//i.test(String(card.official_image_url))) card.official_image_url = null;
    if (card.pack_id != null && card.pack_id !== '') {
      if (!store.getPack(Number(card.pack_id), userId)) throw new HttpError(400, `Pack ${card.pack_id} does not exist`);
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
  const findCard = (id, req) => {
    const card = store.getCard(Number(id), req.user.id);
    if (!card) throw new HttpError(404, 'Card not found');
    return card;
  };
  const findPack = (id, req) => {
    const pack = store.getPack(Number(id), req.user.id);
    if (!pack) throw new HttpError(404, 'Pack not found');
    return pack;
  };

  // ---- routes ----

  const app = express();
  app.disable('x-powered-by');

  // Who is signed in. Photos and the API (except signing in and /api/meta) need a profile.
  app.use((req, _res, next) => {
    req.user = requireLogin ? auth.userFor(req) : localUser;
    next();
  });
  const PUBLIC_API = new Set(['GET /api/meta', 'GET /api/desktop', 'GET /api/auth/state', 'POST /api/auth/setup', 'POST /api/auth/login', 'POST /api/auth/logout']);
  app.use(['/api', '/media'], (req, res, next) => {
    if (req.user || PUBLIC_API.has(`${req.method} ${req.baseUrl}${req.path}`)) return next();
    res.status(401).json({ error: 'Please sign in', signIn: true });
  });
  // Only this app's own pages may change things: a web page on another site can't post to it
  // (browsers mark cross-site requests with Origin / Sec-Fetch-Site). Tools without a browser are fine.
  app.use('/api', (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    let sameOrigin = true;
    try {
      sameOrigin = !origin || new URL(origin).host === req.host; // req.host follows X-Forwarded-Host only behind a trusted proxy
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin || req.get('sec-fetch-site') === 'cross-site') return next(new HttpError(403, 'Requests from other websites are not allowed'));
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  // Experimental pre-grading through the local Viridian service (127.0.0.1 only; see server/grading).
  app.use('/api/grading', createGradingRouter({ store, dataDir }));
  app.use('/media/uploads', express.static(path.join(dataDir, 'uploads'), { maxAge: '30d', immutable: true }));
  app.use('/media/official', express.static(dirs.official, { maxAge: '30d' }));
  for (const [url, dir] of Object.entries(VENDOR)) app.use(url, express.static(dir, { maxAge: '30d' }));
  app.use(express.static(PUBLIC_DIR));

  // ---- profiles and signing in ----

  const meJson = (user) => publicUser(store.getUser(user.id));

  app.get('/api/auth/state', (req, res) => {
    res.json({ setupNeeded: requireLogin && store.countUsers() === 0, requireLogin, user: req.user ? meJson(req.user) : null });
  });

  // First start: create the owner profile, which takes over any collection made before profiles.
  app.post('/api/auth/setup', async (req, res) => {
    if (!requireLogin || store.countUsers() > 0) throw new HttpError(409, 'The app is already set up: sign in instead');
    const { username, display_name, password } = req.body ?? {};
    const problem = validateProfile({ username, display_name: display_name ?? username, password });
    if (problem) throw new HttpError(400, problem);
    const id = store.createUser({ username: username.trim(), display_name: String(display_name || username).trim(), password_hash: await hashPassword(password), is_owner: 1 });
    store.claimUnowned(id);
    auth.startSession(res, id);
    res.status(201).json({ user: meJson({ id }) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const result = await auth.login(req.body?.username, req.body?.password, req.ip);
    if (result.error) throw new HttpError(result.status, result.error);
    auth.startSession(res, result.user.id);
    res.json({ user: meJson(result.user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.endSession(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => res.json(meJson(req.user)));

  // Change your display name, preferences (theme, gallery view…) or password.
  app.patch('/api/auth/me', async (req, res) => {
    const { display_name, settings, current_password, new_password } = req.body ?? {};
    const changes = {};
    if (display_name !== undefined) {
      if (!String(display_name).trim()) throw new HttpError(400, 'Give the profile a display name.');
      changes.display_name = String(display_name).trim().slice(0, 60);
    }
    if (settings !== undefined) {
      if (typeof settings !== 'object' || Array.isArray(settings) || JSON.stringify(settings).length > 4000) throw new HttpError(400, 'Invalid settings');
      changes.settings = { ...publicUser(store.getUser(req.user.id)).settings, ...settings };
    }
    if (new_password !== undefined) {
      if (!(await checkPassword(current_password, store.getUser(req.user.id).password_hash))) throw new HttpError(403, 'Your current password is wrong.');
      if (String(new_password).length < 6) throw new HttpError(400, 'Passwords need at least 6 characters.');
      changes.password_hash = await hashPassword(new_password);
      store.deleteSessionsOf(req.user.id, auth.currentHash(req)); // sign out everywhere else
    }
    store.updateUser(req.user.id, changes);
    res.json(meJson(req.user));
  });

  // The owner manages the other profiles (each has its own collection).
  const ownerOnly = (req) => {
    if (!store.getUser(req.user.id)?.is_owner) throw new HttpError(403, 'Only the owner profile can manage profiles');
  };
  app.get('/api/users', (req, res) => {
    ownerOnly(req);
    res.json({ users: store.listUsers() });
  });
  app.post('/api/users', async (req, res) => {
    ownerOnly(req);
    const { username, display_name, password } = req.body ?? {};
    const problem = validateProfile({ username, display_name: display_name ?? username, password });
    if (problem) throw new HttpError(400, problem);
    if (store.getUserByName(username.trim())) throw new HttpError(409, 'That username is taken');
    const id = store.createUser({ username: username.trim(), display_name: String(display_name || username).trim(), password_hash: await hashPassword(password) });
    res.status(201).json({ user: publicUser(store.getUser(id)) });
  });
  app.delete('/api/users/:id', (req, res) => {
    ownerOnly(req);
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'You can’t delete your own profile');
    if (!store.getUser(id)) throw new HttpError(404, 'Profile not found');
    for (const photo of store.deleteUser(id)) removeFile(photo);
    sweepGrading();
    res.status(204).end();
  });

  // Desktop app: the installed version, a newer one waiting, and a restart that installs it.
  app.get('/api/desktop', (_req, res) => {
    res.json(desktop ? { desktop: true, version: desktop.version(), update: desktop.update ?? null } : { desktop: false });
  });

  app.post('/api/desktop/restart', (_req, res) => {
    if (!desktop?.restart) throw new HttpError(404, 'Only the desktop app can restart itself');
    res.json({ restarting: true });
    setTimeout(() => desktop.restart(), 200); // after the answer has gone out
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      packKinds: PACK_KINDS,
      variants: VARIANTS,
      setCodes: SET_CODES,
      // Public (the desktop launcher checks it to see the server is up): collection details only when signed in.
      collectionSets: req.user ? store.setCodes(req.user.id) : [],
      stats: req.user ? store.stats(req.user.id) : null,
      conditions: CONDITIONS,
      statuses: STATUSES,
      facets: req.user ? store.facets(req.user.id) : null,
    });
  });

  app.get('/api/lookup', async (req, res) => {
    const { name, setCode, number } = req.query;
    const lang = ['en', 'ja'].includes(req.query.lang) ? req.query.lang : undefined;
    if (!name && !setCode && !number) throw new HttpError(400, 'Give a name, set code or number to look up');
    try {
      const results = await catalog.search({ name, setCode, number, lang });
      const owned = store.ownedCounts(results.map((r) => r.tcgId), req.user.id);
      res.json({ results: results.map((r) => ({ ...r, owned: owned[r.tcgId] ?? 0 })) });
    } catch (err) {
      res.status(502).json({ error: 'The online card database could not be reached. You can still save the card and look it up later.', detail: err.message });
    }
  });

  // Work out which card a photo shows from the text the browser read off it (see public/js/ocr.js).
  app.post('/api/identify', async (req, res) => {
    const texts = (v) => (Array.isArray(v) ? v : []).filter((t) => typeof t === 'string').slice(0, 12).map((t) => t.slice(0, 200));
    const result = await identifyCard(catalog, { names: texts(req.body?.names), lines: texts(req.body?.lines) });
    const owned = store.ownedCounts(result.candidates.map((c) => c.tcgId), req.user.id);
    const withOwned = (c) => c && { ...c, owned: owned[c.tcgId] ?? 0 };
    res.json({ ...result, match: withOwned(result.match), candidates: result.candidates.map(withOwned) });
  });

  // Only catalog-owned image addresses, never a client-supplied download URL.
  app.get('/api/catalog/cards/:id/scan-image', async (req, res) => {
    const details = await catalog.details(req.params.id);
    if (!details) throw new HttpError(404, 'Card not found');
    const urls = [details.official_image_url, ...await catalog.fallbackImages(details).catch(() => [])].filter(Boolean);
    for (const url of urls.slice(0, 3)) {
      try {
        const image = await catalog.download(url);
        if (!/^image\/(png|jpeg|webp)$/.test(image.contentType) || image.buffer.length > 8 * 1024 * 1024) continue;
        res.set('Cache-Control', 'private, max-age=86400').type(image.contentType).send(image.buffer);
        return;
      } catch { /* Try the next catalog source. */ }
    }
    throw new HttpError(404, 'Reference image unavailable');
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
    res.json({ card, market, owned: store.ownedCounts([card.tcg_id], req.user.id)[card.tcg_id] ?? 0 });
  });

  // AI model files the browser runs on this device (server/aiModels.js).
  app.use('/api/ai/models', aiModelsRouter(aiModels ?? new AiModels({ dataDir, log: console.log })));

  // Card dioramas: the list, the jobs the browser makes, the finished pictures.
  app.use('/api/card-effects', cardDioramasRouter(dioramas));

  // The owner's own scanner tests (photos with their cards marked), for npm run bench:scan.
  app.use('/api/scan-labels', scanLabelsRouter({ dataDir, isOwner: (req) => Boolean(req.user && store.getUser(req.user.id)?.is_owner) }));

  // Set completion: your sets, any set to browse, and one set's checklist.
  // ---- PokéBattles: 3D models and battle data from the cards ----

  const models = models3d ?? new Models3D({ dataDir });

  // The user's Pokémon cards for the picker (copies of the same card grouped), from the database only.
  app.get('/api/battles/fighters', (req, res) => {
    const { cards } = store.queryCards({ userId: req.user.id, group: true, pageSize: 500, sort: 'name' });
    res.json({ cards: cards.filter((c) => !c.category || /pok[eé]mon|ポケモン/i.test(c.category)).map(toJson) });
  });

  // One card ready for battle: its attacks, abilities, HP, weakness… and its 3D model forms.
  app.get('/api/battles/cards/:id', async (req, res) => {
    const card = findCard(req.params.id, req);
    const battle = await battleData(catalog, card);
    if (!isPokemonCard(card, battle)) throw new HttpError(400, 'Only Pokémon cards can battle');
    res.json({ card: toJson(card), battle, models: await models.forCard(card, battle.dexIds) });
  });

  // A 3D model file: downloaded once from the Pokémon 3D API (only files its list names), then cached.
  app.get('/api/battles/models/:form/:file', async (req, res) => {
    try {
      const file = await models.file(req.params.form, req.params.file);
      res.set('Cache-Control', 'private, max-age=2592000, immutable');
      res.type('model/gltf-binary').sendFile(file);
    } catch (err) {
      throw Object.assign(new HttpError(err.status ?? 502, err.message), { expose: true }); // expected (offline, bad file): not a bug
    }
  });

  // ---- 3D Pop-out (gallery): which 3D model each card has, and the saved model pictures ----
  // A picture is the model drawn by the browser on a transparent background, one per model file
  // (shared by every card of that Pokémon), kept in data/popout/<form>/<id>.webp|png.

  const popoutDir = path.join(dataDir, 'popout');
  const PICTURE_TYPES = { '.webp': 'image/webp', '.png': 'image/png' };
  const pictureBase = async (form, id) => {
    let idx = null;
    try { idx = await models.index(); } catch { /* list unavailable */ }
    if (!idx || !/^[A-Za-z][\w-]{0,30}$/.test(form) || !/^[\w-]{1,60}$/.test(id) || !idx.byFile.has(`${form}/${id}.glb`)) {
      throw new HttpError(404, 'No such model');
    }
    return path.join(popoutDir, form, id);
  };
  const savedPicture = (base) => Object.keys(PICTURE_TYPES).map((ext) => base + ext).find((f) => fs.existsSync(f)) ?? null;

  app.post('/api/popout/models', async (req, res) => {
    if (!Array.isArray(req.body?.ids)) throw new HttpError(400, '"ids" must be a list of card ids');
    const ids = [...new Set(req.body.ids.map(Number).filter(Number.isInteger))].slice(0, 200);
    const out = {};
    const todo = [];
    for (const id of ids) {
      const card = store.getCard(id, req.user.id);
      if (!card || /trainer|energy|トレーナー|エネルギー/i.test(String(card.category ?? ''))) out[id] = null;
      else todo.push([id, card]);
    }
    const lookup = async ([id, card]) => {
      // By name first (no network); a card whose name doesn't match (Japanese, unusual names) by its Pokédex number.
      let m = await models.forCard(card, []);
      if (!m.available && card.tcg_id) m = await models.forCard(card, (await battleData(catalog, card).catch(() => null))?.dexIds ?? []);
      const entry = m.available && m.forms.find((f) => f.form === m.default);
      const file = entry?.url?.split('/').pop()?.replace(/\.glb$/, '');
      if (!file) { out[id] = null; return; }
      const saved = savedPicture(path.join(popoutDir, entry.form, file));
      out[id] = { form: entry.form, id: file, model: entry.url, picture: `/api/popout/pictures/${entry.form}/${file}`, has: Boolean(saved) };
    };
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(lookup));
    res.json({ models: out });
  });

  app.get('/api/popout/pictures/:form/:id', async (req, res) => {
    const file = savedPicture(await pictureBase(req.params.form, req.params.id));
    if (!file) throw new HttpError(404, 'Not drawn yet');
    res.set('Cache-Control', 'private, max-age=2592000');
    res.type(PICTURE_TYPES[path.extname(file)]).sendFile(file);
  });

  app.put('/api/popout/pictures/:form/:id', express.raw({ type: Object.values(PICTURE_TYPES), limit: '1mb' }), async (req, res) => {
    const base = await pictureBase(req.params.form, req.params.id);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ext = buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' ? '.webp'
      : buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? '.png' : null;
    if (!ext) throw new HttpError(400, 'Send a WebP or PNG picture');
    if (!savedPicture(base)) {
      fs.mkdirSync(path.dirname(base), { recursive: true });
      const tmp = `${base}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, base + ext);
    }
    res.status(204).end();
  });

  app.get('/api/sets', async (req, res) => {
    res.json({ sets: await userSets(catalog, store, req.user.id) });
  });
  app.get('/api/sets/:lang/all', async (req, res) => {
    const lang = req.params.lang === 'ja' ? 'ja' : 'en';
    try {
      res.json({ sets: await allSets(catalog, lang) });
    } catch {
      throw new HttpError(502, 'The online card database could not be reached. Try again later.');
    }
  });
  app.get('/api/sets/:lang/:id', async (req, res) => {
    const lang = req.params.lang === 'ja' ? 'ja' : 'en';
    let checklist;
    try {
      checklist = await setChecklist(catalog, store, req.user.id, lang, req.params.id, { values: req.query.values === '1' });
    } catch {
      throw new HttpError(502, 'The online card database could not be reached. Try again later.');
    }
    if (!checklist) throw new HttpError(404, 'Set not found');
    res.json(checklist);
  });

  // Which printings of a card exist (normal / reverse holo / holo / full art), for the variant suggestion.
  app.get('/api/catalog/cards/:id/printings', async (req, res) => {
    let printings;
    try {
      printings = await catalog.printings(req.params.id);
    } catch {
      throw new HttpError(502, 'The online card database could not be reached. Try again later.');
    }
    if (!printings) throw new HttpError(404, 'Card not found');
    res.json(printings);
  });

  // Cards

  app.get('/api/cards', (req, res) => {
    const filters = { ...req.query, userId: req.user.id, ids: req.query.ids ? String(req.query.ids).split(',') : undefined };
    if (req.query.page === undefined) return res.json({ cards: store.listCards(filters).map(toJson) });
    // A page of the collection (optionally with copies grouped): { cards, total, page, pageSize }.
    const { cards, total } = store.queryCards({ ...filters, group: req.query.group === '1' });
    res.json({ cards: cards.map(toJson), total, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 60 });
  });

  // The chosen cards (or every card) as a CSV file for a spreadsheet.
  app.get('/api/cards/export', (req, res) => {
    const ids = req.query.ids ? String(req.query.ids).split(',') : undefined;
    const rows = store.listCards({ userId: req.user.id, ids, sort: 'set' });
    const cols = ['name', 'set_code', 'set_name', 'number', 'set_total', 'variant', 'language', 'rarity', 'condition', 'grade_company', 'grade',
      'purchase_price', 'market_price', 'market_currency', 'storage_location', 'status', 'pack_name', 'notes', 'created_at', 'tcg_id', ...Object.keys(PRINTING_DEFAULTS)];
    const cell = (v) => {
      const t = v == null ? '' : String(v);
      return /[",\n\r]|^[=+\-@]/.test(t) ? `"${t.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : t;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pokedex-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`\ufeff${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')}\r\n`);
  });

  app.get('/api/cards/:id', (req, res) => {
    const card = findCard(req.params.id, req);
    // Every copy of the same card (official card + printing), for the card page.
    res.json({ ...toJson(card), copies: store.copiesOf(card).map(toJson) });
  });

  // Batch create: multipart with `cards` (JSON array) and one image per card, referenced by `photoField`.
  app.post('/api/cards', upload.any(), async (req, res) => {
    const files = filesByField(req);
    const input = parseList(req.body.cards, 'cards').map((c) => ({ ...cleanCard(c, req.user.id), user_id: req.user.id }));
    const tokens = input.map((c) => c.scan_token).filter(Boolean);
    if (new Set(tokens).size !== tokens.length) throw new HttpError(400, 'Each physical copy needs a distinct scan token');
    const prepared = [];
    for (const card of input) prepared.push(store.scannedCard(req.user.id, card.scan_token) ?? await withOfficial(card));
    const fresh = prepared.filter((card) => !store.scannedCard(req.user.id, card.scan_token));
    const ids = insertWithPhotos(fresh, files, 'cards', (card) => store.scannedCard(req.user.id, card.scan_token)?.id ?? store.insertCard({ ...card, user_id: req.user.id }));
    const freshIds = new Map(fresh.map((card, i) => [card, ids[i]]));
    const created = prepared.map((card) => store.getCard(store.scannedCard(req.user.id, card.scan_token)?.id ?? freshIds.get(card), req.user.id, { trash: true }));
    created.forEach(snapshotPrice);
    created.forEach((c) => tracker.rememberPictureSearch(c));
    // Each new card gets its diorama made in the background (by the browser, for free).
    created.forEach((c) => dioramas.sync(c.id, { create: true }));
    res.status(201).json({ cards: created.map(toJson) });
  });

  app.patch('/api/cards/:id', async (req, res) => {
    const existing = findCard(req.params.id, req);
    if (req.body.scan_token !== undefined) throw new HttpError(400, 'Scan identity cannot be changed');
    let card = cleanCard({ ...existing, ...req.body, user_id: existing.user_id }, req.user.id);
    const relink = req.body.tcg_id !== undefined && req.body.tcg_id !== existing.tcg_id;
    const before = { ...existing, ...cleanNumber(existing), set_code: existing.set_code?.toUpperCase() ?? null };
    const moved = ['set_code', 'number', 'set_total'].some((k) => (card[k] ?? null) !== (before[k] ?? null));
    const repriced = Object.keys(PRINTING_DEFAULTS).some((k) => card[k] !== existing[k]) || moved || (card.variant ?? null) !== (existing.variant ?? null);
    if (relink) {
      card = card.tcg_id ? await withOfficial(card) : { ...card, official_image_url: null, official_image_path: null };
    } else if (moved && existing.tcg_id) {
      // A different set code or number is a different card: find it again rather than keep the old link.
      card = { ...card, tcg_id: null, official_image_url: null, official_image_path: null };
      const tcgId = await findOfficialCard(card);
      card = tcgId ? await withOfficial({ ...card, tcg_id: tcgId }) : await withMarket(card);
    } else if (repriced) {
      card = await withMarket(card);
    }
    store.updateCard(existing.id, card);
    if (relink || repriced) snapshotPrice(store.getCard(existing.id));
    res.json(toJson(store.getCard(existing.id)));
  });

  // Re-fetch the official details/image for a card that is already linked (e.g. it was added offline).
  app.post('/api/cards/:id/refresh-official', async (req, res) => {
    const existing = findCard(req.params.id, req);
    if (!existing.tcg_id) throw new HttpError(400, 'This card is not linked to an online card yet');
    const card = await withOfficial({ ...existing });
    store.updateCard(existing.id, card);
    res.json(toJson(store.getCard(existing.id)));
  });

  // Refresh rarity, pull chance and price for one card, or for the whole collection.
  app.post('/api/cards/refresh-market', async (req, res) => {
    let updated = 0;
    let linked = 0;
    for (const card of store.listCards({ userId: req.user.id })) {
      const next = await refreshCardMarket(card);
      if (next.market_price != null || next.pull_chance != null) updated++;
      if (next.official_image_path && !card.official_image_path) linked++;
    }
    res.json({ updated, linked, stats: store.stats(req.user.id) });
  });

  app.post('/api/cards/:id/refresh-market', async (req, res) => {
    res.json(toJson(await refreshCardMarket(findCard(req.params.id, req))));
  });

  // Price history: every price the app has seen for the card, one per source, line and day.
  app.get('/api/cards/:id/price-history', (req, res) => {
    const card = findCard(req.params.id, req);
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const groups = new Map();
    for (const row of store.priceHistory(card.id, { since })) {
      const key = `${row.source}|${row.label}`;
      if (!groups.has(key)) groups.set(key, { source: row.source, label: row.label, currency: row.currency, points: [] });
      groups.get(key).points.push({ day: row.day, price: row.price });
    }
    const series = [...groups.values()].map((s) => {
      const firstPrice = s.points[0].price;
      const lastPrice = s.points[s.points.length - 1].price;
      const change = firstPrice ? (lastPrice - firstPrice) / firstPrice : 0;
      return { ...s, first: firstPrice, last: lastPrice, change: Math.round(change * 1000) / 1000, direction: s.points.length > 1 ? direction(change) : null };
    });
    res.json({ days, series });
  });

  // PokemonPriceTracker: eBay graded sales, recent history and population, within the daily credit budget.
  app.get('/api/pricetracker/status', (_req, res) => {
    res.json(tracker.status());
  });

  app.get('/api/cards/:id/pricetracker', (req, res) => {
    res.json(tracker.view(findCard(req.params.id, req)));
  });

  // Uses the day-old cache unless `force=1`; refuses to spend past the daily budget.
  app.post('/api/cards/:id/pricetracker/refresh', async (req, res) => {
    res.json(await tracker.refresh(findCard(req.params.id, req), { force: req.query.force === '1' }));
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
    res.json(ebayView(findCard(req.params.id, req), req.query.condition));
  });

  // Fetch the last 90 days of sold listings from eBay's official API (needs EBAY_CLIENT_ID/SECRET).
  app.post('/api/cards/:id/ebay/refresh', async (req, res) => {
    const card = findCard(req.params.id, req);
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
    const card = findCard(req.params.id, req);
    const listings = Array.isArray(req.body?.listings) ? req.body.listings.slice(0, 1000) : null;
    if (!listings) throw new HttpError(400, 'Send the listings as { listings: [...] }');
    const { matching, skipped } = cleanSales(card, listings);
    const added = store.addSales(card.id, matching, 'pasted');
    res.json({ added, skipped, ...ebayView(card, req.query.condition) });
  });

  app.delete('/api/cards/:id/ebay/:saleId', (req, res) => {
    const card = findCard(req.params.id, req);
    if (!store.deleteSale(card.id, Number(req.params.saleId))) throw new HttpError(404, 'Listing not found');
    res.json(ebayView(card, req.query.condition));
  });

  app.post('/api/cards/:id/photo', upload.single('photo'), (req, res) => {
    const existing = findCard(req.params.id, req);
    if (!req.file) throw new HttpError(400, 'Attach an image as "photo"');
    const photo_path = saveUpload(req.file, 'cards');
    store.updateCard(existing.id, { photo_path });
    removeFile(existing.photo_path);
    res.json(toJson(store.getCard(existing.id)));
  });

  // Deleting moves a card to the trash (restorable for 30 days); ?permanent=1 removes it for good.
  app.delete('/api/cards/:id', (req, res) => {
    const existing = store.getCard(Number(req.params.id), req.user.id, { trash: true });
    if (!existing) throw new HttpError(404, 'Card not found');
    if (req.query.permanent === '1') {
      store.deleteCard(existing.id);
      removeFile(existing.photo_path);
      sweepGrading();
    } else {
      store.trashCards([existing.id], req.user.id);
    }
    res.status(204).end();
  });

  // Before saving new cards: how many of each the user already has (same official card and printing).
  app.post('/api/cards/duplicates', (req, res) => {
    const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 500) : [];
    const owned = store.ownedByKey(req.user.id, cards.map((c) => ({ ...c, stamp: normalizeStamp(c.stamp ?? 'none') ?? 'none', ...cleanNumber(c), set_code: c.set_code ? String(c.set_code).toUpperCase() : null })));
    res.json({ owned });
  });

  // One change for many cards: pack, condition, storage place, keep/trade/sell, grading; or trash / restore.
  app.post('/api/cards/bulk', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 5000) : [];
    if (!ids.length) throw new HttpError(400, 'Choose some cards first');
    const action = req.body.action;
    if (action === 'trash' || action === 'restore') {
      const changed = store.trashCards(ids, req.user.id, action === 'restore');
      return res.json({ changed, stats: store.stats(req.user.id) });
    }
    if (action !== 'set') throw new HttpError(400, 'Unknown bulk action');
    const allowed = ['pack_id', 'condition', 'storage_location', 'status', 'grade_company', 'grade', 'purchase_price', 'variant'];
    const fields = Object.fromEntries(Object.entries(req.body.set ?? {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to change');
    const clean = cleanCard({ name: 'x', ...fields }, req.user.id);
    const changes = Object.fromEntries(Object.keys(fields).map((k) => [k, clean[k] ?? null]));
    res.json({ changed: store.updateCards(ids, req.user.id, changes), stats: store.stats(req.user.id) });
  });


  // Packs / tins / kits / bundles

  app.get('/api/packs', (req, res) => {
    res.json({ packs: store.listPacks({ ...req.query, userId: req.user.id }).map(packJson) });
  });

  app.get('/api/packs/:id', (req, res) => {
    res.json(packJson(findPack(req.params.id, req)));
  });

  app.post('/api/packs', upload.any(), (req, res) => {
    const files = filesByField(req);
    const input = parseList(req.body.packs, 'packs').map(cleanPack);
    const ids = insertWithPhotos(input, files, 'packs', (pack) => store.insertPack({ ...pack, user_id: req.user.id }));
    res.status(201).json({ packs: ids.map((id) => packJson(store.getPack(id))) });
  });

  app.patch('/api/packs/:id', (req, res) => {
    const existing = findPack(req.params.id, req);
    store.updatePack(existing.id, cleanPack({ ...existing, ...req.body, user_id: existing.user_id }));
    res.json(packJson(store.getPack(existing.id)));
  });

  app.post('/api/packs/:id/photo', upload.single('photo'), (req, res) => {
    const existing = findPack(req.params.id, req);
    if (!req.file) throw new HttpError(400, 'Attach an image as "photo"');
    store.updatePack(existing.id, { photo_path: saveUpload(req.file, 'packs') });
    removeFile(existing.photo_path);
    res.json(packJson(store.getPack(existing.id)));
  });

  // Deleting a pack keeps its cards (they become "no pack") unless ?withCards=1.
  app.delete('/api/packs/:id', (req, res) => {
    const existing = findPack(req.params.id, req);
    const cards = req.query.withCards === '1' ? store.listCards({ packId: existing.id, userId: req.user.id }) : [];
    store.transaction(() => {
      for (const c of cards) store.deleteCard(c.id);
      store.deletePack(existing.id);
    });
    for (const c of cards) removeFile(c.photo_path);
    removeFile(existing.photo_path);
    if (cards.length) sweepGrading();
    res.status(204).end();
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err instanceof multer.MulterError ? 400 : 500);
    if (status >= 500 && !err.expose) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.expose ? 'Something went wrong on the server' : err.message });
  });

  app.locals.store = store;
  app.locals.dioramas = dioramas;
  app.locals.tracker = tracker;
  app.locals.refreshCardMarket = refreshCardMarket;
  return app;
}
