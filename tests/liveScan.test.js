import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPixels, hashDistance, rankImages, imageEvidence, repeatOf, recognitionStatus, validationReport } from '../public/js/scan/core.js';
import { normalizeStamp } from '../public/js/printing.js';
import { openDb } from '../server/db.js';

test('artwork hashes preserve brightness-order structure and report ambiguous candidates', () => {
  const pixels = (reverse, brighten = 0) => ({ width: 9, height: 8, data: Uint8ClampedArray.from(Array.from({ length: 72 }, (_, i) => [((reverse ? 8 - i % 9 : i % 9) * 20) + brighten, 0, 0, 255]).flat()) });
  const a = hashPixels(pixels(false)), b = hashPixels(pixels(true));
  assert.equal(hashDistance(a, hashPixels(pixels(false, 20))), 0);
  assert.equal(hashDistance(a, b), 64);
  assert.equal(hashDistance(undefined, a), 64);
  assert.equal(imageEvidence(rankImages(a, [{ tcgId: 'a', hash: a }, { tcgId: 'b', hash: b }])), 'supports');
  assert.equal(imageEvidence(rankImages(a, [{ tcgId: 'a', hash: a }, { tcgId: 'b', hash: a }])), 'ambiguous');
});

test('repeat sightings and identical catalog cards never silently count as more copies', () => {
  const first = { hash: '0'.repeat(64), match: { tcgId: 'sv02-066' } };
  assert.equal(repeatOf([first], '0'.repeat(64)), first);
  assert.equal(repeatOf([first], '1'.repeat(64), { tcgId: 'sv02-066' }), first);
  assert.equal(repeatOf([first], '1'.repeat(64), { tcgId: 'sv02-067' }), undefined);
});

test('conflicting image evidence remains for review and validation keeps original predictions', () => {
  assert.equal(recognitionStatus({ confidence: 'high', match: { tcgId: 'a' } }, { evidence: 'supports', bestId: 'b' }), 'conflicting evidence');
  const report = validationReport([{ predictedId: 'wrong', match: { tcgId: 'right' }, expectedId: 'right', confidence: 'high' }, { confidence: 'low' }]);
  assert.equal(report.total, 2); assert.equal(report.labelled, 1); assert.equal(report.correct, 0); assert.equal(report.confidentWrong, 1);
  assert.equal(report.results[0].finalId, 'right');
});

test('printing details separate physical copies, duplicates and grouped collection rows', () => {
  const store = openDb(':memory:');
  try {
    const base = { name: 'Voltorb', tcg_id: 'sv02-066', variant: 'reverse-holo', user_id: 1 };
    const first = store.insertCard(base);
    const second = store.insertCard({ ...base, foil_pattern: 'master-ball' });
    const third = store.insertCard({ ...base, foil_pattern: 'master-ball', stamp: 'staff' });
    assert.deepEqual(store.ownedByKey(1, [base, { ...base, foil_pattern: 'master-ball' }, { ...base, foil_pattern: 'master-ball', stamp: 'staff' }]), [1, 1, 1]);
    assert.equal(store.queryCards({ userId: 1, group: true }).total, 3);
    assert.deepEqual(store.copiesOf(store.getCard(second)).map((c) => c.id), [second]);
    assert.equal(store.getCard(first).foil_pattern, 'unknown');
    assert.equal(store.getCard(third).stamp, 'staff');
  } finally { store.close(); }
});

test('multiple stamps have a stable inventory identity and empty selection means none', () => {
  assert.equal(normalizeStamp('staff+pokemon-center+staff'), 'pokemon-center+staff');
  assert.equal(normalizeStamp(''), 'none');
  assert.equal(normalizeStamp('unrecognized'), null);
});
