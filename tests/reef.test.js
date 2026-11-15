// The Reef (public/js/reef/reef.js) and swimming in it (sanctuary/player.js, sanctuary/zoo.js): the
// pure parts, run in Node.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blockedBy, makeSchool, REEF, reefHeight, reefLayout, stepSchool } from '../public/js/reef/reef.js';
import { createSwimmer, stepSwimmer, SWIM } from '../public/js/sanctuary/player.js';
import { createCreature, reefResidents, stepDrifter } from '../public/js/sanctuary/zoo.js';

const none = { x: 0, z: 0, up: 0, fast: false };
const swim = (p, input, seconds, world) => { for (let i = 0; i < Math.round(seconds * 60); i++) stepSwimmer(p, input, 1 / 60, world); return p; };
const open = { heightAt: () => 0, top: 14, radius: 50, obstacles: [] };

describe('the Reef', () => {
  test('the seabed: walls rise at the edge; a battle keeps a flat field in the middle', () => {
    assert.ok(reefHeight(REEF.radius + 4, 0) > 6, 'canyon walls');
    assert.ok(Math.abs(reefHeight(10, 10)) < 3, 'sand in the middle');
    for (const [x, z] of [[0, 0], [3, -4], [-5, 2]]) assert.equal(reefHeight(x, z, { flat: 7.7 }), 0);
  });

  test('the layout: creatures start clear of obstacles; a battle keeps its field open; the same every time', () => {
    const l = reefLayout();
    assert.ok(l.kelp.length > 30 && l.spots.length > 20 && l.obstacles.length > 20);
    for (const s of l.spots) assert.ok(!blockedBy(l.obstacles, s.x, s.y, s.z, 1), 'a spot in open water');
    assert.deepEqual(reefLayout(), l);
    const b = reefLayout({ clear: 8.2 });
    for (const k of b.kelp) assert.ok(Math.hypot(k.x, k.z) > 8.2);
    for (const o of b.boulders) assert.ok(Math.hypot(o.x, o.z) > 8.2);
  });

  test('fish schools stay together, inside the reef, and dart away from the trainer', () => {
    const s = makeSchool({ home: { x: 0, y: 5, z: 0 }, count: 20, seed: 3 });
    const trainer = { x: s.home.x, y: s.home.y, z: s.home.z };
    for (let i = 0; i < 600; i++) stepSchool(s, i / 60, 1 / 60, i > 300 ? trainer : null);
    for (const f of s.fish) {
      assert.ok([f.x, f.y, f.z].every(Number.isFinite));
      assert.ok(Math.hypot(f.x, f.z) <= REEF.radius - 4 + 1e-9 && f.y <= REEF.top);
    }
    const close = s.fish.filter((f) => Math.hypot(f.x - trainer.x, f.y - trainer.y, f.z - trainer.z) < 1).length;
    assert.ok(close < 3, `the fish keep away (${close} within 1 m)`);
  });
});

describe('swimming', () => {
  test('eases up to speed, faster with Shift (using stamina), and drifts up when left alone', () => {
    const p = swim(createSwimmer({ x: 0, y: 5, z: 0 }), { ...none, z: 1 }, 2, open);
    assert.ok(Math.abs(p.moving - SWIM.speed) < 0.1);
    const f = swim(createSwimmer({ x: 0, y: 5, z: 0 }), { ...none, z: 1, fast: true }, 2, open);
    assert.ok(f.moving > SWIM.speed * 2 && f.stamina < 100);
    const d = swim(createSwimmer({ x: 0, y: 5, z: 0 }), none, 3, open);
    assert.ok(d.y > 5 && d.y < 5.5, 'a gentle drift upwards');
  });

  test('slides along rock instead of going through, never below the sand, never above the surface', () => {
    const rock = { ...open, obstacles: [{ x: 0, y: 5, z: 4, r: 2 }] };
    const p = swim(createSwimmer({ x: 0.3, y: 5, z: 0 }), { ...none, z: 1 }, 4, rock);
    assert.ok(Math.hypot(p.x, p.y - 5, p.z - 4) >= 2 + SWIM.body - 1e-6, 'outside the rock');
    assert.ok(p.z > 4, 'and past it');
    const down = swim(createSwimmer({ x: 0, y: 3, z: 0 }), { ...none, up: -1 }, 3, open);
    assert.equal(down.y, SWIM.body);
    const up = swim(createSwimmer({ x: 0, y: 10, z: 0 }), { ...none, up: 1 }, 4, open);
    assert.ok(up.atSurface && up.y <= open.top);
  });

  test('a fast swimmer still can’t pass through a thin rock (moved in short steps)', () => {
    const wall = { ...open, obstacles: [{ x: 0, y: 5, z: 3, r: 0.3 }] };
    const p = createSwimmer({ x: 0, y: 5, z: 0 });
    p.vz = 60;
    stepSwimmer(p, { ...none, z: 1, fast: true }, 0.1, wall);
    assert.ok(p.z < 3, `stopped in front (z ${p.z.toFixed(2)})`);
  });

  test('Reef creatures: Water types only, one of each; they drift in open water and follow in 3-D', () => {
    const cards = [{ name: 'Squirtle', types: ['Water'] }, { name: 'Squirtle', types: ['Water'] }, { name: 'Charmander', types: ['Fire'] }, { name: 'Lapras', types: 'Water' }];
    assert.deepEqual(reefResidents(cards).map((c) => c.name), ['Squirtle', 'Lapras']);
    const c = createCreature({ card: cards[0], habitat: null, x: 5, z: 5, home: { x: 5, z: 5 } }, 0);
    c.y = 3;
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const world = { heightAt: () => 0, top: 14, blocked: () => false };
    for (let i = 0; i < 60 * 20; i++) {
      stepDrifter(c, 1 / 60, { x: 0, y: 8, z: 0 }, rand, world);
      assert.ok(c.y >= 0.5 && c.y <= 13.4);
    }
    c.state = 'follow';
    for (let i = 0; i < 60 * 20; i++) stepDrifter(c, 1 / 60, { x: 0, y: 8, z: 0 }, rand, world);
    assert.ok(Math.hypot(c.x, c.y - 8.3, c.z) < 3, 'swam up to the trainer');
  });
});
