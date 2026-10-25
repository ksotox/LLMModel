import { codeFromSetId, parseNumber, sameNumber, setFromCode } from './setCodes.js';

const DAY = 24 * 60 * 60 * 1000;

/** The set total as printed next to the number: "092" in a 94-card set reads "092/094". */
function printedTotal(localId, official) {
  if (official == null) return null;
  const total = String(official);
  return /^\d+$/.test(String(localId)) ? total.padStart(String(localId).length, '0') : total;
}

/**
 * Small client for the free TCGdex API (https://tcgdex.dev), used to find the official
 * artwork and details for a card from what is printed on it: name, set code, number.
 */
export class TcgClient {
  constructor({ baseUrl = 'https://api.tcgdex.net/v2/en', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async #get(path, ttl = DAY) {
    const hit = this.cache.get(path);
    if (hit && hit.expires > Date.now()) return hit.value;
    const res = await this.fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TCGdex ${path} responded ${res.status}`);
    const value = await res.json();
    this.cache.set(path, { value, expires: Date.now() + ttl });
    return value;
  }

  sets() {
    return this.#get('/sets');
  }

  set(setId) {
    return this.#get(`/sets/${encodeURIComponent(setId)}`);
  }

  card(tcgId) {
    return this.#get(`/cards/${encodeURIComponent(tcgId)}`);
  }

  /** Set ids to try for a set code and/or printed set total. */
  async #candidateSets(setCode, total) {
    const known = setFromCode(setCode);
    if (known) return [known.id];
    if (!total) return [];
    const sets = (await this.sets()) ?? [];
    return sets.filter((s) => String(s.cardCount?.official) === String(Number(total))).map((s) => s.id);
  }

  /**
   * Find cards matching what the user typed. Any combination of fields works:
   * set code + number is the most precise, name alone gives the broadest list.
   */
  async search({ name, setCode, number, limit = 48 } = {}) {
    name = String(name ?? '').trim();
    const { localId, total } = parseNumber(number);
    const setIds = await this.#candidateSets(setCode, total);
    const results = [];

    if (setIds.length) {
      for (const setId of setIds) {
        const set = await this.set(setId);
        if (!set?.cards) continue;
        for (const card of set.cards) {
          if (localId && !sameNumber(card.localId, localId)) continue;
          if (name && !card.name.toLowerCase().includes(name.toLowerCase())) continue;
          results.push(this.#brief(card, set));
        }
      }
    }

    if (!results.length && name) {
      const cards = (await this.#get(`/cards?name=${encodeURIComponent(name)}`, DAY / 4)) ?? [];
      const sets = await this.sets().catch(() => null);
      const setsById = new Map((sets ?? []).map((s) => [s.id, s]));
      for (const card of cards) {
        const setId = card.id.slice(0, card.id.lastIndexOf('-'));
        if (localId && !sameNumber(card.localId, localId)) continue;
        if (setIds.length && !setIds.includes(setId)) continue;
        results.push(this.#brief(card, setsById.get(setId) ?? { id: setId }));
      }
      // Newest sets first: what people are pulling today is most likely recent.
      results.reverse();
    }

    return results.slice(0, limit);
  }

  #brief(card, set) {
    return {
      tcgId: card.id,
      name: card.name,
      number: card.localId,
      setId: set.id,
      setName: set.name ?? null,
      setCode: codeFromSetId(set.id),
      setTotal: printedTotal(card.localId, set.cardCount?.official),
      image: card.image ? `${card.image}/high.png` : null,
      thumb: card.image ? `${card.image}/low.webp` : null,
    };
  }

  /** Full details for a chosen card, normalised to the columns we store. */
  async details(tcgId) {
    const card = await this.card(tcgId);
    if (!card) return null;
    const setId = card.set?.id ?? tcgId.slice(0, tcgId.lastIndexOf('-'));
    return {
      tcg_id: card.id,
      name: card.name,
      number: card.localId,
      set_id: setId,
      set_name: card.set?.name ?? null,
      set_code: codeFromSetId(setId),
      set_total: printedTotal(card.localId, card.set?.cardCount?.official),
      rarity: card.rarity ?? null,
      category: card.category ?? null,
      hp: card.hp ?? null,
      types: Array.isArray(card.types) ? card.types.join(', ') : null,
      official_image_url: card.image ? `${card.image}/high.png` : null,
    };
  }

  /** Download an image; returns { buffer, contentType } or null when unavailable. */
  async download(url) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs * 2) });
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/png' };
  }
}
