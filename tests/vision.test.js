// The card finder's pure parts (public/js/vision/): geometry, table colours, rectangles from lines,
// edge snapping and the choice between overlapping outlines. OpenCV isn't needed for any of them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bbox, orderCorners, overlap, polygonArea, readingOrder } from '../public/js/vision/geometry.js';
import { distanceTo, palette, percentile, ringSamples } from '../public/js/vision/colour.js';
import { angleDiff, coverage, mergeSegments, rectanglesFromLines } from '../public/js/vision/lines.js';
import { edgeSupport, snapToEdges } from '../public/js/vision/snap.js';
import { cardScore } from '../public/js/vision/score.js';
import { dropGroupsAndParts } from '../public/js/vision/detect.js';

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const segmentsOf = (q) => q.map((p, i) => ({ x1: p.x, y1: p.y, x2: q[(i + 1) % 4].x, y2: q[(i + 1) % 4].y }));
const near = (a, b, tol = 0.6) => a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) < tol);

describe('card finder geometry', () => {
  test('corners come back as top-left, top-right, bottom-right, bottom-left', () => {
    const q = rect(10, 20, 63, 88);
    assert.deepEqual(orderCorners([q[2], q[0], q[3], q[1]]), q);
    assert.equal(polygonArea(q), 63 * 88);
    assert.deepEqual(bbox(q), { x0: 10, y0: 20, x1: 73, y1: 108 });
  });

  test('a 63:88 rectangle filled by its shape is a perfect card; a square is not', () => {
    assert.ok(cardScore(rect(0, 0, 63, 88), 63 * 88) > 0.99);
    assert.ok(cardScore(rect(0, 0, 88, 88), 88 * 88) < 0.2);
    assert.ok(cardScore(rect(0, 0, 63, 88), 63 * 44) <= 0.5, 'half filled');
  });

  test('overlap is the share of the smaller outline, and reading order goes by rows', () => {
    assert.equal(overlap(rect(0, 0, 10, 10), rect(5, 0, 100, 100)), 0.5);
    assert.equal(overlap(rect(0, 0, 10, 10), rect(50, 50, 10, 10)), 0);
    const [a, b, c] = [rect(200, 5, 60, 80), rect(0, 0, 60, 80), rect(100, 200, 60, 80)];
    assert.deepEqual(readingOrder([c, a, b]), [b, a, c]);
  });
});

describe('table colours', () => {
  test('a few colours stand for many samples; a stray one is dropped', () => {
    const samples = [];
    for (let i = 0; i < 200; i++) samples.push(100 + (i % 3), 130, 140); // brown table
    for (let i = 0; i < 200; i++) samples.push(60, 128 + (i % 2), 128); // dark grain
    samples.push(250, 128, 128); // one pixel of a card at the edge
    const colours = palette(samples, 4);
    assert.ok(colours.length >= 2 && colours.length <= 4);
    assert.ok(colours.every((c) => c[0] < 200), 'the stray light sample is not a table colour');
    assert.deepEqual(palette(samples, 4), colours, 'the same every time');
  });

  test('distance ignores lightness more than colour, so shadows stay table', () => {
    const table = [[150, 140, 150]];
    const [shadow, card] = distanceTo(new Uint8Array([90, 140, 150, 150, 128, 128]), table);
    assert.ok(shadow < card, `shadow ${shadow} vs grey card ${card}`);
    assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  });

  test('ring samples come from the photo’s edge only', () => {
    const W = 20;
    const H = 20;
    const lab = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) lab[(y * W + x) * 3] = x > 3 && x < 16 && y > 3 && y < 16 ? 255 : 10;
    const s = ringSamples(lab, W, H, { ring: 0.1, step: 1 });
    for (let i = 0; i < s.length; i += 3) assert.equal(s[i], 10);
  });
});

describe('rectangles from straight lines', () => {
  test('pieces of one edge merge into one line, with their covered stretches', () => {
    const lines = mergeSegments([{ x1: 0, y1: 0, x2: 40, y2: 0 }, { x1: 60, y1: 0.5, x2: 100, y2: 1 }, { x1: 0, y1: 30, x2: 100, y2: 30 }]);
    assert.equal(lines.length, 2);
    const edge = lines.find((l) => l.length < 90);
    assert.ok(Math.abs(coverage(edge, { x: 0, y: 0 }, { x: 100, y: 0 }) - 0.8) < 0.02);
    assert.ok(angleDiff(0, Math.PI) < 1e-9 && Math.abs(angleDiff(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
  });

  test('a card’s four edges make one card rectangle; a stray line doesn’t make another', () => {
    const card = rect(100, 50, 63, 88);
    const lines = mergeSegments([...segmentsOf(card), { x1: 0, y1: 10, x2: 300, y2: 12 }]);
    const found = rectanglesFromLines(lines, { W: 300, H: 200, minSide: 20, maxSide: 300 });
    assert.equal(found.length, 1);
    assert.ok(near(found[0].quad, card));
  });

  test('a rectangle whose side lines run on past it is part of something bigger', () => {
    // The top half of a card: its side lines carry on to the card's bottom edge.
    const lines = mergeSegments([
      { x1: 0, y1: 0, x2: 88, y2: 0 }, { x1: 0, y1: 63, x2: 88, y2: 63 }, // a half: 88 × 63
      { x1: 0, y1: 0, x2: 0, y2: 126 }, { x1: 88, y1: 0, x2: 88, y2: 126 }, // sides run on
    ]);
    const found = rectanglesFromLines(lines, { W: 300, H: 300, minSide: 20, maxSide: 300 });
    assert.equal(found.length, 0);
  });
});

describe('snapping and choosing outlines', () => {
  // A 200 × 200 "photo" whose gradient is strong along a card's edge at (50, 40)–(113, 128).
  const W = 200;
  const H = 200;
  const card = rect(50, 40, 63, 88);
  const grad = new Float32Array(W * H);
  for (const [p, q] of card.map((p, i) => [p, card[(i + 1) % 4]])) {
    for (let t = 0; t <= 1; t += 0.002) grad[Math.round(p.y + (q.y - p.y) * t) * W + Math.round(p.x + (q.x - p.x) * t)] = 100;
  }

  test('a rough outline a little inside the card moves out onto its edges', () => {
    const snapped = snapToEdges(rect(52, 42, 59, 84), grad, W, H);
    assert.ok(near(snapped, card, 1.1), JSON.stringify(snapped));
    assert.ok(edgeSupport(card, grad, W, H, 1) > 90);
    assert.ok(edgeSupport(rect(52, 42, 59, 84), grad, W, H, 1) < 10);
  });

  test('a block of cards and a card’s half are dropped; the cards are kept', () => {
    const c = (quad, rank = 1) => ({ quad, area: polygonArea(quad), rank });
    const a = c(rect(0, 0, 63, 88));
    const b = c(rect(70, 0, 63, 88));
    const block = c(rect(0, 0, 133, 186)); // holds a and b (and would hold two more)
    const half = c(rect(0, 0, 63, 44), 2); // a's top half, ranked higher
    const kept = dropGroupsAndParts([a, b, block, half]);
    assert.deepEqual(kept, [a, b]);
  });
});

describe('parts of cards', () => {
  test('a card’s top half is a part (its side edges carry on); the card is not', async () => {
    const { runsOn } = await import('../public/js/vision/snap.js');
    const W = 200;
    const H = 200;
    const grad = new Float32Array(W * H);
    const card = rect(50, 40, 63, 88);
    for (const [p, q] of card.map((p, i) => [p, card[(i + 1) % 4]])) {
      for (let t = 0; t <= 1; t += 0.002) grad[Math.round(p.y + (q.y - p.y) * t) * W + Math.round(p.x + (q.x - p.x) * t)] = 100;
    }
    for (let x = 50; x <= 113; x++) grad[84 * W + x] = 100; // the picture's frame across the middle
    assert.equal(runsOn(card, grad, W, H), -1);
    const half = rect(50, 40, 63, 44);
    const side = runsOn(half, grad, W, H);
    assert.equal(side, 2, 'the bottom side lies inside the card');
    const { completePart } = await import('../public/js/vision/snap.js');
    assert.ok(near(completePart(half, side), card, 0.01), 'and the whole card is worked out from it');
  });
});

describe('is a card photo good enough to read?', () => {
  const card = (fill) => {
    const W = 120;
    const H = 168;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(fill(x, y), (y * W + x) * 4);
    return { data, width: W, height: H };
  };
  const stripes = (x, y) => ((Math.floor(x / 3) + Math.floor(y / 5)) % 2 ? [40, 40, 40, 255] : [200, 190, 120, 255]);

  test('sharp detail passes; a smooth (blurred) card, glare and a tiny card are flagged', async () => {
    const { cardQuality, retakeAdvice } = await import('../public/js/vision/quality.js');
    const sharp = cardQuality(card(stripes), { sourceWidth: 600 });
    assert.deepEqual(sharp.problems, []);
    assert.equal(retakeAdvice(sharp), null);
    const blurry = cardQuality(card((x) => [100 + x / 4, 100, 100, 255]), { sourceWidth: 600 });
    assert.deepEqual(blurry.problems, ['blurry']);
    const glare = cardQuality(card((x, y) => (x > 40 && x < 80 && y > 50 && y < 110 ? [255, 255, 255, 255] : stripes(x, y))), { sourceWidth: 600 });
    assert.deepEqual(glare.problems, ['glare']);
    assert.deepEqual(cardQuality(card(stripes), { sourceWidth: 120 }).problems, ['too small']);
    assert.equal(retakeAdvice({ problems: ['blurry', 'glare'] }),
      'Retake suggested: this card is blurry and has glare on it. Hold the phone steady and let it focus and tilt the card away from the light.');
  });
});

describe('finding a line of small print by its text', () => {
  test('the band with the most text wins; among close ones, the one nearest where it should be', async () => {
    const { textBand, rowEnergy } = await import('../public/js/vision/textline.js');
    const W = 60;
    const H = 40;
    const gray = new Float32Array(W * H).fill(200);
    const stripes = (y0, y1, step) => { for (let y = y0; y < y1; y++) for (let x = 0; x < W; x += step) gray[y * W + x] = 20; };
    stripes(4, 8, 6); // faint small print above (the illustrator line)
    stripes(20, 26, 2); // the set line: dense text
    stripes(32, 35, 6); // faint small print below (copyright)
    assert.ok(rowEnergy(gray, W, H)[22] > rowEnergy(gray, W, H)[5]);
    const [top, bottom] = textBand(gray, W, H, { lineH: 6, expected: 15, pad: 0 });
    assert.deepEqual([top, bottom], [20, 26]);
    const [pt, pb] = textBand(gray, W, H, { lineH: 6, expected: 15, pad: 0.5 });
    assert.deepEqual([pt, pb], [17, 29], 'padded by half a line each side');
  });
});
