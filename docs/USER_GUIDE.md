# My Pokédex: user guide

A personal catalog for the Pokémon cards you own, and the packs, tins, kits and bundles they came from. Snap a photo, and the app finds each card, cuts it out, reads it and matches it to the official card. It then shows rarity, how hard the card is to pull, its market value, eBay sold prices and a growing price history.

Contents:
1. [Getting started](#1-getting-started)
2. [Finding your way around](#2-finding-your-way-around)
3. [Adding cards](#3-adding-cards)
4. [Your collection](#4-your-collection)
5. [A card's page](#5-a-cards-page)
6. [Packs, tins, kits and bundles](#6-packs-tins-kits-and-bundles)
6b. [Set completion](#6b-set-completion)
7. [Searching any card](#7-searching-any-card)
8. [Prices, rarity and pull chance explained](#8-prices-rarity-and-pull-chance-explained)
9. [eBay sold prices](#9-ebay-sold-prices)
10. [Price history and graded sales (PokemonPriceTracker)](#10-price-history-and-graded-sales-pokemonpricetracker)
11. [Updates, backups and your data](#11-updates-backups-and-your-data)
12. [Using it on your phone](#12-using-it-on-your-phone)
13. [Troubleshooting](#13-troubleshooting)
14. [Glossary](#14-glossary)

---

## 1. Getting started

### What you need
- A Windows, Mac or Linux computer with **[Node.js](https://nodejs.org) 22.5 or newer** (choose the "LTS" download).
- An internet connection for looking up cards, pictures and prices. Your collection itself is stored on your computer.

### Install the desktop app (Windows, recommended)
Paste this into **PowerShell** once:

```powershell
irm https://raw.githubusercontent.com/ksotox/LLMModel/main/desktop/install.ps1 | iex
```

A **Pokedex** icon appears on your Desktop and in the Start menu, and the app opens. The first start downloads the app into `C:\Users\<you>\LLMModel-main`, which takes a minute or two.

From then on:
- **Open it** from the icon. It opens in its own window, without browser tabs or an address bar.
- **Close the window** to stop it.
- **It updates itself.** Every time it opens, it installs the newest version first. While it's open, a green bar appears when a new version is ready: click **Restart to update**.

### Other ways to start it
- **`Start Pokedex.cmd`** in the app folder starts the app in your normal browser. Keep its black window open while you use the app.
- **From a terminal** in the app folder, run `npm install` once, then `npm start`, and open <http://localhost:3000>.

### Optional keys
| Key | What it adds | How to set it (PowerShell, once) |
| --- | --- | --- |
| PokemonPriceTracker | eBay sales by grade (PSA 10…), extra price history, and pictures for brand-new promos | `[Environment]::SetEnvironmentVariable("POKEMONPRICETRACKER_API_KEY", "your-key", "User")` |
| eBay developer keys | Automatic eBay sold listings, once eBay approves your app | `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, set the same way |

After setting a key, close the app and open it again. If it doesn't pick the key up, sign out of Windows and back in.

### Your profile and signing in
The first time the app opens, it asks you to **create your profile**: a username, a display name and a password (6+ characters). Any cards already in the app become yours.
- **Signing in:** each browser stays signed in for 30 days. After 5 wrong passwords, wait 10 minutes.
- **Your name (top right)** opens a menu: **Profile & settings**, **Dark mode / Light mode**, and **Sign out**.
- **Profile & settings:** theme (Light, Dark or Match my computer), display name, password (changing it signs out your other devices), and iPhone photo conversion.
- **More profiles:** as the owner (the first profile), you can add a profile for each person under **Profile & settings → Profiles**. Everyone has their own collection, packs and settings. Deleting a profile deletes its collection.
- **Forgot the password?** There's no reset yet. Ask for help: the profile can be reset from the database without losing cards.

---

## 2. Finding your way around

The red bar at the top has four buttons:

| Button | What it opens |
| --- | --- |
| **Collection** | All your cards, with search, filters, sorting and the total value |
| **Packs** | The packs, tins, kits and bundles you've recorded, and what came out of each |
| **Sets** | How complete each expansion is, with every card you own and still need |
| **Search** | Any Pokémon card, including ones you don't own yet |
| **+ Add** | Add cards from photos (or packs) |

Click any card to open its page (see [section 5](#5-a-cards-page)).

---

## 3. Adding cards

Go to **+ Add**.

### Step 1: Pulled from (optional)
Choose the pack, tin, kit or bundle the cards came from, or **Not from a pack / not sure**. To record a new one, choose **New pack, tin, kit or bundle…**, give it a name, and optionally add photos of it.

### Step 2: Card photos
Click **Choose photos** or **Take photo** (on a phone this opens the camera), or drag photos onto the box. You can add several photos at once, and **a photo can contain several cards**: lay them out side by side.

For each photo, the app:
1. **Finds every card** in it, even tilted or photographed at an angle.
2. **Cuts each card out** along its own edges and straightens it. Only the card is kept, with rounded corners and no table or background.
3. **Reads the card**: the name at the top, and the set code and number at the bottom left (for example `PAL 066/193`, or `MEP 060` on promos).
4. **Matches the official card** and fills everything in. You'll see **"Read from the photo — please check it's the right card"** with the match underneath.

All of this happens inside your browser: your photos aren't sent to any outside service. **iPhone HEIC photos** are converted to JPEG first (this takes a few seconds; you can turn it off in your profile).

**While cards are read,** a bar shows **Reading card N of M**. Each card then gets one of these labels:

| Label | Meaning |
| --- | --- |
| **Recognized** (green) | Read and matched to its official card. |
| **Review needed** (amber) | Probably right, or only partly read: check it's the right card. |
| **Unrecognized** (red) | Couldn't be read. Type its details, or click **Read again**. |
| **Checked** (green) | You picked the match or typed the details yourself. |

After a batch, a summary shows how many cards are in each group. **Review N uncertain cards** shows only the ones to check; **Show all cards** brings the rest back. **Read again** (on a card, or for all unrecognized cards at once) reads the card a second time, also upside down in case it was photographed that way. It never replaces anything you typed: it only fills empty boxes, and if it finds a match after you typed, it offers it instead of choosing it.

### If something isn't right
- **The outline is off.** Click **Adjust cards** (or **Crop / split**). In the editor:
  - drag a card's corner handles onto the card's real corners;
  - draw a new box for a card it missed;
  - delete a box that isn't a card.

  Three buttons help too: **Auto-detect cards** tries again, **Split evenly: N × N** splits a neat grid of cards, and **Whole photo** treats the photo as one card. Click **Apply** when you're done.
- **The wrong card was matched, or none was.** Type the **set code** and **number** from the bottom-left corner of the card (for example `PAL` and `066/193`), or just the name. Pick the right card from the matches that appear. Anything you type is never overwritten by the automatic reading.
- **Variant.** Normal, **reverse holo**, **holo**, **full art** or **promo**. It changes the price and pull chance. The app suggests it (see below).

### The variant suggestion
Under each card's **Variant** box you'll see something like **✨ Suggested: Reverse holo · 85% sure**, with the reasons. Click **Use** to accept it. The app never changes the variant on its own unless the answer is certain.

It combines three things:
1. **Which printings exist.** The online card database lists the printings each card was made in. For example, a common Voltorb exists only as normal or reverse holo. Some answers are certain and filled in for you, marked **certain**:
   - **Full art:** ex Illustration Rares, Special Illustration Rares and Hyper Rares.
   - **Full art:** any card whose number is above the set total (e.g. `190/182`), which makes it a secret rare.
   - **Holo:** "Double Rare" ex cards.
   - **Promo:** promo cards.
   - **Only one printing:** filled in as that printing.

   If a card also exists with a special **Poké Ball or Master Ball pattern** foil, or with a stamp, the suggestion says so. Those you check by eye.
2. **The foil in your photo.** Foil has a fine sparkle texture that printed ink doesn't, so the app compares the area around the attacks with the artwork. A sparkly body next to the art means **reverse holo**; a smooth one means **normal** (or **holo** for rares). Glare on a glossy card can fool a single photo, so it's never more than 85% sure.
3. **Tilt scan (most reliable).** Click **Tilt scan** and take 1–2 more photos of the same card in the same light, tilting it a little left or right each time. On a phone, the camera opens. Foil changes its shine as the card tilts, and ink doesn't, so this tells normal, reverse holo, holo and full art apart. **Add another angle** takes a third photo.

### Step 3: Save
Click **Save N cards**. **If a card is already in your collection** (same card, same variant), or appears twice in what you're adding, a popup lists them and asks **Would you like to add it anyway?**
- **Yes, add anyway** saves everything, so you have another copy.
- **No** saves nothing and outlines the duplicates in amber, so you can remove them and save again.

The date added is recorded automatically. Each card is saved with:
- your photo;
- a local copy of the official picture;
- its rarity, pull chance and price.

**If the internet is down,** the card is still saved with your photo, and it's linked to its official card automatically later.

### Japanese cards
Japanese cards work the same way, and the app recognises them by themselves:
- **Reading:** the bottom-left corner shows a Japanese set code and number, e.g. `SV2a 100/165` (151), `SV4a`, `M1L` or `SV-P` for promos. When the app sees one, it also reads the card's name in Japanese (ビリリダマ). The first time, it downloads a small Japanese reading model (about 2 MB).
- **Finding:** it looks the card up in TCGdex's Japanese card database, with its official Japanese picture. Its printings are included, such as 151's Poké Ball pattern reverse holos.
- **Typing it in yourself:** enter the set code and number as printed (`SV2a` and `100/165`), or the name in Japanese (`ピカチュウ`).
- **In your collection:** Japanese cards carry a black **JP** tag. Type `japanese` or `jp` in the search box to list only them.
- **Prices** come from Cardmarket, which sells Japanese cards, shown in US dollars.
- **No pull chance:** Japanese packs hold different numbers of cards and rarities, so there's no pull-chance estimate.
- **Search page:** use the **Language** box (Any / English / Japanese).

### Tips for good photos
- Use daylight or a bright room, and avoid glare on holo cards (tilt the card slightly).
- Use a plain background that contrasts with the card's yellow border (dark wood works well).
- Keep the bottom-left text sharp: that's what identifies the card.

---

## 4. Your collection

The **Collection** page shows:
- **Totals:** number of cards, unique cards, packs, and the **estimated value** of everything priced.
- **Quick views (chips):** **Most valuable**, **Recently added** (last 30 days), **Missing prices**, **Unmatched cards**, **Duplicates**, **Grading candidates** (raw cards worth $20 or more in near-mint or unknown condition) and **For trade or sale**. Click one again to turn it off.
- **Search box:** type anything, such as a name, set code, number (`066/193`), rarity, type, variant, pack name, storage place or notes. Every word must match.
- **Pack, set and sort:** one pack or bundle (or **Not from a pack**), one set, and **Newest first**, **Oldest first**, **Name A–Z**, **Set & number**, **Highest value**, **Hardest to pull**, **Most copies** or **Condition**.
- **Filters:** rarity, type, variant, language, condition, plans (keeping / for trade / for sale), graded or raw, a price range, a date-added range, owned twice or more, not matched yet, and no price yet. All the filters you set apply together. **Clear filters** resets them.
- **Update prices:** refreshes rarity, pull chance and price for every card. It also links cards that aren't matched yet and fetches missing official pictures.

**Views** (your choice is remembered for your profile):
- **Compact:** picture, name, number, rarity and price.
- **Detailed:** also pull chance, date added, condition, grade, plans and pack.
- **Table:** one row per card with name, set, number, rarity, variant, quantity, condition and value. Click a column heading to sort by it.
- **Density:** **Compact**, **Comfortable** or **Large** tiles.
- **Official / My photos:** shows the official picture or your own photo on each tile. The other one appears as a small inset.
- **Group copies:** several copies of the same card and variant show as one tile with **×2**, **×3**…. Turn it off to see each copy.

The collection loads 60 cards at a time and loads more as you scroll, so large collections stay fast.

**Each tile shows:**
- the card's name, then its set code (red tag) and number;
- its rarity badge (for example ● Common, ◆ Uncommon, ★ Rare, ★★ Double Rare) and its **price**;
- how hard it is to pull ("1 in 23 packs") and the date it was added;
- condition, grade and plans, if set, and the pack it came from;
- **"Not matched yet"** if the card isn't linked to its official card. Open it to fix that.

### Changing many cards at once
Click **Select**, then click the cards you want (or **Select all shown**). A bar appears with:
- **Move to pack…**, **Set condition…**, **Mark as…** (keeping, for trade, for sale) and **Storage…** (for example "Binder 2, page 5");
- **Export CSV:** a spreadsheet of the chosen cards (opens in Excel);
- **Delete:** asks first, then moves the cards to the **Trash**. An **Undo** button appears for a few seconds.

Click **Done selecting** to finish.

### Trash
Deleted cards stay in the **Trash** (button at the top of the collection) for 30 days. There, select cards to **Restore** them, or **Delete for good** (with their photos).

---

## 5. A card's page

Click a card to open its page:
- **Pictures:** your photo and the official card side by side. Click either one to see it full size.
- **Rarity, Pull chance, Market price:**
  - the price shows the low–high range and its source;
  - hover over a converted price to see the original amount (for example "converted from €6.09");
  - **Refresh price** updates it now. Prices also refresh automatically when they're over a day old.
- **Details:** set, number, variant, category, HP, type, pack, condition, grade, price paid (and how its value compares now), storage place, plans, date added and notes.
- **Edit:** change the name, set code, number, set name, variant, pack and notes, and under **This copy**: condition (NM, LP, MP, HP, DMG), grading company and grade, price paid, where it's stored, and your plans for it.
- **Your copies:** if you own more than one of this card, a table lists every copy with its condition, storage place, plans, price paid and value. Click a row to open that copy.
- **+ Add a copy:** adds another copy of the same card, then lets you set its condition.
- **Find official card** or **Change official card:** search and pick the right official card.
- **Retry official image:** appears if the official picture couldn't be downloaded earlier.
- **Replace my photo** or **Add my photo:** a new photo is cut out automatically.
- **Delete:** moves the card to the Trash (with **Undo**).
- **Price history & graded sales:** see [section 10](#10-price-history-and-graded-sales-pokemonpricetracker).
- **eBay sold prices:** see [section 9](#9-ebay-sold-prices).

When you open a card that isn't matched yet, the app tries to match it straight away. You'll see **"Found the official card"** if it succeeds.

---

## 6. Packs, tins, kits and bundles

**Packs** lists everything you've recorded (booster packs, tins, kits, bundles, Elite Trainer Boxes, collection boxes, blisters, booster boxes), with photos and the number of cards from each.
- **Add packs** records one or several at once, with photos. A photo of several packs can be split, as with cards.
- **Opening a pack** shows its cards, a search box for just that pack, and **Add cards from this pack**.
- **Edit pack** lets you rename it, change its type or set, add notes, or **Replace photo**.
- **Delete:** your cards are kept, and become "Not from a pack". You can choose to delete the pack's cards too.

---

## 6b. Set completion

**Sets** shows each set you own cards from, with a progress bar and how many of its numbered cards you have. **Browse any set** opens any English or Japanese set, even ones you haven't started.

A set's page shows:
- **Cards owned, Total cards, Completion, Missing** and **Duplicate copies**;
- **Est. value of missing:** click **Estimate** to price the cards you still need (it looks up each one, so it takes a moment);
- **Goal:** **Main set** (the numbered cards, e.g. 1–193), **Master set** (also the secret rares numbered above that) or **Reverse holo set** (one reverse holo of every card that has one);
- **Filters:** **All**, **Missing**, **Owned**, **Duplicates** and **Missing illustration rares**;
- every card in the set: the ones you own in colour, the missing ones greyed out. Click a card you own to open it, or a missing one to see its price and **Add to my collection**.

Rarities (for illustration rares and the reverse holo goal) are available for English sets.

---

## 7. Searching any card

**Search** looks up any Pokémon card, even ones you don't own:
- search by name (`Charizard`), or by set code and number (`PAL` + `066/193`);
- cards you already have show **Owned ×N**;
- open a result to see its rarity, pull chance and price, then **Add to my collection**. You can add your own photo later from the card's page.

---

## 8. Prices, rarity and pull chance explained

**Prices are always in US dollars.** The app takes the first price it finds:
1. TCGplayer market price (from TCGdex);
2. TCGplayer price (from tcgcsv.com);
3. Cardmarket (a European site) price trend, converted from euros to dollars at that day's European Central Bank rate. The price's tooltip says when this happened. If the rate can't be fetched, an approximate fixed rate is used, and the tooltip says "approximate rate".

The price is for your card's variant when there is one, for example the reverse holo price. **Prices are estimates of market value, not offers.**

**Rarity** is the rarity printed on the card (Common, Uncommon, Rare, Double Rare, Illustration Rare, Special Illustration Rare, Hyper Rare, ACE SPEC…).

**Pull chance** estimates how likely you are to get *that exact card* from **one booster pack**:

> chance = (how many cards of that rarity an average pack holds) ÷ (how many cards of that rarity are in the set)

- The rates come from TCGplayer's published studies of thousands of opened packs.
- It's available for Scarlet & Violet and Mega Evolution era sets.
- Older sets, promos and special sets (Paldean Fates, Prismatic Evolutions…) show "Not available".
- Real odds vary between products and boxes.

---

## 9. eBay sold prices

On a card's page, **eBay sold prices** shows:
- the **average sold price**, median, range and number of sales. Filter by **All**, **Ungraded** or **Graded**, because one PSA 10 can skew the average a lot;
- a **trend chart** by week or month: **green** where the price went up, **red** where it went down, **yellow** where it held within 2%. Above it is the overall direction and rate of change;
- **every sale** behind the numbers: title (linked to eBay), price, date and condition or grade (read from the title, for example "PSA 10"). Remove any sale that isn't really your card.

### Adding sales: copy and paste (works right away)
1. Open **Add sales from eBay.com (free)**, then **Open the sold listings on eBay ↗**. This is eBay's own "Sold items" search for the card. Sign in to eBay if asked.
2. Select the results (Ctrl+A, or "Select all" on a phone) and copy them.
3. Paste into the box (**Paste here**).

The app keeps only sales of that exact card (same name, number and set) and skips lots, bundles and other cards. Sales are saved with the card, so its history keeps growing every time you paste.

### Adding sales: eBay's API (automatic, needs eBay's approval)
eBay must approve your free developer app for its Marketplace Insights API. After that, set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` (see [Optional keys](#optional-keys)) and an **Update from eBay** button appears.

---

## 10. Price history and graded sales (PokemonPriceTracker)

**Your own price history (always on).** The app saves each card's price once a day: when you add it, when you open it, and from an hourly background check while the app is running. The **Price history & graded sales** section on a card's page charts it:
- pick a line in the menu, for example TCGplayer market price, or eBay average for PSA 10;
- the colours are the same as the eBay chart;
- the change since the first day is shown.

The longer you use the app, the longer the history.

**With a PokemonPriceTracker key** (free: 100 credits a day, no credit card), the same section adds:
- **eBay sales by grade**: PSA 10, PSA 9, CGC 9.5… with count, average, median, range and last sale;
- PokemonPriceTracker's own recent price history;
- population counts, when your plan includes them;
- **official pictures for cards no other source has yet**, such as the newest promos.

**How credits are spent.** About 3 credits per card refresh. The app keeps you inside your 100 a day by itself:
- each card is refreshed at most once a day;
- a card that isn't found, or a picture search that found nothing, isn't retried for a day (or a week, for pictures);
- the hourly background check always leaves 30% of the day's credits for cards you open yourself;
- credits used are counted even across restarts.

The footer shows "N of 100 credits used today". **Update now** forces a refresh and uses about 3 credits.

---

## 11. Updates, backups and your data

### Where your collection lives
Everything is in the **`data`** folder inside the app folder (`C:\Users\<you>\LLMModel-main\data`):
- `collection.db` holds the cards, packs, prices and history;
- `uploads\` holds your photos;
- `official\` holds the official pictures.

**Back up this folder to back up your collection.**

### Updates (desktop app)
Each update:
1. **Backs up** `collection.db` to `LLMModel-main.backups\`. The last 10 copies are kept.
2. **Downloads** the new version next to the app folder and installs it.
3. **Swaps the folders**, moving `data` into the new version. The replaced code is kept as `LLMModel-main.previous`.
4. **Puts the previous version back**, cards included, if the new version doesn't start.

If the collection can't be moved (a file is locked), the update is cancelled and the current version keeps running. A collection ever found left behind in `.previous` is moved to `LLMModel-main.rescued-data-…`, never deleted.

### Moving to a new computer
Install the app on the new computer, close it, and copy your old `data` folder over the new one.

---

## 12. Using it on your phone

The app runs on your computer, and your phone opens it in its browser.

**Same Wi-Fi:**
1. Find the computer's address. In PowerShell, run `ipconfig` and look for **IPv4 Address**, something like `192.168.1.23`.
2. On the phone, open `http://192.168.1.23:3000`.
3. Optional: add it to your home screen. In Safari, tap Share → **Add to Home Screen**. In Chrome, tap ⋮ → **Add to Home screen**.

**+ Add → Take photo** opens the phone's camera.

**If the phone can't connect:**
- Allow Node.js through the Windows Firewall on **Private** networks.
- Make sure your Wi-Fi is set to **Private** (Settings → Network & internet → Wi-Fi → your network).

Sign in with your profile on the phone too.

**Away from home:** install **Tailscale** (free) on both the computer and the phone, and open `http://<computer-name>:3000`. Don't expose the app to the internet with port forwarding, even with a password.

---

## 13. Troubleshooting

| Problem | What to do |
| --- | --- |
| The icon shows "Node.js isn't installed" | Install Node.js LTS from nodejs.org, then open the app again. |
| The icon shows "The Pokedex couldn't start" | Read the end of `%LOCALAPPDATA%\Pokedex\launcher.log`. Running the install command again repairs the setup. |
| The app opens but didn't update | It updates only when it starts and isn't already running. Close every app window (and any old "Start Pokedex" window), then open it again. |
| A card shows "Not matched yet" | Open it (it tries automatically), or use **Find official card** and type the set code and number. |
| No official picture | Click **Update prices**, or **Retry official image** on the card. Very new promos may need a PokemonPriceTracker key. |
| No price | Some cards have no recent sales. Prices are refreshed daily. |
| A Japanese card wasn't matched | Check the bottom-left code and number (e.g. `SV2a 100/165`) and type them in. The Japanese name can be typed too. |
| "You already have this card" when adding | The same card and variant is in your collection. Choose **Yes, add anyway** for another copy, or **No** to go back. |
| An iPhone photo won't open | Turn on **Convert iPhone HEIC photos** in **Profile & settings**, or on the iPhone choose Settings → Camera → Formats → **Most Compatible**. |
| Deleted a card by mistake | Open **Trash** at the top of the collection and **Restore** it (within 30 days). |
| A card was read wrong | Fix the name, set code or number, and pick the right match. Blurry or dark photos are the usual cause. |
| `npm` errors about `package.json` | PowerShell is in the wrong folder: `cd` into the app folder first. |
| Phone can't connect | See [section 12](#12-using-it-on-your-phone). |
| Checking which online sources work | In the app folder, run `npm run check:live`. It tests every source and prints ✓ or ✗. |

---

## 14. Glossary

| Term | Meaning |
| --- | --- |
| **Set code** | The three letters at the bottom left of a card (`PAL` = Paldea Evolved). |
| **Number** | The card's number in its set, e.g. `066/193`. Promos have no total (`MEP 060`). |
| **Variant** | The printing: normal, reverse holo, holo, full art, promo. |
| **Official card** | The card's entry in the online card databases, with its official picture and details. |
| **Pull chance** | The estimated chance of getting that exact card in one booster pack. |
| **Graded** | A card professionally rated and sealed, e.g. PSA 10 (perfect). |
| **Population** | How many copies of a card have received each grade. |
| **Credits** | PokemonPriceTracker's daily allowance (100 a day on the free plan). |

More: [README](../README.md) (setup and technical details) · [SOURCES](SOURCES.md) (every website and API used) · [HISTORY](HISTORY.md) (how the app was built).
