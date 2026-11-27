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

  test('the glider: holding jump while falling from a low height (under the paraglider’s 6 m) slows the fall and uses stamina', () => {
    const cliff = { heightAt: (x) => (x < 0 ? 5.5 : 0), waterAt: () => null, radius: 200 };
    const fall = createPlayer({ x: -0.5, z: 0 });
    fall.y = 5.5;
    let fallTime = 0;
    while (fall.y > 0 && fallTime < 20) { stepPlayer(fall, { ...none, x: 1 }, 1 / 60, cliff); fallTime += 1 / 60; }
    const glide = createPlayer({ x: -0.5, z: 0 });
    glide.y = 5.5;
    let glideTime = 0;
    let glided = false;
    while (glide.y > 0 && glideTime < 60) { stepPlayer(glide, { ...none, x: 1, jumpHeld: true }, 1 / 60, cliff); glideTime += 1 / 60; glided ||= glide.mode === 'glide'; if (glide.mode === 'glide') assert.ok(glide.vy >= -MOVE.glideFall - 1e-9); }
    assert.ok(glided);
    assert.ok(glideTime > fallTime * 2, `gliding ${glideTime.toFixed(1)} s vs falling ${fallTime.toFixed(1)} s`);
    assert.ok(glide.x > fall.x + 10, 'and carries much further');
    assert.ok(glide.stamina < MOVE.staminaMax);
  });

  test('the paraglider: opened high up, it sinks slowly, turns, uses no stamina and lands', async () => {
    const { PARA } = await import('../public/js/sanctuary/player.js');
    const hill = { heightAt: () => 0, waterAt: () => null, radius: 78 };
    const p = createPlayer({ x: 0, z: 0 });
    p.y = 40;
    p.mode = 'fall';
    stepPlayer(p, { ...none, jumpHeld: true }, 1 / 60, hill);
    assert.equal(p.mode, 'paraglide', 'Space held 40 m up opens it');
    let t = 0;
    while (t < 12) { stepPlayer(p, { ...none, steer: { f: 0, r: 0 } }, 1 / 60, hill); t += 1 / 60; }
    assert.ok(Math.abs(p.vy + PARA.sink) < 0.05, `it settles to its sink rate (${p.vy.toFixed(2)})`);
    assert.ok(Math.abs(p.moving - PARA.speed) < 0.3, 'and its airspeed');
    assert.ok(Math.hypot(p.x, p.z) > 78, 'past the edge of the walking area: the air is wider');
    const heading = p.facing;
    for (let i = 0; i < 120; i++) stepPlayer(p, { ...none, steer: { f: 0, r: 1 } }, 1 / 60, hill);
    assert.ok(p.facing < heading - 0.5, 'D banks it round to the right');
    const fast = { ...p };
    stepPlayer(Object.assign(createPlayer(), p), { ...none, steer: { f: 0, r: 0 } }, 1 / 60, hill);
    for (let i = 0; i < 180; i++) stepPlayer(fast, { ...none, steer: { f: 1, r: 0 } }, 1 / 60, hill);
    assert.ok(fast.vy < -PARA.sink - 0.5 && fast.moving > PARA.speed + 2, 'W: faster, sinking more');
    assert.equal(p.stamina, MOVE.staminaMax, 'no stamina used');
    while (p.mode === 'paraglide' && t < 120) { stepPlayer(p, { ...none, steer: { f: 0, r: 0 } }, 1 / 60, hill); t += 1 / 60; }
    assert.equal(p.mode, 'walk', 'it lands on its feet');
    assert.equal(p.y, 0);
    // Landed outside the walking area: you can walk back in, but no further out.
    const r0 = Math.hypot(p.x, p.z);
    for (let i = 0; i < 60; i++) stepPlayer(p, { ...none, x: p.x / r0, z: p.z / r0 }, 1 / 60, hill);
    assert.ok(Math.hypot(p.x, p.z) <= r0 + 1e-6, 'not further out on foot');
  });

  test('the trainer mantles onto the authored slab and stands on its visible top', async () => {
    const { addTraversalLedge } = await import('../public/js/sanctuary/habitats.js');
    const plan = [{ kind: 'slab', x: 0, z: 0, turn: 0, size: 1 }];
    const ledge = addTraversalLedge(plan, flat.heightAt);
    const ground = { ...flat, ledge };
    const p = createPlayer({ x: 0, z: 0.9 });
    const toward = { ...none, z: -1, jumpHeld: true };
    assert.equal(stepPlayer(p, toward, 1 / 60, ground).mode, 'mantle');
    run(p, toward, MOVE.mantleTime, ground);
    assert.equal(p.mode, 'walk');
    assert.equal(p.y, ledge.top);
    run(p, none, 0.2, ground);
    assert.equal(p.y, ledge.top);
    run(p, { ...none, x: 1 }, 0.8, ground);
    assert.equal(p.y, 0);

    const blocked = createPlayer({ x: 0, z: 0.9 });
    const obstructed = { ...ground, solid: (x, z) => Math.hypot(x, z) < 0.3 };
    run(blocked, toward, 0.5, obstructed);
    assert.equal(blocked.mode, 'walk');
    assert.ok(blocked.z >= 0.5, 'a blocked landing keeps the trainer at the foot of the slab');
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

describe('Sanctuary: habitats, animations and the gamepad', () => {
  test('each habitat gets its own scenery, out of the water and off the plaza, the same every time', async () => {
    const { planHabitats, solidAt } = await import('../public/js/sanctuary/habitats.js');
    const lake = { x: 27, z: -21, shore: 10.5 };
    const inWater = (x, z) => Math.hypot(x - lake.x, z - lake.z) < lake.shore;
    const plan = planHabitats({ inWater, lake });
    const kinds = (h) => new Set(plan.filter((p) => p.habitat === h).map((p) => p.kind));
    assert.ok(kinds('woods').has('tree') && kinds('woods').has('fern'));
    assert.ok(kinds('rocks').has('firePit') && kinds('rocks').has('redRock'));
    assert.ok(kinds('ruins').has('ruin') && kinds('ruins').has('stoneRing'));
    assert.ok(kinds('dusk').has('mushroom') && kinds('dusk').has('pine'));
    assert.ok(kinds('shore').has('palm') && kinds('shore').has('boat') && kinds('shore').has('pier'));
    assert.equal(plan.filter((p) => p.kind === 'sign').length, HABITATS.length - 1, 'a sign at every habitat but the meadow');
    for (const p of plan) {
      if (p.kind !== 'pier' && p.kind !== 'fireflies' && p.kind !== 'stoneRing') assert.ok(!inWater(p.x, p.z), `${p.kind} is on land`);
      assert.ok(Math.hypot(p.x, p.z) > 8, `${p.kind} is off the plaza`);
    }
    assert.deepEqual(planHabitats({ inWater, lake }), plan);
    const tree = plan.find((p) => p.kind === 'tree');
    assert.ok(solidAt(plan, tree.x, tree.z), 'you can’t walk through a tree');
    assert.ok(!solidAt(plan, 0, 0));
  });

  test('the trainer slides along solid things instead of walking through them', () => {
    const wall = { heightAt: () => 0, waterAt: () => null, radius: 80, solid: (x) => x > 2 && x < 3 };
    const p = run(createPlayer({ x: 0, z: 0 }), { ...none, x: 1, z: 0.5 }, 3, wall);
    assert.ok(p.x < 2.01, 'stopped at it');
    assert.ok(p.z > 2, 'and slid along it');
  });

  test('animations are picked by name: idle, walk and a happy one', async () => {
    const { pickClips } = await import('../public/js/battle/modelLoader.js');
    const clip = (name) => ({ name });
    const all = ['Idle_Loop', 'Walk', 'Faint', 'Attack_1'].map(clip);
    const picked = pickClips(all);
    assert.deepEqual([picked.idle.name, picked.walk.name, picked.extra.name], ['Idle_Loop', 'Walk', 'Attack_1']);
    assert.deepEqual(pickClips([clip('Take 001')]), { idle: { name: 'Take 001' }, walk: null, extra: null });
    assert.deepEqual(pickClips([]), { idle: null, walk: null, extra: null });
    assert.equal(pickClips([clip('ground_idle'), clip('Run')]).walk.name, 'Run');
  });

  test('the gamepad: sticks with a dead zone, buttons pressed once per press', async () => {
    const { readGamepad } = await import('../public/js/battle/controls.js');
    const pad = (axes, held) => [{ axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })) }];
    const memory = {};
    let g = readGamepad(0, memory, pad([0.1, -0.9, 0.5, 0], [0]));
    assert.deepEqual([g.lx, g.ly, g.rx], [0, -0.9, 0.5]);
    assert.ok(g.pressed.has(0) && g.held.has(0));
    g = readGamepad(0, memory, pad([0, 0, 0, 0], [0, 2]));
    assert.ok(!g.pressed.has(0), 'still held: not pressed again');
    assert.ok(g.pressed.has(2));
    assert.equal(readGamepad(1, memory, pad([0, 0, 0, 0], [])), null, 'no second pad');
  });
});

describe('Sanctuary: smooth looking, and keeping 3D pages smooth', () => {
  test('a turn reaches the camera gradually, the same at any frame rate, and the pitch stays in range', async () => {
    const { addLook, createLook, ease, stepLook } = await import('../public/js/sanctuary/look.js');
    const at = (fps) => {
      const look = createLook({ yaw: 0 });
      addLook(look, 1, 0);
      const seen = [];
      for (let i = 0; i < fps; i++) { stepLook(look, 1 / fps); if (i === Math.round(fps * 0.1) - 1) seen.push(look.yaw); } // (sampled after 0.1 s)
      return { early: seen[0], end: look.yaw };
    };
    const a = at(30);
    const b = at(144);
    assert.ok(a.early > 0 && a.early < 0.9, 'not all at once');
    assert.ok(Math.abs(a.end - 1) < 0.01 && Math.abs(b.end - 1) < 0.01, 'all of it in the end');
    assert.ok(Math.abs(a.early - b.early) < 0.12, 'about the same at 30 and 144 fps');
    const look = createLook();
    addLook(look, 0, 10);
    for (let i = 0; i < 120; i++) stepLook(look, 1 / 60);
    assert.equal(look.pitch, look.max);
    assert.ok(Math.abs(ease(1 / 60, 30) + ease(1 / 60, 30) * (1 - ease(1 / 60, 30)) - ease(2 / 60, 30)) < 1e-9, 'two small steps = one big one');
  });

  test('dynamic resolution: fewer pixels when slow (never below 60%), back up when there is room', async () => {
    const { nextPixelRatio } = await import('../public/js/battle/perf.js');
    assert.ok(nextPixelRatio(30, 2, 2) < 2);
    assert.equal(nextPixelRatio(200, 1.3, 2), 1.2, 'never below 60% of the level');
    assert.equal(nextPixelRatio(16, 1.5, 2), 1.5, 'fine: no change');
    assert.ok(nextPixelRatio(8, 1.5, 2) > 1.5);
    assert.equal(nextPixelRatio(8, 2, 2), 2, 'never above the level');
  });

  test('slow frames turn the High passes off first, then lower the pixels', async () => {
    const { perfStep } = await import('../public/js/battle/perf.js');
    assert.deepEqual(perfStep(30, 2, 2, true), { ratio: 2, drop: true }, 'the passes go before any pixels');
    const after = perfStep(30, 2, 2, false);
    assert.equal(after.drop, false);
    assert.ok(after.ratio < 2, 'then fewer pixels');
    assert.deepEqual(perfStep(12, 2, 2, true), { ratio: 2, drop: false }, 'fast enough: all kept');
  });

  test('a new graphics level settles before frames are judged (its first frames compile shaders)', async () => {
    const { createPerf } = await import('../public/js/battle/perf.js');
    let drops = 0;
    const effects = { on: true, drop() { drops++; this.on = false; } };
    const perf = createPerf({ getPixelRatio: () => 2, setPixelRatio() {} }, () => 2, effects);
    for (let i = 0; i < 200; i++) perf.frame(16);
    assert.equal(drops, 0, 'fast frames keep the passes');
    perf.settle();
    for (let i = 0; i < 15; i++) perf.frame(120);
    assert.equal(drops, 0, 'slow frames right after a change are not held against it');
    for (let i = 0; i < 20; i++) perf.frame(120);
    assert.equal(drops, 1, 'still slow once settled: the passes go');
  });

  test('more pixels come back only after 3 easy seconds in a row (no see-saw)', async () => {
    const { createPerf } = await import('../public/js/battle/perf.js');
    let ratio = 1.5;
    const changes = [];
    const perf = createPerf({ getPixelRatio: () => ratio, setPixelRatio(r) { ratio = r; changes.push(r); } }, () => 2);
    const second = (ms) => { for (let i = 0; i < Math.round(1000 / ms); i++) perf.frame(ms); };
    second(16); second(16); // settling (2 s)
    second(10); second(10);
    assert.equal(changes.length, 0, 'two easy seconds: not yet');
    second(10);
    assert.equal(changes.length, 1, 'the third: a little more resolution');
    assert.ok(ratio > 1.5);
    second(30);
    assert.equal(changes.length, 2, 'a slow second lowers it at once');
    assert.ok(ratio < changes[0]);
  });

  test('warming a model up: each of its textures once, then its shaders', async () => {
    const THREE = await import('three');
    const { texturesOf, warmUp } = await import('../public/js/battle/modelLoader.js');
    const map = new THREE.Texture();
    const normal = new THREE.Texture();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map, normalMap: normal })));
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial({ map }), new THREE.MeshBasicMaterial()]));
    assert.deepEqual(new Set(texturesOf(group)), new Set([map, normal]));
    const calls = [];
    let ready = false;
    const program = { isReady: () => ready };
    const renderer = {
      initTexture: (t) => calls.push(t),
      compile: (o) => { calls.push(o); setTimeout(() => { ready = true; }, 30); return new Set(o.children.map((c) => [].concat(c.material)).flat()); },
      properties: { get: (m) => ({ currentProgram: m.isMeshBasicMaterial && !m.map ? undefined : program }) },
    };
    const t0 = Date.now();
    await warmUp(renderer, group, null, null);
    assert.ok(ready && Date.now() - t0 >= 25, 'it waits for the shaders, and a material without a program doesn\'t stop it');
    assert.equal(calls.length, 3);
    assert.equal(calls[2], group, 'shaders last');
    await warmUp(null, group, null, null); // no renderer (tests, a page without WebGL): nothing to do
  });

  test('the camera boom comes in fast and goes back out slowly, the same at any frame rate', async () => {
    const { approach } = await import('../public/js/sanctuary/look.js');
    let a = 1;
    for (let i = 0; i < 6; i++) a = approach(a, 0.3, 1 / 60, 20, 3); // a tree comes between: 0.1 s
    assert.ok(a < 0.5, `in quickly (${a})`);
    let b = 0.3;
    for (let i = 0; i < 6; i++) b = approach(b, 1, 1 / 60, 20, 3);
    assert.ok(b < 0.5 && b > 0.3, `out gently (${b})`);
    let c60 = 0.3;
    for (let i = 0; i < 60; i++) c60 = approach(c60, 1, 1 / 60);
    let c144 = 0.3;
    for (let i = 0; i < 144; i++) c144 = approach(c144, 1, 1 / 144);
    assert.ok(Math.abs(c60 - c144) < 1e-9, 'one second at 60 Hz is one second at 144 Hz');
  });

  test('the shadow camera follows in whole texels (no shimmer)', async () => {
    const { snapToTexel } = await import('../public/js/battle/world.js');
    const l = Math.hypot(0.5, 1, 0.3);
    const dir = { x: 0.5 / l, y: 1 / l, z: 0.3 / l };
    const a = snapToTexel({ x: 3.001, y: 0.5, z: -2 }, dir, 0.02);
    const b = snapToTexel({ x: 3.004, y: 0.5, z: -2 }, dir, 0.02);
    // (Only movement along the light's own direction remains, which doesn't move the shadow map.)
    const d = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const across = Math.hypot(d.y * dir.z - d.z * dir.y, d.z * dir.x - d.x * dir.z, d.x * dir.y - d.y * dir.x);
    assert.ok(across < 1e-9, 'a move smaller than a texel leaves the shadow map where it is');
    assert.ok(Math.hypot(a.x - 3.001, a.y - 0.5, a.z + 2) < 0.02, 'and stays within a texel of the trainer');
  });

  test('frame statistics: fps, slowest frame and long frames', async () => {
    const { frameStats } = await import('../public/js/battle/frameMeter.js');
    const ms = Array(140).fill(6.9);
    ms[50] = 20; // one hitch at 144 Hz
    ms[90] = 14;
    const s = frameStats(ms);
    assert.equal(s.refresh, 6.9);
    assert.equal(s.long, 2);
    assert.equal(s.worst, 20);
    assert.ok(s.fps > 130 && s.fps < 145);
    assert.deepEqual(frameStats([]), { fps: 0, worst: 0, p95: 0, long: 0, refresh: 0 });
  });

  test('the High passes: only on High, and gone for good once dropped', async () => {
    const { createEffects } = await import('../public/js/battle/postfx.js');
    let plain = 0;
    const fx = createEffects({ render: () => { plain++; } });
    fx.setLevel('standard');
    assert.equal(fx.on, false);
    fx.render({}, {});
    assert.equal(plain, 1, 'Standard draws straight to the screen');
    fx.setLevel('high');
    assert.equal(fx.on, true);
    fx.drop();
    assert.equal(fx.on, false);
    fx.setLevel('high');
    assert.equal(fx.on, false, 'not back on after a drop');
    fx.render({}, {});
    assert.equal(plain, 2);
  });

  test('needle cards lie round a pine\'s cones, sloping down', async () => {
    const { skirtGeometry } = await import('../public/js/battle/surface.js');
    const tiers = [[1, 1, 1.3], [1.6, 0.75, 1.3]];
    const geo = skirtGeometry(tiers, 3, 9);
    const pos = geo.attributes.position;
    assert.equal(pos.count % 4, 0, 'quads');
    assert.ok(pos.count / 4 >= 20, 'two rings a tier');
    assert.equal(geo.index.count, (pos.count / 4) * 6);
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      assert.ok([x, y, z].every(Number.isFinite));
      assert.ok(Math.hypot(x, z) < 1.6 && y > -0.1 && y < 2.4, 'close round the cones');
    }
    // Each card's top edge (v = 1) is higher than its bottom (it hangs down the slope).
    const uv = geo.attributes.uv;
    for (let q = 0; q < pos.count; q += 4) {
      const top = [0, 1, 2, 3].filter((k) => uv.getY(q + k) === 1).map((k) => pos.getY(q + k));
      const bottom = [0, 1, 2, 3].filter((k) => uv.getY(q + k) === 0).map((k) => pos.getY(q + k));
      assert.ok(Math.min(...top) > Math.max(...bottom));
    }
  });

  test('a crashed load starts one graphics level lower next time', async () => {
    const { clearLoad, markLoad } = await import('../public/js/battle/perf.js');
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    assert.equal(markLoad('high', storage), 'high');
    assert.equal(markLoad('high', storage), 'standard', 'the last load never finished');
    clearLoad(storage);
    assert.equal(markLoad('high', storage), 'high');
    assert.equal(markLoad('basic', storage), 'basic', 'already the lowest');
  });
});

describe('realistic Pokémon materials', () => {
  test('a surface is guessed from the card types and the texture', async () => {
    const { surfaceKind } = await import('../public/js/battle/modelLoader.js');
    assert.equal(surfaceKind({ types: ['Metal'] }), 'metal');
    assert.equal(surfaceKind({ types: ['Water'] }), 'wet');
    assert.equal(surfaceKind({ types: ['Fighting'] }), 'hard');
    assert.equal(surfaceKind({ types: ['Fire'], sat: 0.3, lum: 0.5 }), 'fur', 'muted colours: fur');
    assert.equal(surfaceKind({ types: ['Psychic'], sat: 0.7, lum: 0.6 }), 'skin', 'bright, saturated: skin');
    assert.equal(surfaceKind(), 'fur');
  });
});

describe('as many frames as the screen shows', () => {
  test('a fast screen is aimed at its own rate, without giving up much sharpness', async () => {
    const { frameTargets, nextPixelRatio } = await import('../public/js/battle/perf.js');
    assert.deepEqual(frameTargets(16.7), { slow: 19, fast: 13.5, floor: 0.6, target: 16.7 }, '60 Hz: as before');
    const hz144 = frameTargets(1000 / 144);
    assert.ok(hz144.slow < 10 && hz144.floor === 0.75, JSON.stringify(hz144));
    assert.ok(nextPixelRatio(9.5, 2, 2, hz144) < 2, '105 fps on a 144 Hz screen: a little fewer pixels');
    assert.equal(nextPixelRatio(9.5, 2, 2), 2, 'the same on a 60 Hz screen: nothing to do');
    assert.ok(nextPixelRatio(40, 2, 2, hz144) >= 1.5, 'never below three quarters on a fast screen');
  });
});
