# Code review: bugs, improvements and tech debt

A review of the whole codebase as of 2026-11-01 (after PR #8). Severity: **Critical** (can lose data), **High**, **Medium** or **Low**. The four most serious problems are fixed in the same PR as this document, with tests. The rest are listed by priority with a suggested fix.

## Fixed in this PR

| # | Severity | Problem | Fix |
| --- | --- | --- | --- |
| F1 | **Critical** | **The desktop updater could lose the collection.** It swaps the code folders, *then* moves `data/` across. If that move failed (e.g. Windows Defender briefly locking `collection.db`), the app started with an empty collection while the cards sat in `LLMModel-main.previous`, which the **next update deleted**. | The move is retried for a few seconds. If it still fails, the swap is undone and the current version keeps running with its data. A `data/` folder found in `.previous` is moved to `LLMModel-main.rescued-data-<time>` instead of being deleted. Every update first copies `collection.db` (and its `-wal`/`-shm` files) to `LLMModel-main.backups/`, keeping the last 10 (`desktop/launcher.mjs`). |
| F2 | **High** | **PokemonPriceTracker credits drained by picture searches.** For a card with no picture anywhere, `pictureUrls` searched again on every price update (up to 13 credits each, daily per card via the hourly job, and on every card open). It also used the share reserved for cards you open yourself. A handful of such cards could use up the whole day's 100 credits. | A search is remembered for 7 days: in memory by card identity, then in the new `pricetracker_cache.picture_checked_at` column once the card is saved. A search skipped for lack of credits isn't counted. Picture searches never use the viewing reserve (`server/priceTrackerService.js`, `server/db.js`). |
| F3 | Medium | **Other websites could change the collection.** Form posts are "simple" cross-site requests, so any page you visited could add cards, start **Update prices** (spending credits), force PokemonPriceTracker refreshes or restart the desktop app. Combined with the next problem, it could also plant a `javascript:` link: the server accepted any `official_image_url`, and the card page linked to it, so clicking the picture ran the other site's code inside the app. | Requests other than GET/HEAD to `/api` are refused when the browser marks them as coming from another site (`Origin` host ≠ `Host`, or `Sec-Fetch-Site: cross-site`). Tools without a browser (no `Origin`) still work. `official_image_url` must be `http(s)://`, and the page only links to the app's own files or web addresses (`server/app.js`, `public/js/views.js`). |
| F4 | Low | **The hourly job skipped unmatched cards with no set code** (e.g. "Roxie's Performance 081/086"), so they were only matched when opened or on **Update prices**. | `cardsNeedingSnapshot` includes cards with a name and number (`server/db.js`). |

Tests were added for each fix. The credit-drain test was confirmed to fail without the fix: `npm test` has 102 tests, all passing, and `npm run test:e2e` passes.

## Fixed in the follow-up (bugs B1–B6, P3)

| # | Fix |
| --- | --- |
| B1 | `refreshCardMarket` shares one lookup per card while it runs (the hourly job, Update prices and opening a card no longer double up). Test: two simultaneous updates make one lookup. |
| B2 | Changing a linked card's set code or number re-matches it (`findOfficialCard`) instead of keeping the old link. Older saves with a `/000` total aren't treated as changed. |
| B3 | A HEIC photo the browser can't open gets an explanation and how to fix it on the iPhone. |
| B4 | "Set & number" sorts by prefix, then digits (`9, 10, TG05, TG12`). |
| B5 | Official images use the right extension for every image type, and the "already saved" check knows them all. |
| B6 | `with_official` counts saved pictures. |
| P3 | Index on `cards.tcg_id`. |

## Open findings

### Bugs

| # | Severity | Problem | Suggested fix |
| --- | --- | --- | --- |
| B1 | ~~Medium~~ fixed | **Overlapping refreshes.** The hourly job, **Update prices** and opening a card can all run `refreshCardMarket` on the same card at once. That means duplicate network calls, possibly duplicate PokemonPriceTracker searches, and the last write wins. | Give `refreshCardMarket` the same per-card "in flight" sharing that `PriceTrackerService.refresh` already has, and let **Update prices** skip cards already checked in the last hour. |
| B2 | ~~Low~~ fixed | **Editing the set code or number of a linked card keeps the old link.** `PATCH /api/cards/:id` re-prices, but `tcg_id`, the official picture and the details still point at the old card. | When `set_code`/`number` change on a linked card, unlink it and run `findOfficialCard` again (or ask the user). |
| B3 | ~~Low~~ fixed | **HEIC photos** (iPhone files copied to a PC) are accepted by the server, but Chrome/Edge on Windows can't decode them, so cutting out the card fails. | Say so in the error message. Or convert on the server, which would need an image library (e.g. `sharp`, a native dependency). |
| B4 | ~~Low~~ fixed | **"Set & number" sort** casts numbers to integers, so `TG05`, `GG12` and `SV001` sort as 0. | Sort by the leading letters, then the digits. |
| B5 | ~~Low~~ fixed | **Official images download with a fixed extension list.** A GIF is saved as `.png`, and the "already downloaded" check only looks for `.png`/`.jpg`/`.webp`. | Map every image type, and check by base name. |
| B6 | ~~Low~~ fixed | `stats.with_official` counts cards with an official *URL*, not a saved picture. It isn't shown anywhere. | Count `official_image_path`, or remove it. |

### Desktop app

| # | Severity | Problem | Suggested fix |
| --- | --- | --- | --- |
| D1 | Medium | **Auto-update trusts `main` completely.** Whatever is merged runs on the PC at the next start, so anyone who can push to `main` (or a compromised GitHub account) can run code there. | Turn on branch protection for `main` and 2-factor sign-in. Optionally update only from tagged releases, and show the change before installing. |
| D2 | Low | **Without Edge or Chrome** the app opens in the default browser, and the server keeps running with no window to close it. Task Manager is the only way to stop it. | A tray icon, or a small "Stop" page. |
| D3 | Low | **`install.ps1` and `Pokedex.exe` were never run on real Windows** (there's no Windows in the build environment). The launcher itself was tested end to end on Linux against the real GitHub and npm. | The first real install is the test. Watch `launcher.log`. A GitHub Actions `windows-latest` job could run the installer. |

### Performance

| # | Severity | Problem | Suggested fix |
| --- | --- | --- | --- |
| P1 | Medium | **Everything is one card at a time.** Saving 10 cards looks each one up in turn, and **Update prices** walks the whole collection in one request with no progress shown. With a few hundred cards that's minutes of waiting. | Do lookups 4 at a time, and run **Update prices** as a background job the page can follow ("Updating 37 of 212…"). |
| P2 | Low | **In-memory caches never shrink.** TCGdex, tcgcsv (several MB of products per set) and exchange-rate caches only expire entries when they're read again. | Cap them (small LRU) or sweep expired entries. |
| P3 | ~~Low~~ fixed | **No index on `cards.tcg_id`**, which is used to show "Owned ×N" on search results. | `CREATE INDEX idx_cards_tcg ON cards(tcg_id)`. |

### Security

| # | Severity | Problem | Suggested fix |
| --- | --- | --- | --- |
| S1 | Medium | **No password, and the server listens on every network interface.** Anyone on the same network (home Wi-Fi guests, a café if run on a laptop) can open, change or delete the collection. | Listen on `localhost` by default, and offer "Allow my phone" with a PIN. |
| S2 | Low | The server downloads any `http(s)` address it's sent as an official picture, which could be used to probe the local network. | Accept only known image hosts (TCGdex, pokemontcg.io, Scrydex, TCGplayer CDN). |

### Data sources (risks)

| # | Severity | Problem | Suggested fix |
| --- | --- | --- | --- |
| R1 | High | **The Pokémon TCG dataset is now "legacy".** Its API shuts down on 2027-03-01, and the GitHub data may stop being updated. It's the second card source, the fallback picture source, and the **only source of rarity counts behind pull chances**, so new sets would lose pull chances. | Compute rarity counts from TCGdex instead (its card data has rarity), or from Scrydex, the dataset's successor. |
| R2 | Medium | **Several integrations are written to documentation but unverified live:** <br>• PokemonPriceTracker response layout (parsed defensively); <br>• tcgcsv.com (answered 401; the User-Agent fix is unconfirmed); <br>• TCGplayer CDN picture sizes; <br>• the guessed Scrydex addresses; <br>• eBay's Marketplace Insights API. | Run `npm run check:live` on the PC after each related change. It reports each one. |
| R3 | Medium | **Hand-kept tables need updating for every new set:** `SET_CODES` (printed code → TCGdex id + TCGplayer group) and the pull-rate studies. A new set code is only found through its printed total until it's added. | Generate `SET_CODES` from TCGdex's data files, which list the abbreviation and TCGplayer id for each set. |

### Tech debt

| # | Problem | Suggested fix |
| --- | --- | --- |
| T1 | **No CI.** The "checks passed" on every PR was vacuous: nothing runs the tests on GitHub. | Add a GitHub Actions workflow running `npm test` and `npm run test:e2e` on pull requests. |
| T2 | No linter or formatter. | ESLint (flat config) and Prettier, run in CI. |
| T3 | `server/app.js` (~600 lines) holds every route. | Split into routers: cards, packs, eBay, PokemonPriceTracker, desktop. |
| T4 | **Card-number matching is written five times:** `identify.js`, tcgcsv `product()`, PokemonPriceTracker `#sameCard`, `soldStats.listingMatchesCard`, and TCGdex `search`. Each handles promos ("MEP 060"), leading zeros and totals slightly differently. | One shared `cardNumber.js` with tests. |
| T5 | **Ad-hoc migrations:** column lists checked on every start. | Versioned migrations with `PRAGMA user_version`. |
| T6 | `Store.transaction` isn't re-entrant: calling `addSales` inside another transaction would fail. | Use savepoints (`SAVEPOINT`/`RELEASE`). |
| T7 | **Leftovers:** euro totals (`value_eur`) and the euro `cardmarket` history line from before USD-only pricing; `Start Pokedex.cmd` and `--open` alongside the desktop app. | Drop them once nothing uses them. |
| T8 | The frontend has no type checking; `add.js` (~470 lines) and `views.js` (~520) are large; the browser test isn't part of `npm test`. | JSDoc types + `tsc --checkJs`, split the card dialog out of `views.js`, and run e2e in CI. |
| T9 | The README repeats much of the user guide. | Keep the README for setup and development, and link to `docs/USER_GUIDE.md` for usage. |

## Feature ideas

- **Set completion:** a "Pokédex" view per set ("142 of 193 owned"), with the missing cards.
- **Quantities and condition:** one row per card with a count and condition (NM/LP…), instead of duplicate rows.
- **Purchase price**, to show gain or loss against today's value.
- **Export/import** (CSV) and a **Back up now** button in the app.
- **Wishlist** with price alerts.
