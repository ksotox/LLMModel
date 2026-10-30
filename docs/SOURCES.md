# Sources, websites and APIs

This page lists every outside service, dataset, library and reference the app uses or was built from.
Everything the app calls at run time is **free**. Only PokemonPriceTracker needs a key, and the eBay API needs eBay's approval. The app scrapes no websites.

## Called by the app at run time

| Service | Base URL (env override) | Used for | Code | Key? |
| --- | --- | --- | --- | --- |
| **TCGdex** REST API v2 | `https://api.tcgdex.net/v2/en` (`TCGDEX_URL`) | Main card database: sets, cards, name search, rarity, TCGplayer/Cardmarket prices, TCGplayer product id | `server/tcg.js` | No |
| **TCGdex assets** | `https://assets.tcgdex.net/en/<series>/<set>/<number>/high.png` | Official card images (a local copy is saved) | `server/tcg.js` | No |
| **Pokémon TCG dataset** (GitHub, PokemonTCG/pokemon-tcg-data) | `https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master` (`PTCG_DATA_URL`) | Second card source and images when TCGdex has no match; rarity counts per set for pull chances | `server/ptcgData.js` | No |
| **pokemontcg.io image CDN** (`images.pokemontcg.io`) | URLs come from the dataset above | Card images for cards found in the dataset | `server/ptcgData.js` | No |
| **tcgcsv.com** | `https://tcgcsv.com/tcgplayer/3` (`TCGCSV_URL`) | Backup TCGplayer prices and product pictures (category 3 = Pokémon): `/groups`, `/<groupId>/products`, `/<groupId>/prices`. Sets are found by their TCGplayer group id, listed in `server/setCodes.js` and taken from TCGdex's data files. | `server/prices.js` | No |
| **TCGplayer image CDN** | `https://tcgplayer-cdn.tcgplayer.com/product/<id>_in_1000x1000.jpg` (then `_400w`, `_200w`) | Official picture of a card when TCGdex and the dataset have none, e.g. Mega Evolution promos (MEP) | `server/prices.js`, `server/catalog.js` | No |
| **PokemonPriceTracker (pictures)** | same API, `GET /cards?search=<name>` | Last resort for a card no other source has a picture for: its picture links and TCGplayer product id (→ TCGplayer image). One search per card, inside the daily credit budget | `server/priceTrackerService.js` (`pictureUrls`) | `POKEMONPRICETRACKER_API_KEY` |
| **Scrydex / pokemontcg.io image hosts** | `https://images.scrydex.com/pokemon/<set>-<n>/large`, `https://images.pokemontcg.io/<set>/<n>_hires.png` | Last-resort picture, at the address the dataset would use for a card it doesn't list yet (e.g. `mep-59`) | `server/catalog.js` | No |
| **Frankfurter** (ECB exchange rates) | `https://api.frankfurter.dev/v1` (`FX_URL`) | Converts Cardmarket euro prices to US dollars (`/latest?base=EUR&symbols=USD`, cached 12 h; `EUR_USD_RATE` fallback when offline) | `server/fx.js` | No |
| **eBay Marketplace Insights API** (`v1_beta`) | `https://api.ebay.com` | Sold listings from the last 90 days. OAuth client credentials, scope `buy.marketplace.insights`, `item_sales/search` in category 183454 (CCG Individual Cards) | `server/ebay.js` | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`; eBay must approve the app |
| **eBay.com "Sold items" search** | `https://www.ebay.com/sch/i.html?…&LH_Sold=1&LH_Complete=1` | Opened in the user's own browser. The user copies the results and pastes them into the app; the app never fetches eBay pages itself. | `server/ebay.js`, `public/js/ebay.js` | No |
| **PokemonPriceTracker** API v2 | `https://www.pokemonpricetracker.com/api/v2` (`POKEMONPRICETRACKER_URL`) | `GET /cards` with history and eBay data: eBay sales by grade, recent price history, population. Free tier: 100 credits a day. | `server/priceTracker.js`, `server/priceTrackerService.js` | `POKEMONPRICETRACKER_API_KEY` |

### Where prices come from, in order
All prices are shown in US dollars.
1. TCGplayer market price (USD) from TCGdex, using the price for the card's variant (e.g. reverse holo).
2. TCGplayer price (USD) from tcgcsv.com.
3. Cardmarket trend price (EUR) from TCGdex, converted to USD with the day's ECB rate (Frankfurter).
4. Optional: PokemonPriceTracker market price and eBay graded averages, saved into the local price history.

### Pull-rate data
Per-pack rates for Double Rare and higher come from **TCGplayer's published pack-opening studies**:
Scarlet & Violet base set (8,000+ packs), Scarlet & Violet—151, Temporal Forces (8,000+ packs) and
Phantasmal Flames (5,000+ packs). Other Scarlet & Violet and Mega Evolution sets use the average for their era. The
numbers and their attribution are in `server/pullRates.js`, and each card shows its source in the UI.

## Libraries (npm)

| Package | Version | Used for |
| --- | --- | --- |
| [express](https://expressjs.com/) | ^5.1 | HTTP server and routes |
| [multer](https://github.com/expressjs/multer) | ^2.0 | Photo uploads (multipart) |
| [@techstark/opencv-js](https://github.com/TechStark/opencv-js) (OpenCV.js) | 4.12.0 | Finding cards in photos, edge snapping, perspective straightening (in the browser) |
| [tesseract.js](https://tesseract.projectnaptha.com/) | 7.0.0 | OCR of the card name, set code and number (in the browser) |
| [@tesseract.js-data/eng](https://github.com/naptha/tessdata) | 1.0.0 | English OCR model, served by the app |
| `node:sqlite` | built into Node ≥ 22.5 | The collection database |
| [Playwright](https://playwright.dev/) | preinstalled | Browser e2e test (not a project dependency) |

OpenCV.js, Tesseract.js and the OCR model are served by the app itself from `node_modules` (`/vendor/*`), so no CDN is involved.

## Documentation and references used while building

- **TCGdex:** docs at [tcgdex.dev](https://tcgdex.dev) ([card reference](https://tcgdex.dev/reference/card), [filtering, sorting and pagination](https://tcgdex.dev/rest/filtering-sorting-pagination)). Its server code at [github.com/tcgdex/cards-database](https://github.com/tcgdex/cards-database) was used to confirm:
  - the set and card endpoint fields, and the query parser and filter;
  - the TCGplayer (via tcgcsv) and Cardmarket price providers;
  - the set data files for Paldea Evolved, Obsidian Flames, the Mega Evolution sets, Black Bolt and White Flare (set codes and card counts).
- **Pokémon TCG dataset:** [github.com/PokemonTCG/pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data) (`sets/en.json`, `cards/en/<set>.json`). Real files for a few sets are in `tests/fixtures/ptcg`. The pokemontcg.io API itself was not used, because its future was unclear after the move to Scrydex ([scrydex.com/faq](https://scrydex.com/faq)).
- **tcgcsv.com:** [tcgcsv.com](https://tcgcsv.com/), a daily dump of TCGplayer's catalogue and prices.
- **eBay:** [developer.ebay.com](https://developer.ebay.com/), Marketplace Insights API (limited release). Background on the 2025 shutdown of `findCompletedItems`:
  - [dev.to/trawl, eBay sold listings API in 2026](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)
  - [soldcomps.io, Marketplace Insights access](https://www.soldcomps.io/blog/ebay-marketplace-insights-api-access)
- **PokemonPriceTracker:** [pokemonpricetracker.com/api-docs](https://www.pokemonpricetracker.com/api-docs). Its examples show differing response layouts, so `normalizeCard` reads several of them.
- **Pull rates:** TCGplayer pack-opening studies, found through web searches for each set.
- **Reference photos:** the owner's own card photos in `docs/reference/` (Voltorb, Punk Helmet and Linoone group photo; Voltorb reverse-holo close-up; Froakie promo). They are used by the upload feature design and the tests.

## Not used, on purpose
- **Scraping** eBay, TCGplayer or any other site. It is against their terms and breaks easily.
- **Paid APIs.** Every source above has a free route.
- **Cloud OCR or vision services.** Photos never leave the user's browser.
