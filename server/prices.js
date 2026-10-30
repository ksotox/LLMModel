import { parseNumber, sameNumber, setFromCode } from './setCodes.js';

const HOUR = 60 * 60 * 1000;

const positive = (v) => (typeof v === 'number' && v > 0 ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

// Which TCGplayer price line to use for each of our variants, best first.
const TCGPLAYER_ORDER = {
  'reverse-holo': ['reverse-holofoil', 'reverseHolofoil', 'reverse'],
  normal: ['normal', 'holofoil', 'holo'],
  default: ['holofoil', 'holo', 'normal'],
};
const TCGPLAYER_LABEL = { 'reverse-holofoil': 'reverse holo', reverseHolofoil: 'reverse holo', reverse: 'reverse holo', holofoil: 'holo', holo: 'holo', normal: 'normal' };

/**
 * Pick a market price from a TCGdex card's `pricing` block:
 *   { tcgplayer: { unit: 'USD', updated, normal: { marketPrice, midPrice, lowPrice, highPrice }, 'reverse-holofoil': {...} },
 *     cardmarket: { unit: 'EUR', updated, trend, avg, low, 'trend-holo', 'avg-holo', ... } }
 * TCGplayer (USD) is preferred; Cardmarket (EUR) is the fallback. `sources` limits which are used.
 */
export function priceFromTcgdex(pricing, variant = 'normal', { sources = ['tcgplayer', 'cardmarket'] } = {}) {
  const tp = sources.includes('tcgplayer') ? pricing?.tcgplayer : null;
  if (tp) {
    const order = TCGPLAYER_ORDER[variant] ?? TCGPLAYER_ORDER.default;
    const others = Object.keys(TCGPLAYER_LABEL).filter((k) => !order.includes(k));
    for (const key of [...order, ...others]) {
      const line = tp[key];
      const value = positive(line?.marketPrice) ?? positive(line?.midPrice);
      if (!value) continue;
      return {
        value: round2(value),
        currency: tp.unit ?? 'USD',
        low: positive(line.lowPrice),
        high: positive(line.highPrice),
        source: `TCGplayer market price (${TCGPLAYER_LABEL[key]})`,
        updated: tp.updated ?? null,
      };
    }
  }
  const cm = sources.includes('cardmarket') ? pricing?.cardmarket : null;
  if (cm) {
    // Cardmarket's "-holo" columns are the reverse-holo printing of the card.
    const reverse = variant === 'reverse-holo';
    const value = (reverse && (positive(cm['trend-holo']) ?? positive(cm['avg-holo']))) || positive(cm.trend) || positive(cm.avg);
    if (value) {
      return {
        value: round2(value),
        currency: cm.unit ?? 'EUR',
        low: (reverse && positive(cm['low-holo'])) || positive(cm.low),
        high: null,
        source: 'Cardmarket price trend',
        updated: cm.updated ?? null,
      };
    }
  }
  return null;
}

const SUBTYPE_ORDER = {
  'reverse-holo': ['Reverse Holofoil'],
  normal: ['Normal', 'Holofoil'],
  default: ['Holofoil', 'Normal'],
};

const cleanGroupName = (name) => String(name ?? '').replace(/^[A-Z0-9.\s]+:\s*/i, '').trim().toLowerCase();

/**
 * Backup price source: tcgcsv.com, a free daily mirror of TCGplayer's catalogue and prices
 * (no API key). Used when TCGdex has no price for a card.
 */
export class TcgCsvClient {
  constructor({ baseUrl = 'https://tcgcsv.com/tcgplayer/3', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async #get(path) {
    const hit = this.cache.get(path);
    if (hit && hit.expires > Date.now()) return hit.value;
    const res = await this.fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`tcgcsv ${path} responded ${res.status}`);
    const value = (await res.json())?.results ?? [];
    this.cache.set(path, { value, expires: Date.now() + 12 * HOUR });
    return value;
  }

  async #group({ setName, setCode }) {
    // The set's TCGplayer group id is known for every printed set code; otherwise match by name.
    const known = setFromCode(setCode)?.tcgplayer;
    if (known) return { groupId: known };
    const groups = await this.#get('/groups');
    const name = String(setName ?? '').trim().toLowerCase();
    return (name && groups.find((g) => cleanGroupName(g.name) === name))
      || (setCode && groups.find((g) => String(g.abbreviation ?? '').toUpperCase() === String(setCode).toUpperCase()))
      || null;
  }

  /** The card's TCGplayer product: { productId, name, imageUrl, groupId }, or null. */
  async product({ setName, setCode, number, name }) {
    const { localId } = parseNumber(number);
    if (!localId || (!setName && !setCode)) return null;
    const group = await this.#group({ setName, setCode });
    if (!group) return null;
    const products = await this.#get(`/${group.groupId}/products`);
    const printed = (p) => String(p.extendedData?.find((d) => d.name === 'Number')?.value ?? '').split('/')[0].trim();
    // Promos can be listed as "MEP059" or "SVP 059": compare the digits when the card's number is plain digits.
    const digitsOnly = /^\d+$/.test(localId);
    const sameCard = (p) => sameNumber(printed(p), localId) || (digitsOnly && sameNumber(printed(p).match(/(\d+)$/)?.[1], localId));
    let candidates = products.filter(sameCard);
    // Some listings carry the number only in the product name ("Fennekin - 059").
    if (!candidates.length && name) {
      const digits = String(Number(localId.match(/(\d+)$/)?.[1] ?? NaN));
      candidates = products.filter((p) => String(p.name).toLowerCase().startsWith(String(name).toLowerCase())
        && digits !== 'NaN' && (String(p.name).match(/\d+/g) ?? []).some((d) => String(Number(d)) === digits));
    }
    const named = name ? candidates.find((p) => String(p.name).toLowerCase().startsWith(String(name).toLowerCase())) : null;
    const product = named ?? (candidates.length === 1 ? candidates[0] : null);
    return product ? { ...product, groupId: group.groupId } : null;
  }

  /** Official card pictures from TCGplayer, largest first. */
  async images(card) {
    const product = await this.product(card);
    if (!product) return [];
    const url = product.imageUrl || `https://tcgplayer-cdn.tcgplayer.com/product/${product.productId}_200w.jpg`;
    return [...new Set([url.replace(/_\d+w\.(jpe?g|png)$/i, '_in_1000x1000.$1'), url.replace(/_\d+w\./i, '_400w.'), url])];
  }

  async price({ setName, setCode, number, name, variant = 'normal' }) {
    const product = await this.product({ setName, setCode, number, name });
    if (!product) return null;
    const lines = (await this.#get(`/${product.groupId}/prices`)).filter((p) => p.productId === product.productId);
    const order = SUBTYPE_ORDER[variant] ?? SUBTYPE_ORDER.default;
    const sorted = [...lines].sort((a, b) => {
      const ia = order.indexOf(a.subTypeName);
      const ib = order.indexOf(b.subTypeName);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const line of sorted) {
      const value = positive(line.marketPrice) ?? positive(line.midPrice);
      if (!value) continue;
      return {
        value: round2(value),
        currency: 'USD',
        low: positive(line.lowPrice),
        high: positive(line.highPrice),
        source: `TCGplayer market price (${String(line.subTypeName).toLowerCase()}, via tcgcsv.com)`,
        updated: new Date().toISOString(),
      };
    }
    return null;
  }
}
