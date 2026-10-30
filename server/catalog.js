import { ExchangeRates } from './fx.js';
import { priceFromTcgdex, TcgCsvClient } from './prices.js';
import { PtcgDataClient } from './ptcgData.js';
import { pullChance } from './pullRates.js';
import { TcgClient } from './tcg.js';

const isPtcg = (id) => String(id ?? '').startsWith(PtcgDataClient.PREFIX);

/**
 * Where the Pokémon TCG dataset's image hosts would keep a card's picture, worked out from its
 * TCGdex set id ("mep" + "059" → "mep-59"). Used last, for cards the dataset doesn't list yet
 * (such as the newest promos); a wrong guess simply fails to download and is skipped.
 */
function datasetImageGuesses(card) {
  const setId = card.set_id ?? String(card.tcg_id ?? '').replace(/-[^-]+$/, '');
  const n = String(card.number ?? '').match(/^\D*0*(\d+)$/)?.[1];
  if (!setId || !n || isPtcg(card.tcg_id)) return [];
  const id = setId.replace(/0+(\d)/, '$1').replace(/\.5$/, 'pt5');
  return [`https://images.scrydex.com/pokemon/${id}-${n}/large`, `https://images.pokemontcg.io/${id}/${n}_hires.png`];
}

/**
 * One place to ask about cards. TCGdex is the main source; the Pokémon TCG dataset fills in
 * when TCGdex has no match or no image, and also supplies the rarity counts behind pull-rate
 * estimates. Prices are always in US dollars: TCGplayer via TCGdex, then TCGplayer via tcgcsv.com,
 * then Cardmarket (euros) converted to dollars. Pictures fall back to TCGplayer's product images.
 */
export class CardCatalog {
  constructor({ tcgdex = new TcgClient(), ptcg = new PtcgDataClient(), tcgcsv = new TcgCsvClient(), fx = new ExchangeRates() } = {}) {
    this.tcgdex = tcgdex;
    this.ptcg = ptcg;
    this.tcgcsv = tcgcsv;
    this.fx = fx;
  }

  /** Search both sources. Throws only when every source failed. */
  async search(query) {
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
   * Rarity, estimated pull chance and market price for a card. Every part is optional:
   * whatever can't be worked out (offline, unknown set, no sales data) is left null.
   */
  async market(card) {
    const out = { rarity: card.rarity ?? null, pull: null, price: null };

    if (!out.rarity && card.set_code && card.number) {
      const twin = await this.ptcg.findCard({ setCode: card.set_code, setName: card.set_name, number: card.number, name: card.name }).catch(() => null);
      out.rarity = twin?.rarity ?? null;
    }

    if (out.rarity && (card.set_code || card.set_name)) {
      const profile = await this.ptcg.rarityProfile({ setCode: card.set_code, setName: card.set_name }).catch(() => null);
      out.pull = pullChance({ rarity: out.rarity, variant: card.variant, profile });
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
