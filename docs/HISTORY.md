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
| 2026-10-30 | PR #8 merged | tcgcsv 401: app User-Agent, promo pictures via PokemonPriceTracker; desktop app that updates itself |
| 2026-11-01 | PR #9 merged | User guide, code review; fixes: updater data safety, credit drain, cross-site requests; bugs B1–B6; variant suggestion (printings, foil in photo, tilt scan) |
| 2026-11-02 | PR #10 | Japanese cards: recognised, found and pictured from TCGdex's Japanese database; card-detection fix |

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

## Phase 12: user guide and code review

**Asked:** a user guide covering every feature, and a review of the code for improvements, bugs and tech debt.

**Built:**
- **`docs/USER_GUIDE.md`**, written for a non-developer: getting started, each screen, adding cards, prices, eBay, history, updates and backups, phone use, troubleshooting and a glossary.
- **`docs/CODE_REVIEW.md`**: four problems fixed in this PR, plus prioritised open findings.

**Fixed:**
- **F1 (critical):** the updater could lose the collection if moving `data/` failed. A failed move now undoes the swap, a collection left in `.previous` is set aside rather than deleted, and the database is backed up before each update.
- **F2:** PokemonPriceTracker picture searches repeated on every price update and drew on the viewing reserve. They're now remembered for 7 days and never use the reserve.
- **F3:** other websites could post to the app, and a `javascript:` picture address could become a link. Cross-site requests are now refused and picture addresses must be `http(s)`.
- **F4:** the hourly job skipped unmatched cards with no set code.

Tests cover each fix, and the credit-drain test fails without its fix. 102 tests pass.

## Phase 13: remaining bugs and variant detection

**Asked:**
- fix the remaining bugs;
- suggest each card's variant with a confidence level the user confirms, using three methods:
  - a region comparison (art box vs body);
  - a tilt scan;
  - TCGdex's printing data.

**Fixed:** bugs B1–B6 and P3 from the code review (overlapping refreshes, re-matching after a number change, HEIC message, set sort, image extensions, a stats count, the `tcg_id` index). Each has a test that fails without its fix.

**Built:**
- **`server/printings.js` + `GET /api/catalog/cards/:id/printings`:** the allowed printings come from TCGdex `variants_detailed` / `variants`, then from TCGplayer price lines. Rarity rules make some answers certain: Illustration, Special Illustration, Ultra and Hyper rares, and secret rares (number above the set total), are full art; Double Rares (ex) are holo; promos are Promo. Pattern foils and stamps are reported as notes.
- **`public/js/foil.js`:**
  - normalises every card to 360 px wide;
  - measures fine texture in 8×8 background blocks of the art box and the body, skipping ink and glare;
  - calibrated on the reference photos: normal bodies ≈ 0.004 (body ÷ art ≈ 0.25–0.44), reverse holo ≈ 0.012 (≈ 0.95), full foil ≈ 0.033 (≈ 1.9);
  - single-photo confidence is capped at 85%;
  - the tilt scan compares brightness-evened, slightly blurred cut-outs from 2–3 angles.
- **Add cards:** a suggestion line under Variant with **Use** and **Tilt scan** / **Add another angle**, the reasons, and pattern-foil notes. Only a certain printing is filled in automatically.
- **Results on real photos:** the normal Voltorb, Punk Helmet and Linoone came out Normal (body foil chance 6–12%); the Voltorb close-up came out Reverse holo (88%).
- **Limits:** the tilt-scan thresholds are only tested on synthetic cards and need real tilt photos to tune. Pattern foils and stamps aren't detected from the image.

## Phase 14: Japanese cards

**Asked:** recognise, find and get pictures for Japanese cards.

**Built:**
- **TCGdex's Japanese database** (`/v2/ja`) through a second `TcgClient`. Ids are prefixed `ja:`, and the printed code (`SV2a`, `M1L`, `SV-P`) is the TCGdex set id, matched case-insensitively.
- **Catalog routing:** Japanese-looking lookups (a Japanese code, a Japanese name, or `lang=ja`) go there first. Japanese cards skip the English-only sources. Prices come from Cardmarket and are converted to USD; there's no pull chance.
- **Identification:**
  - Japanese set codes are read, including OCR's "5V" for "SV".
  - Names are compared in the same script (NFKC, kana/kanji kept).
  - With no Japanese reading, code + number + total must all agree.
  - A Japanese code searches only Japanese, because the English 151 is also /165.
- **OCR:** the bottom line now allows lowercase (`SV2a`). The Japanese model (`@tesseract.js-data/jpn`, 2 MB) reads the name strip when a Japanese code is seen.
- **App:**
  - `language` column, a **JP** tag on tiles, search results and lookups;
  - "japanese"/"jp" in collection search;
  - a Language box on the Search page;
  - Japanese promo sets count as promos.
- **Also fixed a card-detection bug:** on a lighter background, the photo's own border (from the dark frame added to catch cards touching the edge) outscored the real card. Outlines along all four photo edges are now dropped when a card was found inside.
- **Tested** on a realistic synthetic Japanese card photo (`tests/fixtures/photos/japanese-voltorb.jpg`). The real browser pipeline read `SV2a 100/165` and ビリリダマ and matched `ja:SV2a-100` at high confidence. A 7-test unit suite and an e2e step cover it.
- **Limits:** eBay listing matching for Japanese cards is weak, because listing titles are in English and the card's name is Japanese. There's no TCGplayer or PokemonPriceTracker data for Japanese cards.

## Phase 15: Profiles, inventory, gallery, bulk changes, set completion, smarter recognition

- **Profiles and sign-in:** first start shows a setup screen that creates the owner profile, which takes over the existing collection. The owner can add and remove profiles; each has its own collection, packs, theme and gallery settings. Passwords are scrypt hashes; the browser holds a 30-day HttpOnly session cookie (only its SHA-256 is stored). Five wrong passwords per username or address in 10 minutes → wait. Changing the password signs out other devices. `/api/meta` and `/api/desktop` stay public because older desktop launchers check them to see the server is up.
- **Physical inventory:** each copy is its own row with condition (NM/LP/MP/HP/DMG), grading company and grade, price paid, storage place and plans (keep / trade / sell). Copies of the same card and printing are grouped by a key (official card id, or name + set + number, plus variant). This was chosen over a catalog/items table split, which would have meant migrating price history, eBay sales and tracker data. The card page lists every copy and has "+ Add a copy".
- **Duplicate check:** before saving new cards, the app asks the server how many of each the user already owns (`POST /api/cards/duplicates`) and also spots the same card twice in one batch. A Yes/No popup lists them; "No" saves nothing and marks the duplicates.
- **Gallery:** Compact, Detailed and a sortable Table view (name, set, number, rarity, variant, quantity, condition, value); Compact / Comfortable / Large density; copies grouped as ×N; light mode by default with dark mode in the account menu or profile. The collection loads 60 at a time from the server (`GET /api/cards?page=…&group=1`) and loads more as you scroll.
- **Filters and bulk changes:** rarity, type, variant, language, condition, plans, graded, value range, date added, duplicates, unmatched, missing price, all combined. Presets: Most valuable, Recently added, Missing prices, Unmatched, Duplicates, Grading candidates (≥ $20, raw, NM or unset), For trade or sale. Select mode with a bulk bar: move to pack, condition, plans, storage place, export CSV (`GET /api/cards/export`, formula-safe), delete. Deleting moves cards to a trash for 30 days, with Undo; the trash can restore or delete for good.
- **Set completion (`#/sets`):** your sets with progress bars, and any English or Japanese set to browse. A set's page has owned / total / completion / missing / duplicates, an on-demand estimate of the missing cards' value, three goals (main set, master set with secret rares, reverse holo set), filters (missing, owned, duplicates, missing illustration rares), and muted tiles for missing cards.
- **Smarter recognition:** each card shows Recognized / Review needed / Unrecognized (or Checked, once the user fixed it); a progress bar ("Reading card N of M"); after a batch, a summary with "Review uncertain cards" (shows only those) and "Read again". Reading again also tries the photo upside down and keeps the better reading (turning the saved photo too). Typed fields are never overwritten: after the user types, a later reading only fills empty fields and offers its match instead of picking it.
- **iPhone HEIC photos** are converted to JPEG in the browser with heic2any (loaded only when needed; can be turned off in the profile). **Foil measurements** run in a Web Worker (`foilAsync.js`), falling back to the main thread.
- **Tests:** auth (6), collection management (8), set completion (4); the e2e now starts with setup and covers the duplicate popup, grouping, compact/table views, presets, filters, bulk condition + trash + undo, per-copy fields, a set checklist, dark mode, and signing out and in.

## Phase 16: Experimental pre-grading (Viridian computer vision)

- **Source:** the owner supplied the "My Pokédex — Viridian Pre-Grading Integration Kit v0.1" (installer, Express router, FastAPI adapter, UI, tests), built around the MIT-licensed [Viridian](https://github.com/dylan7077/viridian) grader by Dylan Roberts. It was chosen over other open-source graders for its clear license and its own published findings on which measurements are reliable.
- **Integration:** the kit's installer stopped safely because this branch had moved on from the public snapshot it was written for, so the payload was integrated by hand:
  - every card is checked against the signed-in profile, and trashed cards can't be graded;
  - photo-size errors answer 413, and the service's own messages reach the user;
  - report photos are removed after *any* card deletion (one card for good, a pack with its cards, a profile, the 30-day trash purge) by sweeping report folders that no saved report points to. This replaced the kit's per-route snapshots, which wouldn't have covered the trash purge or deleted profiles;
  - the screens use the app's theme (dark mode works).
- **Adapter fixes:**
  - the card's official picture (sent as an optional alignment reference) went through the user-photo checks, so a small official image failed the whole inspection; it's now skipped instead;
  - a note now appears when the back photo doesn't look like a card back, and when back centering can't be measured because Viridian's card-back reference image isn't installed (upstream doesn't ship it).
- **Honesty:**
  - every result carries "Experimental CV estimate — not professional grading.";
  - the report explains that the overall estimate uses centering and surface only, because Viridian's own validation found its blind corner/edge heuristics don't separate damaged from clean cards;
  - no probabilities, accuracy claims or grading-profit advice.
- **Desktop launcher:**
  - it now carries `.venv-grading` and `third_party/viridian` across updates and rollbacks (before, an update would have discarded the setup);
  - it starts the grading service if it's set up, and skips it quietly if not;
  - it stops the service before swapping folders and when the window closes.
- **Verified:** a real run of the pinned Viridian commit on the reference Voltorb photo through the browser (upload, report with overlays, reopen from the card, delete) and a fresh install of the pinned commit. Tests: 9 Node integration tests with a mock service, the kit's 3 sanitising tests, 3 launcher tests, 7 Python adapter tests, and an e2e step.

## Phase 17: A detailed pre-grading report with a virtual slab

- **Asked for:** a report as detailed as TCGrader's graded-card page, with the card shown in a sleeve/slab. The owner supplied a saved copy of a TCGrader page; the live site wasn't reachable from the build environment, so its layout was taken from that page's markup: a flippable 3D slab with a label, a breakdown per category with front/back scores and flagged issues, and a "precision scan" of every corner and edge.
- **Precision scan (`services/grading/precision.py`):**
  - each side is cut out and straightened at 800×1120 from the detected outline;
  - close-ups of the 4 corners and 4 edges come with a transparent map of the pixels Viridian's test counted, in exactly the regions it measures. The front and back use different upstream rules, and both are reproduced; tests check the maps add up to Viridian's own numbers;
  - per-corner and per-edge scores use Viridian's own fraction-to-grade tables, and a surface map marks its scratch/scuff features;
  - findings are built only from those measurements, worst first;
  - when the card was aligned to its official picture, Viridian's reference-difference map is kept too.
- **What it showed:** on a pack-fresh card, Viridian's blind corner test counts printed text and symbols ("BASIC", the energy symbol) as whitening, because its corner box reaches into the print. That's why upstream excludes these readings from the grade. The report now says so beside them, labels them "Screening only", and lets you see the counted pixels on the **Map** view.
- **Report UI (`public/js/gradingReport.js`):**
  - **virtual slab:** label, estimate badge and an "experimental · not a pro grade" stamp; flip; tilt with the pointer; flattened or original photo; save as a PNG that keeps the label;
  - **breakdown cards:** front/back bars, generated analysis text, flagged issues, and "Counts toward estimate" or "Screening only";
  - **precision scan:** each close-up has Original / Contrast / Inverted / Detail / Map views; plus a surface map and a findings table;
  - **graded eBay prices:** saved PokemonPriceTracker data, shown for reference with no advice.
  - Older reports still open, with their original photos and overlays.
- **Tests:**
  - Python: 2 new, against the real Viridian code;
  - Node integration: precision data and images, including that unknown keys never become file names and that images whose content doesn't match their declared type are dropped;
  - e2e: the slab, flip, close-ups, Map view, back tab and findings.

## Phase 18: PokéBattles

- **Asked for:** a PokéBattles tab using the Pokémon 3D API models: one card shown in 3D with its moves, or two cards battling, with moves and abilities to choose and a game-like presentation. Battles should open the way TomBastable's Pokemon-Card-ARKit demo does, with the Pokémon popping out of its card, but without scanning. The owner chose: moves from the card's own data, and both a vs-computer and a two-player mode.
- **3D models:** `pokemon-3d-api.oneapp.dev` was blocked in the build environment. It's the viewer of the open-source Pokémon 3D API, whose model list (`MergedOpt.json`, 1,025 Pokémon with forms) and `.glb` files are on GitHub. `server/models3d.js` caches the list (memory + disk) and downloads each model once; only files the list names, from the project's GitHub address, are allowed, checked as glTF (≤ 15 MB). Forms follow the card (Mega, regional, VMAX → Gigantamax, shiny rarities). Cards without a Pokédex number are matched by name with card suffixes and owner prefixes removed.
- **Battle data:** TCGdex and the dataset already send attacks, abilities, weakness, resistance and the Pokédex number, but the app was dropping them. `server/battle.js` reads them again from the (cached) raw card. Unlinked or attack-less cards get a basic Tackle; Trainers can't battle.
- **Rules (`public/js/battle/engine.js`):** simple, original rules built on the cards' data:
  - energy per turn and printed costs;
  - "+" and "×" damage decided by coin flips; weakness and resistance as printed;
  - abilities usable once each, powering up the next attack;
  - a computer opponent;
  - pure functions with a seeded random generator, so battles can be tested.
- **Stage (`public/js/battle/scene.js`, three.js 0.180.0 served locally):**
  - **the summon:** the card (its picture on a 3D card with our own card back) drops onto a type-coloured platform and glows, and the model pops out with a flash and particles;
  - **attacks and hits:** attacks lunge with type-coloured particles (Lightning adds a bolt); hits shake, flash red and show floating numbers; healing, energy, power-up aura and fainting each have their own effect;
  - **models:** a model's own animation clip plays when it has one (most have none);
  - **fallbacks:** a Pokémon without a model fights as its standing card; without WebGL, a CSS card stage is used.
- **Closer to the AR demo** (after the owner shared its screenshot):
  - the Pokémon now stands on its card, which stays full-size and bright as its base;
  - a Poké Ball (a simple model of our own) bounces onto the card, pops open as the Pokémon appears, and stays on the card;
  - the details float as a banner above the Pokémon (card thumbnail, name, set and number, type icon, HP) and follow the camera;
  - the camera looks down at the card;
  - the models are sized to about the card's width.
- **More realistic look** (owner's request):
  - **No better models exist.** The Pokémon 3D API only publishes its compressed, game-style models, so realism comes from rendering.
  - **Lighting (`public/js/battle/world.js`, all generated in code):**
    - a physically based sky and sun (dusk in dark mode), with light from that sky on every surface;
    - soft sun shadows from the Pokémon, cards, Poké Balls and platforms;
    - neutral tone mapping (ACES washed out the models' reds) and distance haze.
  - **Environment:** gently rolling grass land; a dirt battle field with chalk lines and a stone ring; 16,000 instanced grass blades swaying in a wind shader; smooth rocks and boulders, pine and broadleaf trees, distant hills; stone platforms.
  - **Art direction:** the owner then shared an open-world game screenshot as a reference. Added:
    - a deeper blue sky with a drifting cloud dome (an fBm shader);
    - snow-capped mountain ranges and green ridges built from ridged noise and coloured by height, with aerial-perspective haze and mist banks;
    - layered hills, an instanced forest in clumps, cut-stone blocks around the field, ruined pillars and walls, flower patches.
    - Everything is procedural; none of that game's assets or landmarks are used.
  - **Graphics levels:**
    - **High:** GTAO ambient occlusion, bloom (bright effects only; a too-low threshold at first washed out the whole picture) and the densest vegetation, at 1.5× pixels;
    - **Standard:** no post-processing, fewer blades, smaller shadows;
    - **Basic:** no shadows, no sky lighting, Lambert materials, no grass, flowers or clouds, 0.75× resolution;
    - **defaults:** software renderers get Basic; phones and ≤ 4-core machines get Standard. The choice is remembered.
    - Measured in a software renderer: 1.1 s → 0.3 s per frame for Basic. The e2e's 3D steps got longer time limits because it runs without a GPU.
  - **Camera:** lowered so the horizon, mountains and sky are in view.
  - **The owner's "Hi-Fi v4" mock-up** (a single-page three.js battle the owner made, attached as HTML) was then merged in, rewritten for the app's three.js version and pipeline (colour space, tone mapping, fog):
    - **Land:** one heightfield from the arena to ridged peaks, replacing the separate green ridges. It is coloured by height and slope (meadow and dirt, sand, rock, snow); a shader swaps the grass texture for its plain brightness on bare ground.
    - **Lake:** water with Fresnel sky reflection, sun glint and moving noise ripples.
    - **Grass:** the instanced grass shader, placed where the fixed camera looks, with gusts, root shading and backlight. High has 60k blades, Standard 20k (it was 16k / 5k).
    - **Trees and air:** layered-cone pines in the forest, drifting pollen, and mist banks laid along the view.
    - **Battle view and hits:** a three-quarter camera with idle drift; hits shake the camera and flash the screen (both off with reduced motion); attacks wind up before the lunge; a fainted Pokémon topples.
    - **Panels:** frosted-glass HP plates, a vignette, move buttons with a type-coloured edge and a type label, and two-column moves on phones.
    - **Left out:** the mock-up's two placeholder creatures and its made-up moves and levels. The battles keep the cards' real models and card rules.
- **Page:** picker with form choice and mode switch; the summon intro with floating card details (they shrink to a tag on phones); the showcase (orbit, practice target); the battle (HP and energy plates, typewriter messages, move buttons with cost pips and expected damage, turn banner, win screen with rematch).
- **Found while testing:**
  - a Pokémon with a single 3D form crashed the showcase;
  - moves clicked during the intro were silently ignored (they're now disabled until it ends);
  - Skip only fast-forwarded for 50 ms;
  - three.js hides its package.json, so the vendor path is resolved from its main file.
- **Tests:**
  - `battle.test.js` (6): battle data from TCGdex, Japanese and unlinked cards; forms; proxy and cache, path tricks, non-glTF files, offline; profile access;
  - `battleEngine.test.js` (8): the rules;
  - mock TCGdex cards carry battle data, and the mock serves a model list and generated glTF cubes;
  - e2e: showcase, a full battle against the computer, two-player turns, and the card-only fallback with the model host down.
  - Verified in a browser with the real models from GitHub (Voltorb, Electrode, Linoone), including dark mode and a 390 px-wide phone screen.

## Phase 19: 3D Pop-out gallery

- **Asked for:** the collection shown like the owner's phone mockup, with each Pokémon bursting out of its card above a glowing pedestal and a frosted info panel. The owner supplied a code package (`pokemon_artwork_effect_demo.zip`: switch, CSS, `registerArtwork()`, 4 prepared scene images cropped from the mockup, an installer for `views.js`).
- **Limit, said up front:** CSS can't make a Pokémon come out of an arbitrary card; only the 4 prepared cards match the mockup exactly.
- **The owner chose:**
  - every other Pokémon card shows its 3D model (the PokéBattles models) standing out of its tilted card;
  - the 4 scene images are committed.
- **Built:**
  - the package, applied by hand. It is shown in official mode only; My photos and Select show plain tiles, and table view has no switch. A dual-type card glows in its first type. Dark-theme panels, a lavender backdrop, and two columns on phones were added.
  - **3D pictures (`public/js/popoutRender.js`):**
    - `POST /api/popout/models` gives each card's model (by name, else Pokédex number; none for Trainers, Energy or another profile's cards);
    - tiles ask for theirs as they scroll into view;
    - missing ones are drawn one at a time by one offscreen WebGL renderer (transparent background, three-quarter turn, studio light);
    - each picture is saved with `PUT /api/popout/pictures/<form>/<id>` (WebP/PNG signature, 1 MB limit, listed models only) into `data/popout/`, so it's drawn once per Pokémon for all cards and devices;
    - the picture sits over the CSS-tilted card, so card pictures never go through WebGL (no cross-origin images needed).
  - `public/js/battle/modelLoader.js`: model loading shared with the battle stage.
- **Tests:** `popout.test.js` (4): keys, effects, `registerArtwork`, the model lookup, pictures (signature, size, path tricks, first one kept). The e2e covers: switch on, Voltorb's picture drawn and saved, no upload after reload, a Trainer with no Pokémon, My photos and Select plain, switch off.
- **Found while testing:** in a 390 px window the pop-out grid fell back to one column (the "Comfortable" minimum width). It's now two columns on phones unless "Large" is chosen.

## Phase 20: The battle environment ported from the Hi-Fi v4 reference

- **Asked for:** port the reference's environment rendering into the battle scene, without touching creatures, UI or battle logic. That meant its grass, sky dome, FogExp2 in the sky's horizon colour, ACES at exposure 1 with hemisphere and sun lighting (no strong ambient), mountains as part of the terrain mesh with vertex colours, pollen, mist and a vignette, plus a mobile path.
- **Changed in `world.js`:**
  - **Sky:** the physical `Sky`, the separate cloud dome and the sky light (IBL) are replaced by the reference's sky-dome shader (gradient, sun disc and glow, fBm clouds), which follows the camera.
  - **Fog:** `FogExp2(horizon, 0.0042)`.
  - **Light:** the reference's hemisphere light and angled sun (intensities ×π for three's physical light units), with no ambient or IBL light.
  - **Land:** one 800-unit mesh (170 segments on phones, 260 elsewhere) with the reference's vertex-colour palette and grey speckle detail texture. The separate far mountain ranges are removed, and the ridged peaks are 85 high instead of 120, because our camera sits lower.
  - **Grass:** 95k / 28k blades, as in the reference.
  - **High:** loses GTAO and bloom (the reference has no post-processing), and its pixel ratio cap goes from 1.5 to 2.
- **Colour pipeline:**
  - the custom shaders (sky, water, grass) work in display colours exactly like the reference, with tone mapping first and three's fog chunk after;
  - the fog colour equals the sky's horizon on screen;
  - the output stays sRGB, not the reference's linear output, because three.js r180 decodes the models' and cards' sRGB textures, so linear output would show them too dark;
  - ACES makes saturated reds a little duller than the earlier neutral tone mapping, as accepted with the request.

## Phase 21: After a battle: same battle again, or a different opponent

- **Asked for:** turn-based battles where you choose the move, and when a Pokémon reaches 0 HP, a question whether to pick a different opponent or play the same battle again. Turn-based move choice already existed (attacks, abilities, Rest; vs Computer or two players).
- **Added:**
  - the result panel asks "Battle <opponent> again, or choose a different opponent for <your Pokémon>?";
  - **Same battle again** replays it (the old Rematch);
  - **Different opponent** returns to the picker with your Pokémon still chosen, the same mode, and the empty opponent slot highlighted;
  - **Choose both again** starts over.
- **Tests:** the e2e checks the question and both choices, and that your Pokémon stays chosen.

## Phase 22: Battle graphics and app layout plan; stage 1, the full-window battle screen

- **Asked for:** a plan to improve the battle scene's graphics and the overall layout. The owner chose: the whole app's layout; a battle screen that fills the window with the controls on top (as in the Hi-Fi v4 mock-up); and all four graphics areas (bigger Pokémon and a closer camera, attack effects per type, better scenery, lighting polish).
- **Plan, four stages, one PR each:** (1) full-window battle screen; (2) battle graphics; (3) app menu and frame (a bottom tab bar on phones); (4) the collection page's controls and the other pages.
- **Stage 1, built:**
  - **Shell:** `arenaShell` (`public/js/battles.js`) makes the arena `position: fixed; inset: 0` and adds `body.battle-mode`, which hides the top bar. Leaving (Back, a menu link, the browser's back button) removes it.
  - **Overlays, frosted glass in the app's light or dark theme:** opponent plate top left; Back, Graphics and full screen top right; a bottom dock (at most 900 px wide) with your plate, the message, and the moves: a 2-column attack grid plus a side column for abilities and Rest (underneath on phones).
  - **Card text:** one line on the button; a small **i** opens the full text above the message box.
  - **Result:** the result and its question take the moves' place in the dock, so the winner stays in view. (The plan said a panel in the middle of the screen; there it covered the Pokémon.)
  - **Camera (`scene.js` `#fitCamera`):** in a narrow window the battle camera widens its lens (46° to 72°), then steps back, so both Pokémon stay in view; the picture is shifted up by half the dock's height (a view offset that glides when the dock grows), so the controls cover ground, not Pokémon. The camera is fitted before the world is built, so the grass is placed for where it really stands.
  - The flat card stage (no WebGL) keeps its cards above the dock.
- **Tests:** the e2e checks that the menu is hidden in a battle and back afterwards, that the moves are in view with nothing to scroll, and that a move's card text opens and closes.

## Phase 23: Roadmap for the scanner, 3D Pop-out for every card, and animated moves

- **Asked for:** an architecture plan to execute later, covering a better card scanner, automatic 3D for every card in 3D Pop-out mode, more realistic move animations, and the remaining architecture gaps.
- **The owner chose:** 3D from each card's own artwork (free, on the PC; no 360° AI models, no cloud service); a live camera scanner on the phone plus better detection in photos; free local AI models with a classic fallback; and the earlier plan's unbuilt stages (battle graphics, phone bottom menu, collection page) folded in after the new work.
- **Result:** `docs/ROADMAP.md`, with milestones M0–M11, one draft PR each. Nothing in it is built yet. The earlier plan's stage 1 (full-window battle screen) is already merged (PR #15).
- **Checked while planning:** the bundled OpenCV.js has `grabCut`, `inpaint`, `HoughLinesP`, `CLAHE`, `distanceTransform`, `ORB`, `findHomography` and `readNetFromONNX`, so the classic fallbacks need no new library.

## Phase 24: Roadmap M0, foundations

- **Versioned migrations:** `server/migrations.js` runs each change once, in a transaction with its `PRAGMA user_version` bump; a failure rolls both back. Migration 1 is the baseline: the column checks `openDb` used to make on every start, kept idempotent so databases from any earlier version end up the same. A database newer than the app (after the desktop updater rolls back) is opened as it is, with a warning.
- **Workers:** `public/js/workers/rpc.js` (`connect` / `serve` / `transfer`) lets the page call a Web Worker like an async library, with buffer transfer, progress, timeouts and cancel. Unit-tested over a `MessageChannel`.
- **AI runtime:** `onnxruntime-web` 1.30.0 (MIT) served at `/vendor/ort`; `public/js/ai/runtime.js` (WebGPU where available, else WebAssembly; one thread, because cross-origin isolation would block official card pictures from other sites).
  - **Model store:** `server/aiModels.js` and `/api/ai/models` download each listed model once, with a size cap and a SHA-256 check. The hash is either in the manifest or pinned on first download, because Hugging Face can't be reached from the build sandbox.
  - The manifest is empty until M1 and M5 add models.
  - **Tests:** an e2e step runs a hand-written ONNX model (`tests/helpers/tiny-onnx.js`) on the page and in a module worker.
- **Scan benchmark:** `npm run bench:scan`, `scripts/scan-bench/` and `scripts/make-scan-set.mjs`.
  - **Labels:** `tests/fixtures/scan/reference.json` (5 cards, corners checked on overlays).
  - **Synthetic set:** 30 photos of real card faces pasted with perspective onto wood, light, patterned and dark tables, rows, binder pages, with glare, sleeves and blur.
  - **Baseline** (recorded in ROADMAP A4): reference 100%, binder 96%, synthetic overall 46%, and 0 confident-but-wrong. M1 has to reach 95%.
- **CI:** `.github/workflows/ci.yml`:
  - **Linux:** `npm test`, e2e and the benchmark, keeping the results and any failure screenshot.
  - **Windows:** `npm test`.
  - `playwright` 1.63.0 is now a devDependency; the desktop updater installs with `--omit=dev`.
  - The first run showed two picture tests reaching the real image hosts the catalog guesses (blocked in the sandbox, open on GitHub). `mockCatalog` now downloads from the mock server only. It also showed that a PokemonPriceTracker picture's size was read from its whole address, so a port such as `:38001` ranked a 200w picture as an 800w one; only the key and path count now. On the Windows runner, CRLF checkouts pushed `MEMORY.md` over its budget; the size test counts `\n` line endings.

## Phase 25: Roadmap M1, detection v2

- **Card finder split up:** `public/js/vision/`, with `vision.js` keeping its exports.
  - `geometry.js`, `score.js`, `snap.js`, `colour.js`, `lines.js` and `sleeve.js` are plain maths, unit-tested in `tests/vision.test.js`.
  - `detect.js` runs the strategies on raw pixels with OpenCV passed in.
- **Worker:** finding runs in `workers/vision.worker.js` through `workers/rpc.js`, falling back to the page if a worker can't start.
  - OpenCV.js is fetched and run inside the module worker.
  - A photo takes about 250 ms; the longest main-thread task is about 50 ms.
  - Gradients now read OpenCV's typed arrays once: its `.data32F` getter made a new view per pixel, which had cost about 400 ms a photo.
- **New strategies:**
  - `background`: the table's colours (k-means in Lab over the photo's outer ring), and whatever is far from them;
  - `lines`: 63:88 rectangles from long straight edges, in lightness and colour.
- **Choosing outlines:**
  - each outline is snapped on a colour gradient, and straightened onto nearby straight edges when that keeps it card-shaped and gives clearer edges;
  - outlines are ranked by their weakest side;
  - groups of cards (a 2×2 block of pockets) and parts of a card (a half ending at the picture's frame, found because the card's edges carry on past it) are recognised, and a part proposes the whole card;
  - a sleeve's bright rim with the card's edge just inside is peeled.
- **Reading retry:** an unsure reading is retried on cuts with 0.8% wider and with no margin (the Froakie promo's set line read only at one margin). Tesseract's engine diagnostics on noisy text are ignored by the e2e error check.
- **Quality:** `vision/quality.js` measures each cut-out card's blur (Laplacian variance), glare (blown-out share) and size, and the Add page shows "Retake suggested: …" with a tip. Thresholds come from the benchmark.
- **Benchmark:** synthetic detection 46% → 93% (target 95%; misses: patterned cloth with sleeves or blur). The reference photos stay at 100%; `bench:scan` now also reports the longest main-thread task. Orientation by read confidence and the labelling page moved to M2.

## Phase 26: Roadmap M2, reading v2 and rarity counts from TCGdex

- **R1, rarity counts from TCGdex:** the Pokémon TCG dataset gets no new sets after its API closes (2027-03-01).
  - TCGdex's card list has no rarity, but its filters do exact matches: `/cards?set=eq:<id>&rarity=eq:<name>`, one per name from `/rarities`. This was confirmed in TCGdex's own `QueryEngine/parsers.ts`: without `eq:` a value means "contains".
  - `catalog.rarityProfile()` uses TCGdex when it lists the whole set (counted cards ≥ 90% of the total), else the dataset.
  - Checklists ask TCGdex for rarities when the dataset lacks the set.
- **Reading:**
  - the set line is located by its text (`vision/textline.js`, row-wise contrast) and read beside the fixed band;
  - name-only search when no set code was read;
  - a one-digit-off number in a matching set suggests the card for checking (never auto-linked);
  - unmatched cards are read turned round automatically.
  - Cards read correctly went from 72% to 81%. Two ideas were measured and dropped (see ROADMAP A5).
- **Scanner tests (owner):** Profile → Scanner tests (`#/scan-tests`) marks the cards in your own photos with the crop editor, pre-filled by the scanner's reading. Save keeps the photo and labels in `<data>/scan-bench/` (`/api/scan-labels`, owner only).
  - This is the one place the server keeps a whole photo. The owner chose it, and it is noted in MEMORY.md's rules.
  - `bench:scan` reads these photos as the `own` group (it follows `DATA_DIR`).
  - The benchmark gained an upside-down group.

## Phase 28: Card dioramas in 3D Pop-out (owner's card-effects package)

- **The package:** 27 diorama PNGs (made with an image model, outside the app), the owner's card records, a manifest, and a Python generator for OpenAI's paid image API.
- **The owner's choices:**
  - store the 27 as WebP in the repository (about 10 MB instead of 70 MB);
  - show them in 3D Pop-out;
  - make new ones with a free method of our own, so the paid generator isn't used.
- **Delivered dioramas:**
  - `assets/card-effects/<id>.webp` + `manifest.json`; every PNG's SHA-256 was checked against the package's manifest first.
  - `CardDioramas.importBundled()` copies each into `data/card-effects/` only for the collection card with that id and the same name or card id.
  - The ids are the owner's own collection ids; two Armarouge copies keep separate pictures.
- **Free generator** (`public/js/dioramaMaker.js`):
  - **Look:** lavender studio, metal pedestal with a glowing ring and Poké Ball emblem, the card in a holographic frame, ribbons and particles in the type's colours, and a small card at the lower right.
  - **Cut-out:** OpenCV GrabCut on the picture window, keeping the largest shape, and rejected when it takes the whole background (more than 52% of the window, or along its edges).
  - **Speed:** 1–4 s per card in the browser.
- **Jobs** (`server/cardDioramas.js`, table `card_dioramas`, created in the schema rather than a numbered migration):
  - a new card is queued once; a fingerprint of name, card id, category, types and picture decides when to make it again (never for price or storage);
  - stale uploads are refused (409); a claimed job is leased for 3 minutes;
  - a failure stays failed until **Try again**;
  - only the card's owner sees its jobs and pictures;
  - dioramas of purged cards are removed.
- **In the app:**
  - `public/js/dioramas.js` runs the maker in the background while the app is visible and is woken when cards are saved;
  - 3D Pop-out shows a copy's diorama as a finished scene, ahead of the 3D model;
  - the card page shows the diorama, its state, and **Try again** / **Make a 3D diorama**.
- **Tests:** server (import matching, one job per new card, price edits don't repeat it, relinking does, failure and retry, access), the generator's plain parts, and an e2e step: a card's diorama is made in the browser and shown in 3D Pop-out and on its page.

## Environment limits seen during development
The cloud sandbox could reach only GitHub (including raw files) and the npm registry. TCGdex, eBay,
PokemonPriceTracker, tcgcsv.com and Scrydex were blocked, so those integrations are tested
against local mocks (`tests/helpers/mock-sources.js`) built from their docs and source code. The owner can
check the real services with `npm run check:live`.
