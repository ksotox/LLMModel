# Roadmap: scanner v2, 3D Pop-out for every card, animated moves, and the gaps to close

## Context
The owner asked for an architecture plan to execute, covering:
1. a better card scanner (camera and text reading);
2. automatic 3D for every card in 3D Pop-out mode;
3. more realistic, animated moves in PokéBattles;
4. remaining architecture recommendations and gaps.

The owner's choices:
- **3D for all cards:** made from each card's own artwork, free, on the owner's PC. No 360° AI models and no cloud service.
- **Scanner:** live camera on the owner's phone, plus better detection in photos. Recognising cards by their picture is not in scope; it is listed as a later option.
- **AI models:** free models, downloaded once and run on the owner's devices, with a classic fallback.
- **Earlier plan:** its unbuilt stages (battle graphics, phone bottom menu, tidier collection page) are folded in after the new work.

**Status (2026-11-12):** approved by the owner. M0 is done (PR #16, merged). M1 is done (PR #17), M2 is done (PR #18): synthetic detection 93% against the 95% target (see A4). The rest is not started. Build the milestones in order, one draft PR each. Tick a milestone off in the table below when its PR is merged.

## Where things stand (facts the executor needs)
- **Repo:** `ksotox/LLMModel`, branch `claude/pokemon-collection-catalog-aw6vsc`, `main` at PR #15. Node ≥ 22.5, Express 5, `node:sqlite`, vanilla ES modules with no build step, three.js 0.180 served from `/vendor/three`.
- **Scanner today:**
  - `public/js/add.js` takes photos from a file input. There is no live camera.
  - `public/js/vision.js` `findCards` finds card outlines two ways (Otsu brightness and Canny edges), scores each quad, snaps it to the real edge, and `warpCard` straightens it. It runs on the main thread.
  - `public/js/ocr.js` `readCardText` reads fixed regions with Tesseract (name strip and set line, 9 readings).
  - `server/identify.js` `identifyCard` votes across the readings and returns high / medium / low confidence.
- **OpenCV.js already bundled** (checked in Node): it has `grabCut`, `inpaint`, `HoughLinesP`, `CLAHE`, `adaptiveThreshold`, `distanceTransform`, `Laplacian`, `ORB`, `findHomography` and `readNetFromONNX`.
- **Pop-out today:**
  - `public/js/pokemon-popout.js` holds the switch, 4 prepared scenes, and `registerArtwork` with `{scene}` or `{background, foreground}` layers.
  - `public/js/popoutRender.js` draws a Pokémon's species model once and saves it through `/api/popout/pictures/<form>/<id>`.
  - Trainers, Energy and unmatched Pokémon stay flat.
  - The Pokédex number is looked up per request and not stored.
- **Battles today:**
  - `public/js/battle/scene.js` (948 lines) has `attack()` (step back, lunge, one particle stream per type colour), `hit()` (shake, flash) and `faint()`.
  - Models have no skeletons.
  - Engine events (`engine.js`): `use`, `coins`, `hit`, `heal`, `energy`, `boost`, `ko`, `end`.
  - A new renderer and world are built for every battle, showcase and rematch.
- **Sandbox limits:**
  - The cloud sandbox reaches only GitHub and npm, so TCGdex and Hugging Face are untested there; use mocks, and extend `npm run check:live` for the owner to run.
  - There is no GPU, so 3D e2e steps are slow (90 s limits).

## Rules that still hold
- **Photos stay in the browser.** The server gets only the cropped card and text readings.
- **Free sources only.**
- **Typed text wins:** automatic readings never overwrite what the user typed.
- **No native npm dependencies.**
- **Assets:** nothing derived from card art or Nintendo models goes into git; it lives in `data/`.
- **Workflow:**
  - one draft PR per milestone;
  - `npm test` and `npm run test:e2e` green before pushing;
  - update `MEMORY.md` (≤ 10 KB), `docs/HISTORY.md`, `docs/USER_GUIDE.md`;
  - merge only when the owner says "merge";
  - no model names in commits or PRs.

## Workstream A: Scanner v2

### A1. One detection module, off the main thread
- Move `vision.js` into `public/js/vision/`:
  - `detect.js`: the pipeline;
  - `strategies/*.js`: one file per way of finding outlines;
  - `score.js`, `quality.js`;
  - `warp.js`: the existing `warpCard`.
- Run it in a Web Worker (`public/js/workers/vision.worker.js`) behind a small request/response helper (`workers/rpc.js`). Photos go in as `ImageBitmap`. `images.js` `cardQuads` keeps its signature.
- **Strategies** (each returns candidate quads; all are scored and merged as today):

  | Strategy | Finds |
  |---|---|
  | brightness (existing), edges (existing) | cards on plain tables |
  | adaptive threshold + CLAHE | uneven light, glare |
  | colour distance from the photo's border colour (Lab) | dark cards on dark tables |
  | lines (`HoughLinesP` → rectangles of 63:88) | borderless full-art cards, sleeves, toploaders |
  | grid completion | binder pages: when 4+ quads form a grid, the missing cells are inferred |
  | saliency mask (AI, when available) | cluttered backgrounds |

- **Scoring** adds two terms to today's aspect × fill × parallel:
  - edge support along all four sides (reusing `snapToEdges`' measure);
  - agreement with the other cards' size in the same photo.
- **Quality gates** (`quality.js`): sharpness (variance of `Laplacian`), glare share, and size in pixels. A weak crop gets "Retake: blurry / glare / too small" instead of a silent bad read.
- **Orientation:** choose upright among the 4 rotations by reading confidence of the name strip, before the full read. This replaces today's retry-only 180° check.

### A2. Reading v2
- **Regions by layout:** `public/js/vision/layouts.js` describes name, HP and set-line regions per card kind (modern Pokémon, older eras, Trainer, Energy, full-art, Japanese). The set line is located by text components in the bottom strip, where today it is fixed fractions.
- **Confidence:** keep Tesseract's per-word confidence and send it with each reading. `identifyCard` weights votes by it. Add a digits-only pass for `NNN/NNN`.
- **Optional AI reader:** a small recognition model (PP-OCR mobile, Apache-2.0) through onnxruntime-web, behind the same `readCardText` interface. It is used only if the benchmark shows it beats Tesseract.
- **Rule kept:** `confidence === 'high'` is still required for automatic linking. The benchmark tracks "confident but wrong", which must stay at 0.

### A3. Live scanner on the phone
- **HTTPS listener** (`server/https.js`):
  - **Why:** phones only allow the camera in a web page over a secure connection.
  - **Certificate:** on first start the server creates a self-signed certificate in `data/tls/`, using the pure-JS `selfsigned` package, pinned.
  - **Ports:** it serves `https://<pc>:3443` beside `http://localhost:3000`. The desktop app keeps using http on localhost.
  - **Cookies:** session cookies are `Secure` on https.
  - **Phone page:** the Profile page shows the https address as a QR code, with the one-time "accept the warning" steps.
- **Scanner screen** (`public/js/scanner.js`, opened from Add cards):
  - a full-window camera view using `getUserMedia` with the rear camera;
  - the worker detects at low resolution several times a second, and outlines are drawn live;
  - **Auto-capture:** a full-resolution frame is taken when the same outline has been steady, sharp and glare-free for about half a second;
  - **No repeats:** a small picture fingerprint of the crop stops the same card being captured twice;
  - **Controls:** torch toggle, a count of captured cards, and a tray of thumbnails;
  - captured cards flow into the existing `addPhotos` → `buildSourceCards` review list.
- **Fallback:** without https or camera permission, the current "take a photo" button remains.

### A4. Benchmark (built first, used by A1–A3)
- **`npm run bench:scan`** runs the real pipeline in headless Chromium over:
  - the photos in `docs/reference/`;
  - a synthetic set (`scripts/make-scan-set.mjs`): fixture cards pasted on backgrounds with tilt, blur, glare, sleeves and binder grids, with known corners and identities;
  - the owner's own labelled photos in `data/scan-bench/` (git-ignored), listed in `data/scan-bench/labels.json` (same format as `tests/fixtures/scan/reference.json`; a page to label them comes with M1).
- **Reports:** detection recall and precision (corner error ≤ 2% of card width), top-1 identification, confident-wrong count, and time per card.
- **Targets:**
  - synthetic detection recall ≥ 95%;
  - binder pages ≥ 8 of 9 cards;
  - confident-wrong = 0;
  - no main-thread task over 100 ms while scanning.
- **Baseline (M0, 2026-11-11, today's `vision.js` and `ocr.js`, mock catalog, headless Chromium):**

  | Group | Photos | Cards | Found | Precision | Corner error | Read correct | Sure but wrong |
  |---|---|---|---|---|---|---|---|
  | reference | 3 | 5 | 100% | 100% | 0.06% | 100% | 0 |
  | synthetic-single | 6 | 6 | 17% | 17% | 1.43% | 1 of 1 | 0 |
  | synthetic-row | 5 | 15 | 7% | 11% | 1.51% | 1 of 1 | 0 |
  | synthetic-binder | 3 | 27 | 96% | 96% | 0.92% | 46% | 0 |
  | synthetic-dark | 4 | 8 | 100% | 100% | 0.86% | 63% | 0 |
  | synthetic-glare | 4 | 8 | 0% | 0% | — | — | 0 |
  | synthetic-sleeve | 4 | 8 | 13% | 25% | 1.11% | 1 of 1 | 0 |
  | synthetic-blur | 4 | 8 | 0% | 0% | — | — | 0 |

  Synthetic recall overall: 46% (target 95%). The misses were checked on overlays and are real detector faults, not label errors:
  - on wood, an edge snaps to the card's shadow or an inner line (3–7% corner error);
  - on a light desk the card isn't separated at all, and the whole photo is returned;
  - glare and blur break the outline.

  Finding takes about 230 ms a photo; reading a card about 640 ms.

- **After M1 (2026-11-12, `public/js/vision/`, finder in a worker):**

  | Group | Before | After |
  |---|---|---|
  | reference | 100% | 100% (corner error 0.06% → about 0.5%) |
  | synthetic-single | 17% | 100% |
  | synthetic-row | 7% | 93% |
  | synthetic-binder | 96% | 100% |
  | synthetic-dark | 100% | 100% |
  | synthetic-glare | 0% | 100% |
  | synthetic-sleeve | 13% | 63% |
  | synthetic-blur | 0% | 75% |
  | **synthetic overall** | **46%** | **93%** (target 95%) |

  - Binder pages pass; confident-but-wrong stays 0; the longest main-thread task while finding is about 50 ms (target 100 ms).
  - Finding takes about 250 ms a photo, in a worker.
  - **Reading:** the reference cards are read 5 of 5 and binder cards 56% (was 46%); 72% of the cards found are read correctly. An unsure reading is retried on cuts with slightly different margins, because the reader is that sensitive to the exact cut (a 2 px shift lost the Froakie promo). Making reading robust is M2's job.
  - **Still missed:** cards on the busy patterned cloth combined with a sleeve or blur (5 cards), and one near miss on a blurred photo (2.13%). Those are the next things to work on if real photos show the same.
  - **How M1 got there:**
    - strategies `background` (table colours from the photo's outer ring) and `lines` (63:88 rectangles from straight edges);
    - snapping on a colour gradient;
    - ranking by each outline's weakest edge;
    - groups of cards and parts of a card recognised, with a part completing to the whole card;
    - sleeves peeled.

### A5. M2 results (2026-11-12)
- **Cards read correctly** (of those found): 72% → **81%**. Target 85%: not met.
- **By group:** reference 5 of 5, binder 74%, upside down 4 of 5. Blurred photos: 0%, because the text itself is unreadable.
- **Confident but wrong:** stays 0.
- **What helped:**
  - the set line is found by its text (`vision/textline.js`) and read beside the fixed band;
  - with no set code read, the matcher also searches the name alone;
  - a number one digit off in a matching set gives "please check", never an automatic link;
  - a card nothing was matched for is read turned round too.
- **Tried and dropped:**
  - a digits-only read: it made a misread set total confident and gave a wrong match;
  - choosing upright by the name strip's OCR confidence: turned round, that strip holds the crisp copyright line, so upright cards got turned and accuracy fell to 54%.
- **Not done:** per-word confidence weighting (not needed for these results); the optional AI reader (not needed yet).
- **Scanner tests:** Profile → Scanner tests lets the owner mark cards in their own photos (`server/scanLabels.js`, `public/js/scanLabels.js`). `bench:scan` adds them as the `own` group. The photos stay on the owner's PC, by the owner's choice.

## Workstream B: 3D Pop-out for every card

### B1. Asset model
- **New table `popout_assets`**, with a versioned migration:
  - **key:** `tcg_id`, or a hash of the official image for unlinked cards;
  - `kind`: `scene` | `species` | `layers` | `relief` | `flat`;
  - `status`: `queued` | `ready` | `failed`;
  - `gen_version`, file names, quality score, timestamps.
- **Files** live in `data/popout/art/<key>/`. The existing species pictures (`data/popout/<form>/<id>.webp`) stay.
- **Routes** (`server/popoutAssets.js`, a router):
  - `GET /api/popout/assets?ids=`: status and URLs for a batch of cards;
  - `PUT /api/popout/assets/:key/:file`: signature-checked WebP/PNG, with a size cap, and the key must belong to a card the profile owns;
  - `POST /api/popout/assets/:key/retry`.
- **Invalidation:** bumping `GEN_VERSION` regenerates everything.

### B2. Which look a card gets
1. A prepared scene (`registerArtwork`), as today.
2. **Species model** for Pokémon, with better matching:
   - store the Pokédex number in a new `cards.dex_id` column when a card is linked;
   - backfill existing cards in the background;
   - owner-prefixed and Japanese names then resolve without a lookup (for example "Ethan's Typhlosion", "Team Rocket's Spidops").
3. **Own-art pop-out** for everything else (Trainers, Energy, items, Pokémon without a model), generated as in B3.
4. `flat` (today's tilted card on its pedestal) when the art gives no clean subject.

### B3. Generating from the card's own art
Runs in a worker (`public/js/popout/generate.worker.js`) on PC-class devices only. Phones display what the PC has made.
1. **Input:** the cached official image (`/media/official/...`). The server caches it first if it only has a web address.
2. **Art window:** find the illustration box using the layouts from A2. For full-art cards it is the whole card.
3. **Subject cut-out:**
   - AI saliency mask (U²-Net small, Apache-2.0), refined with `grabCut`;
   - without AI: `grabCut` seeded from the centre and the art-box border colour.
4. **Depth:**
   - AI depth (Depth Anything V2 Small, Apache-2.0);
   - without AI: a dome from `distanceTransform` inside the cut-out, plus brightness detail.
5. **Clean plate:** `inpaint` the art behind the subject, so lifting it leaves no hole.
6. **Quality gate:** a cut-out covering under 4% or over 85% of the art, or in many pieces, is marked `flat`.
7. **Saved:** `foreground.webp` (cut-out with a soft edge), `depth.webp`, `plate.webp` and `meta.json`.

### B4. Showing it
- **Grid:** the existing CSS layer path (`.pfx-foreground` over the tilted plate, type glow, pedestal). No WebGL per tile.
- **Relief picture:** one offscreen three.js render of a 128×128 plane, displaced by depth inside the cut-out, with the subject scaled past the card frame and a rim light. It is saved like the species pictures and used in the grid when ready.
- **Card page:** a live relief with pointer and gyroscope parallax, on one canvas.
- **Queue:**
  - visible tiles first, then the rest of the collection during idle time, one at a time;
  - paused while a battle runs or the tab is hidden;
  - a chip shows "3D ready: 37 of 212";
  - new cards are queued on save.

### B5. AI model store (shared with A)
- **`server/aiModels.js`:** a manifest of model files, each with URL, SHA-256, size and licence. Files are downloaded once into `data/ai-models/` and served at `/api/ai/models/:name`, the same pattern as `server/models3d.js` (listed files only, checksum, size cap).
- **Runtime:** onnxruntime-web (MIT) vendored at `/vendor/ort`, running on WASM, or WebGPU where present.
- **Fallback:** each consumer asks `aiAvailable(name)` and uses the classic path otherwise.
- **Licences:** use only models whose code and weights are Apache-2.0 or MIT. Do not use Ultralytics YOLO (AGPL) or RMBG (non-commercial).

## Workstream C: Moves that look alive

### C1. Structure (split `scene.js`)
| New file in `public/js/battle/` | Job |
|---|---|
| `stage.js` | renderer, loop, quality; one stage kept alive and reused between battles |
| `fighters.js` | loading, summon, idle |
| `camera.js` | base framing from both Pokémon's real sizes, plus additive tracks (push, swing, orbit, shake) |
| `timeline.js` | keyframed tracks with easing, skippable, with a reduced-motion variant; pure and unit-tested |
| `moves.js` | classifies an attack into a style; pure and unit-tested |
| `choreography.js` | turns a style into a timeline |
| `deform.js` | shader squash, stretch, bend and wobble for models without skeletons |
| `effects/` | particle pool, ribbons, rings, decals, one kit per element |
| `audio.js` | synthesised sound effects (WebAudio, no files), with a mute switch |

### C2. Move styles (`moves.js`)
- **Input:** attack name, card text, type, damage.
- **Output:** `{ family, element, power, flags }`.
- **Family** from name keywords, defaulting by type:

  | Family | Example keywords | Motion |
  |---|---|---|
  | contact | tackle, bite, slash, punch, kick, tail, headbutt | dash to the target, strike, spring back |
  | projectile | ball, shot, bullet, seed, needle | wind-up, throw, travel, impact |
  | beam | beam, ray, blast, cannon, flamethrower, pulse | brace, a sustained beam with recoil |
  | area | quake, storm, wave, surf, blizzard | stomp or raise, effect across the field |
  | sky | thunder, bolt, meteor, drop | strikes from above |
  | self | heal, draw, search, energy, call | glow and rise, no travel |

- **Power tier** from damage: light < 50, medium, heavy ≥ 100, massive ≥ 200. It scales timing, shake, particle count and hit-stop.
- **Element** = the 11 card types, with a kit each (flame, water, lightning, leaves, rings, rock and dust, shadow, metal sparks, dragon beam, stars, white impact). Colours come from `TYPE_COLORS`.

### C3. What makes it read as real
- **Animation principles:** anticipation, a fast action, a 60–90 ms hit-stop on contact, follow-through, and settle.
- **Body:** `deform.js` uniforms give squash on landing, stretch in a dash, a lean into acceleration (a damped spring), and a ripple on being hit. A model's own clips still play when it has them.
- **Target:** knocked back on a spring, a white shader flash, and dust at its feet. Weakness hits are bigger.
- **World reacts:**
  - grass bends away from a shockwave (an impulse uniform in the grass shader);
  - scorch, puddle or crack decals fade out;
  - light flickers on lightning.
- **Camera:** push in on wind-up, swing to the target on impact, orbit the winner. Off with reduced motion and on Basic.
- **Extras:** a 3D coin toss for coin flips; turn-start hop; KO topple with dust; victory hop.
- **Budgets:** particle caps per graphics level, pooled objects, and no per-frame allocation.

### C4. Hooks
- `battles.js` passes the attack to the stage: `stage.attack(who, { move, type, damage })`. The engine stays pure and unchanged apart from carrying the attack in `use` events.
- `FlatStage` (no WebGL) keeps CSS animations, one per family.

## Folded-in stages from the earlier plan
- **G. Battle graphics remainder:**
  - Pokémon about 1.7 units tall and closer together; this goes into C1's `camera.js` work;
  - scenery (trees, field edge, larger lake, clearer peaks, softer shadows, ruins);
  - lighting polish (rim light, contact shadow, saturation lift on models).
- **L1. Phone bottom menu:** Collection, Packs, + Add, Battles, More; a slimmer top bar; a 1400 px page on large screens.
- **L2. Collection page:** one toolbar row, presets on one scrolling line, a View panel, and first cards within about 300 px on a phone; the card page as a full-height sheet on phones.

## Architecture gaps and recommendations

| # | Gap | Why it matters | Fix |
|---|---|---|---|
| R1 | The Pokémon TCG dataset's API shuts down on **2027-03-01**; it is the only source of the rarity counts behind pull chances | new sets lose pull chances | **done in M2:** rarity counts and checklist rarities from TCGdex's exact-match filters, dataset as fallback |
| T1 | No CI | "checks passed" on PRs means nothing ran | GitHub Actions: `npm test` and e2e on PRs, plus a `windows-latest` smoke test of the launcher |
| N1 | No HTTPS | no phone camera; cookies not `Secure` | A3's listener |
| N2 | OpenCV and Tesseract run on the main thread | the page freezes while reading cards | A1's worker |
| N3 | Scan accuracy is never measured | changes can make it worse unnoticed | A4's benchmark, run in CI on the synthetic set |
| N4 | A new 3D world per battle, showcase and rematch | seconds of start-up each time; risk of losing the WebGL context | one reusable stage (C1); handle `webglcontextlost` |
| N5 | Pop-out pictures have no version or status record | stale or broken pictures can't be found or redone | B1's table |
| N6 | Pokédex number not stored | repeated lookups; missed model matches | `cards.dex_id` (B2) |
| P1 | Lookups run one at a time; long actions show no progress | minutes of waiting on Update prices | a small job runner (`server/jobs.js`: SQLite table plus server-sent events); first users are Update prices, the dex backfill and model downloads |
| T3 | `server/app.js` holds every route (941 lines) | hard to change safely | split into routers as each area is touched (popout, battles, cards, packs) |
| T4 | Card-number matching is written 5 times | promo and leading-zero bugs differ per copy | one shared `cardNumber.js` with tests |
| T5 | Migrations are ad-hoc column checks | risky as tables grow (B1 adds one) | versioned migrations with `PRAGMA user_version` |
| T8 | Large untyped frontend files (`views.js` 859, `add.js` 766, `battles.js` 600) | regressions | JSDoc types with `tsc --checkJs` on new modules; ESLint; split files when touched |
| S1 | The server listens on every network interface; no password reset | exposure on shared networks | listen on localhost unless "Allow my phone" is on; an owner-run reset |
| S2 | The server downloads any `http(s)` address as an official image | can be used to probe the home network | allow only the known image hosts |
| S3 | Uploaded photos are readable by any signed-in profile that knows the file name | privacy between profiles | serve uploads through a route that checks the owner |
| D1 | Auto-update runs whatever is on `main` | a compromised account runs code on the PC | branch protection and 2-factor sign-in; optionally update only from tagged releases |
| N7 | High graphics has never been checked on a real graphics card; e2e is software-only | real-device problems go unseen | a `?perf` overlay (frame time, draw calls) and one owner check per graphics milestone |
| N8 | Backups happen only during updates; `data/` now also holds models and pictures | data loss; disk growth | a daily backup, "Back up now" and restore; a Storage page with sizes and clear-cache buttons |
| N9 | The public repo holds 4 scene images made from official art, and the updater needs the repo public | takedown risk | owner's decision: move those images to `data/` with an import button, or accept the risk |
| R3 | `SET_CODES` is hand-kept per new set | new sets are matched late | generate it from TCGdex's set data |

**Not planned, worth considering later:**
- recognising cards by their picture (ORB features plus `findHomography` against the official image, to confirm or rescue a read);
- a trained card-corner detector, if the benchmark shows the classic strategies and saliency fall short (YOLOX-Nano or a custom corner network, trained on the synthetic set);
- fighters without a species model using their relief as a "living card" in battles.

## Milestones (one draft PR each, in this order)
| # | Milestone | Contains | Done |
|---|---|---|---|
| M0 | Foundations | CI workflow (T1); worker helper; onnxruntime-web vendored; `server/aiModels.js`; versioned migrations (T5); scan benchmark skeleton (A4) | done (PR #16) |
| M1 | Detection v2 | A1, with the benchmark targets met | done (PR #17): 93% of 95%; orientation and the labelling page moved to M2 |
| M2 | Reading v2 | A2; rarity counts from TCGdex (R1), because of its deadline; from M1: upright choice by the name strip's read confidence, a page to label your own photos | done (PR #18): reading 72% → 81% (target 85%); R1 done; scanner tests page |
| M3 | Phone live scanner | A3 (HTTPS and the scanner screen); S1's localhost-by-default switch | |
| M4 | Pop-out for all, classic | B1, B2, and B3 without AI; B4's grid display and queue | |
| M5 | Pop-out with AI | B5's models for cut-out and depth; the relief picture and card-page parallax | |
| M6 | Moves, structure | C1 split and reusable stage (N4); `camera.js` with bigger Pokémon; `timeline.js`; `moves.js`; contact, projectile and beam families; hit-stop | |
| M7 | Moves, full set | all element kits; `deform.js`; world reactions; coin toss; KO and victory; audio | |
| M8 | Battle graphics remainder | scenery and lighting polish (G) | |
| M9 | Phone bottom menu | L1 | |
| M10 | Collection page | L2 | |
| M11 | Hardening | P1 job runner, T4, S2, S3, N8, R3 | |

## Verification (every milestone)
- `npm test`, with new unit tests for each pure module (`moves.js`, `timeline.js`, the strategies' scoring, `popoutAssets`, `aiModels`, migrations).
- `npm run test:e2e`, extended per milestone:
  - **M3:** the scanner opens with a fake camera stream (Chromium's `--use-fake-device-for-media-stream` with a card video) and captures a card.
  - **M4:** a Trainer card gets an own-art cut-out; a bad cut-out falls back to `flat`; nothing is regenerated after a reload.
  - **M6–M7:** one attack per family completes, and Skip still fast-forwards.
- `npm run bench:scan` before and after M1–M3, with the table pasted into the PR.
- Screenshots on desktop and a 390 px phone, light and dark, sent to the owner.
- A Basic frame time measured before and after M6–M8; it must stay near today's.
- **Owner checks that the sandbox can't do**, listed in each PR:
  - `npm run check:live` (TCGdex, model downloads);
  - the phone's certificate warning and camera;
  - High graphics on a real graphics card.
