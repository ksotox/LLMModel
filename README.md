# My Pokédex — a personal Pokémon card collection catalog

Catalog the Pokémon cards you pull and the packs, tins, kits and bundles they came from.

- **Upload cards one at a time or in batches.** Add as many photos as you like. A photo of several cards on a table (like [`docs/reference/three-cards.jpg`](docs/reference/three-cards.jpg)) is split into separate cards automatically, and you can adjust the boxes in a crop editor. A close-up of one card (like [`docs/reference/voltorb-reverse-holo.jpg`](docs/reference/voltorb-reverse-holo.jpg)) is cropped to the card.
- **Optionally record where each card came from.** Upload one or more photos of packs, tins, kits, bundles, Elite Trainer Boxes and so on (or add one without a photo), and link the cards to them.
- **Official artwork when it exists.** Type the set code and number printed at the bottom left of the card (e.g. `PAL` `066/193`), or just the name, and the app finds the card in the free [TCGdex](https://tcgdex.dev) database. It keeps a local copy of the official PNG next to your own photo.
- **Date added is recorded** for every card and pack.
- **Saved between sessions.** Everything goes into a SQLite database and an image folder on disk, so it's still there after you close the browser or restart the server.
- **Searchable.** Search the whole collection by name, set, number (`066/193`), rarity, type, variant, pack name or notes. You can filter by pack/bundle (or "not from a pack") and by set, or search inside a single pack.

| Add cards (auto-split + official match) | Crop / split editor |
| --- | --- |
| ![Add cards](docs/screenshots/02-add-cards.png) | ![Crop editor](docs/screenshots/03-crop-editor.png) |
| **Collection** | **Card: your photo + official image** |
| ![Collection](docs/screenshots/05-collection.png) | ![Card detail](docs/screenshots/06-card-detail.png) |

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
| `TCGDEX_URL` | `https://api.tcgdex.net/v2/en` | Card database API base URL |

To use it from your phone, run it on a computer on your home network and open `http://<computer-ip>:3000`. The **Take photo** button opens the camera.

## How to add cards

1. Go to **+ Add**.
2. *(Optional)* Under **Pulled from**, pick an existing pack, or choose **New pack, tin, kit or bundle…** and upload one or more photos of them.
3. Drop in card photos. Cards are found in each photo automatically. Use **Adjust cards** / **Crop / split** to fix the boxes: draw, drag, resize, delete, *Auto-detect* again, *Split evenly* (e.g. 3 × 1) or *Whole photo*.
4. For each card, type the **set code** and **number** from the bottom-left corner, or the **name**. Matching official cards appear, and if there's exactly one it is selected for you. Set the variant (reverse holo, holo…) if you like.
5. Click **Save**. If the online database can't be reached, the card is still saved with your photo. You can link it later from the card's **Find official card** / **Retry official image** buttons.

## Project layout

```
server/
  index.js      start-up (env config)
  app.js        Express routes: cards, packs, lookup, uploads, media
  db.js         SQLite schema + queries (search, filters, stats)
  tcg.js        TCGdex client: lookup by set code/number/name, details, image download
  setCodes.js   printed set codes (PAL, OBF, PFL…) → TCGdex set ids
public/         no-build frontend (vanilla ES modules)
  js/add.js     upload flow for cards and packs
  js/cropper.js crop / split editor
  js/images.js  cropping + automatic card detection in photos
  js/lookup.js  official-card picker
  js/views.js   collection, packs, pack page, card dialog
tests/
  api.test.js   API tests (node:test) against a mock TCGdex
  e2e/run.js    browser walkthrough with Playwright using docs/reference photos
docs/reference/ the reference photos used for the upload feature and the tests
```

### API

| Method & path | Description |
| --- | --- |
| `GET /api/cards?q=&packId=&setCode=&sort=` | Search / list cards (`packId=none` for cards not from a pack; `sort` = `oldest`, `name` or `set`) |
| `POST /api/cards` | Add one or more cards: multipart with `cards` (JSON array) and one image per card referenced by `photoField` |
| `PATCH /api/cards/:id` | Edit a card. Changing `tcg_id` re-links it and fetches the official image |
| `POST /api/cards/:id/refresh-official` | Retry downloading the official image |
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

Both suites use a local mock of the TCGdex API (`tests/helpers/mock-tcgdex.js`), so they don't need internet access.
