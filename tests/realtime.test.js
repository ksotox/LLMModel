// Real-time PokéBattles (public/js/battle/realtime.js): a pure, seeded simulation run here in Node.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aiIntent, ARENA_RULES, createRealtime, hitAmount, idle, moveSpecs, STEP, step, TIME_LIMIT } from '../public/js/battle/realtime.js';

const atk = (name, base, cost = 1, mod = null, effect = '') => ({ name, cost: Array(cost).fill('Colorless'), damage: { base, mod }, effect });
const voltorb = { name: 'Voltorb', battle: { hp: 70, types: ['Lightning'], attacks: [atk('Rollout', 10, 1), atk('Lightning Ball', 30, 2)], weaknesses: [{ type: 'Fighting', mult: 2 }] } };
const linoone = { name: 'Linoone', battle: { hp: 110, types: ['Colorless'], attacks: [atk('Headbutt', 20, 1), atk('Gutsy Charge', 70, 3)], abilities: [{ name: 'Quick Search' }], weaknesses: [{ type: 'Lightning', mult: 2 }] } };
const still = () => [idle(), idle()];
const run = (s, intents, seconds) => {
  const events = [];
  for (let i = 0; i < Math.round(seconds / STEP) && !s.over; i++) events.push(...step(s, typeof intents === 'function' ? intents(s) : intents));
  return events;
};
const both = (s) => [aiIntent(s, 0), aiIntent(s, 1)];

describe('real-time PokéBattles', () => {
  test('moves come from the card: attacks (ranged by type), then the ability, then a free quick strike', () => {
    const v = moveSpecs(voltorb.battle);
    assert.deepEqual(v.map((m) => [m.name, m.kind]), [['Rollout', 'projectile'], ['Lightning Ball', 'projectile'], ['Quick Strike', 'melee']]);
    assert.equal(v[1].energy, 40, 'two energy symbols');
    assert.ok(v[1].cooldown > v[0].cooldown, 'dearer moves wait longer');
    const l = moveSpecs(linoone.battle);
    assert.deepEqual(l.map((m) => m.kind), ['melee', 'melee', 'boost', 'melee']);
    assert.equal(moveSpecs({ types: ['Water'], attacks: [atk('Rain Splash', 20, 1, 'x')] })[0].shots, 3, '"×" fires three shots');
    assert.equal(moveSpecs({ types: ['Grass'], attacks: [atk('Leech', 0, 1, null, 'Heal 30 damage')] })[0].kind, 'heal');
  });

  test('the same seed plays the same battle', () => {
    const play = () => {
      const s = createRealtime(voltorb, linoone, { seed: 42 });
      run(s, both, TIME_LIMIT);
      return [s.winner, s.t.toFixed(3), s.fighters.map((f) => f.hp).join('/')];
    };
    assert.deepEqual(play(), play());
  });

  test('the computer finishes a battle on every difficulty and arena, with sane positions', () => {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      for (const arena of Object.keys(ARENA_RULES)) {
        const s = createRealtime(voltorb, linoone, { seed: 3, difficulty, arena });
        const events = run(s, both, TIME_LIMIT + 1);
        assert.ok(s.over, `${difficulty} ${arena} ends`);
        assert.ok(events.some((e) => e.type === 'hit'), 'someone lands a hit');
        for (const f of s.fighters) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.z) && Number.isFinite(f.hp));
      }
    }
  });

  test('energy and cooldown: a move spends energy and can’t be used again straight away', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1 });
    const use = (i) => [{ ...idle(), use: i }, idle()];
    const before = s.fighters[0].energy;
    step(s, use(1));
    assert.ok(Math.abs(s.fighters[0].energy - (before - 40 + 12 * STEP)) < 1e-9, 'Lightning Ball costs 40 (and energy keeps refilling)');
    assert.ok(s.fighters[0].cooldowns[1] > 1);
    run(s, still(), 0.5);
    const energy = s.fighters[0].energy;
    step(s, use(1));
    assert.ok(Math.abs(s.fighters[0].energy - (energy + 12 * STEP)) < 1e-6, 'still cooling down: nothing happens');
  });

  test('a projectile hits a standing rival (with its weakness); stepping aside avoids it', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1, mode: 'pvp' });
    const events = run(s, (st) => (st.t < STEP * 2 ? [{ ...idle(), use: 1 }, idle()] : still()), 2);
    const hit = events.find((e) => e.type === 'hit');
    assert.ok(hit && hit.side === 1 && hit.weakness, 'Lightning hits Linoone’s Lightning weakness');
    assert.equal(hit.amount, hitAmount(s.fighters[0], s.fighters[1], s.fighters[0].moves[1]).amount);

    const t = createRealtime(voltorb, linoone, { seed: 1, mode: 'pvp' });
    const side = run(t, (st) => (st.t < STEP * 2 ? [{ ...idle(), use: 1 }, idle()] : [idle(), { ...idle(), move: { x: 1, z: 1 } }]), 2);
    assert.ok(!side.some((e) => e.type === 'hit'), 'moving out of the way avoids it');
  });

  test('a dodge is invulnerable for a moment and uses a charge; charges come back', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1, mode: 'pvp' });
    step(s, [idle(), { ...idle(), dodge: true }]);
    assert.equal(s.fighters[1].dodges, 1);
    assert.ok(s.fighters[1].invulnerable > 0);
    run(s, still(), 0.5);
    step(s, [idle(), { ...idle(), dodge: true }]);
    step(s, [idle(), { ...idle(), dodge: true }]);
    assert.equal(s.fighters[1].dodges, 0, 'no more than two in a row');
    run(s, still(), 5);
    assert.equal(s.fighters[1].dodges, 2, 'refilled');
  });

  test('melee lunges at a close rival; a combo’s fifth hit knocks down, then a moment of invulnerability', () => {
    const s = createRealtime(linoone, voltorb, { seed: 1, mode: 'pvp' });
    s.fighters[0].x = 0; s.fighters[0].z = 0;
    s.fighters[1].x = 0; s.fighters[1].z = -2.4;
    s.fighters[0].facing = Math.PI;
    let knocked = false;
    for (let i = 0; i < 400 && !knocked && !s.over; i++) {
      s.fighters[0].energy = 100;
      s.fighters[0].cooldowns = [0, 0, 0, 0];
      const events = step(s, [{ ...idle(), use: 3 }, idle()]);
      knocked = events.some((e) => e.type === 'hit' && e.down);
    }
    assert.ok(knocked, 'knocked down by a combo');
    assert.ok(s.fighters[1].down > 0);
    run(s, still(), 1);
    assert.ok(s.fighters[1].invulnerable > 0 || s.fighters[1].down === 0);
  });

  test('Floating Stadium: walking off the edge is a ring-out; elsewhere a wall holds you in', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1, arena: 'floating', mode: 'pvp' });
    const events = run(s, [{ ...idle(), move: { x: -1, z: 0 } }, idle()], 8);
    assert.ok(events.some((e) => e.type === 'ringout' && e.side === 0));
    assert.equal(s.winner, 1);
    const m = createRealtime(voltorb, linoone, { seed: 1, arena: 'meadow', mode: 'pvp' });
    run(m, [{ ...idle(), move: { x: -1, z: 0 } }, idle()], 8);
    assert.equal(m.over, false);
    assert.ok(Math.hypot(m.fighters[0].x, m.fighters[0].z) <= ARENA_RULES.meadow.radius);
  });

  test('League Stadium: the field closes in by phases', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1, arena: 'league', mode: 'pvp' });
    const events = run(s, still(), 90);
    assert.deepEqual(events.filter((e) => e.type === 'zone').map((e) => e.radius), [5.0, 4.2, 3.5]);
    for (const f of s.fighters) assert.ok(Math.hypot(f.x, f.z) <= 3.5);
  });

  test('weather: rain strengthens Water; a sandstorm wears down all but Fighting and Metal', () => {
    const water = { name: 'Squirtle', battle: { hp: 70, types: ['Water'], attacks: [atk('Water Gun', 40, 1)] } };
    const s = createRealtime(water, linoone, { seed: 1, weather: 'rain' });
    const [a, b] = s.fighters;
    const clear = hitAmount(a, b, a.moves[0]).amount;
    const rain = hitAmount(a, b, a.moves[0], { weather: 'rain' }).amount;
    assert.ok(Math.abs(rain - clear * 1.5) <= 1, `rain ${rain} vs clear ${clear}`);
    assert.ok(hitAmount(a, b, a.moves[0], { weather: 'sun' }).amount < clear, 'sun weakens Water');
    const rock = { name: 'Onix', battle: { hp: 90, types: ['Fighting'], attacks: [atk('Rock Throw', 20, 1)] } };
    const sand = createRealtime(rock, linoone, { seed: 1, weather: 'sand', mode: 'pvp' });
    const events = run(sand, still(), 13);
    assert.deepEqual(events.filter((e) => e.type === 'weather').map((e) => e.side), [1, 1]);
    assert.equal(sand.fighters[0].hp, 90);
    assert.equal(sand.fighters[1].hp, 90);
  });

  test('time up: the side with more HP left (by share) wins', () => {
    const s = createRealtime(voltorb, linoone, { seed: 1, mode: 'pvp' });
    s.fighters[1].hp = 50;
    run(s, still(), TIME_LIMIT + 1);
    assert.equal(s.over, true);
    assert.equal(s.winner, 0);
  });
});

describe('Tropical Beach arena', () => {
  test('the sand is flat on the field, rises in low dunes, and slopes under the sea past the shore', async () => {
    const { beachHeight, lookFor, shoreRadius } = await import('../public/js/battle/stadiums.js');
    for (const [x, z] of [[0, 0], [3, -4], [-6, 2]]) assert.equal(beachHeight(x, z, 6.2), 0, 'flat where the Pokémon stand');
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const shore = shoreRadius(a);
      assert.ok(shore > 12 && shore < 19);
      const at = (r) => beachHeight(Math.cos(a) * r, Math.sin(a) * r, 6.2);
      assert.ok(at(shore - 5) >= 0, 'dry sand inside the shore');
      assert.ok(at(shore + 1) < -0.45, 'under water past it');
      assert.ok(at(9) <= 0.6, 'dunes stay low');
    }
    assert.ok(ARENA_RULES.beach.wall);
    // Day in light mode, a sunset in dark mode; the other places look the same in both.
    assert.notDeepEqual(lookFor('beach', true).sky, lookFor('beach', false).sky);
    assert.ok(lookFor('beach', true).skyDir[1] < 0.2, 'the sun is low at sunset');
    assert.deepEqual(lookFor('league', true), lookFor('league', false));
    assert.equal(lookFor('meadow'), null);
  });
});
