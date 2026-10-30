// Currency conversion, so every price can be shown in US dollars. Rates come from Frankfurter
// (https://frankfurter.dev): free, no key, the European Central Bank's daily reference rates.
// If it can't be reached, a fixed fallback rate is used (EUR_USD_RATE overrides it).

const HOUR = 60 * 60 * 1000;

export class ExchangeRates {
  constructor({
    baseUrl = process.env.FX_URL ?? 'https://api.frankfurter.dev/v1',
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    fallback = { EUR: Number(process.env.EUR_USD_RATE ?? 1.15) },
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    Object.assign(this, { fetch: fetchImpl, timeoutMs, fallback });
    this.cache = new Map();
  }

  /** US dollars per one unit of `currency`: { rate, date, live }. */
  async usdRate(currency) {
    const from = String(currency ?? '').toUpperCase();
    if (!from || from === 'USD') return { rate: 1, date: null, live: true };
    const hit = this.cache.get(from);
    if (hit && hit.expires > Date.now()) return hit.value;
    let value;
    try {
      const res = await this.fetch(`${this.baseUrl}/latest?base=${encodeURIComponent(from)}&symbols=USD`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`exchange rates responded ${res.status}`);
      const body = await res.json();
      const rate = Number(body?.rates?.USD);
      if (!(rate > 0)) throw new Error('no USD rate');
      value = { rate, date: body.date ?? null, live: true };
      this.cache.set(from, { value, expires: Date.now() + 12 * HOUR });
    } catch {
      if (!this.fallback[from]) return null;
      value = { rate: this.fallback[from], date: null, live: false };
      this.cache.set(from, { value, expires: Date.now() + HOUR }); // try the live rate again soon
    }
    return value;
  }

  /** A price object ({ value, currency, low, high, source, … }) converted to US dollars. */
  async toUsd(price) {
    if (!price || !price.currency || price.currency === 'USD') return price;
    const fx = await this.usdRate(price.currency);
    if (!fx) return price;
    const conv = (v) => (v == null ? null : Math.round(v * fx.rate * 100) / 100);
    const original = new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(price.value);
    return {
      ...price,
      value: conv(price.value),
      low: conv(price.low),
      high: conv(price.high),
      currency: 'USD',
      source: `${price.source}, converted from ${original}${fx.live ? '' : ' (approximate rate)'}`,
      original: { value: price.value, currency: price.currency, rate: fx.rate },
    };
  }
}
