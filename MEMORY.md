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
- `npm test`: unit/API tests (node:test). `npm run test:e2e`: Playwright browser walkthrough (`SCREENSHOTS=1`
  refreshes `docs/screenshots/`). `npm run bench:scan`: scanner accuracy. All use local mocks; CI runs them on PRs.
- **Desktop app (Windows):** `desktop/install.ps1` builds `Pokedex.exe` (`desktop/Pokedex.cs`, csc.exe) into
  `%LOCALAPPDATA%\Pokedex`; it runs `launcher.mjs` (self-updating): newest commit via `<repo>.git/info/refs`, codeload
  zip, swap `LLMModel-main` (keeps `.previous`, moves `data/` and the grading setup, reuses `node_modules` if the lock
  is unchanged, rolls back if the server won't start), server over IPC (`/api/desktop`), Edge `--app` window.
- Old start: `Start Pokedex.cmd` (CRLF) runs `npm start -- --open`.
- `npm run check:live`: checks every real source. Data lives in `DATA_DIR` (default `./data`): back it up.

## Architecture (where to look)
- `server/app.js`: Express 5 routes; `createApp({dataDir, catalog, ebay, priceTracker, requireLogin})` (tests pass
  `requireLogin: false` → a built-in local user). `server/auth.js`: scrypt passwords, HttpOnly session cookie
  (sha256 in `sessions`), 5 fails/10 min throttle. First profile = owner (claims old `user_id IS NULL` rows,
  manages profiles). Public: `/api/meta`, `/api/desktop`, `/api/auth/*`.
- `server/db.js`: SQLite schema + `MIGRATIONS` (run by `migrations.js`; 2 = scanner printing columns).
  **One row per physical copy** (condition, grade,
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
  `vision.js` → `vision/` (card finder: strategies, snap, sleeves, quality; in `workers/vision.worker.js`),
  `ocr.js` (Tesseract.js), `foilAsync.js` (foil maths in a Worker), `ebay.js`, `history.js`.
  OpenCV, Tesseract and heic2any are served from node_modules at `/vendor/*`, not a CDN.
- Tests: `tests/*.test.js`, mocks in `tests/helpers/mock-sources.js`, real dataset fixtures in
  `tests/fixtures/ptcg`, e2e in `tests/e2e/run.js` using the photos in `docs/reference/`.

## Decisions that must hold
- **Free sources only.** No scraping of eBay or other sites (against their terms). eBay sold data
  comes from the official Insights API (needs eBay approval) or from the user copying and pasting
  eBay's own sold search.
- **Photos stay in the browser** for detection and OCR; the server gets cropped cards and text. Owner-approved
  exception: Profile → Scanner tests saves a photo to `data/scan-bench/` on Save (`server/scanLabels.js`).
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
- tcgcsv.com answered **401** to the owner's PC (2026-10-30): the client sends `USER_AGENT` (`server/prices.js`).
  Promo pictures also fall back to guessed dataset image URLs (`images.scrydex.com/pokemon/mep-59/large`),
  then (with a key) PokemonPriceTracker: its picture links / TCGplayer product id → TCGplayer CDN image
  (`tracker.pictureUrls`, one search per card, budget-checked). Froakie MEP 060 = TCGplayer 709974.
- Updater data safety: backup to `<app>.backups/` before each swap; a failed `data/` move undoes the swap; a
  `data/` left in `.previous` goes to `<app>.rescued-data-*`, never deleted. Keep these properties.
- Mutating `/api` requests from other sites are refused (Origin/Sec-Fetch-Site check in `server/app.js`).
- `node:sqlite` warns as experimental; npm scripts pass `--disable-warning=ExperimentalWarning`.
- PokemonPriceTracker docs show inconsistent layouts; `normalizeCard` deep-searches (unverified live).
- The cloud sandbox reaches only GitHub and npm: the owner checks live sources with `npm run check:live`.
- PRs target `main` (CodeRabbit skips PRs to other branches).

## Current state (2026-11-12)
- `main` has PRs #1–#19 (M0: migrations, `workers/rpc.js`, AI runtime, `bench:scan`, CI). **Plan: `docs/ROADMAP.md`.**
  M1 = PR #17 (detection 46% → 93%). M2 = PR #18: TCGdex rarity counts, reading 72% → 81%, scanner tests. #19: dioramas.
- Not verified live: eBay Insights API (needs approval), PokemonPriceTracker (needs the owner's key).

## Open items / ideas
- Japanese cards: `TcgClient({ lang: 'ja' })`, ids `ja:SV2a-100`; no pull chance, no dataset/tcgcsv/PPT fallbacks.
- **Scan deck** (`#/scan`, `scanner.js`, `scan/`): perceptual-hash picture check (not ONNX), manual review before
  save, `scan_token` per copy; printing columns skip prices. HTTPS: `POKEDEX_TLS_KEY`/`_CERT`, `HTTPS_PORT`.
  Real-deck and iPhone accuracy unvalidated.
- Variant suggestion (`server/printings.js`, `public/js/foil.js`): never auto-applied unless certain. Tilt
  thresholds are synthetic-tested only: tune with real tilt photos.
- Set rarities are English-only (dataset, else TCGdex filters); missing value costs a price lookup per card.
- **PokéBattles:** `server/battle.js` (attacks/abilities/weakness/dexId from the cached raw card),
  `server/models3d.js` (Pokémon 3D API list + .glb proxy/cache in data/models3d; only listed files), `public/js/battle/`
  (engine = rules, pure + seeded; scene = stage + summon; world = owner's Hi-Fi v4 look, High/Standard/Basic).
  Models are Nintendo IP (fan project): never commit them.
- **3D Pop-out** (gallery): `pokemon-popout.js` (owner's package, 4 prepared scenes) + `popoutRender.js` (model
  drawn once per form/id, kept in data/popout via `/api/popout/*`, over the CSS-tilted card). A copy's **diorama**
  wins: `server/cardDioramas.js` (27 delivered in `assets/card-effects`, imported only for the same id + name/card id;
  new cards get a free in-browser one, `dioramaMaker.js`, made once per identity). No paid image API (owner's choice).
- **Pre-grading (experimental):** `server/grading/` (`card_grading_reports`, photos in `data/uploads/grading/`)
  → optional Python `services/grading/app.py` (127.0.0.1:8765, MIT Viridian in gitignored `third_party/viridian`,
  pinned by `scripts/grading-setup.*`); `gradingReport.js` shows it. Label every result "Experimental CV estimate —
  not professional grading."; no probabilities, accuracy claims or "worth grading" advice. Back centering needs
  `third_party/viridian/data/refs/card_back.jpg` (not shipped). The launcher starts it if set up.
- Open gaps: the table in `docs/ROADMAP.md`. Users read `docs/USER_GUIDE.md`.
- Have the owner run `npm run check:live` and set `POKEMONPRICETRACKER_API_KEY`; fix parser gaps from real answers.
- Pull-rate tables cover the Scarlet & Violet and Mega Evolution eras only. Older eras show no estimate.
- Forgotten owner password: no reset flow yet (delete the `users`/`sessions` rows to rerun setup).

## Conventions
- Plain, friendly UI text. The README is written for a non-developer.
- Match the surrounding code style: ES modules, small pure helpers, comments explain *why*.
- Add or extend tests with every change. Update the e2e and screenshots when the UI changes.
- After a change: update this file (replace, don't append), add a line to `docs/HISTORY.md`, and
  update `docs/SOURCES.md` if a source or API changed.
