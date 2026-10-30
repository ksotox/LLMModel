# My Pokédex — a personal Pokémon card collection catalog

Catalog the Pokémon cards you pull and the packs, tins, kits and bundles they came from.

- **Upload cards one at a time or in batches.** Add as many photos as you like. A photo of several cards on a table (like [`docs/reference/three-cards.jpg`](docs/reference/three-cards.jpg)) is split into separate cards automatically, and you can adjust the boxes in a crop editor. A close-up of one card (like [`docs/reference/voltorb-reverse-holo.jpg`](docs/reference/voltorb-reverse-holo.jpg)) is cropped to the card.
- **Optionally record where each card came from.** Upload one or more photos of packs, tins, kits, bundles, Elite Trainer Boxes and so on (or add one without a photo), and link the cards to them.
- **Official artwork when it exists.** Type the set code and number printed at the bottom left of the card (e.g. `PAL` `066/193`), or just the name, and the app finds the card in the free [TCGdex](https://tcgdex.dev) database. If TCGdex has no match or no picture, it checks the open [Pokémon TCG dataset](https://github.com/PokemonTCG/pokemon-tcg-data), which covers every English set. It keeps a local copy of the official image next to your own photo.
- **Rarity, pull chance and price on every card.** Each card shows its rarity (● Common, ◆ Uncommon, ★ Rare, ★★ Double Rare…), an **estimated chance of pulling it from one booster pack**, and an **estimated market price**. The collection page adds up the total value. Prices refresh automatically when you open a card, or all at once with **Update prices**.
- **Search any card.** The **Search** page looks up any Pokémon card, not just the ones you own, with its rarity, pull chance and price, and you can add it to your collection in one click.
- **Date added is recorded** for every card and pack.
- **Saved between sessions.** Everything goes into a SQLite database and an image folder on disk, so it's still there after you close the browser or restart the server.
- **Searchable.** Search the whole collection by name, set, number (`066/193`), rarity, type, variant, pack name or notes. You can filter by pack/bundle (or "not from a pack") and by set, or search inside a single pack.

| Add cards (auto-split + official match) | Crop / split editor |
| --- | --- |
| ![Add cards](docs/screenshots/02-add-cards.png) | ![Crop editor](docs/screenshots/03-crop-editor.png) |
| **Collection** | **Card: your photo + official image** |
| ![Collection](docs/screenshots/05-collection.png) | ![Card detail](docs/screenshots/06-card-detail.png) |
| **Search any card** | **Rarity, pull chance and price** |
| ![Search](docs/screenshots/10-search.png) | ![Search result](docs/screenshots/09-search-card.png) |

> The screenshots come from the automated test, which runs against a mock card database, so the "official" images there are flat placeholder colours. In normal use they are the real card PNGs.

## Running it

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite`).

```bash
npm install
npm start            # http://localhost:3000
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the database (`collection.db`) and images are stored. Back up this folder to back up your collection. |
| `TCGDEX_URL` | `https://api.tcgdex.net/v2/en` | Main card database (cards, images, prices) |
| `PTCG_DATA_URL` | `https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master` | Second card source (cards, images, rarities) |
| `TCGCSV_URL` | `https://tcgcsv.com/tcgplayer/3` | Backup price source (TCGplayer prices) |

To check which online sources your computer can reach, run `npm run check:live`. It looks up the three reference cards in every source and prints what each one returns.

To use it from your phone, run it on a computer on your home network and open `http://<computer-ip>:3000`. The **Take photo** button opens the camera.

## How to add cards

1. Go to **+ Add**.
2. *(Optional)* Under **Pulled from**, pick an existing pack, or choose **New pack, tin, kit or bundle…** and upload one or more photos of them.
3. Drop in card photos. Cards are found in each photo automatically. Use **Adjust cards** / **Crop / split** to fix the boxes: draw, drag, resize, delete, *Auto-detect* again, *Split evenly* (e.g. 3 × 1) or *Whole photo*.
4. For each card, type the **set code** and **number** from the bottom-left corner, or the **name**. Matching official cards appear, and if there's exactly one it is selected for you. Set the variant (reverse holo, holo…) if you like.
5. Click **Save**. If the online database can't be reached, the card is still saved with your photo. You can link it later from the card's **Find official card** / **Retry official image** buttons.

## Where the numbers come from

| | Source | Notes |
| --- | --- | --- |
| Card details & images | [TCGdex](https://tcgdex.dev), then the [Pokémon TCG dataset](https://github.com/PokemonTCG/pokemon-tcg-data) | Both are free and need no API key. |
| Rarity | The card's own data | Same rarity names as printed on the card. |
| Market price | TCGplayer market price (USD) via TCGdex, then Cardmarket trend (EUR) via TCGdex, then TCGplayer via [tcgcsv.com](https://tcgcsv.com) | Uses the price for your variant (e.g. reverse holo) when there is one. Prices change: treat them as a guide, not an offer. |
| Pull chance | Calculated | See below. |

**Pull chance** is an *estimate* for one booster pack:

> chance = (how many cards of that rarity an average pack holds) ÷ (how many cards of that rarity are in the set)

- Commons: 4 per pack. Uncommons: 3 per pack. Reverse holos: about 2 per pack, shared with every common, uncommon and rare.
- Double Rare, Ultra Rare, Illustration Rare, Special Illustration Rare, Hyper Rare and ACE SPEC use the per-pack rates published by TCGplayer from thousands of opened packs. Scarlet & Violet base set, 151, Temporal Forces and Phantasmal Flames use their own studies. Other Scarlet & Violet and Mega Evolution sets use the era average.
- The number of cards of each rarity in a set comes from the Pokémon TCG dataset.
- There's no estimate for older eras or for special sets with a different pack layout (Paldean Fates, Prismatic Evolutions, Black Bolt / White Flare, Ascended Heroes, 30th Celebration, promos…).

Real odds vary by product (booster packs, ETBs, bundles) and from box to box, so this tells you how rare a card is, not what you'll pull.

## Project layout

```
server/
  index.js      start-up (env config)
  app.js        Express routes: cards, packs, lookup, uploads, media
  db.js         SQLite schema + queries (search, filters, stats)
  catalog.js    combines the sources: search, details, image fallback, market info
  tcg.js        TCGdex client: lookup by set code/number/name, details, prices, image download
  ptcgData.js   Pokémon TCG dataset client (second source, rarity counts per set)
  prices.js     picks the right price for a variant; tcgcsv.com backup prices
  pullRates.js  pull-chance estimates
  setCodes.js   printed set codes (PAL, OBF, PFL…) → TCGdex set ids
public/         no-build frontend (vanilla ES modules)
  js/add.js     upload flow for cards and packs
  js/cropper.js crop / split editor
  js/images.js  cropping + automatic card detection in photos
  js/lookup.js  official-card picker
  js/views.js   collection, packs, pack page, card dialog
  js/search.js  search any card online
tests/
  api.test.js     API tests (node:test) against mock sources
  market.test.js  pull chances, prices, second source, market API
  fixtures/ptcg   real Pokémon TCG dataset files for a few sets
  e2e/run.js    browser walkthrough with Playwright using docs/reference photos
docs/reference/ the reference photos used for the upload feature and the tests
```

### API

| Method & path | Description |
| --- | --- |
| `GET /api/cards?q=&packId=&setCode=&sort=` | Search / list cards (`packId=none` for cards not from a pack; `sort` = `oldest`, `name`, `set`, `value` or `rarity`) |
| `POST /api/cards` | Add one or more cards: multipart with `cards` (JSON array) and one image per card referenced by `photoField` |
| `PATCH /api/cards/:id` | Edit a card. Changing `tcg_id` re-links it and fetches the official image |
| `POST /api/cards/:id/refresh-official` | Retry downloading the official image |
| `POST /api/cards/:id/refresh-market` · `POST /api/cards/refresh-market` | Refresh rarity, pull chance and price for one card · for every card |
| `GET /api/catalog/cards/:id?variant=` | Any online card with its rarity, pull chance and price |
| `POST /api/cards/:id/photo` · `DELETE /api/cards/:id` | Replace photo · delete |
| `GET /api/packs?q=` · `POST /api/packs` | List · add one or more packs (same multipart format, key `packs`) |
| `PATCH /api/packs/:id` · `POST /api/packs/:id/photo` · `DELETE /api/packs/:id[?withCards=1]` | Edit · replace photo · delete (cards are kept unless `withCards=1`) |
| `GET /api/lookup?name=&setCode=&number=` | Search the online card database |
| `GET /api/meta` | Pack kinds, variants, known set codes, stats |

## Tests

```bash
npm test             # API tests
npm run test:e2e     # browser walkthrough (needs Playwright + Chromium); SCREENSHOTS=1 refreshes docs/screenshots
```

Both suites use local mocks of the online sources (`tests/helpers/mock-sources.js`), so they don't need internet access. The Pokémon TCG dataset mock serves real data files.
