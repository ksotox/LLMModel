# Project history

A full record of how the app was built: what was asked, what was delivered, problems hit and how
they were fixed. Newest phase last. Sources and APIs are listed in [`SOURCES.md`](SOURCES.md), and the
current state for the next agent is in [`../MEMORY.md`](../MEMORY.md).

All work was done by Claude Code (cloud sessions) for the repo owner, on branch
`claude/pokemon-collection-catalog-aw6vsc`, merged into `main` through pull requests.

## Timeline

| Date (UTC) | Commit / PR | Summary |
| --- | --- | --- |
| 2026-10-25 | `63ab63b` | First version of the Pokédex collection catalog |
| 2026-10-26 | `6c8e929`, `9c38441` | Empty "Initial commit" on `main` merged into the branch so a PR could be opened |
| 2026-10-28 | PR #2 merged (`0febd2c`) | First version lands in `main` |
| 2026-10-29 | `3fee330` | Second card source, rarity, pull chance, prices, card search |
| 2026-10-30 | PR #3 merged (`f07b06f`) | Above lands in `main` |
| 2026-10-30 | `0fc3f7f` | Read cards from photos automatically; clean card cut-outs |
| 2026-10-30 | `fee9e5d` | eBay sold prices per card: average, trend chart, listings |
| 2026-10-30 | `01aa259` | Local daily price history; PokemonPriceTracker graded eBay sales |
| 2026-10-30 | PR #4 merged | Above, plus `MEMORY.md`, this history and `SOURCES.md` |
| 2026-10-30 | PR #5 merged | One-click Windows launcher with desktop icon; API key kept in the user environment |
| 2026-10-30 | PR #6 merged | Link unmatched cards automatically (missing official images); cleaner card tiles |
| 2026-10-30 | PR #7 merged | Promo pictures from TCGplayer; all prices in US dollars |
| 2026-10-30 | PR #8 | tcgcsv 401: app User-Agent, promo pictures via PokemonPriceTracker; desktop app that updates itself |

## Phase 1: the catalog (PR #2)

**Asked:** a personal Pokédex covering:
- uploading one or many card photos;
- optionally uploading photos of the pack, tin, kit or bundle the cards came from;
- recording the date added;
- keeping the data between sessions;
- searching across all cards or by pack;
- showing the user's photo next to the official PNG when one exists.

The owner supplied reference photos: Voltorb, Punk Helmet and Linoone in one shot, plus a Voltorb reverse-holo close-up.

**Built:**
- Node 22 + Express 5 + `node:sqlite`, with a no-build vanilla JS frontend.
- Multi-card photos are split automatically, and a crop editor lets the user draw, move, resize, split evenly or use the whole photo.
- Pack, tin and bundle records, each with photos.
- TCGdex lookup by set code and number or by name, with a local copy of the official image.
- Search with filters by pack and set.
- 16 API tests and a Playwright walkthrough using the reference photos.

**Problems:**
- The first push failed with a 403 because the Claude GitHub App had no access to the repo, so the project was sent as a zip until the owner reconnected GitHub.
- `main` held an unrelated empty "Initial commit". It was merged into the branch so a PR could be opened.
- The repo's default branch was the `claude/...` branch, so the CodeRabbit bot skipped PRs. The owner was told how to switch it to `main`.

**Support:**
- "How do I run this": install Node LTS, download, `npm install`, `npm start`.
- On Windows, `npm` failed with `ENOENT … package.json` because PowerShell was in the user folder rather than the app folder. The fix was step-by-step PowerShell commands that download and unzip `main` and `cd` into `LLMModel-main`.
- "Test TCGdex": the sandbox blocks TCGdex, so the app's assumptions were checked against TCGdex's own server code on GitHub instead. The owner was given three lookup URLs to try locally.

## Phase 2: second source, rarity, pull chance, price, search (PR #3)

**Asked:**
- use another website when TCGdex lacks a card or image;
- search any card;
- show rarity, % chance of pulling and a resale price estimate.

**Built:**
- **Second source:** the PokemonTCG GitHub dataset, ids prefixed `ptcg:`. It works when TCGdex is down, and it was verified against the real dataset.
- **Rarity badges** using the symbols printed on cards.
- **Pull chance:** per-pack rate ÷ number of cards of that rarity in the set, using TCGplayer study rates for the Scarlet & Violet and Mega Evolution eras.
- **Prices:** TCGplayer (via TCGdex), then Cardmarket, then tcgcsv.com, matched to the card's variant.
- Collection total value, sort by value or rarity, an **Update prices** button, and a **Search** page with one-click add.
- `npm run check:live` lets the owner test the real sources.
- 37 tests.

**Notes:**
- pokemontcg.io's own API was avoided because its future is uncertain after the move to Scrydex.
- Promo and special sets get no pull estimate.

## Phase 3: automatic reading and clean cut-outs (PR #4, commit 1)

**Asked:**
- fill in the card info by reading the card, with no typing;
- crop the background out cleanly without cutting into the card.

**Built:**
- **Cut-outs (OpenCV.js in the browser):**
  - card outlines are found by brightness and by edges, with a dark frame added so cards touching the photo edge are still found;
  - each side is snapped outwards onto the card's real edge;
  - a perspective warp straightens the card to an upright 63:88 picture with transparent rounded corners;
  - the crop editor uses 4 draggable corners.
- **Reading:**
  - Tesseract.js reads the name strip and the bottom-left set code and number;
  - `POST /api/identify` votes across the readings, fixes misreads ("0667193" → 066/193, "0BF" → OBF, a dropped leading zero on promos) and requires the name to agree before matching automatically.
- Results on the reference photos: Voltorb PAL 066/193, Punk Helmet PFL 092/094, Linoone OBF 168/197, and the Froakie promo MEP 060.

**Problems fixed:**
- OpenCV.js is a thenable module, so `await` hung until it was wrapped as `{cv}`.
- A use-after-free on `approx.rows` crashed the page.
- A misread number matched Heracross; the name-agreement check fixed it.
- The bright Linoone card lost a strip at the bottom until edge snapping was added.
- The e2e test had a navigation race, fixed with heading waits.

## Phase 4: eBay sold prices (PR #4, commit 2)

**Asked:** for each card, show:
- the average eBay sold price;
- a trend graph that is green going up, red going down and yellow flat;
- the sold listings, with title, price, date, condition or grade, and URL.

The owner chose "find a free way".

**Built:**
- Average, median, range and count, filterable to all, raw or graded sales.
- Weekly or monthly trend chart. Each segment is coloured by its change (±2% band). The overall trend comes from a regression slope, so one outlier can't flip it.
- A listings table, with a button to remove listings that aren't the card.
- **Data, free and allowed:**
  1. eBay's official Marketplace Insights API, which needs eBay's approval;
  2. copy and paste from eBay's own "Sold items" search, opened in the user's browser and read from page structure or plain text.

  Only listings for the exact card are kept (name, number and set total must match; lots are skipped).
- 67 tests.

**Notes:**
- eBay's open `findCompletedItems` API was shut down in 2025, scraping breaks eBay's terms, and sold searches now require signing in. That is why these two routes were chosen.
- The trend direction and % change originally disagreed. Both now come from the same regression.

## Phase 5: price history and PokemonPriceTracker (PR #4, commit 3)

**Asked, in the owner's own plan:**
1. a PokemonPriceTracker free-tier client (100 calls a day; eBay graded sales and 3-day history);
2. local price history in SQLite;
3. API endpoints for the price history and eBay data;
4. smart caching to stay within 100 a day.

**Built:**
- **`price_history` table:** one row per card, source, label and day. It is saved on add, re-link, open and refresh, and by an hourly scheduler that re-prices any card not checked that day.
- **`PriceTrackerClient`:** a tolerant parser covering several documented layouts. It reads graded sales, individual sales, history and population.
- **`PriceTrackerService`:**
  - 24h cache per card;
  - the TCGplayer id comes from TCGdex; otherwise one search is made once and remembered, and the result must match the card's number, set total and set name;
  - a per-day credit ledger in `api_usage`, which also uses the remaining credits the API reports;
  - a 30% reserve kept back from background use;
  - a 1-day backoff after errors;
  - concurrent requests for the same card share one call.
- **Endpoints:**
  - `GET /api/cards/:id/price-history`
  - `GET /api/pricetracker/status`
  - `GET /api/cards/:id/pricetracker`
  - `POST /api/cards/:id/pricetracker/refresh`
- **UI:** a "Price history & graded sales" section with a daily chart, a series picker, a graded-sales table, population, credits used, and an "Update now" button.
- 81 tests.

**Problems fixed:**
- A search matched a wrong-set card by number alone.
- The background count included failed lookups.
- Cards were re-priced every hour because the snapshot check used the source's price date. A `market_checked_at` column fixed it.
- The UI loaded history in parallel with the refresh and missed new points.
- The chart axis repeated "$0.24" for cheap cards; it now shows more decimals when needed.

**Not verified live:** the sandbox can't reach PokemonPriceTracker or eBay. Population data probably needs a paid plan.

## Phase 6: handoff documentation (PR #4)

**Asked:**
- a memory file that doesn't grow too large and that another agent or model can pick up;
- full history documentation;
- a list of sources, websites and APIs;
- merge.

**Built:**
- **`MEMORY.md`:** current state only, capped at 150 lines and 10 KB by `tests/memory.test.js`.
- **`AGENTS.md` and `CLAUDE.md`:** pointers to `MEMORY.md`, so common agents load it automatically.
- **This file and `SOURCES.md`.**

## Phase 7: one-click start on Windows

**Asked:** start the server by clicking an icon, with the PokemonPriceTracker key already set.

**Built:**
- **`Start Pokedex.cmd`:**
  - checks that Node is installed;
  - runs `npm install` on first run;
  - starts the app with `--open`.
- **`--open`:** opens the default browser once the server is listening. If the port is already in use, it reopens the browser and exits.
- **A Poké Ball `public/pokedex.ico`.**
- **A README PowerShell snippet** that saves the key as a Windows user environment variable (it survives updates and stays out of the repo) and creates a desktop shortcut that starts minimised.

## Phase 8: missing official images and cleaner card tiles

**Asked:** why some cards had no official picture, and a cleaner, easier-to-read info block under each card.

**Cause:** those cards were saved with a name, set code and number (typed in, or added on the first version) but were never linked to an official card. **Update prices** could still find their rarity and price from the set code and number, but nothing ever fetched the image. Promo numbers had also been saved as `059/000`.

**Built:**
- `refreshCardMarket`, which runs on Update prices, on opening a card and in the hourly job, now links unlinked cards through `identifyCard`. It only links when the name, number and set agree (`confidence === 'high'`), then downloads the official image. Linked cards whose image is missing are retried.
- A total of `000` is treated as no total.
- The Update prices message says how many images were found.
- Card tiles:
  - names wrap to two lines instead of being cut off;
  - the set code is a small tag next to the number, in grey rather than red;
  - rarity and price share one row;
  - a footer shows "1 in N packs" and a short date;
  - the bottom rows line up across the grid;
  - cards not yet matched say so.
- The Search page uses the same layout.

## Phase 9: promo pictures and prices in dollars

**Asked:** find official pictures for the promo cards, even from another source, and show prices in US dollars instead of euros.

**Cause:**
- The Mega Evolution promos (MEP) have no picture on TCGdex, and the Pokémon TCG dataset has no MEP set at all.
- The promos showed € because TCGdex had only a Cardmarket price for them, and that euro price was used before the backup TCGplayer price was tried.

**Built:**
- **TCGplayer group ids for every known set,** read from TCGdex's data files (e.g. MEP 24451). tcgcsv.com finds the exact set by this id instead of by name.
- **Product lookup by number or name.** It matches "MEP 059"-style numbers by their digits, and listings that carry the number only in the name.
- **TCGplayer's product picture is the third image source,** for saved cards and for search results.
- **Price order is always USD:** TCGplayer via TCGdex, then tcgcsv, then Cardmarket converted with the day's ECB rate (`server/fx.js`, Frankfurter). There's a fixed fallback rate when offline, labelled "approximate".
- **Converted prices get their own history line** (`cardmarket-usd`).
- **The rarity badge no longer gets clipped** by the price on narrow tiles.

## Phase 10: tcgcsv.com answered 401

**Found:** the owner ran `npm run check:live`.
- Working: TCGdex, the dataset, images, TCGplayer prices via TCGdex, and the exchange rate (1 EUR = 1.113 USD).
- Failing: every tcgcsv.com request returned **401**, so promo pictures and the backup prices failed.

**Changed:**
- `TcgCsvClient` sends a descriptive `User-Agent` and `Accept: application/json`. The mock now rejects requests without it, so the tests prove it's sent.
- Promo pictures fall back to the dataset image hosts' usual addresses (Scrydex, pokemontcg.io), guessed from the TCGdex set id.
- `check:live` tests tcgcsv with and without the app's name and lists each promo picture address it tries.
- The owner shared BinderDex's picture address for Froakie, `assets.binderdex.com/collectr/pkmn/mega-evolution-promos/709974.jpg`.
  - `709974` is Froakie's TCGplayer product number, which confirms TCGplayer has the promo pictures. BinderDex itself isn't used, since it has no API.
  - When no source has a picture, the app now asks PokemonPriceTracker using the owner's key. It reads the picture links and TCGplayer product number from a search, then downloads TCGplayer's picture.
  - A test recreates the owner's situation (tcgcsv 401, no TCGdex or dataset picture) and checks the picture is saved.
  - `check:live` also downloads Froakie's TCGplayer picture by product number and tests the PokemonPriceTracker lookup.

## Phase 11: desktop app that updates itself

**Asked:** a real desktop application. Opening an exe should start the server, and every merged change should update the app by replacing the `LLMModel-main` folder with the latest code.

**Built (`desktop/`):**
- **`install.ps1`**, run once with `irm … | iex`:
  - builds `Pokedex.exe` from `Pokedex.cs` with Windows' own C# compiler, so there's no downloaded binary;
  - puts it, `launcher.mjs`, the icon and `config.json` in `%LOCALAPPDATA%\Pokedex`;
  - adds Desktop and Start menu shortcuts.
- **`Pokedex.exe`** runs the launcher with Node, without a console window, and shows a message box if it fails.
- **`launcher.mjs`:**
  - finds the newest commit through git's `info/refs`, because the API was rate-limited during testing;
  - downloads the zip and unpacks it with its own zip reader;
  - installs packages, or copies them when `package-lock.json` didn't change;
  - swaps the folders, moving `data/` across and keeping `.previous`, and rolls back if the server doesn't start;
  - installs packages if they're missing;
  - starts the server with IPC and opens an Edge/Chrome `--app` window, stopping the server when it closes;
  - checks every 30 minutes, and offers a restart through `/api/desktop`;
  - updates itself.
- **Server:** `/api/desktop`, `/api/desktop/restart`, and a clean shutdown on request. **Page:** a "Restart to update" banner.

**Tested:**
- Unit tests against a stand-in GitHub cover install, update with the cards kept, rollback, the rate limit, missing packages, path safety and the API.
- **Real run 1:** the real launcher against the real GitHub and npm updated an unversioned folder to `main` (`3ebdcae`). The saved card survived and the page served; closing the window stopped everything.
- **Real run 2:** this branch's code served as v1 and then v2. A merge arriving while the app was open was detected, Restart to update installed v2 in under a second, and the server shut down cleanly.
- **Not tested here:** `Pokedex.exe` and `install.ps1` themselves (no Windows in the sandbox).

## Environment limits seen during development
The cloud sandbox could reach only GitHub (including raw files) and the npm registry. TCGdex, eBay,
PokemonPriceTracker, tcgcsv.com and Scrydex were blocked, so those integrations are tested
against local mocks (`tests/helpers/mock-sources.js`) built from their docs and source code. The owner can
check the real services with `npm run check:live`.
