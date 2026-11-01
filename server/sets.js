// Set completion: the full checklist of an expansion (from TCGdex), with what the user owns.
//
// What counts: a card number counts as owned when the user has at least one copy with that set
// code and number, in any printing. Three goals are offered:
//   main    – the numbered cards, 1 to the printed total ("066/193" → 193 cards);
//   master  – every card in the set, including secret rares numbered above the total;
//   reverse – one reverse holo of every card that has one (commons, uncommons and rares).

import { codeFromSetId, sameNumber, SET_CODES } from './setCodes.js';

const client = (catalog, lang) => (lang === 'ja' ? catalog.tcgdexJa : catalog.tcgdex);
const num = (n) => Number(String(n ?? '').match(/\d+/)?.[0] ?? NaN);
const REVERSE_RARITIES = /^(common|uncommon|rare)$/i;

/** The printed code of a set ("PAL" for English sets; Japanese cards print the set id). */
export const printedCode = (lang, setId) => (lang === 'ja' ? setId : codeFromSetId(setId) ?? setId);

/** The user's sets, with completion of the main set. */
export async function userSets(catalog, store, userId) {
  const jaSets = await catalog.tcgdexJa.sets().catch(() => []);
  const out = [];
  for (const s of store.setCodes(userId)) {
    const lang = s.language === 'ja' ? 'ja' : 'en';
    const known = lang === 'en' ? SET_CODES[s.code] : null;
    const ja = lang === 'ja' ? (jaSets ?? []).find((x) => String(x.id).toUpperCase() === s.code) : null;
    const setId = known?.id ?? ja?.id ?? null;
    const total = known?.total ?? ja?.cardCount?.official ?? null;
    const numbers = new Set(store.cardsInSet(userId, s.code).map((c) => num(c.number)).filter((n) => Number.isFinite(n) && (!total || n <= total)));
    out.push({ lang, setId, code: lang === 'ja' ? ja?.id ?? s.code : s.code, name: ja?.name ?? s.name, copies: s.count, owned: numbers.size, total, completion: total ? numbers.size / total : null });
  }
  return out.sort((a, b) => (b.completion ?? -1) - (a.completion ?? -1));
}

/** Every set TCGdex knows in a language, newest last (for "browse any set"). */
export async function allSets(catalog, lang) {
  const sets = (await client(catalog, lang).sets()) ?? [];
  return sets.map((s) => ({ setId: s.id, code: printedCode(lang, s.id), name: s.name, total: s.cardCount?.official ?? null }));
}

/** Run `fn` over `items`, `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

/** A set's checklist and completion numbers; with `values`, the estimated price of the missing cards. */
export async function setChecklist(catalog, store, userId, lang, setId, { values = false } = {}) {
  const set = await client(catalog, lang).set(setId);
  if (!set?.cards) return null;
  const code = printedCode(lang, set.id);
  const official = set.cardCount?.official ?? null;
  const mine = store.cardsInSet(userId, code);

  // Rarities come from the Pokémon TCG dataset (one file per set, English only).
  const rarities = new Map();
  if (lang === 'en') {
    const ptcgSet = (await catalog.ptcg.sets().catch(() => [])).find((s) => s.ptcgoCode === code);
    for (const c of ptcgSet ? await catalog.ptcg.cards(ptcgSet.id).catch(() => []) : []) rarities.set(num(c.number), c.rarity ?? null);
  }

  const cards = set.cards.map((c) => {
    const copies = mine.filter((m) => sameNumber(m.number, c.localId));
    const n = num(c.localId);
    const rarity = rarities.get(n) ?? null;
    return {
      tcgId: client(catalog, lang).ownId(c.id),
      number: c.localId,
      name: c.name,
      image: c.image ? `${c.image}/low.webp` : null,
      imageLarge: c.image ? `${c.image}/high.png` : null,
      rarity,
      secret: Boolean(official && Number.isFinite(n) && n > official),
      reverseEligible: Boolean(rarity && REVERSE_RARITIES.test(rarity) && !(official && n > official)),
      owned: copies.length,
      ownedReverse: copies.filter((m) => m.variant === 'reverse-holo').length,
      variants: [...new Set(copies.map((m) => m.variant || 'normal'))],
      ids: copies.map((m) => m.id),
      value: null,
    };
  });

  if (values) {
    const missing = cards.filter((c) => !c.owned);
    const prices = await mapLimit(missing, 6, (c) => catalog.market({ tcg_id: c.tcgId, language: lang, set_code: code, set_name: set.name, number: c.number, name: c.name, variant: 'normal', rarity: c.rarity }));
    missing.forEach((c, i) => { c.value = prices[i]?.price?.currency === 'USD' ? prices[i].price.value : null; });
  }

  const count = (list, own = (c) => c.owned > 0) => ({ owned: list.filter(own).length, total: list.length });
  const main = cards.filter((c) => !c.secret);
  const goals = {
    main: { label: `Main set (1–${official ?? main.length})`, ...count(main) },
    master: { label: 'Master set (with secret rares)', ...count(cards) },
    reverse: { label: 'Reverse holo set', ...count(cards.filter((c) => c.reverseEligible), (c) => c.ownedReverse > 0) },
  };
  for (const g of Object.values(goals)) g.completion = g.total ? g.owned / g.total : null;
  const missingValues = cards.filter((c) => !c.owned && c.value != null);
  return {
    lang, setId: set.id, code, name: set.name, official,
    goals,
    duplicates: cards.reduce((sum, c) => sum + Math.max(0, c.owned - 1), 0),
    missing: cards.filter((c) => !c.owned).length,
    missingValue: values ? Math.round(missingValues.reduce((s, c) => s + c.value, 0) * 100) / 100 : null,
    missingPriced: values ? missingValues.length : null,
    hasRarities: rarities.size > 0,
    cards,
  };
}
