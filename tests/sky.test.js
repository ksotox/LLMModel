// The sky drop and freefall, the mount's power dive (sanctuary/player.js), hands that hold the paraglider's
// brakes and a ridden Pokémon (sanctuary/trainer.js rigDriver: two-bone IK), and Pokémon arms that move
// where their own clips leave them still (creature/armSwing.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as THREE from 'three';
import { createPlayer, FLY, PARA, SKY, startSkyDrop, stepFlyer, stepPlayer, stepSkydive } from '../public/js/sanctuary/player.js';
import { findRig, gait, trainerState } from '../public/js/sanctuary/rig.js';
import { rigDriver } from '../public/js/sanctuary/trainer.js';
import { armSwing, createArmSwing, stillArms, trackTurn } from '../public/js/creature/armSwing.js';

const flat = { heightAt: () => 0, waterAt: () => null, radius: 78, airRadius: 300 };
const step = (p, input, seconds, ground = flat) => { for (let i = 0; i < Math.round(seconds * 60); i++) stepPlayer(p, input, 1 / 60, ground); };
const still = { x: 0, z: 0, steer: { f: 0, r: 0 } };

describe('sky drop', () => {
  test('G lifts you high over the land and you fall, at most at the terminal speed', () => {
    const p = startSkyDrop(createPlayer({ x: 5, z: 5 }), flat);
    assert.equal(p.mode, 'skydive');
    assert.equal(p.y, SKY.height);
    step(p, still, 4);
    assert.equal(p.mode, 'skydive');
    assert.ok(p.vy < -SKY.belly * 0.5 && p.vy >= -SKY.belly - 1e-6, `falling, no faster than ${SKY.belly} m/s belly down (${p.vy.toFixed(1)})`);
  });

  test('head down (the dive key) falls faster; W tracks forward; A/D turn', () => {
    const belly = startSkyDrop(createPlayer(), flat);
    const head = startSkyDrop(createPlayer(), flat);
    for (let i = 0; i < 300; i++) {
      stepSkydive(belly, { steer: { f: 1, r: 0 } }, 1 / 60, flat);
      stepSkydive(head, { steer: { f: 0, r: 1 }, down: true }, 1 / 60, flat);
    }
    assert.ok(head.vy < belly.vy - 5, `head down is faster (${head.vy.toFixed(1)} vs ${belly.vy.toFixed(1)})`);
    assert.ok(belly.moving > SKY.track * 0.5, 'W moves you forward over the land');
    assert.ok(head.facing < Math.PI - 1, 'D turns you round');
  });

  test('Space opens the paraglider; low down it opens by itself; never into the ground', () => {
    const p = startSkyDrop(createPlayer(), flat);
    step(p, still, 1);
    step(p, { ...still, jumpHeld: true }, 1 / 60);
    assert.equal(p.mode, 'paraglide', 'Space opens the wing');
    const q = startSkyDrop(createPlayer(), flat);
    let lowest = Infinity;
    for (let i = 0; i < 60 * 30 && q.mode === 'skydive'; i++) { stepPlayer(q, still, 1 / 60, flat); lowest = Math.min(lowest, q.y); }
    assert.equal(q.mode, 'paraglide', 'it opened by itself');
    assert.ok(lowest > SKY.open - 3 && lowest > PARA.drop, `opened ${lowest.toFixed(0)} m up`);
  });

  test('over high ground or the lake, the drop starts high above that', () => {
    const hills = { ...flat, heightAt: () => 60, waterAt: () => null };
    assert.equal(startSkyDrop(createPlayer(), hills).y, 60 + SKY.height);
    const lake = { ...flat, heightAt: () => -4, waterAt: () => 0 };
    assert.equal(startSkyDrop(createPlayer(), lake).y, SKY.height);
  });
});

describe('the power dive', () => {
  test('holding dive builds into a steep, fast dive, and it pulls up by itself near the ground', () => {
    const hills = { heightAt: () => 0, waterAt: () => null, radius: 78 };
    const p = { ...createPlayer({ x: 0, z: 0 }), mode: 'ride', air: true, y: 120, throttle: 0.5, bank: 0, vx: 0, vz: 11, vy: 0, facing: 0 };
    const cruise = { ...p };
    for (let i = 0; i < 60 * 2; i++) {
      stepFlyer(p, { steer: { f: 0, r: 0 }, down: true }, 1 / 60, hills);
      stepFlyer(cruise, { steer: { f: 0, r: 0 } }, 1 / 60, hills);
    }
    assert.ok(p.vy < -FLY.dive - 5, `plunging (${p.vy.toFixed(1)} m/s down)`);
    assert.ok(p.moving > cruise.moving * 1.2, 'and faster than cruising');
    let lowest = Infinity;
    for (let i = 0; i < 60 * 10; i++) {
      stepFlyer(p, { steer: { f: 0, r: 0 }, down: true }, 1 / 60, hills);
      lowest = Math.min(lowest, p.y);
    }
    assert.ok(lowest >= FLY.clearance - 1e-9, 'never into the ground');
    assert.ok(p.air && Math.abs(p.vy) < 3, 'levelled out over the ground');
  });
});

describe('poses', () => {
  test('freefall is its own state and pose: arms spread, the inside one tucked in a turn', () => {
    assert.equal(trainerState({ mode: 'skydive', moving: 3 }), 'skydive');
    const level = gait('skydive', 0, 0, 0, 0);
    const turning = gait('skydive', 0, 0, 0, 1);
    assert.ok(level.armOutL > 1 && level.armOutR > 1, 'arms spread');
    assert.ok(turning.armOutR < turning.armOutL, 'a right turn: the right arm tucks');
  });

  test('hands are found by name (game, Mixamo and Blender rigs)', () => {
    assert.equal(findRig(['Hips', 'LThigh', 'RThigh', 'LArm', 'RArm', 'LHand', 'RHand']).handL, 'LHand');
    assert.equal(findRig(['mixamorig:Hips', 'mixamorig:LeftHand', 'mixamorig:LeftHandIndex1']).handL, 'mixamorig:LeftHand');
    assert.equal(findRig(['hand.R']).handR, 'hand.R');
  });
});

/** A small human skeleton (in a T-pose), as a loaded model would have. */
function skeleton({ hands = true } = {}) {
  const root = new THREE.Group();
  const bone = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    (parent ?? root).add(b);
    return b;
  };
  const hips = bone('Hips', null, 0, 0.95, 0);
  const spine = bone('Spine', hips, 0, 0.2, 0);
  const chest = bone('Spine2', spine, 0, 0.2, 0);
  bone('Head', chest, 0, 0.25, 0);
  for (const [s, x] of [['Left', 1], ['Right', -1]]) {
    const arm = bone(`${s}Arm`, chest, x * 0.18, 0.12, 0);
    const fore = bone(`${s}ForeArm`, arm, x * 0.28, 0, 0);
    if (hands) bone(`${s}Hand`, fore, x * 0.26, 0, 0);
    const thigh = bone(`${s}UpLeg`, hips, x * 0.1, -0.05, 0);
    bone(`${s}Leg`, thigh, 0, -0.42, 0);
  }
  root.updateMatrixWorld(true);
  return root;
}

describe('hands that hold on (two-bone IK)', () => {
  for (const hands of [true, false]) {
    test(`each hand reaches its target${hands ? '' : ' (a rig with no hand bones, as autoRig makes)'}`, () => {
      const root = skeleton({ hands });
      const driver = rigDriver(THREE, root);
      assert.ok(driver, 'a human rig');
      const targets = { L: new THREE.Vector3(0.3, 1.75, 0.15), R: new THREE.Vector3(-0.3, 1.45, 0.25) };
      driver.pose(gait('paraglide', 0, 0, 0, 0.5), targets);
      root.updateMatrixWorld(true);
      for (const side of ['L', 'R']) {
        const fore = root.getObjectByName(`${side === 'L' ? 'Left' : 'Right'}ForeArm`);
        const hand = hands ? root.getObjectByName(`${side === 'L' ? 'Left' : 'Right'}Hand`).getWorldPosition(new THREE.Vector3())
          : fore.localToWorld(new THREE.Vector3(...(side === 'L' ? [0.28, 0, 0] : [-0.28, 0, 0])));
        const miss = hand.distanceTo(targets[side]);
        assert.ok(miss < 0.01, `${side} hand within 1 cm of its handle (${(miss * 100).toFixed(1)} cm)`);
        // The elbow points down, not up over the hand.
        const elbow = fore.getWorldPosition(new THREE.Vector3());
        const shoulder = root.getObjectByName(`${side === 'L' ? 'Left' : 'Right'}Arm`).getWorldPosition(new THREE.Vector3());
        assert.ok(elbow.y < Math.max(hand.y, shoulder.y), 'the elbow hangs below the hand or shoulder');
      }
    });
  }

  test('out of reach: the arm stretches towards it and nothing breaks', () => {
    const root = skeleton();
    const driver = rigDriver(THREE, root);
    driver.pose(gait('ride', 0, 0, 0, 0), { L: new THREE.Vector3(3, 1.5, 3), R: null });
    root.updateMatrixWorld(true);
    const hand = root.getObjectByName('LeftHand').getWorldPosition(new THREE.Vector3());
    assert.ok(Number.isFinite(hand.x) && hand.distanceTo(new THREE.Vector3(3, 1.5, 3)) < 4);
  });
});

describe('Pokémon arms are never stiff', () => {
  const quatTrack = (name, angles) => ({ name: `${name}.quaternion`, values: angles.flatMap((a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]) });

  test('how far a clip turns a bone', () => {
    assert.ok(Math.abs(trackTurn(quatTrack('A', [0, 0.3, 0.1]).values) - 0.3) < 1e-6);
    assert.equal(trackTurn([0, 0, 0, 1]), 0, 'one key: no turn');
  });

  test('arms the clips leave still are found; arms they swing are left to them', () => {
    const clips = [{ tracks: [quatTrack('LArm', [0, 0.02, 0.01]), quatTrack('RArm', [0, 0.6, 0]), quatTrack('LThigh', [0, 0.5])] }];
    assert.deepEqual(stillArms(['LArm', 'RArm', 'LForeArm'], clips), ['LArm', 'LForeArm']);
  });

  test('the overlay sways the arms standing and swings them walking, not in lockstep', () => {
    const idle = [0, 1, 2, 3].map((t) => armSwing(0, t, 0));
    assert.ok(Math.max(...idle.map((s) => s.L)) - Math.min(...idle.map((s) => s.L)) > 0.08, 'they move standing still');
    assert.ok(idle.some((s) => Math.abs(s.L - s.R) > 0.05), 'not mirrored');
    const walk = armSwing(Math.PI / 2, 0, 1);
    assert.ok(walk.R - walk.L > 0.6, 'walking: one forward, one back');
  });

  test('on a model whose clips leave the arms still, the arms move after each mixer step', () => {
    const root = skeleton();
    const object = new THREE.Group();
    object.add(root);
    const clip = new THREE.AnimationClip('idle', 1, [new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 1], [0, 0, 0, 1, Math.sin(0.2), 0, 0, Math.cos(0.2)])]);
    const swing = createArmSwing(object, { mode: 'walk', runSpeed: 3 }, [clip]);
    assert.ok(swing, 'its arms are still in the clip, so they get the overlay');
    const arm = root.getObjectByName('LeftArm');
    const seen = [];
    for (let i = 0; i < 60; i++) { swing.update(1 / 20, { speed: 0 }); seen.push(arm.quaternion.x); }
    assert.ok(Math.max(...seen) - Math.min(...seen) > 0.02, 'the arm moves');
    // Without a clip setting it each frame, the turn never adds up.
    assert.ok(Math.max(...seen.map(Math.abs)) < 0.2, 'and stays a sway');
    assert.equal(createArmSwing(object, { mode: 'fly', runSpeed: 3 }, [clip]), null, 'a flyer’s arms are its wings');
  });
});
