// Pokémon at their real size, moving the way they do: the species data (server/species.js), body
// plans and gaits (public/js/creature/body.js), bone sorting (creature/animate.js) and what a body
// changes in a real-time battle.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formKey, speciesForCardName, speciesInfo } from '../server/species.js';
import { BATTLE_SIZES, battleBody, battleScale, bodyPlan, creaturePose, displayHeight, gaitRate, movementMode, SANCTUARY_SIZES, sizedSpecies, TRAINER_HEIGHT } from '../public/js/creature/body.js';
import { createRealtime, step } from '../public/js/battle/realtime.js';

describe('species: real sizes from the Pokédex', () => {
  test('heights and weights, with the forms that differ', () => {
    assert.deepEqual([speciesInfo(25).heightM, speciesInfo(25).weightKg], [0.4, 6]);
    assert.equal(speciesInfo(321).heightM, 14.5, 'Wailord');
    assert.equal(speciesInfo(595).heightM, 0.1, 'Joltik');
    assert.equal(speciesInfo(6, 'gmax').heightM, 28, 'Gigantamax Charizard');
    assert.deepEqual(speciesInfo(6, 'mega-x').types, ['fire', 'dragon']);
    assert.deepEqual(speciesInfo(37, 'alola').types, ['ice']);
    assert.equal(speciesInfo(9999), null);
  });

  test('a 3D model folder names its form', () => {
    assert.equal(formKey('x'), 'mega-x');
    assert.equal(formKey('sy'), 'mega-y');
    assert.equal(formKey('megaShiny'), 'mega');
    assert.equal(formKey('alolan'), 'alola');
    assert.equal(formKey('regular'), null);
    assert.equal(formKey('shiny'), null);
  });

  test('a card names its Pokémon and form', () => {
    const f = (name) => speciesForCardName(name);
    assert.equal(f('Pikachu ex').dexId, 25);
    assert.equal(f("Team Rocket's Moltres ex").dexId, 146);
    assert.equal(f('Alolan Vulpix').form, 'alola');
    assert.equal(f('Mega Charizard X ex').form, 'mega-x');
    assert.equal(f('Charizard VMAX').heightM, 28);
    assert.equal(f('Mr. Mime').dexId, 122);
    assert.equal(f('Nidoran ♀').dexId, 29);
    assert.equal(f('Pikachu & Zekrom-GX').dexId, 25);
    assert.equal(f('Punk Helmet'), null);
  });
});

describe('body plans: how each Pokémon gets about', () => {
  const plan = (id) => bodyPlan(speciesInfo(id));
  test('the way it moves follows its shape, types and abilities', () => {
    assert.equal(plan(25).mode, 'quad', 'Pikachu');
    assert.equal(plan(6).mode, 'fly', 'Charizard has wings');
    assert.equal(plan(16).mode, 'fly', 'Pidgey');
    assert.equal(plan(12).mode, 'fly', 'Butterfree');
    assert.equal(plan(129).mode, 'swim', 'Magikarp');
    assert.equal(plan(130).mode, 'swim', 'Gyarados');
    assert.equal(plan(384).mode, 'fly', 'Rayquaza');
    assert.equal(plan(95).mode, 'slither', 'Onix');
    assert.equal(plan(109).mode, 'hover', 'Koffing levitates');
    assert.equal(plan(92).mode, 'hover', 'Gastly');
    assert.equal(plan(39).mode, 'walk', 'Jigglypuff');
    assert.equal(plan(84).mode, 'walk', 'Doduo can’t fly');
    assert.equal(movementMode({ shape: 'ball', types: ['normal'] }), 'hop');
    assert.equal(plan(6).perches, true, 'Charizard lands to rest');
    assert.equal(plan(384).perches, false, 'Rayquaza stays up');
  });

  test('speed and step rate follow size, as for real animals', () => {
    const pikachu = plan(25);
    const snorlax = plan(143);
    assert.ok(snorlax.walkSpeed > pikachu.walkSpeed, 'longer legs cover more ground');
    assert.ok(gaitRate(pikachu, pikachu.walkSpeed) > gaitRate(snorlax, snorlax.walkSpeed), 'but small legs step faster');
    assert.ok(Math.abs(bodyPlan({ heightM: 1.75, shape: 'humanoid', types: [] }).walkSpeed - 1.4) < 0.15, 'a person walks about 1.4 m/s');
    assert.ok(gaitRate(plan(12), 0) > gaitRate(plan(6), 0), 'a butterfly beats its wings faster than a dragon');
    assert.equal(gaitRate(pikachu, 0), 0, 'standing still, no steps');
    assert.equal(plan(130).measure, 'length', 'a Gyarados’ Pokédex size is its length');
    assert.equal(plan(25).measure, 'height');
  });

  test('a battle keeps both to scale, shrinking together only when one is too tall', () => {
    assert.equal(battleScale([0.4, 1.7]), 1, 'Pikachu and Charizard at their real sizes');
    const k = battleScale([0.4, 14.5]);
    assert.ok(Math.abs(14.5 * k - 2.4) < 1e-9, 'Wailord fits the field');
    assert.ok(Math.abs((0.4 * k) / (14.5 * k) - 0.4 / 14.5) < 1e-12, 'and Pikachu stays to scale with it');
    const big = battleBody(plan(143), 1);
    const small = battleBody(plan(25), 1);
    assert.ok(big.radius > small.radius && big.speed < small.speed, 'Snorlax is bigger and slower than Pikachu');
    for (const b of [big, small, battleBody(plan(321), k), battleBody(plan(595), 1)]) assert.ok(b.speed >= 0.8 && b.speed <= 1.2, 'speeds stay fair');
    assert.ok(battleBody(plan(6), 1).gravity < 1 && battleBody(plan(6), 1).air > 0, 'a flyer floats and falls slowly');
  });

  test('gaits: legs in opposition, wings beat, a body wave for snakes and fish', () => {
    const walk = creaturePose(plan(4), Math.PI / 2, { move: 0.5 });
    assert.ok(walk.thighL > 0 && walk.thighR < 0 && Math.sign(walk.armL) === -Math.sign(walk.thighL));
    const trot = creaturePose(plan(25), Math.PI / 2, { move: 0.5 });
    assert.equal(Math.sign(trot.thighL), Math.sign(trot.armR), 'a trot moves diagonal legs together');
    const up = creaturePose(plan(6), Math.PI / 2, { move: 0.5 }).wing;
    const down = creaturePose(plan(6), -Math.PI / 2, { move: 0.5 }).wing;
    assert.ok(up > 0.5 && down < -0.5, 'wings up, then down');
    assert.ok(creaturePose(plan(95), 0, { move: 1 }).waveAmp > 0, 'Onix slithers');
    assert.ok(creaturePose(plan(129), 0, { move: 0.5 }).waveAmp > 0, 'Magikarp swims');
    const still = creaturePose(plan(4), 1, { move: 0, t: 2 });
    assert.equal(still.thighL, 0, 'standing still');
    assert.ok(creaturePose(bodyPlan({ heightM: 0.5, shape: 'ball', types: [] }), Math.PI / 2, { move: 0.5 }).lift > 0.2, 'a round one bounces');
  });
});

describe('sizes on screen: by real height, compressed to fit', () => {
  test('bigger in life is bigger on screen; small ones stay visible, giants fit', () => {
    const shown = (h, sizes = SANCTUARY_SIZES) => displayHeight(h, sizes);
    const heights = [0.1, 0.4, 0.6, 1.7, 2.1, 6.5, 14.5, 28];
    for (const sizes of [SANCTUARY_SIZES, BATTLE_SIZES]) {
      const drawn = heights.map((h) => shown(h, sizes));
      for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i] > drawn[i - 1], `${heights[i]} m is drawn bigger than ${heights[i - 1]} m`);
      assert.ok(drawn[0] >= 0.3, 'Joltik is still visible');
      assert.ok(drawn.at(-1) <= sizes.max, 'a Gigantamax fits');
    }
    assert.ok(shown(2.1) > TRAINER_HEIGHT && shown(0.4) < TRAINER_HEIGHT / 2, 'Snorlax stands over the trainer, Pikachu below the knee… nearly');
    assert.equal(shown(TRAINER_HEIGHT), TRAINER_HEIGHT, 'the trainer’s own height is kept');
    assert.ok(shown(14.5) / shown(0.4) < 14.5 / 0.4 / 4, 'the range is compressed');
    const sized = sizedSpecies(speciesInfo(143));
    assert.deepEqual([sized.realHeightM, sized.heightM.toFixed(2)], [2.1, shown(2.1).toFixed(2)]);
    assert.equal(sizedSpecies(null), null);
    // Pikachu and Wailord: both on screen, Wailord far bigger.
    const pika = bodyPlan(sizedSpecies(speciesInfo(25), BATTLE_SIZES));
    const wailord = bodyPlan(sizedSpecies(speciesInfo(321), BATTLE_SIZES));
    const k = battleScale([pika.heightM, wailord.heightM]);
    assert.ok(pika.heightM * k >= 0.3 && wailord.heightM > 5 * pika.heightM);
  });
});

describe('bones: found by name in the game rigs', () => {
  test('legs, arms, tail, spine and wings', async () => {
    const { sortBones } = await import('../public/js/creature/animate.js');
    const charizard = sortBones(['Waist_63', 'Spine1_40', 'LFeeler1_5', 'LFeeler2_4', 'RFeeler1_11', 'Spine2_39', 'LArm_20', 'LForeArm_19', 'RArm_37', 'Neck1_28', 'Head_25', 'RThigh_44', 'RLeg_43', 'Tail1_57', 'Tail2_56', 'Tail3_55', 'LThigh_61'], { flies: true });
    assert.deepEqual(charizard.wing.map((w) => [w.name, w.side]), [['LFeeler1_5', 1], ['RFeeler1_11', -1]]);
    assert.deepEqual(charizard.thigh.map((t) => t.side).sort(), [-1, 1]);
    assert.deepEqual(charizard.tail.map((t) => t.name), ['Tail1_57', 'Tail2_56', 'Tail3_55']);
    assert.equal(charizard.spine[0].name, 'Waist_63');
    assert.equal(charizard.head[0].name, 'Head_25');
    assert.deepEqual(sortBones(['LFeeler1'], { flies: false }).wing, [], 'a walker’s feelers are not wings');
  });
});

describe('real-time battles: bodies of different sizes', () => {
  const fighter = (body) => ({ battle: { hp: 100, types: ['Colorless'], attacks: [{ name: 'Tackle', cost: [], damage: { base: 20 } }] }, name: 'X', body });
  test('a big Pokémon is hit from further away, and a flyer falls slowly', () => {
    const touching = (body) => {
      const s = createRealtime(fighter(body), fighter(undefined), { seed: 1, mode: 'pvp' });
      const [a, b] = s.fighters;
      Object.assign(a, { x: 0, z: 0 }); Object.assign(b, { x: 1.4, z: 0 });
      step(s, [null, null]);
      return Math.hypot(b.x - a.x, b.z - a.z);
    };
    assert.ok(touching({ radius: 1.2, height: 2.4 }) > touching(undefined), 'big bodies push apart further');
    const fall = (body) => {
      const s = createRealtime(fighter(body), fighter(undefined), { seed: 1, mode: 'pvp' });
      const f = s.fighters[0];
      let n = 0;
      step(s, [{ move: { x: 0, z: 0 }, jump: true }, null]);
      while (f.y > 0 && n < 600) { step(s, [null, null]); n++; }
      return n;
    };
    assert.ok(fall({ gravity: 0.4 }) > fall(undefined) * 1.4, 'a flyer stays up longer');
  });
});
