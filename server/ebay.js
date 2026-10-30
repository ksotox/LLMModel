// eBay sold listings, the free and allowed ways:
//  1. eBay's official Marketplace Insights API (free; your eBay developer app must be approved for it).
//     Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to switch it on.
//  2. Copy and paste: the app opens the matching "Sold items" search on ebay.com in your browser and
//     you paste the results back in (see public/js/ebay.js). That works without any approval.
// Either way the listings are stored with the card, so its price history builds up over time.

const INSIGHTS_SCOPE = 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights';
export const POKEMON_SINGLES_CATEGORY = '183454'; // CCG Individual Cards

/** What to search eBay for: the name and printed number ("Voltorb 066/193"), or "promo" for promos. */
export function searchQuery(card) {
  const number = card.number ? (card.set_total ? `${card.number}/${card.set_total}` : card.number) : '';
  const promo = !card.set_total && /promo/i.test(card.set_name ?? '') ? 'promo' : '';
  return [card.name, number, promo].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** The eBay.com "Sold items" search for a card, for opening in the browser. */
export function soldSearchUrl(card) {
  const params = new URLSearchParams({
    _nkw: searchQuery(card),
    _sacat: POKEMON_SINGLES_CATEGORY,
    LH_Sold: '1',
    LH_Complete: '1',
    _ipg: '240',
    _sop: '13', // newest first
  });
  return `https://www.ebay.com/sch/i.html?${params}`;
}

export class EbayNotApproved extends Error {}

export class EbayClient {
  constructor({
    clientId = process.env.EBAY_CLIENT_ID,
    clientSecret = process.env.EBAY_CLIENT_SECRET,
    marketplace = process.env.EBAY_MARKETPLACE ?? 'EBAY_US',
    baseUrl = process.env.EBAY_API_URL ?? 'https://api.ebay.com',
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
  } = {}) {
    Object.assign(this, { clientId, clientSecret, marketplace, fetch: fetchImpl, timeoutMs });
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = null;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async #accessToken() {
    if (this.token && this.token.expires > Date.now() + 60000) return this.token.value;
    const res = await this.fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: INSIGHTS_SCOPE }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'invalid_scope') throw new EbayNotApproved('Your eBay app is not approved for the Marketplace Insights API yet.');
      throw new Error(`eBay sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
    }
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 7200) * 1000 };
    return this.token.value;
  }

  /** Sold listings for a card from the last 90 days (eBay's limit), newest first. */
  async soldListings(card, { maxResults = 600 } = {}) {
    const token = await this.#accessToken();
    const out = [];
    for (let offset = 0; offset < maxResults; offset += 200) {
      const params = new URLSearchParams({
        q: searchQuery(card),
        category_ids: POKEMON_SINGLES_CATEGORY,
        limit: '200',
        offset: String(offset),
      });
      const res = await this.fetch(`${this.baseUrl}/buy/marketplace_insights/v1_beta/item_sales/search?${params}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': this.marketplace },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 403) throw new EbayNotApproved('Your eBay app is not approved for the Marketplace Insights API yet.');
      if (!res.ok) throw new Error(`eBay search failed (${res.status})`);
      const body = await res.json();
      for (const s of body.itemSales ?? []) {
        const price = Number(s.lastSoldPrice?.value);
        if (!price || !s.lastSoldDate) continue;
        out.push({
          itemId: s.itemId ?? null,
          title: s.title ?? '',
          price,
          currency: s.lastSoldPrice?.currency ?? 'USD',
          soldAt: s.lastSoldDate,
          condition: s.condition ?? null,
          url: s.itemWebUrl ?? null,
        });
      }
      if (!body.itemSales?.length || offset + 200 >= (body.total ?? 0)) break;
    }
    return out;
  }
}
