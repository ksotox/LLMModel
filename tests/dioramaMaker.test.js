// The free diorama maker's plain parts (public/js/dioramaMaker.js): looks per type, where the
// artwork is, the layout and the cut-out check. The drawing itself runs in the browser (e2e).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { artWindow, cutLooksRight, dioramaLayout, dioramaTheme, rng, seedOf } from '../public/js/dioramaMaker.js';

describe('free card dioramas', () => {
  test('each type gets its own look; trainers get a stage', () => {
    assert.equal(dioramaTheme({ types: 'Fire' }).particle, 'embers');
    assert.equal(dioramaTheme({ types: ['Water'] }).key, 'water');
    assert.equal(dioramaTheme({ types: 'Lightning' }).particle, 'sparks');
    assert.equal(dioramaTheme({ types: 'Grass, Psychic' }).key, 'grass', 'a dual type uses its first');
    assert.equal(dioramaTheme({ category: 'Trainer' }).key, 'trainer');
    assert.equal(dioramaTheme({}).key, 'colorless');
  });

  test('the cut-out starts from the picture window, or the whole card for full art', () => {
    assert.equal(artWindow({ rarity: 'Common' }).fullArt, false);
    assert.equal(artWindow({ rarity: 'Special Illustration Rare' }).fullArt, true);
    assert.equal(artWindow({ variant: 'full-art' }).fullArt, true);
  });

  test('the card stands on the pedestal, the small card sits at the lower right, all inside the picture', () => {
    const L = dioramaLayout(1122, 1402);
    assert.ok(Math.abs(L.card.w / L.card.h - 63 / 88) < 1e-9);
    assert.ok(L.card.y >= 0 && L.card.y + L.card.h <= L.pedestal.top + L.pedestal.ry);
    assert.ok(L.small.x + L.small.w <= L.W && L.small.x > L.W / 2);
    assert.ok(L.pedestal.top + L.pedestal.depth + L.pedestal.ry <= L.H);
  });

  test('the same card always gets the same diorama', () => {
    const a = rng(seedOf('Voltorb|PAL|066'));
    const b = rng(seedOf('Voltorb|PAL|066'));
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notEqual(seedOf('Voltorb|PAL|066'), seedOf('Voltorb|SVI|066'));
  });

  test('a cut-out is kept only when it is a character, not the whole background', () => {
    const w = 20;
    const h = 20;
    const rect = { x: 1, y: 1, width: 18, height: 18 };
    const blob = (x0, y0, x1, y1) => {
      const a = new Uint8ClampedArray(w * h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
      return a;
    };
    assert.equal(cutLooksRight(blob(6, 5, 14, 15), w, h, rect), true, 'a figure in the middle');
    assert.equal(cutLooksRight(blob(0, 0, 20, 20), w, h, rect), false, 'everything');
    assert.equal(cutLooksRight(blob(9, 9, 10, 10), w, h, rect), false, 'a speck');
    assert.equal(cutLooksRight(null, w, h, rect), false);
  });
});
