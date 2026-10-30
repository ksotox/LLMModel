import { parseNumber, sameNumber } from './setCodes.js';

const DAY = 24 * 60 * 60 * 1000;
const NAME_SCAN_SETS = 40;

/** Card numbers are printed with three digits from Sword & Shield onwards ("066/193"). */
const PADDED_SERIES = new Set(['Sword & Shield', 'Scarlet & Violet', 'Mega Evolution']);

const normalise = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Second card source: the open Pokémon TCG dataset published on GitHub
 * (https://github.com/PokemonTCG/pokemon-tcg-data). It covers every English set with images
 * and a rarity for each card, needs no API key, and is used when TCGdex has no match or no image.
 * Card ids from this source are prefixed with "ptcg:" so they never clash with TCGdex ids.
 */
export class PtcgDataClient {
  static PREFIX = 'ptcg:';

  constructor({ baseUrl = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async #get(path) {
    const hit = this.cache.get(path);
    if (hit && hit.expires > Date.now()) return hit.value;
    const res = await this.fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Pokémon TCG data ${path} responded ${res.status}`);
    const value = await res.json();
    this.cache.set(path, { value, expires: Date.now() + DAY });
    return value;
  }

  async sets() {
    return (await this.#get('/sets/en.json')) ?? [];
  }

  async cards(setId) {
    return (await this.#get(`/cards/en/${encodeURIComponent(setId)}.json`)) ?? [];
  }

  /** Sets matching a printed set code ("PAL"), a set name, and/or a printed total ("193"). */
  async findSets({ setCode, setName, total } = {}) {
    const sets = await this.sets();
    const code = String(setCode ?? '').trim().toUpperCase();
    if (code) {
      const byCode = sets.filter((s) => s.ptcgoCode?.toUpperCase() === code);
      if (byCode.length) return total ? byCode.filter((s) => String(s.printedTotal) === String(Number(total))) : byCode;
    }
    if (setName) {
      const byName = sets.filter((s) => normalise(s.name) === normalise(setName));
      if (byName.length) return byName;
    }
    if (total) return sets.filter((s) => String(s.printedTotal) === String(Number(total)));
    return [];
  }

  /** Same contract as TcgClient.search: briefs with name, number, set and image. */
  async search({ name, setCode, number, limit = 48 } = {}) {
    name = normalise(name);
    const { localId, total } = parseNumber(number);
    const matches = (card) => (!localId || sameNumber(card.number, localId)) && (!name || normalise(card.name).includes(name));
    const results = [];

    const targeted = setCode || total ? await this.findSets({ setCode, total }) : [];
    if (targeted.length) {
      for (const set of targeted) {
        for (const card of await this.cards(set.id)) if (matches(card)) results.push(this.#brief(card, set));
      }
    } else if (name) {
      // No set given: look through the most recent sets first, which is what people are opening now.
      const recent = [...(await this.sets())].sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
      for (const set of recent.slice(0, NAME_SCAN_SETS)) {
        for (const card of await this.cards(set.id)) if (matches(card)) results.push(this.#brief(card, set));
        if (results.length >= limit) break;
      }
    }
    return results.slice(0, limit);
  }

  #printed(set, number) {
    const padded = PADDED_SERIES.has(set.series) && /^\d+$/.test(number);
    return {
      number: padded ? number.padStart(3, '0') : number,
      setTotal: set.printedTotal != null ? (padded ? String(set.printedTotal).padStart(3, '0') : String(set.printedTotal)) : null,
    };
  }

  #brief(card, set) {
    return {
      tcgId: `${PtcgDataClient.PREFIX}${card.id}`,
      name: card.name,
      ...this.#printed(set, card.number),
      setId: set.id,
      setName: set.name,
      setCode: set.ptcgoCode ?? null,
      rarity: card.rarity ?? null,
      image: card.images?.large ?? card.images?.small ?? null,
      thumb: card.images?.small ?? card.images?.large ?? null,
      source: 'pokemontcg',
    };
  }

  async #locate(id) {
    const raw = id.startsWith(PtcgDataClient.PREFIX) ? id.slice(PtcgDataClient.PREFIX.length) : id;
    const setId = raw.slice(0, raw.lastIndexOf('-'));
    const set = (await this.sets()).find((s) => s.id === setId);
    const card = set && (await this.cards(set.id)).find((c) => c.id === raw);
    return card ? { card, set } : null;
  }

  /** Full details for a "ptcg:" id, normalised to the columns we store. */
  async details(id) {
    const found = await this.#locate(id);
    if (!found) return null;
    const { card, set } = found;
    const printed = this.#printed(set, card.number);
    return {
      tcg_id: `${PtcgDataClient.PREFIX}${card.id}`,
      name: card.name,
      number: printed.number,
      set_id: set.id,
      set_name: set.name,
      set_code: set.ptcgoCode ?? null,
      set_total: printed.setTotal,
      rarity: card.rarity ?? null,
      category: card.supertype === 'Pokémon' ? 'Pokemon' : card.supertype ?? null,
      hp: card.hp != null && !Number.isNaN(Number(card.hp)) ? Number(card.hp) : null,
      types: Array.isArray(card.types) ? card.types.join(', ') : null,
      official_image_url: card.images?.large ?? card.images?.small ?? null,
    };
  }

  /** The same printed card in this dataset (used to fill in a missing image or rarity). */
  async findCard({ setCode, setName, number, name }) {
    const { localId, total } = parseNumber(number);
    if (!localId) return null;
    const sets = await this.findSets({ setCode, setName, total });
    for (const set of sets) {
      const cards = (await this.cards(set.id)).filter((c) => sameNumber(c.number, localId));
      const card = cards.find((c) => !name || normalise(c.name) === normalise(name)) ?? cards[0];
      if (card) return this.#brief(card, set);
    }
    return null;
  }

  /** How many cards of each rarity the set has, plus its series, for pull-rate estimates. */
  async rarityProfile({ setCode, setName }) {
    const [set] = await this.findSets({ setCode, setName });
    if (!set) return null;
    const counts = {};
    for (const card of await this.cards(set.id)) {
      const r = normalise(card.rarity);
      if (r) counts[r] = (counts[r] ?? 0) + 1;
    }
    return { setId: set.id, setCode: set.ptcgoCode ?? null, setName: set.name, series: set.series, counts };
  }
}
