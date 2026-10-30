// Statistics over a card's eBay sold listings: average sold price, and how the price moves over time
// (weekly or monthly averages, with each step marked up / down / flat for the trend chart).

const DAY = 24 * 60 * 60 * 1000;
// Moves smaller than this (either way) count as "stayed the same".
export const FLAT_BAND = 0.02;

const round2 = (v) => Math.round(v * 100) / 100;
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function direction(change) {
  if (change > FLAT_BAND) return 'up';
  if (change < -FLAT_BAND) return 'down';
  return 'flat';
}

/** Start of the bucket a date falls in: Monday of its week, or the 1st of its month (UTC). */
function bucketStart(date, by) {
  const d = new Date(date);
  if (by === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * DAY;
}

function bucketEnd(start, by) {
  if (by === 'month') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
  }
  return start + 7 * DAY - 1;
}

/**
 * Average sold price per week or month, oldest first. Each point carries the change from the
 * previous point and whether that step went up, down or stayed flat; `rolling` is the average of
 * the last 3 periods, which smooths out single odd sales.
 */
export function priceSeries(sales, by = 'week') {
  const buckets = new Map();
  for (const s of sales) {
    const key = bucketStart(s.soldAt, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s.price);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([start, prices]) => ({
    start: new Date(start).toISOString(),
    end: new Date(bucketEnd(start, by)).toISOString(),
    average: round2(mean(prices)),
    median: round2(median(prices)),
    count: prices.length,
  }));
  points.forEach((p, i) => {
    const window = points.slice(Math.max(0, i - 2), i + 1);
    p.rolling = round2(mean(window.map((w) => w.average)));
    if (i === 0) {
      p.change = null;
      p.direction = null;
    } else {
      const prev = points[i - 1].average;
      p.change = prev ? (p.average - prev) / prev : 0;
      p.direction = direction(p.change);
    }
  });
  return points;
}

/** Least-squares slope of price against time, in price per day. */
function slopePerDay(sales) {
  if (sales.length < 2) return 0;
  const xs = sales.map((s) => Date.parse(s.soldAt) / DAY);
  const ys = sales.map((s) => s.price);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

/**
 * Everything the card page shows: average and median sold price, the weekly and monthly series,
 * and the overall trend (direction, % change first → last period, and rate per week).
 */
export function soldStats(sales) {
  const valid = sales.filter((s) => Number.isFinite(s.price) && s.price > 0 && !Number.isNaN(Date.parse(s.soldAt)))
    .sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt));
  if (!valid.length) return { count: 0, average: null, median: null, trend: null, weekly: [], monthly: [] };

  const prices = valid.map((s) => s.price);
  const currencies = valid.map((s) => s.currency ?? 'USD');
  const currency = currencies.sort((a, b) => currencies.filter((c) => c === b).length - currencies.filter((c) => c === a).length)[0];
  const weekly = priceSeries(valid, 'week');
  const monthly = priceSeries(valid, 'month');

  // Trend = a straight line fitted through every sale, so one odd sale can't flip it. Its slope is
  // the rate per week; how far it rises or falls over the period, relative to the average sold
  // price, is the % change that decides up / down / about the same.
  let trend = null;
  if (weekly.length >= 2) {
    const perDay = slopePerDay(valid);
    const t0 = Date.parse(valid[0].soldAt) / DAY;
    const t1 = Date.parse(valid[valid.length - 1].soldAt) / DAY;
    const change = (perDay * (t1 - t0)) / mean(prices);
    trend = {
      direction: direction(change),
      change: Math.round(change * 1000) / 1000,
      perWeek: round2(perDay * 7),
      weeks: Math.max(1, Math.round((t1 - t0) / 7)),
    };
  }

  return {
    count: valid.length,
    currency,
    average: round2(mean(prices)),
    median: round2(median(prices)),
    low: round2(Math.min(...prices)),
    high: round2(Math.max(...prices)),
    from: valid[0].soldAt,
    to: valid[valid.length - 1].soldAt,
    trend,
    weekly,
    monthly,
  };
}

// ---- reading sold-listing titles ----

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'Beckett'];

/** "PSA 10", "BGS 9.5"… found in a listing title, or null for a raw (ungraded) card. */
export function gradeFromTitle(title) {
  const m = String(title ?? '').match(new RegExp(`\\b(${GRADERS.join('|')})\\s*(?:GEM\\s*(?:MINT|MT)\\s*)?(10|[1-9](?:\\.5)?)\\b`, 'i'));
  if (!m) return null;
  const grader = m[1].toLowerCase() === 'beckett' ? 'BGS' : m[1].toUpperCase();
  return `${grader} ${m[2]}`;
}

const LOT = /\b(lot|bundle|bulk|collection|x\s?\d{1,3}\b|\d{1,3}\s?x\b|set of|playset|binder|booster box|etb|elite trainer|sealed|pack)\b/i;

/**
 * Does a sold listing look like this exact card (rather than a lot, a different print or a
 * different card)? The title must name the card and, when known, show its number.
 */
export function listingMatchesCard(title, card) {
  const t = String(title ?? '').toLowerCase();
  if (!t || LOT.test(t)) return false;
  const name = String(card.name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  if (name.length && !name.every((w) => t.replace(/[^a-z0-9 ]/g, ' ').includes(w))) return false;
  if (card.number) {
    const n = String(Number(card.number)) === 'NaN' ? card.number.toLowerCase() : String(Number(card.number));
    const numberHere = new RegExp(`(^|[^0-9a-z])0*${n}(\\s*/\\s*0*(\\d+))?([^0-9]|$)`).exec(t);
    if (!numberHere) return false;
    // "066/198" is another set's card with the same number.
    if (card.set_total && numberHere[3] && Number(numberHere[3]) !== Number(card.set_total)) return false;
  }
  return true;
}
