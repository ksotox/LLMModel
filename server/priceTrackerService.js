// Keeps PokemonPriceTracker inside its free tier (100 credits a day by default):
//  - answers come from a cache for a day (their prices update daily anyway);
//  - a card's TCGplayer id comes free from TCGdex's price data, so most cards never need a search,
//    and a search's result is remembered;
//  - credits spent are counted per day in the database, and background refreshes stop early so a
//    share of the day's credits is always left for cards you open yourself;
//  - two requests for the same card at the same time share one call.
// Every answer is also written into the local price history, which keeps growing for free.

import { PriceTrackerClient, PriceTrackerError, normalizeCard } from './priceTracker.js';
import { sameNumber } from './setCodes.js';
import { listingMatchesCard } from './soldStats.js';

export const PROVIDER = 'pokemonpricetracker';
const HOUR = 60 * 60 * 1000;
const PRINTING = { 'reverse-holo': 'Reverse Holofoil', holo: 'Holofoil', 'full-art': 'Holofoil', normal: 'Normal' };

export class PriceTrackerService {
  constructor({
    client = new PriceTrackerClient(),
    store,
    catalog,
    dailyCredits = Number(process.env.POKEMONPRICETRACKER_DAILY_CREDITS ?? 100),
    reserveShare = 0.3, // kept back from background refreshes for cards you open
    freshForMs = 24 * HOUR,
    historyDays = Number(process.env.POKEMONPRICETRACKER_HISTORY_DAYS ?? 3),
    now = () => new Date(),
  }) {
    Object.assign(this, { client, store, catalog, dailyCredits, reserveShare, freshForMs, historyDays, now });
    this.inFlight = new Map();
  }

  get configured() {
    return this.client.configured;
  }

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  status() {
    const used = this.store.usage(PROVIDER, this.today());
    const byCount = Math.max(0, this.dailyCredits - used.credits);
    const remaining = used.reported_remaining != null ? Math.min(byCount, used.reported_remaining) : byCount;
    const tomorrow = new Date(`${this.today()}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return {
      configured: this.configured,
      dailyCredits: this.dailyCredits,
      used: used.credits,
      requests: used.requests,
      remaining,
      reservedForViewing: Math.ceil(this.dailyCredits * this.reserveShare),
      resetsAt: tomorrow.toISOString(),
    };
  }

  canSpend(credits, { background = false } = {}) {
    const { remaining, reservedForViewing } = this.status();
    return remaining - credits >= (background ? reservedForViewing : 0);
  }

  async #call(params, { background }) {
    const cost = PriceTrackerClient.cost(params);
    if (!this.canSpend(cost, { background })) return null;
    const result = await this.client.cards(params);
    this.store.addUsage(PROVIDER, this.today(), result.credits, result.remaining);
    return result;
  }

  /** The card's TCGplayer product id: remembered, from TCGdex's price data, or by a small search. */
  async #tcgPlayerId(card, { background }) {
    const cached = this.store.getTrackerCache(card.id)?.tcg_player_id;
    if (cached) return cached;
    const fromTcgdex = await this.catalog.tcgPlayerId?.(card).catch(() => null);
    if (fromTcgdex) return fromTcgdex;
    if (!card.name) return null;
    // Search costs a credit per card returned: ask for 3 at most and pick the one with the right number.
    const found = await this.#call({ search: [card.name, card.set_name].filter(Boolean).join(' '), limit: 3 }, { background });
    if (!found) return null;
    // Same number isn't enough (every set has a #066): the printed total and set name must agree too.
    const letters = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = found.cards.map((c) => normalizeCard(c)).find((c) => {
      const [n, total] = String(c.number ?? '').split('/');
      return c.tcgPlayerId
        && (!card.number || sameNumber(n, card.number))
        && (!total || !card.set_total || Number(total) === Number(card.set_total))
        && (!c.setName || !card.set_name || letters(c.setName).includes(letters(card.set_name)));
    });
    return match?.tcgPlayerId ?? null;
  }

  /** What the app has for a card, without calling the API. */
  view(card) {
    const cache = this.store.getTrackerCache(card.id);
    const fetchedAt = cache?.fetched_at ?? null;
    const data = cache?.data ?? null;
    return {
      configured: this.configured,
      fetchedAt,
      stale: !fetchedAt || this.now() - new Date(fetchedAt) > this.freshForMs,
      tcgPlayerId: cache?.tcg_player_id ?? null,
      market: data?.market ?? null,
      gradedSales: data?.gradedSales ?? [],
      population: data?.population ?? [],
      historyLabel: data?.historyLabel ?? null,
      error: cache?.error ?? null,
      usage: this.status(),
    };
  }

  /**
   * Bring a card's PokemonPriceTracker data up to date, using the cache when it is less than a
   * day old (unless `force`). Never spends credits past the daily budget.
   */
  refresh(card, { force = false, background = false } = {}) {
    if (this.inFlight.has(card.id)) return this.inFlight.get(card.id);
    const job = this.#refresh(card, { force, background }).finally(() => this.inFlight.delete(card.id));
    this.inFlight.set(card.id, job);
    return job;
  }

  async #refresh(card, { force, background }) {
    const current = this.view(card);
    if (!this.configured) return { ...current, fromCache: true };
    if (!force && !current.stale) return { ...current, fromCache: true };
    // A card that failed (e.g. not on PokemonPriceTracker) isn't retried for a day: that would burn credits.
    const attempted = this.store.getTrackerCache(card.id)?.attempted_at;
    if (!force && current.error && attempted && this.now() - new Date(attempted) < this.freshForMs) return { ...current, fromCache: true };

    const params = { limit: 1, includeHistory: true, includeEbay: true, days: this.historyDays };
    if (!this.canSpend(PriceTrackerClient.cost(params), { background })) return { ...current, fromCache: true, budgetExceeded: true };

    let tcgPlayerId;
    let result;
    try {
      tcgPlayerId = await this.#tcgPlayerId(card, { background });
      if (!tcgPlayerId) {
        this.store.saveTrackerCache(card.id, { error: 'This card wasn’t found on PokemonPriceTracker.' });
        return { ...this.view(card), fromCache: false };
      }
      result = await this.#call({ ...params, tcgPlayerId }, { background });
    } catch (err) {
      const message = err instanceof PriceTrackerError ? err.message : 'PokemonPriceTracker could not be reached right now.';
      this.store.saveTrackerCache(card.id, { tcgPlayerId, error: message });
      return { ...this.view(card), fromCache: true };
    }
    if (!result) return { ...this.view(card), fromCache: true, budgetExceeded: true };

    const raw = result.cards.find((c) => String(c.tcgPlayerId) === String(tcgPlayerId)) ?? result.cards[0];
    if (!raw) {
      this.store.saveTrackerCache(card.id, { tcgPlayerId, error: 'This card wasn’t found on PokemonPriceTracker.' });
      return { ...this.view(card), fromCache: false };
    }
    const data = normalizeCard(raw, { printing: PRINTING[card.variant] ?? null });
    this.store.saveTrackerCache(card.id, { tcgPlayerId, data });
    this.#remember(card, data);
    return { ...this.view(card), fromCache: false };
  }

  /** Write everything dated into the local history, and individual eBay sales into the sales list. */
  #remember(card, data) {
    for (const p of data.history) this.store.recordPrice(card.id, { source: PROVIDER, label: 'Market price', price: p.price, day: p.day });
    if (data.market.price) this.store.recordPrice(card.id, { source: PROVIDER, label: 'Market price', price: data.market.price });
    for (const g of data.gradedSales) {
      const price = g.average ?? g.median;
      if (price) this.store.recordPrice(card.id, { source: 'ebay-graded', label: g.grade, price });
    }
    const sales = data.sales.filter((s) => listingMatchesCard(s.title, card));
    if (sales.length) this.store.addSales(card.id, sales.map((s) => ({ ...s, currency: 'USD' })), PROVIDER);
  }

  /**
   * Background top-up: refresh the cards with the oldest (or no) data while the daily budget,
   * minus the share kept for viewing cards, allows. Returns how many cards were refreshed.
   */
  async runBackground({ maxCards = 50 } = {}) {
    if (!this.configured) return 0;
    let refreshed = 0;
    for (const card of this.store.cardsByTrackerAge()) {
      if (refreshed >= maxCards) break;
      if (card.tracker_attempted_at && this.now() - new Date(card.tracker_attempted_at) < this.freshForMs) break; // the rest are fresher
      if (!this.canSpend(PriceTrackerClient.cost({ limit: 1, includeHistory: true, includeEbay: true }), { background: true })) break;
      const result = await this.refresh(card, { background: true });
      if (result.budgetExceeded) break;
      if (!result.fromCache && !result.error) refreshed++;
    }
    return refreshed;
  }
}
