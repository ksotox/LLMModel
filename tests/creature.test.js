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
    const up = creaturePose(plan(6), Math.PI / 2, { move: 0.5, air: true }).wing;
    const down = creaturePose(plan(6), -Math.PI / 2, { move: 0.5, air: true }).wing;
    assert.ok(up > 0.5 && down < -0.5, 'wings up, then down');
    const perched = creaturePose(plan(6), Math.PI / 2, { move: 0, air: false });
    assert.ok(perched.wingFold === 1 && Math.abs(perched.wing) < 0.1, 'on the ground, wings folded');
    const idle = creaturePose(plan(4), 0, { move: 0, t: 1.4 });
    assert.ok(idle.armL !== 0 && idle.forearmL > 0, 'standing, its arms hang with bent elbows and sway');
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
    assert.deepEqual(charizard.feeler.map((w) => [w.name, w.side]), [['LFeeler1_5', 1], ['RFeeler1_11', -1]], 'a dragon’s wing candidates');
    assert.deepEqual(charizard.thigh.map((t) => t.side).sort(), [-1, 1]);
    assert.deepEqual(charizard.tail.map((t) => t.name), ['Tail1_57', 'Tail2_56', 'Tail3_55']);
    assert.equal(charizard.spine[0].name, 'Waist_63');
    assert.equal(charizard.head[0].name, 'Head_25');
    assert.deepEqual(sortBones(['LFeeler1'], { flies: false }).wing, [], 'a walker’s feelers are not wings');
    // Pidgeot (game rig): its wings are its arms; there are no feelers.
    // (numbered names, as three.js gives them: "050 Head" becomes "050_Head")
    const pidgeot = sortBones(['050_Head', '005_Hips', '044_LShoulder', '045_LArm', '046_LForeArm', '047_LHand', '092_RShoulder', '093_RArm', '036_Tail1'], { flies: true });
    assert.equal(pidgeot.head[0]?.name, '050_Head');
    assert.deepEqual([pidgeot.shoulder.length, pidgeot.arm.length, pidgeot.feeler.length], [2, 2, 0]);
  });

  test('a flyer’s wing on each side: the chain that reaches furthest out', async () => {
    const { wingSide } = await import('../public/js/creature/animate.js');
    assert.equal(wingSide({ armReach: 1.4 }), 'arm', 'a bird: its arms');
    assert.equal(wingSide({ armReach: 0.5, feelerReach: 2.5 }), 'feeler', 'a dragon: its feelers, arms stay arms');
    assert.equal(wingSide({ armReach: 1.2, feelerReach: 1.25 }), 'arm', 'about the same: the arms');
    assert.equal(wingSide({ named: true, feelerReach: 3 }), 'wing', 'bones named as wings win');
    assert.equal(wingSide({}), null);
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

describe('a skeleton for models without one (autoRig.js)', () => {
  const names = (layout, pairs) => pairs.map(([b, w]) => [layout.bones[b].name, Math.round(w * 100) / 100]);
  const heaviest = (layout, x, y, z) => layout.bones[layout.assign(x, y, z)[0][0]].name;

  test('a T-posed person: legs, arms, head and body each follow their own bones', async () => {
    const { rigLayout, measure } = await import('../public/js/creature/autoRig.js');
    // Ash (as the attached model): 5 tall, arms straight out to ±2.4, chest about ±0.5.
    const box = { minX: -2.4, maxX: 2.4, minY: 0, maxY: 5, minZ: -0.8, maxZ: 0.6 };
    const points = [];
    for (let y = 0; y <= 5; y += 0.1) for (let x = -0.5; x <= 0.5; x += 0.1) points.push([x, y]); // body
    for (let x = -2.4; x <= 2.4; x += 0.1) points.push([x, 3.8]); // arms
    const { torso, span } = measure(points, box);
    assert.ok(torso >= 0.3 && torso <= 0.6 && span > 2.3, `chest ${torso}, reach ${span}`);
    const rig = rigLayout(box, 'walk', { torso, span });
    assert.equal(heaviest(rig, 2.2, 3.8, 0), 'LForeArm', 'the left hand');
    assert.equal(heaviest(rig, -0.9, 3.8, 0), 'RArm', 'the right upper arm');
    assert.equal(heaviest(rig, 0.25, 0.3, 0), 'LLeg', 'the left foot');
    assert.equal(heaviest(rig, -0.25, 1.8, 0), 'RThigh');
    assert.equal(heaviest(rig, 0, 4.8, 0), 'Head');
    assert.equal(heaviest(rig, 0, 3.2, 0), 'Spine1');
    const blend = rig.assign(0.2, 2.25, 0); // where the leg meets the hips
    assert.ok(blend.length >= 2 && Math.abs(blend.reduce((s, [, w]) => s + w, 0) - 1) < 1e-9, JSON.stringify(names(rig, blend)));
    assert.ok(rig.bones.every((b, i) => b.parent < i), 'parents come first');
  });

  test('four legs, a snake’s chain, a bird’s wings', async () => {
    const { rigLayout } = await import('../public/js/creature/autoRig.js');
    const quad = rigLayout({ minX: -0.4, maxX: 0.4, minY: 0, maxY: 1.6, minZ: -1, maxZ: 1 }, 'quad');
    assert.equal(heaviest(quad, 0.2, 0.1, 0.7), 'LForeArm', 'front left foot');
    assert.equal(heaviest(quad, -0.2, 0.5, -0.7), 'RThigh', 'back right leg');
    assert.equal(heaviest(quad, 0, 1.3, 0.95), 'Head');
    assert.equal(heaviest(quad, 0, 0.9, -0.98), 'Tail1');
    const snake = rigLayout({ minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -4, maxZ: 4 }, 'slither');
    assert.equal(heaviest(snake, 0, 1, 3.9), 'Head');
    assert.equal(heaviest(snake, 0, 1, -3.9), 'Tail3');
    assert.equal(snake.assign(0, 1, 0).length, 2, 'between two bones, the weight is shared');
    const bird = rigLayout({ minX: -2, maxX: 2, minY: 0, maxY: 1.5, minZ: -0.5, maxZ: 0.5 }, 'fly', { torso: 0.3, span: 2 });
    assert.ok(bird.bones.some((b) => b.name === 'LWing1') && heaviest(bird, 1.8, 1.1, 0) === 'LWing2');
  });
});

describe('blinking and burning (blink.js, flames.js)', () => {
  test('eye materials blink, every few seconds, briefly', async () => {
    const { isEyeMaterial, blinkTimer } = await import('../public/js/creature/blink.js');
    assert.equal(isEyeMaterial('Eye', 'pm0016_00_Eye1.png'), true);
    assert.equal(isEyeMaterial('Material #34', 'pm0004_00_Eye1'), true);
    assert.equal(isEyeMaterial('RIris', 'pm0018_00_Iris1.png'), false, 'an iris moves with the eye, it is not the eye');
    assert.equal(isEyeMaterial('BodyA00', 'pm0018_00_BodyA1.png'), false);
    let seed = 3;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const timer = blinkTimer(rand);
    let shut = 0;
    let blinks = 0;
    let was = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const v = timer.step(1 / 60);
      assert.ok(v >= 0 && v <= 1);
      if (v > 0) shut++;
      if (v > 0 && was === 0) blinks++;
      was = v;
    }
    assert.ok(blinks >= 8 && blinks <= 30, `${blinks} blinks a minute`);
    assert.ok(shut / 60 < 0.16 * 30, 'eyes are open nearly all the time');
  });

  test('flames are found by name, and a few species by their burning mane', async () => {
    const { isFlame } = await import('../public/js/creature/flames.js');
    assert.equal(isFlame('Material #36', 'pm0004_00_FireCoreA1'), true, 'Charmander’s tail tip');
    assert.equal(isFlame('FireCoreA_mat', ''), true, 'Magmar');
    assert.equal(isFlame('Hair', '', 77), true, 'Ponyta’s mane');
    assert.equal(isFlame('Hair', '', 18), false, 'Pidgeot’s crest is feathers');
    assert.equal(isFlame('BodyA', 'pm0018_00_BodyA1.png'), false);
  });
});
