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
- Windows one-click start: `Start Pokedex.cmd` (CRLF, kept by `.gitattributes`). It installs on first
  run and runs `npm start -- --open`. `--open` opens the browser; if the app is already running, it
  just reopens the browser. The desktop shortcut and the user-level env var for the key are set up
  by a PowerShell snippet in the README. Icon: `public/pokedex.ico`.
- `npm run check:live`: looks up the 3 reference cards in every real source (run on a networked machine).
- Data lives in `DATA_DIR` (default `./data`): `collection.db` plus image folders. Back it up to keep the collection.

## Architecture (where to look)
- `server/app.js`: Express 5 routes; `createApp({dataDir, catalog, ebay, priceTracker})` for DI in tests.
- `server/db.js`: SQLite schema + migrations (`CARD_MIGRATIONS`). Tables: packs, cards, ebay_sales,
  price_history, pricetracker_cache, api_usage.
- `server/catalog.js`: combines sources. TCGdex (`tcg.js`) first, then the PokemonTCG dataset
  (`ptcgData.js`, ids prefixed `ptcg:`), with prices from `prices.js` (TCGdex → tcgcsv backup).
- `server/identify.js` + `setCodes.js`: turn OCR readings into a card (voting, misread fixes, name check).
- `server/pullRates.js`: per-pack rarity rate ÷ count of that rarity in the set.
- `server/ebay.js` + `soldStats.js`: Marketplace Insights client, sold stats, weekly/monthly trend.
- `server/priceTracker.js` (client, tolerant parser) + `priceTrackerService.js` (credit budget, cache)
  + `scheduler.js` (hourly: daily price snapshot, then tracker top-ups).
- `public/js/`: vanilla ES modules, no build step, hash routing. `vision.js` (OpenCV.js card finding
  and warp), `ocr.js` (Tesseract.js), `ebay.js` (panel + `trendChart`), `history.js` (price history).
  OpenCV and Tesseract are served from node_modules at `/vendor/*`, not a CDN.
- Tests: `tests/*.test.js`, mocks in `tests/helpers/mock-sources.js`, real dataset fixtures in
  `tests/fixtures/ptcg`, e2e in `tests/e2e/run.js` using the photos in `docs/reference/`.

## Decisions that must hold
- **Free sources only.** No scraping of eBay or other sites (against their terms). eBay sold data
  comes from the official Insights API (needs eBay approval) or from the user copying and pasting
  eBay's own sold search.
- **Photos stay in the browser** for detection and OCR. The server only gets the cropped card and text readings.
- **Never overwrite what the user typed** with automatic readings. Auto-match only when the name agrees.
- **Pull chance and prices are estimates.** Say so in the UI.
- **PokemonPriceTracker budget:** ≤ `POKEMONPRICETRACKER_DAILY_CREDITS` (100) a day; about 3 credits
  per card. 24h cache, a 30% reserve kept back from background use, 1-day backoff after errors. Don't
  add calls that bypass `PriceTrackerService`.
- Trend colours: green `#16a34a` up, red `#dc2626` down, yellow `#eab308` within ±2%.

## Gotchas
- OpenCV.js 4.12 module is a *thenable*: wrap it as `{cv}` before resolving, or `await` hangs.
  Free every `cv.Mat` after use (an earlier `approx.rows` use-after-free crashed).
- `node:sqlite` prints an ExperimentalWarning; npm scripts pass `--disable-warning=ExperimentalWarning`.
- PokemonPriceTracker docs show inconsistent response layouts. `normalizeCard` deep-searches for
  history and sales. Not yet verified against the live API.
- The cloud sandbox used so far could only reach GitHub and npm. TCGdex, eBay, PokemonPriceTracker and
  tcgcsv were blocked, so live behaviour is verified by the owner running `npm run check:live`.
- The GitHub repo's default branch was a `claude/...` branch instead of `main`, which made CodeRabbit
  skip PRs. PRs target `main`.

## Current state (2026-10-30)
- `main` holds everything through PR #4 (photo reading/cropping, eBay sold prices, price history +
  PokemonPriceTracker). 81 unit tests + e2e pass.
- Not verified live: eBay Insights API (needs approval), PokemonPriceTracker (needs the owner's key).

## Open items / ideas
- Have the owner run `npm run check:live` and set `POKEMONPRICETRACKER_API_KEY`. Fix any parser gaps
  using their real responses.
- Pull-rate tables cover the Scarlet & Violet and Mega Evolution eras only. Older eras show no estimate.
- No auth: the app is meant for a home network only.

## Conventions
- Plain, friendly UI text. The README is written for a non-developer.
- Match the surrounding code style: ES modules, small pure helpers, comments explain *why*.
- Add or extend tests with every change. Update the e2e and screenshots when the UI changes.
- After a change: update this file (replace, don't append), add a line to `docs/HISTORY.md`, and
  update `docs/SOURCES.md` if a source or API changed.
