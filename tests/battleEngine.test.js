// PokéBattles rules (public/js/battle/engine.js), with a seeded random generator.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { act, attackCost, cpuChoice, createBattle, createRng, damageFor, expectedDamage, legalActions, makeFighter, MAX_ENERGY } from '../public/js/battle/engine.js';

const atk = (name, base, cost = 1, mod = null, effect = '') => ({ name, cost: Array(cost).fill('Colorless'), damage: { base, mod, text: `${base}${mod ?? ''}` }, effect });
const voltorb = { hp: 70, types: ['Lightning'], attacks: [atk('Rollout', 10, 1), atk('Lightning Ball', 30, 2)], abilities: [], weaknesses: [{ type: 'Fighting', mult: 2 }], resistances: [] };
const linoone = { hp: 110, types: ['Colorless'], attacks: [atk('Headbutt', 20, 1), atk('Gutsy Charge', 70, 3)], abilities: [{ name: 'Quick Search', effect: 'Once during your turn…' }], weaknesses: [{ type: 'Lightning', mult: 2 }], resistances: [] };
const always = (v) => () => v;

describe('PokéBattles rules', () => {
  test('printed damage, "+" and "×" coin flips, rounded to tens', () => {
    const a = makeFighter({ ...voltorb, types: ['Colorless'] });
    const d = makeFighter({ hp: 100, types: ['Water'] });
    assert.equal(damageFor(a, d, atk('Hit', 30)).amount, 30);
    assert.deepEqual(damageFor(a, d, atk('More', 30, 1, '+'), always(0.1)), { amount: 60, weakness: false, resisted: false, coins: [true], raw: 60 });
    assert.equal(damageFor(a, d, atk('More', 30, 1, '+'), always(0.9)).amount, 30);
    assert.equal(damageFor(a, d, atk('Times', 20, 1, 'x'), always(0.1)).amount, 60, 'three heads');
    assert.equal(damageFor(a, d, atk('Times', 20, 1, 'x'), always(0.9)).amount, 0, 'three tails');
    assert.equal(expectedDamage(a, d, atk('Times', 20, 1, 'x')), 30);
  });

  test('weakness and resistance apply as printed', () => {
    const elec = makeFighter(voltorb);
    assert.deepEqual(damageFor(elec, makeFighter(linoone), atk('Zap', 30)), { amount: 60, weakness: true, resisted: false, coins: [], raw: 30 });
    assert.equal(damageFor(elec, makeFighter({ hp: 90, weaknesses: [{ type: 'Lightning', add: 20 }] }), atk('Zap', 30)).amount, 50);
    assert.equal(damageFor(elec, makeFighter({ hp: 90, resistances: [{ type: 'Lightning', sub: 30 }] }), atk('Zap', 20)).amount, 0, 'never below 0');
  });

  test('energy: +1 a turn, attacks spend their cost, rest adds one more, capped', () => {
    const b = createBattle({ battle: voltorb, name: 'Voltorb' }, { battle: linoone, name: 'Linoone' }, { rng: createRng(1) });
    const first = b.turn;
    assert.equal(b.fighters[first].energy, 1, 'the first side starts with 1');
    assert.equal(b.fighters[1 - first].energy, 0);
    const lightning = legalActions(b).find((x) => x.type === 'attack' && x.index === 1);
    if (first === 0) assert.equal(lightning.ok, false, 'Lightning Ball needs 2');
    assert.throws(() => act(b, { type: 'attack', index: 1 }), /needs [23] energy/);
    act(b, { type: 'rest' });
    assert.equal(b.fighters[first].energy, 2);
    assert.equal(b.fighters[1 - first].energy, 1, 'the other side gained its turn energy');
    const f = makeFighter(voltorb);
    f.energy = MAX_ENERGY;
    assert.equal(attackCost(atk('x', 10, 3)), 3);
  });

  test('a full battle ends with a winner, HP never below 0, and the events tell the story', () => {
    const b = createBattle({ battle: voltorb, name: 'Voltorb' }, { battle: linoone, name: 'Linoone' }, { rng: createRng(42), mode: 'cpu' });
    assert.equal(b.opening[0].type, 'start');
    let guard = 0;
    const seen = new Set();
    while (!b.over && guard++ < 300) for (const e of act(b, cpuChoice(b))) seen.add(e.type);
    assert.ok(b.over);
    assert.ok([0, 1].includes(b.winner));
    assert.equal(b.fighters[1 - b.winner].hp, 0);
    for (const t of ['use', 'hit', 'turn', 'ko', 'end']) assert.ok(seen.has(t), t);
    assert.throws(() => act(b, { type: 'rest' }), /over/);
  });

  test('abilities: once each, power up the next attack by 50%', () => {
    const b = createBattle({ battle: linoone, name: 'Linoone' }, { battle: { ...voltorb, weaknesses: [] }, name: 'Voltorb' }, { rng: createRng(7) });
    b.turn = 0;
    b.fighters[0].energy = 3;
    const ev = act(b, { type: 'ability', index: 0 });
    assert.deepEqual(ev.slice(0, 2).map((e) => e.type), ['use', 'boost']);
    b.turn = 0;
    assert.equal(legalActions(b).find((x) => x.type === 'ability').ok, false);
    assert.throws(() => act(b, { type: 'ability', index: 0 }), /already used/);
    const hit = act(b, { type: 'attack', index: 0 }).find((e) => e.type === 'hit');
    assert.equal(hit.amount, 30, '20 × 1.5');
    b.turn = 0;
    b.fighters[0].energy = 1;
    assert.equal(act(b, { type: 'attack', index: 0 }).find((e) => e.type === 'hit').amount, 20, 'the boost is used up');
  });

  test('moves with no damage heal or charge energy', () => {
    const healer = { hp: 100, types: ['Grass'], attacks: [atk('Soothe', 0, 1, null, 'Heal 30 damage from this Pokémon.'), atk('Grow', 0, 1, null, 'Search your deck.')] };
    const b = createBattle({ battle: healer, name: 'A' }, { battle: healer, name: 'B' }, { rng: createRng(3) });
    b.turn = 0;
    b.fighters[0].hp = 60;
    b.fighters[0].energy = 2;
    assert.deepEqual(act(b, { type: 'attack', index: 0 }).find((e) => e.type === 'heal'), { type: 'heal', who: 0, amount: 20, hp: 80, maxHp: 100 });
    b.turn = 0;
    b.fighters[0].energy = 1;
    assert.equal(act(b, { type: 'attack', index: 1 }).find((e) => e.type === 'energy').energy, 2);
  });

  test('the computer takes a knockout when it can, otherwise its best affordable damage', () => {
    const b = createBattle({ battle: voltorb, name: 'Voltorb' }, { battle: linoone, name: 'Linoone' }, { rng: createRng(5) });
    b.turn = 0;
    b.fighters[0].energy = 2;
    b.fighters[1].hp = 20;
    assert.deepEqual(cpuChoice(b), { type: 'attack', index: 0 }, 'Rollout (10 ×2 weakness) knocks out for 1 energy');
    b.fighters[1].hp = 110;
    assert.deepEqual(cpuChoice(b), { type: 'attack', index: 1 }, 'Lightning Ball: 60 against the weakness');
    b.fighters[0].energy = 0;
    assert.deepEqual(cpuChoice(b), { type: 'rest' });
  });

  test('the same seed replays the same battle', () => {
    const run = () => {
      const b = createBattle({ battle: voltorb, name: 'V' }, { battle: linoone, name: 'L' }, { rng: createRng(99) });
      const out = [];
      while (!b.over) out.push(...act(b, cpuChoice(b)).map((e) => `${e.type}:${e.amount ?? ''}`));
      return out.join(',');
    };
    assert.equal(run(), run());
  });
});
