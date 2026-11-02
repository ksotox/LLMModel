import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMetric, mimeFromMagic, normalizeAnalysis, pngDataUriToBuffer } from '../server/grading/normalize.js';

test('rejects suspicious and invalid file content', () => {
  assert.equal(mimeFromMagic(Buffer.from('<svg onload="alert(1)"></svg>')), null);
  assert.equal(mimeFromMagic(Buffer.from('malicious.jpg')), null);
  assert.equal(mimeFromMagic(Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(pngDataUriToBuffer('data:text/html;base64,SGVsbG8='), null);
});

test('drops untrusted metadata and large arbitrary fields', () => {
  const result = normalizeAnalysis({
    ok: true, engine: 'viridian-cv', status: 'complete', experimental_overall: 8,
    front: { centering: { grade: 9, left_right: '53/47', from_external: '<script>' }, injected: '/tmp/delete' },
    back: { centering: { grade: 8 } }, front_overlay: 'data:attack', warnings: ['Testing'],
  });
  assert.equal(result.front.centering.left_right, '53/47');
  assert.equal(result.front.centering.from_external, undefined);
  assert.equal(result.injected, undefined);
  assert.equal(result.front_overlay, undefined);
  assert.equal(result.experimental_overall, 8);
});

test('malformed engine responses are rejected', () => {
  assert.throws(() => normalizeAnalysis({ok: true, engine: 'other', front: {}, back: {}}));
  assert.deepEqual(cleanMetric({per_corner: [0.1, 0.2, 0.3, 0.4], arbitrary: 'x'}), {per_corner: [0.1, 0.2, 0.3, 0.4]});
});
