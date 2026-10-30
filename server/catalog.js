import { priceFromTcgdex, TcgCsvClient } from './prices.js';
import { PtcgDataClient } from './ptcgData.js';
import { pullChance } from './pullRates.js';
import { TcgClient } from './tcg.js';

const isPtcg = (id) => String(id ?? '').startsWith(PtcgDataClient.PREFIX);

/**
 * One place to ask about cards. TCGdex is the main source; the Pokémon TCG dataset fills in
 * when TCGdex has no match or no image, and also supplies the rarity counts behind pull-rate
 * estimates. Prices come from TCGdex (TCGplayer / Cardmarket), with tcgcsv.com as a backup.
 */
export class CardCatalog {
  constructor({ tcgdex = new TcgClient(), ptcg = new PtcgDataClient(), tcgcsv = new TcgCsvClient() } = {}) {
    this.tcgdex = tcgdex;
    this.ptcg = ptcg;
    this.tcgcsv = tcgcsv;
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
      // TCGdex has no picture for some cards (often the newest sets): borrow it from the second source.
      await Promise.all(results.filter((r) => !r.image).map(async (r) => {
        const twin = await this.ptcg.findCard({ setCode: r.setCode, setName: r.setName, number: r.number, name: r.name }).catch(() => null);
        if (twin?.image) Object.assign(r, { image: twin.image, thumb: twin.thumb, imageSource: 'pokemontcg' });
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

  /** Download an image; returns { buffer, contentType } or null when unavailable. */
  download(url) {
    return this.tcgdex.download(url);
  }

  /** Other places the same card's picture can be downloaded from, if the first one fails. */
  async fallbackImage(card) {
    if (isPtcg(card.tcg_id)) return null;
    const twin = await this.ptcg.findCard({ setCode: card.set_code, setName: card.set_name, number: card.number, name: card.name }).catch(() => null);
    return twin?.image ?? null;
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
    if (tcgdexId) {
      const raw = await this.tcgdex.card(tcgdexId).catch(() => null);
      out.price = priceFromTcgdex(raw?.pricing, card.variant);
    }
    if (!out.price && card.number && (card.set_name || card.set_code)) {
      out.price = await this.tcgcsv.price({
        setName: card.set_name, setCode: card.set_code, number: card.number, name: card.name, variant: card.variant,
      }).catch(() => null);
    }
    return out;
  }
}
