import { ExchangeRates } from './fx.js';
import { priceFromTcgdex, TcgCsvClient } from './prices.js';
import { printingsFor } from './printings.js';
import { PtcgDataClient } from './ptcgData.js';
import { PULL_RARITIES, hasPullRates, normaliseRarity, pullChance } from './pullRates.js';
import { codeFromSetId, hasJapanese, isJapaneseCode, setFromCode } from './setCodes.js';
import { TcgClient } from './tcg.js';

const isPtcg = (id) => String(id ?? '').startsWith(PtcgDataClient.PREFIX);
const isJapanese = (cardOrId) => (typeof cardOrId === 'string' ? cardOrId : cardOrId?.tcg_id ?? '').startsWith('ja:')
  || (typeof cardOrId === 'object' && cardOrId?.language === 'ja');

/** A lookup for a Japanese card: a Japanese set code ("SV2a"), a name in Japanese, or lang=ja. */
export const japaneseQuery = (q = {}) => q.lang === 'ja' || (q.lang !== 'en' && (isJapaneseCode(q.setCode) || hasJapanese(q.name)));

/**
 * Where the Pokémon TCG dataset's image hosts would keep a card's picture, worked out from its
 * TCGdex set id ("mep" + "059" → "mep-59"). Used last, for cards the dataset doesn't list yet
 * (such as the newest promos); a wrong guess simply fails to download and is skipped.
 */
function datasetImageGuesses(card) {
  const setId = card.set_id ?? String(card.tcg_id ?? '').replace(/-[^-]+$/, '');
  const n = String(card.number ?? '').match(/^\D*0*(\d+)$/)?.[1];
  if (!setId || !n || isPtcg(card.tcg_id) || isJapanese(card)) return [];
  const id = setId.replace(/0+(\d)/, '$1').replace(/\.5$/, 'pt5');
  return [`https://images.scrydex.com/pokemon/${id}-${n}/large`, `https://images.pokemontcg.io/${id}/${n}_hires.png`];
}

/**
 * One place to ask about cards. TCGdex is the main source; the Pokémon TCG dataset fills in
 * when TCGdex has no match or no image, and also supplies the rarity counts behind pull-rate
 * estimates. Prices are always in US dollars: TCGplayer via TCGdex, then TCGplayer via tcgcsv.com,
 * then Cardmarket (euros) converted to dollars. Pictures fall back to TCGplayer's product images.
 * Japanese cards come from TCGdex's Japanese database (ids "ja:SV2a-100"), with its pictures.
 */
export class CardCatalog {
  constructor({
    tcgdex = new TcgClient(), tcgdexJa = new TcgClient({ lang: 'ja' }), ptcg = new PtcgDataClient(), tcgcsv = new TcgCsvClient(), fx = new ExchangeRates(),
  } = {}) {
    this.tcgdex = tcgdex;
    this.tcgdexJa = tcgdexJa;
    this.ptcg = ptcg;
    this.tcgcsv = tcgcsv;
    this.fx = fx;
  }

  /** Search both sources (Japanese cards: TCGdex's Japanese database). Throws only when every source failed. */
  async search(query) {
    if (japaneseQuery(query)) {
      const ja = await this.tcgdexJa.search(query).catch((err) => (query.lang === 'ja' ? Promise.reject(err) : []));
      if (ja.length || query.lang === 'ja') return ja.map((r) => ({ source: 'tcgdex', ...r }));
    }
    let results = [];
    let primaryError = null;
    try {
      results = await this.tcgdex.search(query);
    } catch (err) {
      primaryError = err;
    }

    if (results.length) {
      // TCGdex has no picture for some cards (often the newest sets): borrow it from another source.
      await Promise.all(results.filter((r) => !r.image).map(async (r) => {
        const twin = await this.ptcg.findCard({ setCode: r.setCode, setName: r.setName, number: r.number, name: r.name }).catch(() => null);
        if (twin?.image) {
          Object.assign(r, { image: twin.image, thumb: twin.thumb, imageSource: 'pokemontcg' });
          return;
        }
        // Not in the dataset either (e.g. the newest promos): TCGplayer's product picture.
        const [large, medium] = await this.tcgcsv.images({ setCode: r.setCode, setName: r.setName, number: r.number, name: r.name }).catch(() => []);
        if (large) Object.assign(r, { image: large, thumb: medium ?? large, imageSource: 'tcgplayer' });
      }));
      return results.map((r) => ({ source: 'tcgdex', ...r }));
    }

    try {
      return await this.ptcg.search(query);
    } catch (err) {
      throw primaryError ?? err;
    }
  }

  /**
   * Full details for a card id from either source. For TCGdex cards, a missing image (or rarity)
   * is filled in from the Pokémon TCG dataset. Returns null when the card can't be found.
   */
  async details(id) {
    if (isPtcg(id)) return this.ptcg.details(id);
    if (isJapanese(id)) return this.tcgdexJa.details(id);
    const card = await this.tcgdex.details(id);
    if (!card) return null;
    if (!card.official_image_url || !card.rarity) {
      const twin = await this.ptcg.findCard({ setCode: card.set_code, setName: card.set_name, number: card.number, name: card.name }).catch(() => null);
      if (twin) {
        card.official_image_url ??= twin.image;
        card.rarity ??= twin.rarity;
      }
    }
    return card;
  }

  /** The card's TCGplayer product id, taken from TCGdex's price data (no extra request when cached). */
  async tcgPlayerId(card) {
    if (isJapanese(card)) return null; // TCGplayer's English catalogue: no Japanese printings
    let id = card.tcg_id && !isPtcg(card.tcg_id) ? card.tcg_id : null;
    if (!id && card.set_code && card.number) {
      const [twin] = await this.tcgdex.search({ setCode: card.set_code, number: card.number }).catch(() => []);
      id = twin?.tcgId ?? null;
    }
    if (!id) return null;
    const raw = await this.tcgdex.card(id).catch(() => null);
    const line = Object.values(raw?.pricing?.tcgplayer ?? {}).find((l) => l && typeof l === 'object' && l.productId);
    return line ? String(line.productId) : null;
  }

  /**
   * Which printings (variants) a card exists in, so impossible ones can be ruled out:
   * { allowed, fixed, reason, notes, source }, or null when the card isn't found.
   */
  async printings(id) {
    let details;
    let raw = null;
    if (isJapanese(id)) {
      raw = await this.tcgdexJa.card(id);
      details = raw ? await this.tcgdexJa.details(id) : null;
    } else if (isPtcg(id)) {
      details = await this.ptcg.details(id);
      // The dataset has no printing list: use the same card on TCGdex when there is one.
      if (details?.set_code && details.number) {
        const [twin] = await this.tcgdex.search({ setCode: details.set_code, number: details.number }).catch(() => []);
        if (twin) raw = await this.tcgdex.card(twin.tcgId).catch(() => null);
      }
    } else {
      raw = await this.tcgdex.card(id);
      details = raw ? await this.details(id) : null;
    }
    if (!details) return null;
    const lines = raw?.pricing?.tcgplayer ?? {};
    return printingsFor({
      variantsDetailed: raw?.variants_detailed,
      variants: raw?.variants,
      priceLines: Object.keys(lines).filter((k) => lines[k] && typeof lines[k] === 'object'),
      rarity: details.rarity,
      number: details.number,
      setTotal: details.set_total,
      setName: details.set_name,
      setId: details.set_id,
    });
  }

  /** Download an image; returns { buffer, contentType } or null when unavailable. */
  download(url) {
    return this.tcgdex.download(url);
  }

  /**
   * Other places the same card's official picture can be downloaded from, best first: the Pokémon
   * TCG dataset, then TCGplayer's product image (via tcgcsv.com), which lists every card including
   * promos the other two have no picture for, then the dataset image hosts' usual addresses.
   */
  async fallbackImages(card) {
    if (isJapanese(card)) return []; // the other picture sources only have English printings
    const urls = [];
    if (!isPtcg(card.tcg_id)) {
      const twin = await this.ptcg.findCard({ setCode: card.set_code, setName: card.set_name, number: card.number, name: card.name }).catch(() => null);
      if (twin?.image) urls.push(twin.image);
    }
    const query = { setName: card.set_name, setCode: card.set_code, number: card.number, name: card.name };
    urls.push(...await this.tcgcsv.images(query).catch(() => []));
    urls.push(...datasetImageGuesses(card));
    return [...new Set(urls)];
  }

  /**
   * How many cards of each rarity the card's set has, for pull chances: { setCode, series, counts }.
   * From TCGdex when it lists the whole set with rarities; else from the Pokémon TCG dataset, which
   * stops getting new sets once its API closes (2027-03-01).
   */
  async rarityProfile(card) {
    const setId = isPtcg(card.tcg_id) ? null
      : card.tcg_id ? String(card.tcg_id).replace(/-[^-]+$/, '') : setFromCode(card.set_code)?.id ?? null;
    const fromTcgdex = setId && !isJapanese(card) ? await this.#tcgdexProfile(setId).catch(() => null) : null;
    return fromTcgdex ?? this.ptcg.rarityProfile({ setCode: card.set_code, setName: card.set_name }).catch(() => null);
  }

  #profiles = new Map();
  #tcgdexProfile(setId) {
    if (!this.#profiles.has(setId)) {
      const work = (async () => {
        const set = await this.tcgdex.set(setId);
        const series = set?.serie?.name;
        if (!set || !hasPullRates(series)) return null;
        const names = ((await this.tcgdex.rarities()) ?? []).filter((r) => PULL_RARITIES.has(normaliseRarity(r)));
        const counts = {};
        for (const [name, n] of Object.entries(await this.tcgdex.rarityCounts(setId, names))) {
          counts[normaliseRarity(name)] = (counts[normaliseRarity(name)] ?? 0) + n;
        }
        // Only a set TCGdex lists in full: new sets can lack rarities for a while.
        const counted = Object.values(counts).reduce((a, b) => a + b, 0);
        if (!set.cardCount?.total || counted < set.cardCount.total * 0.9) return null;
        return { setId, setCode: codeFromSetId(setId), setName: set.name, series, counts, source: 'tcgdex' };
      })();
      this.#profiles.set(setId, work);
      work.catch(() => this.#profiles.delete(setId)); // a failure (offline) is tried again next time
    }
    return this.#profiles.get(setId);
  }

  /**
   * Rarity, estimated pull chance and market price for a card. Every part is optional:
   * whatever can't be worked out (offline, unknown set, no sales data) is left null.
   */
  async market(card) {
    const out = { rarity: card.rarity ?? null, pull: null, price: null };
    if (isJapanese(card)) {
      // Japanese packs hold different cards and rarities: no pull-chance estimate. Prices come from
      // TCGdex's Japanese card (Cardmarket sells Japanese cards), shown in dollars.
      const raw = card.tcg_id ? await this.tcgdexJa.card(card.tcg_id).catch(() => null) : null;
      out.price = priceFromTcgdex(raw?.pricing, card.variant, { sources: ['tcgplayer'] })
        ?? await this.fx.toUsd(priceFromTcgdex(raw?.pricing, card.variant, { sources: ['cardmarket'] })).catch(() => null);
      return out;
    }

    if (!out.rarity && card.set_code && card.number) {
      const twin = await this.ptcg.findCard({ setCode: card.set_code, setName: card.set_name, number: card.number, name: card.name }).catch(() => null);
      out.rarity = twin?.rarity ?? null;
    }

    if (out.rarity && (card.set_code || card.set_name || card.tcg_id)) {
      out.pull = pullChance({ rarity: out.rarity, variant: card.variant, profile: await this.rarityProfile(card) });
    }

    // TCGdex carries the prices; a card linked to the second source looks up its TCGdex twin.
    let tcgdexId = card.tcg_id && !isPtcg(card.tcg_id) ? card.tcg_id : null;
    if (!tcgdexId && card.set_code && card.number) {
      const [twin] = await this.tcgdex.search({ setCode: card.set_code, number: card.number }).catch(() => []);
      tcgdexId = twin?.tcgId ?? null;
    }
    const pricing = tcgdexId ? (await this.tcgdex.card(tcgdexId).catch(() => null))?.pricing : null;
    out.price = priceFromTcgdex(pricing, card.variant, { sources: ['tcgplayer'] });
    if (!out.price && card.number && (card.set_name || card.set_code)) {
      out.price = await this.tcgcsv.price({
        setName: card.set_name, setCode: card.set_code, number: card.number, name: card.name, variant: card.variant,
      }).catch(() => null);
    }
    // Last resort: the European Cardmarket price, shown in dollars.
    if (!out.price) out.price = await this.fx.toUsd(priceFromTcgdex(pricing, card.variant, { sources: ['cardmarket'] })).catch(() => null);
    return out;
  }
}
