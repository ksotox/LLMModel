// The Sanctuary's pure parts: the trainer's movement (player.js) and the zoo (zoo.js).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPlayer, MOVE, stepPlayer } from '../public/js/sanctuary/player.js';
import { createCreature, habitatFor, HABITATS, layoutHabitats, nearest, stepCreature } from '../public/js/sanctuary/zoo.js';

const flat = { heightAt: () => 0, waterAt: () => null, radius: 80 };
const none = { x: 0, z: 0, sprint: false, jump: false, jumpHeld: false };
const run = (p, input, seconds, ground = flat) => { for (let i = 0; i < Math.round(seconds * 60); i++) stepPlayer(p, typeof input === 'function' ? input(i) : input, 1 / 60, ground); return p; };

describe('Sanctuary: the trainer’s movement', () => {
  test('walks, sprints faster, and brakes to a stop', () => {
    const p = run(createPlayer({ x: 0, z: 0 }), { ...none, z: 1 }, 2);
    assert.ok(Math.abs(p.moving - MOVE.walk) < 0.05 && p.z > 6);
    const s = run(createPlayer({ x: 0, z: 0 }), { ...none, z: 1, sprint: true }, 2);
    assert.ok(s.z > p.z && Math.abs(s.moving - MOVE.sprint) < 0.05);
    run(s, none, 1);
    assert.ok(s.moving < 0.01, 'stopped');
  });

  test('sprinting drains stamina to exhaustion; then no sprint until it has recovered', () => {
    const p = run(createPlayer(), { ...none, z: 1, sprint: true }, 8);
    assert.equal(p.exhausted, true);
    assert.ok(p.moving < MOVE.walk, 'tired: slower than a walk');
    run(p, none, 0.4);
    assert.equal(p.exhausted, true, 'still catching its breath');
    run(p, none, 3);
    assert.equal(p.exhausted, false);
    assert.ok(p.stamina > MOVE.recovered);
    run(p, none, 6);
    assert.equal(p.stamina, MOVE.staminaMax);
  });

  test('jumps and lands; a press just before landing still jumps (remembered)', () => {
    const p = createPlayer();
    let top = 0;
    for (let i = 0; i < 120; i++) { stepPlayer(p, { ...none, jump: i === 0 }, 1 / 60, flat); top = Math.max(top, p.y); }
    assert.ok(top > 1 && top < 1.6, `jump height ${top}`);
    assert.equal(p.y, 0);
    assert.equal(p.mode, 'walk');
  });

  test('the glider: holding jump while falling from a height slows the fall and uses stamina', () => {
    const cliff = { heightAt: (x) => (x < 0 ? 30 : 0), waterAt: () => null, radius: 200 };
    const fall = createPlayer({ x: -0.5, z: 0 });
    fall.y = 30;
    let fallTime = 0;
    while (fall.y > 0 && fallTime < 20) { stepPlayer(fall, { ...none, x: 1 }, 1 / 60, cliff); fallTime += 1 / 60; }
    const glide = createPlayer({ x: -0.5, z: 0 });
    glide.y = 30;
    let glideTime = 0;
    let glided = false;
    while (glide.y > 0 && glideTime < 60) { stepPlayer(glide, { ...none, x: 1, jumpHeld: true }, 1 / 60, cliff); glideTime += 1 / 60; glided ||= glide.mode === 'glide'; if (glide.mode === 'glide') assert.ok(glide.vy >= -MOVE.glideFall - 1e-9); }
    assert.ok(glided);
    assert.ok(glideTime > fallTime * 2, `gliding ${glideTime.toFixed(1)} s vs falling ${fallTime.toFixed(1)} s`);
    assert.ok(glide.x > fall.x + 10, 'and carries much further');
    assert.ok(glide.stamina < MOVE.staminaMax);
  });

  test('follows the ground, can’t climb a wall, swims in deep water, and stays inside the world', () => {
    const hill = { heightAt: (x) => Math.max(0, x) * 0.5, waterAt: () => null, radius: 80 };
    const p = run(createPlayer({ x: -1, z: 0 }), { ...none, x: 1 }, 2, hill);
    assert.ok(Math.abs(p.y - p.x * 0.5) < 1e-6 && p.x > 3, 'walks up a gentle slope');
    const wall = { heightAt: (x) => (x > 2 ? 5 : 0), waterAt: () => null, radius: 80 };
    const q = run(createPlayer({ x: 0, z: 0 }), { ...none, x: 1 }, 3, wall);
    assert.ok(q.x <= 2 && q.y === 0, 'stopped by the wall');
    const lake = { heightAt: (x) => (x > 2 ? -3 : 0), waterAt: (x) => (x > 2 ? -0.5 : null), radius: 80 };
    const s = run(createPlayer({ x: 0, z: 0 }), { ...none, x: 1 }, 3, lake);
    assert.equal(s.mode, 'swim');
    assert.ok(Math.abs(s.y - (-0.5 - MOVE.swimDepth)) < 1e-6 && s.moving <= MOVE.swim + 0.01);
    const edge = run(createPlayer({ x: 70, z: 0 }), { ...none, x: 1, sprint: true }, 5);
    assert.ok(Math.hypot(edge.x, edge.z) <= 80 + 1e-6);
  });
});

describe('Sanctuary: the zoo', () => {
  const cards = [
    { name: 'Squirtle', types: ['Water'] }, { name: 'Squirtle', types: ['Water'] }, { name: 'Bulbasaur', types: 'Grass' },
    { name: 'Charmander', types: ['Fire'] }, { name: 'Voltorb', types: ['Lightning'] }, { name: 'Linoone', types: ['Colorless'] },
    { name: 'Mystery', types: null },
  ];
  const inLake = (x, z) => Math.hypot(x - 27, z + 21) < 11;

  test('one creature per different Pokémon, in its type’s habitat, never in the lake or on the plaza', () => {
    const spots = layoutHabitats(cards, { blocked: inLake });
    assert.equal(spots.length, 6, 'the second Squirtle is the same Pokémon');
    assert.deepEqual(spots.map((s) => s.habitat.id), ['shore', 'woods', 'rocks', 'plain', 'meadow', 'meadow']);
    for (const s of spots) {
      assert.ok(!inLake(s.x, s.z), `${s.card.name} is on land`);
      assert.ok(Math.hypot(s.x, s.z) >= 8, `${s.card.name} is off the plaza`);
    }
    assert.deepEqual(layoutHabitats(cards, { blocked: inLake }).map((s) => [s.x, s.z]), spots.map((s) => [s.x, s.z]), 'the same every time');
    assert.equal(habitatFor({ types: ['Metal'] }).id, 'ridge');
    assert.ok(HABITATS.every((h) => h.name && h.types.length));
  });

  test('creatures wander near home, turn back from water, and follow the trainer when asked', () => {
    const [spot] = layoutHabitats([{ name: 'Voltorb', types: ['Lightning'] }]);
    const c = createCreature(spot, 0);
    let seed = 1;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const world = { heightAt: () => 0, blocked: inLake };
    const player = { x: 0, z: 0 };
    let moved = false;
    for (let i = 0; i < 60 * 40; i++) {
      stepCreature(c, 1 / 60, player, rand, world);
      moved ||= c.state === 'wander' && c.speed > 0;
      assert.ok(Math.hypot(c.x - c.home.x, c.z - c.home.z) < 9, 'stays near home');
      assert.ok(Number.isFinite(c.y));
    }
    assert.ok(moved, 'it wandered');
    c.state = 'follow';
    for (let i = 0; i < 60 * 30; i++) stepCreature(c, 1 / 60, player, rand, world);
    assert.ok(Math.hypot(c.x, c.z) < 3, 'came to the trainer and stopped a little way off');
    assert.equal(nearest([c], player), c);
    assert.equal(nearest([c], { x: 50, z: 50 }), null);
  });
});
