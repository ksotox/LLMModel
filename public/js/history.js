// "Price history & graded sales" on the card page: the app's own day-by-day price history (from the
// free sources and PokemonPriceTracker), plus PokemonPriceTracker's eBay graded sales and population.

import { api } from './api.js';
import { trendChart } from './ebay.js';
import { clear, formatDate, formatPrice, h, toast } from './ui.js';

const FLAT_BAND = 0.02;
const SOURCE_NAMES = {
  tcgplayer: 'TCGplayer market price',
  cardmarket: 'Cardmarket price trend (€)',
  'cardmarket-usd': 'Cardmarket price trend (in $)',
  pokemonpricetracker: 'PokemonPriceTracker market price',
};
const seriesName = (s) => (s.source === 'ebay-graded' ? `eBay average · ${s.label}` : SOURCE_NAMES[s.source] ?? `${s.source} · ${s.label}`);

/** Daily points in the shape the trend chart draws, each step marked up / down / flat. */
function chartPoints(points) {
  return points.map((p, i) => {
    const prev = points[i - 1]?.price;
    const change = prev ? (p.price - prev) / prev : null;
    return {
      start: `${p.day}T00:00:00.000Z`,
      average: p.price,
      count: null,
      direction: change == null ? null : change > FLAT_BAND ? 'up' : change < -FLAT_BAND ? 'down' : 'flat',
    };
  });
}

const ago = (iso) => {
  const hours = Math.round((Date.now() - Date.parse(iso)) / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
};

export function historySection(card) {
  const el = h('section.price-history', h('h3', 'Price history & graded sales'), h('p.muted', 'Loading…'));
  let history = null;
  let tracker = null;
  let chosen = null;
  let refreshing = false;

  async function load({ refresh = false, force = false } = {}) {
    try {
      // History is read after the update, so the prices it just saved are included.
      tracker = await (refresh ? api.trackerRefresh(card.id, force) : api.tracker(card.id));
      history = await api.priceHistory(card.id);
      if (refresh && tracker.budgetExceeded) toast('PokemonPriceTracker’s daily credits are used up — showing the last saved data.', 'info');
      if (force && tracker.error) toast(tracker.error, 'error');
      render();
    } catch (err) {
      clear(el, h('h3', 'Price history & graded sales'), h('p.muted', err.message));
    }
  }

  function historyBlock() {
    // Market prices first, then the graded averages from the highest grade down.
    const order = { tcgplayer: 0, pokemonpricetracker: 1, 'cardmarket-usd': 2, cardmarket: 3, 'ebay-graded': 4 };
    const series = history.series.filter((s) => s.points.length)
      .sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9) || b.last - a.last);
    if (!series.length) return h('p.muted', 'No price history yet. A price is saved every day the app runs, so the chart fills in over time.');
    const current = series.find((s) => `${s.source}|${s.label}` === chosen) ?? series.find((s) => s.points.length > 1) ?? series[0];
    chosen = `${current.source}|${current.label}`;
    const select = h('select', { 'aria-label': 'Price line', onchange: (e) => { chosen = e.target.value; render(); } },
      series.map((s) => h('option', { value: `${s.source}|${s.label}` }, `${seriesName(s)} (${s.points.length} day${s.points.length === 1 ? '' : 's'})`)));
    select.value = chosen;
    const pct = current.change != null ? `${current.change > 0 ? '+' : ''}${Math.round(current.change * 1000) / 10}%` : '';
    return h('div.history-block',
      h('div.chart-head',
        select,
        current.direction && h('strong.trend-word', { class: current.direction },
          `${{ up: '▲', down: '▼', flat: '►' }[current.direction]} ${pct} since ${formatDate(current.points[0].day)}`)),
      current.points.length > 1
        ? trendChart(chartPoints(current.points), { currency: current.currency, by: 'day' })
        : h('p.muted.small', `One price so far: ${formatPrice(current.last, current.currency)} on ${formatDate(current.points[0].day)}. The line appears from the second day.`));
  }

  function trackerBlock() {
    if (!tracker.configured) {
      return h('details.tracker-setup',
        h('summary', 'Add eBay graded sales (free PokemonPriceTracker key)'),
        h('ol.small',
          h('li', 'Get a free API key at ', h('a', { href: 'https://www.pokemonpricetracker.com/', target: '_blank', rel: 'noopener' }, 'pokemonpricetracker.com ↗'), ' (100 credits a day, no credit card).'),
          h('li', 'Start the app with ', h('code', 'POKEMONPRICETRACKER_API_KEY=your-key'), ' (see the README).'),
          h('li', 'Graded eBay sales (PSA, BGS, CGC…) and extra price history then appear here. The app uses about 3 credits per card per day, at most.')));
    }
    const u = tracker.usage;
    const graded = tracker.gradedSales;
    return h('div.tracker',
      graded.length
        ? h('div.ebay-listings',
          h('table',
            h('thead', h('tr', h('th', 'Grade'), h('th.num', 'eBay sales'), h('th.num', 'Average'), h('th.num', 'Median'), h('th.num', 'Range'), h('th', 'Last sale'))),
            h('tbody', graded.map((g) => h('tr',
              h('td', h('span.chip.grade', g.grade)),
              h('td.num', g.count || '—'),
              h('td.num', g.average != null ? formatPrice(g.average, 'USD') : '—'),
              h('td.num', g.median != null ? formatPrice(g.median, 'USD') : '—'),
              h('td.num', g.low != null && g.high != null ? `${formatPrice(g.low, 'USD')} – ${formatPrice(g.high, 'USD')}` : '—'),
              h('td.nowrap', g.lastSaleDate ? formatDate(g.lastSaleDate) : '—'))))))
        : h('p.muted.small', tracker.fetchedAt ? 'No graded eBay sales recorded for this card.' : (tracker.error ?? 'Graded sales will appear after the first update.')),
      tracker.population.length > 0 && h('p.population.small',
        h('strong', 'Population: '),
        tracker.population.map((p, i) => [i ? ' · ' : '', `${p.grade}: ${p.count.toLocaleString()}`])),
      h('div.tracker-foot',
        h('span.small.muted',
          'From PokemonPriceTracker',
          tracker.fetchedAt ? ` · updated ${ago(tracker.fetchedAt)}` : '',
          ` · ${u.used} of ${u.dailyCredits} credits used today`),
        h('button.btn.small', {
          type: 'button',
          disabled: refreshing || u.remaining < 3,
          title: u.remaining < 3 ? 'Not enough credits left today' : 'Uses about 3 credits',
          onclick: async () => {
            refreshing = true;
            render();
            await load({ refresh: true, force: true });
            refreshing = false;
            render();
          },
        }, refreshing ? 'Updating…' : 'Update now')));
  }

  function render() {
    if (!history || !tracker) return;
    clear(el, h('h3', 'Price history & graded sales'), historyBlock(), trackerBlock());
  }

  // Show what's saved straight away; ask for fresh data only when it's over a day old (the server
  // decides whether the day's credits allow it).
  load().then(() => {
    if (tracker?.configured && tracker.stale && !tracker.error) load({ refresh: true });
  });
  return el;
}
