// Scoring for the scan benchmark (pure functions; used in the browser and in unit tests).
//
// A detected outline counts as finding a card when its corners are, on average, within
// `tolerance` (a fraction of the card's width) of the labelled corners. The corner order is
// ignored (a card photographed sideways or upside down still counts).

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p);

/** A card's width in the photo: the mean of its two shorter sides. */
export function cardWidth(quad) {
  const q = quad.map(pt);
  const sides = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])].sort((a, b) => a - b);
  return (sides[0] + sides[1]) / 2;
}

/** Mean corner distance between two outlines, best of the 4 rotations and both directions, as a fraction of the truth's width. */
export function cornerError(truth, found) {
  const t = truth.map(pt);
  const f = found.map(pt);
  const orders = [f, [...f].reverse()];
  let best = Infinity;
  for (const o of orders) {
    for (let shift = 0; shift < 4; shift++) {
      let sum = 0;
      for (let i = 0; i < 4; i++) sum += dist(t[i], o[(i + shift) % 4]);
      best = Math.min(best, sum / 4);
    }
  }
  return best / Math.max(1, cardWidth(t));
}

/**
 * Pair labelled cards with detected outlines, closest first, each used once.
 * Returns { pairs: [{ truth, found, error }], missed: [truthIndex], extra: [foundIndex] }.
 */
export function matchQuads(truths, founds, tolerance = 0.02) {
  const cand = [];
  truths.forEach((t, ti) => founds.forEach((f, fi) => {
    const e = cornerError(t, f);
    if (e <= tolerance) cand.push({ ti, fi, e });
  }));
  cand.sort((a, b) => a.e - b.e);
  const usedT = new Set();
  const usedF = new Set();
  const pairs = [];
  for (const c of cand) {
    if (usedT.has(c.ti) || usedF.has(c.fi)) continue;
    usedT.add(c.ti);
    usedF.add(c.fi);
    pairs.push({ truth: c.ti, found: c.fi, error: c.e });
  }
  return {
    pairs,
    missed: truths.map((_, i) => i).filter((i) => !usedT.has(i)),
    extra: founds.map((_, i) => i).filter((i) => !usedF.has(i)),
  };
}

/** Whether an identification result names the labelled card. */
export function sameCard(label, match) {
  if (!match) return false;
  if (label.tcgIds?.length) return label.tcgIds.includes(match.tcgId);
  return String(match.name ?? '').toLowerCase() === String(label.name ?? '').toLowerCase();
}

const pct = (n, d) => (d ? n / d : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Totals over scene results. Each result: { group, truths, found, pairs, missed, extra, ms,
 * longestTask (the longest main-thread task while finding, ms), reads: [{ correct, confidence, ms }] }.
 * Returns the overall line and one per group.
 */
export function summarize(results) {
  const line = (rs) => {
    const truths = rs.reduce((s, r) => s + r.truths, 0);
    const found = rs.reduce((s, r) => s + r.found, 0);
    const hits = rs.reduce((s, r) => s + r.pairs.length, 0);
    const reads = rs.flatMap((r) => r.reads ?? []);
    const errors = rs.flatMap((r) => r.pairs.map((p) => p.error));
    return {
      photos: rs.length,
      cards: truths,
      recall: pct(hits, truths),
      precision: pct(hits, found),
      cornerError: median(errors),
      detectMs: median(rs.map((r) => r.ms)),
      longestTask: Math.max(0, ...rs.map((r) => r.longestTask ?? 0)),
      read: reads.length,
      correct: pct(reads.filter((r) => r.correct).length, reads.length),
      confidentWrong: reads.filter((r) => !r.correct && r.confidence === 'high').length,
      readMs: median(reads.map((r) => r.ms)),
    };
  };
  const groups = {};
  for (const r of results) (groups[r.group] ??= []).push(r);
  return { all: line(results), groups: Object.fromEntries(Object.entries(groups).map(([g, rs]) => [g, line(rs)])) };
}

/** The roadmap's targets (docs/ROADMAP.md, A4), checked against a summary. */
export function checkTargets(summary) {
  const g = summary.groups;
  const synthetic = Object.entries(g).filter(([k]) => k.startsWith('synthetic'));
  const synth = synthetic.reduce((acc, [, v]) => ({ hits: acc.hits + (v.recall ?? 0) * v.cards, cards: acc.cards + v.cards }), { hits: 0, cards: 0 });
  return [
    { target: 'synthetic detection recall ≥ 95%', value: pct(synth.hits, synth.cards), ok: pct(synth.hits, synth.cards) >= 0.95 },
    { target: 'binder pages: ≥ 8 of 9 cards found', value: g['synthetic-binder']?.recall ?? null, ok: (g['synthetic-binder']?.recall ?? 0) >= 8 / 9 },
    { target: 'confident but wrong = 0', value: summary.all.confidentWrong, ok: summary.all.confidentWrong === 0 },
    { target: 'no main-thread task over 100 ms while finding cards', value: summary.all.longestTask, ok: summary.all.longestTask <= 100 },
  ];
}
