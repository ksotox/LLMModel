// Foil detection (public/js/foil.js) on synthetic cards: smooth printed ink, foil sparkle, and
// foil whose shine changes with the angle. Real photos were used to calibrate it (see the file).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyseCard, bodyFoilFromPhoto, compareAngles, REGIONS, suggestVariant } from '../public/js/foil.js';

/** A card-shaped image: plain beige printing, art with a smooth picture, optional foil in either region. */
function card({ width = 420, foilBody = 0, foilArt = 0, seed = 1, shine = 0 } = {}) {
  const height = Math.round((width * 88) / 63);
  const data = new Uint8ClampedArray(width * height * 4);
  // Foil sparkle has a physical size: ~1/120 of the card's width, whatever the photo's resolution.
  const cell = width / 120;
  const rand = (x, y) => {
    let n = (Math.floor(x / cell) * 73856093) ^ (Math.floor(y / cell) * 19349663) ^ (seed * 83492791);
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const inside = ([x0, y0, x1, y1], x, y) => x >= x0 * width && x < x1 * width && y >= y0 * height && y < y1 * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let v = 0.82; // beige printing
      let foil = 0;
      if (inside(REGIONS.art, x, y)) {
        v = 0.6 + 0.25 * Math.sin(x / 23) * Math.cos(y / 31); // a smooth "picture"
        foil = foilArt;
      } else if (inside(REGIONS.body, x, y)) {
        foil = foilBody;
      }
      // Foil: fine sparkle, plus (for tilt photos) a shine that depends on the angle.
      if (foil) v += foil * (rand(x, y) - 0.5) + shine * foil * Math.sin(((x + y) / cell) / 3 + seed);
      v = Math.max(0, Math.min(1, v));
      data[i] = v * 255; data[i + 1] = v * 240; data[i + 2] = v * 200; data[i + 3] = 255;
    }
  }
  // Transparent rounded corners, as the app cuts them.
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) data[(y * width + x) * 4 + 3] = 0;
  return { data, width, height };
}

describe('foil detection from one photo', () => {
  test('a smooth printed body reads as not foil, a sparkly one as foil', () => {
    const plain = analyseCard(card());
    const reverse = analyseCard(card({ foilBody: 0.12 }));
    assert.ok(plain.body < 0.004, `plain body ${plain.body}`);
    assert.ok(reverse.body > 0.015, `foil body ${reverse.body}`);
    assert.ok(bodyFoilFromPhoto(plain) < 0.2);
    assert.ok(bodyFoilFromPhoto(reverse) > 0.8);
  });

  test('measured alike at any photo size (close-up or group photo)', () => {
    const small = analyseCard(card({ width: 400, foilBody: 0.12 }));
    const big = analyseCard(card({ width: 1000, foilBody: 0.12 }));
    assert.ok(Math.abs(Math.log(small.body / big.body)) < 0.7, `${small.body} vs ${big.body}`);
  });

  test('suggests normal or reverse holo for a common, never more than 85% sure', () => {
    const printings = { allowed: ['normal', 'reverse-holo'] };
    const normal = suggestVariant({ printings, photo: analyseCard(card()) });
    assert.equal(normal.variant, 'normal');
    assert.equal(normal.method, 'photo');
    assert.ok(normal.confidence <= 0.85);
    const reverse = suggestVariant({ printings, photo: analyseCard(card({ foilBody: 0.12 })) });
    assert.equal(reverse.variant, 'reverse-holo');
    assert.match(reverse.reasons[0], /foil texture/);
  });

  test('a rare that isn’t reverse holo is suggested as holo', () => {
    const tip = suggestVariant({ printings: { allowed: ['holo', 'reverse-holo'] }, photo: analyseCard(card()) });
    assert.equal(tip.variant, 'holo');
  });

  test('without a printing list, normal and holo can’t be told apart: it asks for a tilt scan', () => {
    const tip = suggestVariant({ photo: analyseCard(card()) });
    assert.equal(tip.needsTilt, true);
    assert.ok(tip.reasons.some((r) => /tilt scan/.test(r)));
  });

  test('a printing that is certain wins, whatever the photo shows', () => {
    const tip = suggestVariant({ printings: { allowed: ['full-art'], fixed: 'full-art', reason: 'Illustration Rare cards are always full art.' }, photo: analyseCard(card()) });
    assert.deepEqual([tip.variant, tip.method, tip.confidence], ['full-art', 'printings', 0.99]);
  });
});

describe('tilt scan', () => {
  const angle = (opts, seed) => card({ ...opts, seed, shine: 1.5 });

  test('foil changes between angles, ink doesn’t', () => {
    const reverse = compareAngles([angle({ foilBody: 0.12 }, 1), angle({ foilBody: 0.12 }, 4)]);
    assert.ok(reverse.body > 0.1, `body change ${reverse.body}`);
    assert.ok(reverse.art < 0.03, `art change ${reverse.art}`);
    const holo = compareAngles([angle({ foilArt: 0.12 }, 1), angle({ foilArt: 0.12 }, 4)]);
    assert.ok(holo.art > 0.1 && holo.body < 0.03);
  });

  test('suggests reverse holo, holo or normal with high confidence', () => {
    const tip = (opts) => suggestVariant({ angles: compareAngles([angle(opts, 1), angle(opts, 4), angle(opts, 7)]) });
    const reverse = tip({ foilBody: 0.12 });
    assert.deepEqual([reverse.variant, reverse.method], ['reverse-holo', 'tilt']);
    assert.ok(reverse.confidence > 0.9);
    assert.equal(tip({ foilArt: 0.12 }).variant, 'holo');
    assert.equal(tip({}).variant, 'normal');
    assert.equal(tip({ foilArt: 0.12, foilBody: 0.12 }).variant, 'full-art');
  });

  test('photos evened out for overall brightness: a darker second photo isn’t "foil"', () => {
    const bright = card({ seed: 1 });
    const dark = card({ seed: 1 });
    for (let i = 0; i < dark.data.length; i += 4) for (let c = 0; c < 3; c++) dark.data[i + c] *= 0.7;
    const change = compareAngles([bright, dark]);
    assert.ok(change.body < 0.03 && change.art < 0.03, JSON.stringify(change));
  });

  test('needs two photos of the same shape', () => {
    assert.throws(() => compareAngles([card()]), /at least two/);
    assert.throws(() => compareAngles([card(), { data: new Uint8ClampedArray(100 * 100 * 4), width: 100, height: 100 }]), /same size/);
  });
});
