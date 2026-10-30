// eBay sold prices for a card: average sold price, a trend chart (green up, red down, yellow flat)
// and the sold listings behind them. Listings come from eBay's official API when it's set up, or are
// pasted in: the user opens the eBay "Sold items" search, copies the results and pastes them here.

import { api } from './api.js';
import { clear, confirmDialog, formatDate, formatPrice, h, toast } from './ui.js';

// ---------------------------------------------------------------------------
// Reading listings pasted from eBay.com

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const SOLD_DATE = /\bSold\s+(?:([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Z][a-z]{2})[a-z]*\.?,?\s+(\d{4}))/;
const PRICE = /^(?:(US|C|AU|NZ)\s?)?([$£€])\s?([\d,]+(?:\.\d{2})?)(?:\s+to\s+.*)?$/;
const CURRENCY = { $: 'USD', '£': 'GBP', '€': 'EUR' };
const PREFIXED = { C: 'CAD', AU: 'AUD', NZ: 'NZD', US: 'USD' };
const CONDITION = /^(brand new|new( \(other\))?|pre-owned|used|ungraded|graded|near mint.*|lightly played.*|moderately played.*|heavily played.*|damaged.*|excellent.*|very good.*)(\s?[·-].*)?$/i;
const NOISE = /^(new listing|sponsored|shop on ebay|opens in a new window or tab|or best offer|best offer accepted|free (shipping|delivery|returns).*|.*\bwatchers?\b.*|.*\bsold\b \d+.*|\d+% positive.*)$/i;

function parseSoldDate(text) {
  const m = SOLD_DATE.exec(text);
  if (!m) return null;
  const [mon, day, year] = m[1] ? [m[1], m[2], m[3]] : [m[5], m[4], m[6]];
  const month = MONTHS[mon.toLowerCase()];
  if (month == null) return null;
  return new Date(Date.UTC(Number(year), month, Number(day), 12)).toISOString();
}

function parsePrice(line) {
  const t = line.trim();
  if (/^\+|shipping|delivery|postage|^was\b/i.test(t)) return null;
  const m = PRICE.exec(t);
  if (!m) return null;
  return { price: Number(m[3].replace(/,/g, '')), currency: (m[1] && PREFIXED[m[1]]) || CURRENCY[m[2]] || 'USD' };
}

/** Text of an element with a line break at every element boundary, so labels don't run together. */
function lines(el) {
  const out = [];
  let current = '';
  const walk = (node) => {
    if (node.nodeType === 3) current += node.textContent;
    else if (node.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(node.tagName)) {
      out.push(current);
      current = '';
      node.childNodes.forEach(walk);
      out.push(current);
      current = '';
    }
  };
  walk(el);
  out.push(current);
  return out.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const cleanTitle = (t) => t.replace(/^new listing\s*/i, '').replace(/opens in a new window or tab/i, '').replace(/\s+/g, ' ').trim();

function listingFromLines(ls, { title, url, itemId } = {}) {
  let soldAt = null;
  let price = null;
  let condition = null;
  for (const l of ls) {
    soldAt ??= parseSoldDate(l);
    price ??= parsePrice(l);
    if (!condition && CONDITION.test(l)) condition = l;
  }
  title ??= ls.filter((l) => l.length >= 12 && !NOISE.test(l) && !SOLD_DATE.test(l) && !parsePrice(l) && !CONDITION.test(l))
    .sort((a, b) => b.length - a.length)[0];
  if (!soldAt || !price || !title) return null;
  return { itemId: itemId ?? null, title: cleanTitle(title), ...price, soldAt, condition, url: url ?? null };
}

function fromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const idOf = (a) => /\/itm\/(?:[^/?#]+\/)?(\d{9,})/.exec(a.getAttribute('href') ?? '')?.[1] ?? null;
  const byId = new Map();
  for (const a of doc.querySelectorAll('a[href*="/itm/"]')) {
    const id = idOf(a);
    if (id && id !== '123456' && !byId.has(id)) byId.set(id, a);
  }
  const listings = [];
  for (const [id, link] of byId) {
    // The listing's box: the largest ancestor that holds no other listing.
    let box = link;
    while (box.parentElement && box.parentElement !== doc.body) {
      const ids = new Set([...box.parentElement.querySelectorAll('a[href*="/itm/"]')].map(idOf).filter(Boolean));
      if (ids.size > 1) break;
      box = box.parentElement;
    }
    const heading = box.querySelector('[role="heading"], h3, .s-item__title, .s-card__title');
    const title = cleanTitle((heading ?? link).textContent ?? '') || undefined;
    const listing = listingFromLines(lines(box), { title: title && title.length >= 8 ? title : undefined, url: `https://www.ebay.com/itm/${id}`, itemId: id });
    if (listing) listings.push(listing);
  }
  return listings;
}

function fromText(text) {
  const ls = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const marks = ls.map((l, i) => (SOLD_DATE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!marks.length) return [];
  // eBay shows "Sold <date>" either above or below each listing. If the lines right after the first
  // date hold a price, the date heads its listing; otherwise it closes the listing above it.
  const after = ls.slice(marks[0] + 1, marks[1] ?? marks[0] + 9);
  const dateLast = !after.some((l) => parsePrice(l));
  const listings = [];
  marks.forEach((m, k) => {
    const block = dateLast ? ls.slice(k ? marks[k - 1] + 1 : Math.max(0, m - 8), m + 1) : ls.slice(m, marks[k + 1] ?? Math.min(ls.length, m + 9));
    const listing = listingFromLines(block);
    if (listing) listings.push(listing);
  });
  return listings;
}

/** Sold listings from what the user pasted: the copied page (HTML) when available, else plain text. */
export function parseEbayPaste({ html = '', text = '' } = {}) {
  const fromPage = html ? fromHtml(html) : [];
  return fromPage.length ? fromPage : fromText(text || (html ? new DOMParser().parseFromString(html, 'text/html').body.innerText ?? '' : ''));
}

// ---------------------------------------------------------------------------
// Trend chart

const TREND_COLOURS = { up: '#16a34a', down: '#dc2626', flat: '#eab308' };
const TREND_WORDS = { up: 'Trending up', down: 'Trending down', flat: 'Holding steady' };
const ARROWS = { up: '▲', down: '▼', flat: '►' };
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, text) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
};

/**
 * Line chart of average sold price per period. Each segment is coloured by where the price went
 * from the previous period: green up, red down, yellow about the same (within 2%).
 */
export function trendChart(points, { currency = 'USD', by = 'week' } = {}) {
  const W = 640;
  const H = 240;
  const pad = { l: 56, r: 16, t: 16, b: 34 };
  const when = (p) => {
    if (by === 'month') return new Date(p.start).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    if (by === 'day') return new Date(p.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return `Week of ${formatDate(p.start)}`;
  };
  const label = (p) => `${when(p)}: ${formatPrice(p.average, currency)}${p.count != null ? ` (${p.count} sale${p.count === 1 ? '' : 's'})` : ''}`;
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-chart', role: 'img' });
  chart.setAttribute('aria-label', points.map(label).join('; '));
  if (!points.length) return chart;

  const prices = points.map((p) => p.average);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi - lo < 0.01) { lo -= 0.5; hi += 0.5; }
  const span = hi - lo;
  lo = Math.max(0, lo - span * 0.12);
  hi += span * 0.12;
  const times = points.map((p) => Date.parse(p.start));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const x = (t) => (t1 === t0 ? (pad.l + W - pad.r) / 2 : pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // Cheap cards move by fractions of a cent: show enough decimals that no two ticks read the same.
  const digits = Math.min(4, Math.ceil(-Math.log10((hi - lo) / 4)));
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    chart.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
    chart.append(svg('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, formatPrice(v, currency, digits > 2 ? { digits } : {})));
  }
  const step = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    if (i % step && i !== points.length - 1) return;
    const text = new Date(p.start).toLocaleDateString(undefined, by === 'month' ? { month: 'short', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const anchor = points.length > 1 && i === 0 ? 'start' : points.length > 1 && i === points.length - 1 ? 'end' : 'middle';
    chart.append(svg('text', { x: x(times[i]), y: H - 10, 'text-anchor': anchor, class: 'axis' }, text));
  });

  for (let i = 1; i < points.length; i++) {
    chart.append(svg('line', {
      x1: x(times[i - 1]), y1: y(points[i - 1].average), x2: x(times[i]), y2: y(points[i].average),
      stroke: TREND_COLOURS[points[i].direction], class: `trend-segment ${points[i].direction}`, 'data-direction': points[i].direction,
    }));
  }
  points.forEach((p, i) => {
    const dot = svg('circle', { cx: x(times[i]), cy: y(p.average), r: 4.5, class: 'trend-point', fill: i ? TREND_COLOURS[p.direction] : '#6b7280' });
    dot.append(svg('title', {}, label(p)));
    chart.append(dot);
  });
  return chart;
}

// ---------------------------------------------------------------------------
// The section on the card page

const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 10}%`;

export function ebaySection(card) {
  const el = h('section.ebay', h('h3', 'eBay sold prices'), h('p.muted', 'Loading eBay sales…'));
  let filter = 'all';
  let by = 'week';
  let data = null;
  let showAll = false;

  const load = async (fn = () => api.ebay(card.id, filter)) => {
    try {
      data = await fn();
      render();
      return data;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  };

  function pastePanel() {
    const box = h('div.paste-box', { contentEditable: 'true', role: 'textbox', 'aria-label': 'Paste eBay sold listings here', 'data-placeholder': 'Paste here (Ctrl+V / ⌘V, or long-press → Paste)' });
    const note = h('p.small.muted');
    box.addEventListener('paste', async (e) => {
      e.preventDefault();
      const listings = parseEbayPaste({ html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain') });
      if (!listings.length) {
        note.textContent = 'No sold listings found in what was pasted. Make sure you copied the eBay “Sold items” results page.';
        return;
      }
      note.textContent = `Found ${listings.length} sold listing${listings.length === 1 ? '' : 's'} — saving…`;
      const result = await load(() => api.ebayImport(card.id, listings, filter));
      if (result) toast(`Added ${result.added} sale${result.added === 1 ? '' : 's'}${result.skipped ? ` · skipped ${result.skipped} that weren’t this card` : ''}`, 'success');
    });
    return h('details.paste-help', { open: !data?.counts.all },
      h('summary', 'Add sales from eBay.com (free)'),
      h('ol.small',
        h('li', h('a', { href: data.searchUrl, target: '_blank', rel: 'noopener' }, 'Open the sold listings on eBay ↗'), ' (sign in to eBay if asked).'),
        h('li', 'Select the results (Ctrl+A / ⌘A, or “Select all” on a phone) and copy them.'),
        h('li', 'Paste below. Only listings for this exact card are kept; lots and other cards are skipped.')),
      box, note);
  }

  function statsBlock(stats) {
    const t = stats.trend;
    return h('div.ebay-stats',
      h('div.stat', h('span.stat-label', 'Average sold'), h('strong.stat-big', formatPrice(stats.average, stats.currency)), h('span.muted.small', `${stats.count} sale${stats.count === 1 ? '' : 's'}`)),
      h('div.stat', h('span.stat-label', 'Median'), h('strong', formatPrice(stats.median, stats.currency))),
      h('div.stat', h('span.stat-label', 'Range'), h('strong', `${formatPrice(stats.low, stats.currency)} – ${formatPrice(stats.high, stats.currency)}`)),
      h('div.stat', h('span.stat-label', 'Trend'),
        t
          ? h('strong.trend-word', { class: t.direction }, `${ARROWS[t.direction]} ${TREND_WORDS[t.direction]}`)
          : h('span.muted', 'Needs 2+ weeks of sales'),
        t && h('span.muted.small', `${pct(t.change)} over ${t.weeks} week${t.weeks === 1 ? '' : 's'} · ${t.perWeek >= 0 ? '+' : '−'}${formatPrice(Math.abs(t.perWeek), stats.currency)}/week`)));
  }

  function listingsTable(listings) {
    const rows = showAll ? listings : listings.slice(0, 10);
    return h('div.ebay-listings',
      h('table',
        h('thead', h('tr', h('th', 'Sold'), h('th', 'Listing'), h('th', 'Condition'), h('th.num', 'Price'), h('th', h('span.sr-only', 'Remove')))),
        h('tbody', rows.map((l) => h('tr',
          h('td.nowrap', formatDate(l.sold_at)),
          h('td', l.url ? h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title) : l.title),
          h('td', l.grade ? h('span.chip.grade', l.grade) : (l.condition ?? 'Ungraded')),
          h('td.num', formatPrice(l.price, l.currency)),
          h('td', h('button.btn.small.ghost', {
            type: 'button',
            title: 'Remove this listing (not this card)',
            'aria-label': `Remove listing: ${l.title}`,
            onclick: async () => {
              if (await confirmDialog('Remove this listing from the price data?', { okLabel: 'Remove' })) load(() => api.ebayDelete(card.id, l.id, filter));
            },
          }, '×')))))),
      listings.length > 10 && h('button.btn.link', { type: 'button', onclick: () => { showAll = !showAll; render(); } },
        showAll ? 'Show fewer' : `Show all ${listings.length} sales`));
  }

  function render() {
    const stats = data.stats;
    const points = by === 'month' ? stats.monthly : stats.weekly;
    const filterSel = h('select', { 'aria-label': 'Which sales', onchange: (e) => { filter = e.target.value; load(); } },
      h('option', { value: 'all' }, `All sales (${data.counts.all})`),
      h('option', { value: 'raw' }, `Ungraded (${data.counts.raw})`),
      h('option', { value: 'graded' }, `Graded (${data.counts.graded})`));
    filterSel.value = filter;
    const toggle = h('div.segmented', { role: 'group', 'aria-label': 'Group sales by' },
      ['week', 'month'].map((b) => h('button', { type: 'button', class: b === by ? 'active' : '', 'aria-pressed': String(b === by), onclick: () => { by = b; render(); } }, b === 'week' ? 'Weekly' : 'Monthly')));
    const refresh = data.apiConfigured && h('button.btn.small', {
      type: 'button',
      onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Checking eBay…';
        const result = await load(() => api.ebayRefresh(card.id, filter));
        if (result) toast(result.added ? `Added ${result.added} new sale${result.added === 1 ? '' : 's'} from eBay` : 'No new eBay sales', 'success');
      },
    }, 'Update from eBay');

    clear(el,
      h('div.ebay-head', h('h3', 'eBay sold prices'), data.counts.all > 0 && filterSel, refresh),
      stats.count
        ? [
          statsBlock(stats),
          h('div.chart-head',
            h('span.legend', h('span.key.up', '▲ up'), h('span.key.down', '▼ down'), h('span.key.flat', '► about the same')),
            toggle),
          points.length >= 2 ? trendChart(points, { currency: stats.currency, by }) : h('p.muted.small', `Only one ${by} of sales so far — the trend line appears once there are two.`),
          listingsTable(data.listings),
        ]
        : h('p.muted', data.counts.all ? 'No sales match this filter.' : 'No eBay sales saved for this card yet.'),
      pastePanel(),
      h('p.small.muted', `Searching eBay for “${data.query}”.${data.lastAdded ? ` Last added ${formatDate(data.lastAdded, true)}.` : ''}`));
  }

  load();
  return el;
}
