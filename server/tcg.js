import { codeFromSetId, parseNumber, sameNumber, setFromCode } from './setCodes.js';

const DAY = 24 * 60 * 60 * 1000;

/** The set total as printed next to the number: "092" in a 94-card set reads "092/094". */
function printedTotal(localId, official) {
  if (!official) return null; // promo sets have no printed total
  const total = String(official);
  return /^\d+$/.test(String(localId)) ? total.padStart(String(localId).length, '0') : total;
}

/**
 * Small client for the free TCGdex API (https://tcgdex.dev), used to find the official
 * artwork and details for a card from what is printed on it: name, set code, number.
 * One client per language: English ids are TCGdex's own ("sv02-066"); other languages get a
 * prefix ("ja:SV2a-100") so the same id never means two different cards.
 */
export class TcgClient {
  constructor({ baseUrl, lang = 'en', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.lang = lang;
    this.prefix = lang === 'en' ? '' : `${lang}:`;
    this.baseUrl = (baseUrl ?? `https://api.tcgdex.net/v2/${lang}`).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  /** Our id for a TCGdex card id, and back. */
  ownId(tcgdexId) {
    return `${this.prefix}${tcgdexId}`;
  }

  owns(id) {
    return this.prefix ? String(id ?? '').startsWith(this.prefix) : !/^[a-z]+:/.test(String(id ?? ''));
  }

  #tcgdexId(id) {
    return this.prefix && String(id).startsWith(this.prefix) ? String(id).slice(this.prefix.length) : String(id);
  }

  /** The set code printed on the card: "PAL" for English sets; Japanese cards print TCGdex's set id ("SV2a"). */
  #printedCode(setId) {
    return this.lang === 'en' ? codeFromSetId(setId) : setId ?? null;
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
    return this.#get(`/cards/${encodeURIComponent(this.#tcgdexId(tcgId))}`);
  }

  /** Set ids to try for a set code and/or printed set total. */
  async #candidateSets(setCode, total) {
    if (this.lang === 'en') {
      const known = setFromCode(setCode);
      if (known) return [known.id];
    }
    if (!setCode && !total) return [];
    const sets = (await this.sets()) ?? [];
    if (setCode && this.lang !== 'en') {
      // Japanese cards print the set id itself; OCR may read "SV2A" for "SV2a".
      const byCode = sets.filter((s) => String(s.id).toLowerCase() === String(setCode).toLowerCase());
      if (byCode.length) return byCode.map((s) => s.id);
    }
    if (!total) return [];
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
      tcgId: this.ownId(card.id),
      language: this.lang,
      name: card.name,
      number: card.localId,
      setId: set.id,
      setName: set.name ?? null,
      setCode: this.#printedCode(set.id),
      setTotal: printedTotal(card.localId, set.cardCount?.official),
      image: card.image ? `${card.image}/high.png` : null,
      thumb: card.image ? `${card.image}/low.webp` : null,
    };
  }

  /** Full details for a chosen card, normalised to the columns we store. */
  async details(tcgId) {
    const card = await this.card(tcgId);
    if (!card) return null;
    const setId = card.set?.id ?? this.#tcgdexId(tcgId).slice(0, this.#tcgdexId(tcgId).lastIndexOf('-'));
    return {
      tcg_id: this.ownId(card.id),
      language: this.lang,
      name: card.name,
      number: card.localId,
      set_id: setId,
      set_name: card.set?.name ?? null,
      set_code: this.#printedCode(setId),
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
