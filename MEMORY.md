# Project memory — handoff notes for the next agent

> **Read this first.** It's the short, current state of the project so any agent or model can
> pick up the work. Plain Markdown, no tool-specific syntax.
>
> **Size rules (enforced by `tests/memory.test.js`): at most 150 lines and 10 KB.**
> - Keep it *current*, not chronological: edit or replace lines, don't append a log.
> - When something is finished or no longer true, delete it here. If it's worth keeping, add one
>   line to [`docs/HISTORY.md`](docs/HISTORY.md) (the full history) instead.
> - Sources and APIs live in [`docs/SOURCES.md`](docs/SOURCES.md); user docs in [`README.md`](README.md).
>   Link to them rather than copying.

## What this is
A personal Pokédex: a local web app for cataloguing your own Pokémon TCG cards and the packs, tins
and bundles they came from. It reads cards from photos, shows the official image, and adds rarity,
pull chance, market price, eBay sold prices and a daily price history. The owner (GitHub `ksotox`)
runs it on Windows with PowerShell and is not a developer. Give them copy-paste steps.

## Run / test
- Node **≥ 22.5** (uses built-in `node:sqlite`). `npm install`, `npm start` → http://localhost:3000.
- `npm test`: unit/API tests (node:test). `npm run test:e2e`: Playwright browser walkthrough.
  `SCREENSHOTS=1` refreshes `docs/screenshots/`. Both use local mocks, so no network is needed.
- **Desktop app (Windows):** `desktop/install.ps1` builds `Pokedex.exe` (`desktop/Pokedex.cs`, csc.exe) into
  `%LOCALAPPDATA%\Pokedex`; it runs `launcher.mjs` (self-updating): newest commit via `<repo>.git/info/refs`, codeload
  zip, swap `LLMModel-main` (keeps `.previous`, moves `data/` and the grading setup, reuses `node_modules` if the lock
  is unchanged, rolls back if the server won't start), server over IPC (`/api/desktop`), Edge `--app` window.
- Older one-click start: `Start Pokedex.cmd` (CRLF, kept by `.gitattributes`) runs `npm start -- --open`.
- `npm run check:live`: checks every real source. Data lives in `DATA_DIR` (default `./data`): back it up.

## Architecture (where to look)
- `server/app.js`: Express 5 routes; `createApp({dataDir, catalog, ebay, priceTracker, requireLogin})` (tests pass
  `requireLogin: false` → a built-in local user). `server/auth.js`: scrypt passwords, HttpOnly session cookie
  (sha256 in `sessions`), 5 failures/10 min throttle. First profile = owner (claims old `user_id IS NULL` rows,
  manages profiles). Public: `/api/meta`, `/api/desktop` (old launchers poll them), `/api/auth/*`.
- `server/db.js`: SQLite schema + migrations (`CARD_MIGRATIONS`). Tables: users, sessions, packs, cards,
  ebay_sales, price_history, pricetracker_cache, api_usage. **One row per physical copy** (condition, grade,
  purchase_price, storage_location, status keep/trade/sell, deleted_at = trash, purged after 30 days);
  copies group by `keyOf()` = tcg_id (or name|set|number) + variant. `queryCards` pages/groups, `#cardFilters`
  ANDs every filter. `server/sets.js`: set checklists (TCGdex set cards, rarities from the dataset).
- `server/catalog.js`: combines sources. TCGdex (`tcg.js`) first, then the PokemonTCG dataset
  (`ptcgData.js`, ids prefixed `ptcg:`), with prices from `prices.js` (TCGdex → tcgcsv backup).
- `identify.js` + `setCodes.js`: OCR readings → card. `pullRates.js`: pull chance. `ebay.js` + `soldStats.js`: sold
  prices/trends. `priceTracker.js` + `priceTrackerService.js` (credit budget) + `scheduler.js` (hourly snapshots).
- `public/js/`: vanilla ES modules, no build step, hash routing. `views.js` (collection: Compact/Detailed/Table,
  density, filters + presets, select + bulk bar, trash; card page with copies), `add.js` (read statuses,
  progress, retry incl. 180°, duplicate Yes/No), `sets.js`, `account.js` (sign-in, profile, theme),
  `vision.js` (OpenCV.js), `ocr.js` (Tesseract.js), `foilAsync.js` (foil maths in a Worker), `ebay.js`, `history.js`.
  OpenCV, Tesseract and heic2any are served from node_modules at `/vendor/*`, not a CDN.
- Tests: `tests/*.test.js`, mocks in `tests/helpers/mock-sources.js`, real dataset fixtures in
  `tests/fixtures/ptcg`, e2e in `tests/e2e/run.js` using the photos in `docs/reference/`.

## Decisions that must hold
- **Free sources only.** No scraping of eBay or other sites (against their terms). eBay sold data
  comes from the official Insights API (needs eBay approval) or from the user copying and pasting
  eBay's own sold search.
- **Photos stay in the browser** for detection and OCR. The server only gets the cropped card and text readings.
- **Never overwrite what the user typed** with automatic readings. Auto-match only when the name agrees.
- **Pull chance and prices are estimates.** Say so in the UI.
- **Prices are shown in USD only** (owner's choice): TCGplayer via TCGdex → tcgcsv → Cardmarket EUR converted
  (`server/fx.js`). Images: TCGdex → dataset → TCGplayer product image via tcgcsv (`fallbackImages`).
- **Unlinked cards are linked automatically** by `refreshCardMarket` (Update prices, opening a card,
  hourly job) via `identifyCard`, only at `confidence === 'high'`. A linked card missing its image is retried too.
- **PokemonPriceTracker budget:** ≤ `POKEMONPRICETRACKER_DAILY_CREDITS` (100) a day; about 3 credits
  per card. 24h cache, a 30% reserve kept back from background use, 1-day backoff after errors. Don't
  add calls that bypass `PriceTrackerService`.
- Trend colours: green `#16a34a` up, red `#dc2626` down, yellow `#eab308` within ±2%.

## Gotchas
- OpenCV.js 4.12 module is a *thenable*: wrap it as `{cv}` before resolving, or `await` hangs.
  Free every `cv.Mat` after use (an earlier `approx.rows` use-after-free crashed).
- tcgcsv.com answered **401** to the owner's PC (2026-10-30). The client now sends a descriptive
  User-Agent (`USER_AGENT` in `server/prices.js`); `npm run check:live` prints its access results.
  Promo pictures also fall back to guessed dataset image URLs (`images.scrydex.com/pokemon/mep-59/large`),
  then (with a key) PokemonPriceTracker: its picture links / TCGplayer product id → TCGplayer CDN image
  (`tracker.pictureUrls`, one search per card, budget-checked). Froakie MEP 060 = TCGplayer 709974.
- Updater data safety: backup to `<app>.backups/` before each swap; a failed `data/` move undoes the swap; a
  `data/` left in `.previous` goes to `<app>.rescued-data-*`, never deleted. Keep these properties.
- Mutating `/api` requests from other sites are refused (Origin/Sec-Fetch-Site check in `server/app.js`).
- `node:sqlite` prints an ExperimentalWarning; npm scripts pass `--disable-warning=ExperimentalWarning`.
- PokemonPriceTracker docs show inconsistent response layouts. `normalizeCard` deep-searches for
  history and sales. Not yet verified against the live API.
- The cloud sandbox used so far could only reach GitHub and npm. TCGdex, eBay, PokemonPriceTracker and
  tcgcsv were blocked, so live behaviour is verified by the owner running `npm run check:live`.
- PRs target `main` (the default branch was once a `claude/...` branch, which made CodeRabbit skip PRs).

## Current state (2026-11-02)
- `main` holds PRs #1–#11. Branch (PR #12): pre-grade report + slab, then PokéBattles. 175 unit + 9 Python tests + e2e pass.
- Not verified live: eBay Insights API (needs approval), PokemonPriceTracker (needs the owner's key).

## Open items / ideas
- Japanese cards: `TcgClient({ lang: 'ja' })`, ids `ja:SV2a-100`; no pull chance, no dataset/tcgcsv/PPT fallbacks.
- Variant suggestion (`server/printings.js`, `public/js/foil.js`): never auto-applied unless certain. Tilt
  thresholds are synthetic-tested only: tune with real tilt photos.
- Set rarities (IR filter, reverse-holo goal) are English-only; missing value costs one price lookup per card.
- **PokéBattles:** `server/battle.js` (attacks/abilities/weakness/dexId re-read from cached raw TCGdex/dataset card),
  `server/models3d.js` (Pokémon 3D API list + .glb proxy/cache in data/models3d; only listed files), `public/js/battle/`
  (engine = original simple rules, pure + seeded; scene = three.js stage, summon-from-card intro, FlatStage fallback).
  Models are Nintendo IP from a fan project: never commit them.
- **Pre-grading (experimental):** `server/grading/` (Express router, `card_grading_reports` table, photos in
  `data/uploads/grading/<uuid>/`, orphan sweep after any card delete) → optional Python FastAPI
  `services/grading/app.py` on 127.0.0.1:8765 using MIT Viridian (`third_party/viridian`, gitignored, pinned in
  `scripts/grading-setup.*`). `precision.py`: flattened sides, corner/edge close-ups + masks matching upstream's
  regions, surface map, findings; `gradingReport.js`: slab (flip/tilt/PNG), breakdown, scan. Label every result "Experimental CV estimate — not professional grading.";
  no probabilities, accuracy claims or "worth grading" advice. No trained model; back centering needs
  `third_party/viridian/data/refs/card_back.jpg` (not shipped). Launcher starts it if set up, keeps it across updates.
- **See `docs/CODE_REVIEW.md`** for the prioritised list (bugs B1–B6 now fixed, desktop D1–D3, perf P1–P3, security S1–S2,
  data-source risks R1–R3, tech debt T1–T9). Biggest: R1 dataset is legacy (pull-chance rarity counts depend on it),
  T1 no CI, S1 (now: sign-in added; still listens on all interfaces), P1 sequential lookups. Users read `docs/USER_GUIDE.md`.
- Have the owner run `npm run check:live` and set `POKEMONPRICETRACKER_API_KEY`. Fix any parser gaps
  using their real responses.
- Pull-rate tables cover the Scarlet & Violet and Mega Evolution eras only. Older eras show no estimate.
- Forgotten owner password: no reset flow yet (delete the `users`/`sessions` rows to rerun setup).

## Conventions
- Plain, friendly UI text. The README is written for a non-developer.
- Match the surrounding code style: ES modules, small pure helpers, comments explain *why*.
- Add or extend tests with every change. Update the e2e and screenshots when the UI changes.
- After a change: update this file (replace, don't append), add a line to `docs/HISTORY.md`, and
  update `docs/SOURCES.md` if a source or API changed.
