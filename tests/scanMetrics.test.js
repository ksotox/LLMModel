// Scoring for the scan benchmark (scripts/scan-bench/metrics.js).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cardWidth, checkTargets, cornerError, matchQuads, sameCard, summarize } from '../scripts/scan-bench/metrics.js';

const card = (x, y, w = 63, h = 88) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe('scan benchmark scoring', () => {
  test('corner error is a fraction of the card width, whatever the corner order', () => {
    const t = card(0, 0);
    assert.equal(cardWidth(t), 63);
    assert.equal(cornerError(t, t), 0);
    const shifted = t.map(([x, y]) => [x + 6.3, y]);
    assert.ok(Math.abs(cornerError(t, shifted) - 0.1) < 1e-9);
    const rotated = [t[2], t[3], t[0], t[1]];
    assert.equal(cornerError(t, rotated), 0, 'upside down still counts');
    assert.equal(cornerError(t, [...t].reverse()), 0, 'mirrored order too');
    assert.equal(cornerError(t, t.map(([x, y]) => ({ x, y }))), 0, 'points as objects');
  });

  test('outlines pair with labels closest first, each once; the rest are missed or extra', () => {
    const truths = [card(0, 0), card(100, 0), card(200, 0)];
    const found = [card(101, 0), card(0.5, 0), card(500, 500), card(100.2, 0)];
    const { pairs, missed, extra } = matchQuads(truths, found, 0.02);
    assert.deepEqual(pairs.map((p) => [p.truth, p.found]).sort(), [[0, 1], [1, 3]]);
    assert.deepEqual(missed, [2]);
    assert.deepEqual(extra.sort(), [0, 2], 'the second outline on the same card counts as extra');
  });

  test('identification is right when the match is one of the label’s ids, else by name', () => {
    assert.equal(sameCard({ name: 'Linoone', tcgIds: ['sv03-168', 'ptcg:sv3-168'] }, { tcgId: 'ptcg:sv3-168', name: 'Linoone' }), true);
    assert.equal(sameCard({ name: 'Linoone', tcgIds: ['sv03-168'] }, { tcgId: 'sv04-001', name: 'Linoone' }), false);
    assert.equal(sameCard({ name: 'Voltorb' }, { name: 'voltorb' }), true);
    assert.equal(sameCard({ name: 'Voltorb' }, null), false);
  });

  test('totals per group, and the roadmap targets', () => {
    const results = [
      { group: 'synthetic-binder', truths: 9, found: 9, pairs: Array.from({ length: 8 }, () => ({ error: 0.01 })), ms: 100, reads: [{ correct: true, confidence: 'high', ms: 900 }] },
      { group: 'synthetic-single', truths: 1, found: 2, pairs: [{ error: 0.005 }], ms: 50, reads: [{ correct: false, confidence: 'high', ms: 800 }] },
    ];
    const s = summarize(results);
    assert.equal(s.all.cards, 10);
    assert.equal(s.all.recall, 0.9);
    assert.equal(s.all.precision, 9 / 11);
    assert.equal(s.all.confidentWrong, 1);
    assert.equal(s.groups['synthetic-binder'].recall, 8 / 9);
    const t = Object.fromEntries(checkTargets(s).map((x) => [x.target, x.ok]));
    assert.equal(t['binder pages: ≥ 8 of 9 cards found'], true);
    assert.equal(t['synthetic detection recall ≥ 95%'], false);
    assert.equal(t['confident but wrong = 0'], false);
  });
});
