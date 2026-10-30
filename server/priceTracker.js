// PokemonPriceTracker (https://www.pokemonpricetracker.com) — free API tier: 100 credits a day, no
// credit card. Adds what the other free sources don't have: eBay graded sales (PSA / BGS / CGC …),
// a few days of price history, and population data on plans that include it.
//
// Credits: each card returned costs 1, plus 1 for its history and 1 for its eBay data. Their docs
// show several response layouts, so everything is read defensively (see normalizeCard).

const DATE_KEYS = ['date', 'day', 'timestamp', 'time', 'recordedAt', 'updatedAt'];
const PRICE_KEYS = ['market', 'marketPrice', 'price', 'value', 'avg', 'average', 'averagePrice', 'mid'];

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const first = (obj, keys) => {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return undefined;
};
const isoDay = (v) => {
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/** "psa10" → "PSA 10", "cgc9_5" / "cgc9.5" → "CGC 9.5", "bgs10" → "BGS 10", "ungraded" → "Ungraded". */
export function gradeLabel(key) {
  const k = String(key).toLowerCase().replace(/[\s-]/g, '');
  const m = /^(psa|bgs|cgc|sgc|tag|ace|beckett)(\d{1,2})(?:[._](5))?$/.exec(k);
  if (m) return `${m[1] === 'beckett' ? 'BGS' : m[1].toUpperCase()} ${m[2]}${m[3] ? '.5' : ''}`;
  if (/^(raw|ungraded|nm|nearmint)$/.test(k)) return 'Ungraded';
  return String(key);
}

/** Every array of {date, price} points anywhere in `node`, with the path that led to it. */
function findSeries(node, path = [], out = []) {
  if (Array.isArray(node)) {
    const points = node
      .map((p) => ({ day: isoDay(first(p, DATE_KEYS)), price: num(first(p, PRICE_KEYS)) }))
      .filter((p) => p.day && p.price);
    if (points.length && points.length >= node.length / 2) out.push({ path, points });
    return out;
  }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) findSeries(v, [...path, k], out);
  return out;
}

/**
 * The history line that best matches the card: prefer Near Mint, then the card's printing
 * (e.g. "Reverse Holofoil" for a reverse holo), then the longest series.
 */
function pickHistory(series, printing) {
  const score = (s) => {
    const p = s.path.join(' ').toLowerCase();
    return (p.includes('near mint') || p.includes('nearmint') ? 4 : 0)
      + (printing && p.includes(printing.toLowerCase()) ? 2 : 0)
      + (/graded|psa|bgs|cgc|ebay/.test(p) ? -10 : 0)
      + s.points.length / 1000;
  };
  return [...series].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function gradedSales(ebay) {
  const groups = ebay?.salesByGrade ?? ebay?.grades ?? null;
  if (!groups || typeof groups !== 'object') return [];
  return Object.entries(groups).map(([key, g]) => {
    if (!g || typeof g !== 'object') return null;
    const smart = g.smartMarketPrice;
    return {
      grade: gradeLabel(key),
      count: Number(first(g, ['count', 'salesCount', 'totalSales', 'sales'])) || 0,
      average: num(first(g, ['averagePrice', 'average', 'avgPrice', 'avg'])),
      median: num(first(g, ['medianPrice', 'median'])),
      low: num(first(g, ['minPrice', 'min', 'low'])),
      high: num(first(g, ['maxPrice', 'max', 'high'])),
      market: num(typeof smart === 'object' ? smart?.price : smart) ?? num(g.marketPrice7Day),
      lastSaleDate: isoDay(first(g, ['lastSaleDate', 'lastSold', 'lastSoldDate'])),
      lastSalePrice: num(first(g, ['lastSalePrice', 'lastSoldPrice'])),
    };
  }).filter((g) => g && (g.count || g.average || g.median))
    .sort((a, b) => (b.average ?? b.median ?? 0) - (a.average ?? a.median ?? 0));
}

/** Individual eBay sales, when the response includes them. */
function individualSales(ebay) {
  const list = first(ebay ?? {}, ['sales', 'recentSales', 'soldListings', 'listings']);
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    title: String(first(s, ['title', 'name']) ?? ''),
    price: num(first(s, ['price', 'soldPrice', 'salePrice'])),
    soldAt: isoDay(first(s, ['soldDate', 'date', 'saleDate', 'soldAt'])),
    grade: s.grade ? gradeLabel(s.grade) : null,
    url: first(s, ['url', 'link', 'itemUrl', 'itemWebUrl']) ?? null,
    itemId: first(s, ['itemId', 'id']) ?? null,
  })).filter((s) => s.title && s.price && s.soldAt);
}

function population(raw) {
  const pop = first(raw, ['population', 'psaPopulation', 'pop', 'gradedPopulation']) ?? raw?.ebay?.population;
  if (!pop || typeof pop !== 'object') return [];
  const rows = Array.isArray(pop)
    ? pop.map((p) => [first(p, ['grade', 'label']), first(p, ['count', 'population', 'total'])])
    : Object.entries(pop);
  return rows
    .map(([grade, count]) => ({ grade: gradeLabel(grade), count: Number(count) }))
    .filter((p) => Number.isFinite(p.count) && p.count >= 0 && !/^(updated|lastupdated|source)$/i.test(p.grade));
}

/** One card from any of the documented response layouts, in the shape the app stores. */
/** TCGplayer's official picture for a product, largest first. */
export function tcgplayerImages(productId) {
  if (!productId) return [];
  const base = `https://tcgplayer-cdn.tcgplayer.com/product/${encodeURIComponent(productId)}`;
  return [`${base}_in_1000x1000.jpg`, `${base}_400w.jpg`];
}

/** Picture links in an answer ("imageUrl", "imageCdnUrl800", "images.large"…), largest first. */
function imageLinks(raw) {
  const found = [];
  const walk = (obj, depth) => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (typeof value === 'string' && /ima?ge?|picture/i.test(key) && /^https?:\/\//i.test(value)) found.push(`${key} ${value}`);
      else if (value && typeof value === 'object' && !Array.isArray(value) && /ima?ge?/i.test(key) && depth < 2) walk(value, depth + 1);
    }
  };
  walk(raw, 0);
  const size = (s) => (/1000|large|hi-?res|800|full|original/i.test(s) ? 0 : /400|medium/i.test(s) ? 1 : 2);
  return [...new Set(found.sort((a, b) => size(a) - size(b)).map((s) => s.slice(s.indexOf(' ') + 1)))];
}

export function normalizeCard(raw, { printing = null } = {}) {
  const prices = raw.prices ?? raw.price ?? {};
  const conditionPrice = prices.conditions?.['Near Mint'] ?? prices.conditions?.nearMint;
  const series = findSeries(first(raw, ['priceHistory', 'history']) ?? {});
  const history = pickHistory(series, printing);
  return {
    pptId: raw.id ?? raw._id ?? null,
    tcgPlayerId: raw.tcgPlayerId != null ? String(raw.tcgPlayerId) : null,
    name: raw.name ?? null,
    setName: raw.setName ?? raw.set?.name ?? (typeof raw.set === 'string' ? raw.set : null),
    number: raw.cardNumber ?? raw.number ?? null,
    rarity: raw.rarity ?? null,
    market: {
      price: num(first(prices, ['market', 'marketPrice'])) ?? num(conditionPrice?.price ?? conditionPrice?.market),
      low: num(first(prices, ['low', 'lowPrice'])),
      condition: prices.primaryCondition ?? (conditionPrice ? 'Near Mint' : null),
      printing: prices.primaryPrinting ?? null,
      updated: raw.lastUpdated ?? prices.lastUpdated ?? null,
    },
    history: history ? history.points.sort((a, b) => a.day.localeCompare(b.day)) : [],
    historyLabel: history ? history.path.filter((p) => !/^(conditions|history|\d+)$/i.test(p)).join(' · ') || 'Market' : null,
    gradedSales: gradedSales(raw.ebay),
    sales: individualSales(raw.ebay),
    population: population(raw),
    images: imageLinks(raw),
  };
}

export class PriceTrackerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class PriceTrackerClient {
  constructor({
    apiKey = process.env.POKEMONPRICETRACKER_API_KEY,
    baseUrl = process.env.POKEMONPRICETRACKER_URL ?? 'https://www.pokemonpricetracker.com/api/v2',
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
  } = {}) {
    Object.assign(this, { apiKey, fetch: fetchImpl, timeoutMs });
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /** Credits a request will cost at most (1 per card + 1 each for history and eBay data). */
  static cost({ limit = 1, includeHistory = false, includeEbay = false }) {
    return limit * (1 + (includeHistory ? 1 : 0) + (includeEbay ? 1 : 0));
  }

  /**
   * GET /cards. Returns { cards (raw), credits (what this call actually cost), remaining (the
   * service's own count of credits left today, when it reports one) }.
   */
  async cards({ tcgPlayerId, search, limit = 1, includeHistory = false, includeEbay = false, days = 3 }) {
    const params = new URLSearchParams();
    if (tcgPlayerId) params.set('tcgPlayerId', String(tcgPlayerId));
    if (search) params.set('search', search);
    params.set('limit', String(limit));
    if (includeHistory) {
      params.set('includeHistory', 'true');
      params.set('days', String(days));
    }
    if (includeEbay) params.set('includeEbay', 'true');
    const res = await this.fetch(`${this.baseUrl}/cards?${params}`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new PriceTrackerError('PokemonPriceTracker rejected the API key. Check POKEMONPRICETRACKER_API_KEY.', res.status);
    if (res.status === 429) throw new PriceTrackerError('PokemonPriceTracker’s daily limit has been reached. It resets tomorrow.', 429);
    if (!res.ok) throw new PriceTrackerError(`PokemonPriceTracker responded ${res.status}${body.error ? `: ${body.error}` : ''}`, res.status);

    const data = body.data ?? body.cards ?? body.results ?? body;
    const cards = (Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []).filter((c) => c && typeof c === 'object');
    const header = (names) => {
      for (const n of names) {
        const v = res.headers.get(n);
        if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
      }
      return null;
    };
    return {
      cards,
      credits: body.metadata?.creditsUsed ?? body.creditsUsed ?? PriceTrackerClient.cost({ limit: Math.max(1, cards.length), includeHistory, includeEbay }),
      remaining: body.metadata?.creditsRemaining ?? header(['x-ratelimit-remaining', 'x-ratelimit-daily-remaining', 'x-credits-remaining', 'x-api-credits-remaining']),
    };
  }
}
