// The trainer's movement in the Sanctuary: walking and sprinting, jumping, gliding and swimming,
// with a stamina gauge. Pure (no DOM, no three.js), so it is tested in Node; written from scratch
// from common game-movement ideas (movement modes, acceleration and braking, weaker steering in
// the air, a short grace time after leaving an edge, a remembered jump press).
//
//   ground: { heightAt(x, z), waterAt(x, z) → the water's level there or null, radius, solid?(x, z) }
//   input:  { x, z } direction in the world (length up to 1), sprint, jump (pressed this step), jumpHeld

export const MOVE = {
  walk: 4.2, sprint: 7.6, swim: 2.4, glide: 6.8,
  accel: 30, brake: 22, airControl: 7,
  jump: 7.2, gravity: 21, glideGravity: 3.2, glideFall: 1.7,
  coyote: 0.12, jumpBuffer: 0.14,
  maxClimb: 1.15, // rise per unit walked that still counts as walkable
  swimDepth: 0.7, // deeper water than this is swum, not waded
  staminaMax: 100, sprintDrain: 15, glideDrain: 11, regen: 24, regenDelay: 0.6, recovered: 30,
};

export function createPlayer({ x = 0, z = 4 } = {}) {
  return { x, y: 0, z, vx: 0, vy: 0, vz: 0, facing: Math.PI, mode: 'walk', stamina: MOVE.staminaMax, exhausted: false, rest: 0, coyote: 0, buffer: 0, moving: 0 };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Advance the trainer by `dt` seconds. Changes and returns `p`. */
export function stepPlayer(p, input, dt, ground) {
  const len = Math.hypot(input.x, input.z);
  const ix = len > 1 ? input.x / len : input.x;
  const iz = len > 1 ? input.z / len : input.z;
  const wants = Math.min(1, len);
  const floor = ground.heightAt(p.x, p.z);
  const water = ground.waterAt?.(p.x, p.z) ?? null;
  const swimming = water != null && water - floor > MOVE.swimDepth && p.y <= water - MOVE.swimDepth + 0.25;
  const onGround = !swimming && p.y <= floor + 0.02 && p.vy <= 0;

  // Mode.
  p.buffer = input.jump ? MOVE.jumpBuffer : Math.max(0, p.buffer - dt);
  p.coyote = onGround || swimming ? MOVE.coyote : Math.max(0, p.coyote - dt);
  if (swimming) p.mode = 'swim';
  else if (onGround) p.mode = 'walk';
  else if (p.mode !== 'glide') p.mode = 'fall';
  if (p.buffer > 0 && p.coyote > 0 && p.mode !== 'glide') {
    p.vy = MOVE.jump * (swimming ? 0.8 : 1);
    p.mode = 'fall';
    p.buffer = 0;
    p.coyote = 0;
  }
  // The glider opens when Space is held on the way down, and folds on landing, release or exhaustion.
  if (p.mode === 'fall' && input.jumpHeld && p.vy < -0.5 && !p.exhausted && p.y - floor > 0.6) p.mode = 'glide';
  if (p.mode === 'glide' && (!input.jumpHeld || p.exhausted)) p.mode = 'fall';

  // Stamina: sprinting and gliding use it; resting a moment brings it back; at 0, recover first.
  const sprinting = input.sprint && wants > 0.1 && p.mode === 'walk' && !p.exhausted;
  const draining = sprinting ? MOVE.sprintDrain : p.mode === 'glide' ? MOVE.glideDrain : 0;
  if (draining) {
    p.stamina = Math.max(0, p.stamina - draining * dt);
    p.rest = 0;
    if (p.stamina === 0) p.exhausted = true;
  } else {
    p.rest += dt;
    if (p.rest >= MOVE.regenDelay) p.stamina = Math.min(MOVE.staminaMax, p.stamina + MOVE.regen * dt);
    if (p.exhausted && p.stamina >= MOVE.recovered) p.exhausted = false;
  }

  // Horizontal speed: accelerate towards what is wanted; brake when nothing is.
  const top = p.mode === 'swim' ? MOVE.swim : p.mode === 'glide' ? MOVE.glide : sprinting ? MOVE.sprint : MOVE.walk * (p.exhausted ? 0.7 : 1);
  const grip = p.mode === 'walk' ? (wants > 0 ? MOVE.accel : MOVE.brake) : p.mode === 'swim' ? 8 : MOVE.airControl;
  const tx = ix * top;
  const tz = iz * top;
  const k = clamp01((grip * dt) / Math.max(0.001, Math.hypot(tx - p.vx, tz - p.vz)));
  p.vx += (tx - p.vx) * k;
  p.vz += (tz - p.vz) * k;
  if (p.mode === 'glide' && wants < 0.1) { // a glider keeps going the way it faces
    p.vx += (Math.sin(p.facing) * top * 0.6 - p.vx) * clamp01(dt * 2);
    p.vz += (Math.cos(p.facing) * top * 0.6 - p.vz) * clamp01(dt * 2);
  }

  // Step, unless the ground ahead is too steep to walk up.
  let nx = p.x + p.vx * dt;
  let nz = p.z + p.vz * dt;
  const step = Math.hypot(nx - p.x, nz - p.z);
  if (p.mode === 'walk' && step > 1e-6 && (ground.heightAt(nx, nz) - floor) / step > MOVE.maxClimb) {
    nx = p.x; nz = p.z; p.vx = 0; p.vz = 0;
  }
  // Solid things (trees, rocks, ruins): slide along them instead of walking through.
  if (ground.solid?.(nx, nz)) {
    if (!ground.solid(nx, p.z)) { nz = p.z; p.vz = 0; } else if (!ground.solid(p.x, nz)) { nx = p.x; p.vx = 0; } else { nx = p.x; nz = p.z; p.vx = 0; p.vz = 0; }
  }
  const r = Math.hypot(nx, nz);
  if (ground.radius && r > ground.radius) { nx *= ground.radius / r; nz *= ground.radius / r; }
  p.x = nx;
  p.z = nz;

  // Height.
  const here = ground.heightAt(p.x, p.z);
  const level = ground.waterAt?.(p.x, p.z) ?? null;
  if (p.mode === 'swim' && level != null && p.vy <= 0) {
    p.y = Math.max(here, level - MOVE.swimDepth);
    p.vy = 0;
  } else if (p.mode === 'walk' && p.y - here <= 0.6) {
    p.y = here; // follows the ground down slopes as well as up
    p.vy = 0;
  } else {
    if (p.mode === 'walk') p.mode = 'fall'; // walked off an edge
    p.vy -= (p.mode === 'glide' ? MOVE.glideGravity : MOVE.gravity) * dt;
    if (p.mode === 'glide') p.vy = Math.max(p.vy, -MOVE.glideFall);
    p.y += p.vy * dt;
    if (p.y <= here) { p.y = here; p.vy = 0; p.mode = 'walk'; }
  }
  p.moving = Math.hypot(p.vx, p.vz);
  if (p.moving > 0.3) {
    const want = Math.atan2(p.vx, p.vz);
    const turn = ((want - p.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.facing += turn * clamp01(dt * 12);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Swimming in the Reef: free movement in three dimensions. Velocity eases towards what is wanted
// with 1 − e^(−rate·dt) (the same at any frame rate), and moves in steps shorter than the body, each
// pushed back out of rock and wreck with the speed into them dropped, so the swimmer slides along
// instead of passing through (both ideas from the MIT-licensed Abyssal Garden).
//
//   world: { heightAt(x, z), top (the surface), radius, obstacles [{ x, y, z, r }] }
//   input: { x, z } direction on the level (length up to 1), up (−1…1), fast

export const SWIM = { speed: 3.4, fast: 8, rate: 4.5, body: 0.5, drain: 14, regen: 20, drift: 0.12 };

export function createSwimmer({ x = 0, y = 4, z = 6 } = {}) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, facing: Math.PI, stamina: MOVE.staminaMax, exhausted: false, mode: 'swim', moving: 0 };
}

export function stepSwimmer(p, input, dt, world) {
  const len = Math.hypot(input.x, input.z);
  const ix = len > 1 ? input.x / len : input.x;
  const iz = len > 1 ? input.z / len : input.z;
  const up = Math.max(-1, Math.min(1, input.up ?? 0));
  const wants = Math.hypot(ix, iz, up) > 0.05;
  const fast = input.fast && wants && !p.exhausted;
  if (fast) {
    p.stamina = Math.max(0, p.stamina - SWIM.drain * dt);
    if (p.stamina === 0) p.exhausted = true;
  } else {
    p.stamina = Math.min(MOVE.staminaMax, p.stamina + SWIM.regen * dt);
    if (p.exhausted && p.stamina >= MOVE.recovered) p.exhausted = false;
  }
  const top = fast ? SWIM.fast : SWIM.speed * (p.exhausted ? 0.7 : 1);
  const k = 1 - Math.exp(-dt * SWIM.rate);
  p.vx += (ix * top - p.vx) * k;
  p.vz += (iz * top - p.vz) * k;
  p.vy += ((wants ? up * top * 0.8 : SWIM.drift) - p.vy) * k; // left alone, a swimmer drifts gently up
  // Move in steps shorter than the body, pushing out of anything solid after each one.
  const dx = p.vx * dt;
  const dy = p.vy * dt;
  const dz = p.vz * dt;
  const n = Math.floor(Math.hypot(dx, dy, dz) / (SWIM.body * 0.8)) + 1;
  for (let i = 0; i < n; i++) {
    p.x += dx / n;
    p.y += dy / n;
    p.z += dz / n;
    for (const o of world.obstacles ?? []) {
      const ox = p.x - o.x;
      const oy = p.y - o.y;
      const oz = p.z - o.z;
      const d = Math.hypot(ox, oy, oz);
      const min = o.r + SWIM.body;
      if (d < min && d > 1e-6) {
        const nx = ox / d;
        const ny = oy / d;
        const nz = oz / d;
        p.x += nx * (min - d);
        p.y += ny * (min - d);
        p.z += nz * (min - d);
        const into = p.vx * nx + p.vy * ny + p.vz * nz;
        if (into < 0) { p.vx -= nx * into; p.vy -= ny * into; p.vz -= nz * into; }
      }
    }
    const floor = world.heightAt(p.x, p.z) + SWIM.body;
    if (p.y < floor) { p.y = floor; if (p.vy < 0) p.vy = 0; }
  }
  const ceiling = world.top - 0.35;
  if (p.y > ceiling) { p.y = ceiling; if (p.vy > 0) p.vy = 0; }
  const r = Math.hypot(p.x, p.z);
  if (world.radius && r > world.radius) { p.x *= world.radius / r; p.z *= world.radius / r; }
  p.moving = Math.hypot(p.vx, p.vy, p.vz);
  if (Math.hypot(p.vx, p.vz) > 0.3) {
    const want = Math.atan2(p.vx, p.vz);
    const turn = ((want - p.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.facing += turn * Math.min(1, dt * 8);
  }
  p.atSurface = p.y >= ceiling - 0.05;
  return p;
}
