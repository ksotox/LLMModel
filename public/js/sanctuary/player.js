// The trainer's movement in the Sanctuary: walking and sprinting, jumping, gliding and swimming,
// with a stamina gauge. Pure (no DOM, no three.js), so it is tested in Node; written from scratch
// from common game-movement ideas (movement modes, acceleration and braking, weaker steering in
// the air, a short grace time after leaving an edge, a remembered jump press).
//
//   ground: { heightAt(x, z), waterAt(x, z) → the water's level there or null, radius, solid?(x, z), ledge? }
//   input:  { x, z } direction in the world (length up to 1), sprint, jump (pressed this step), jumpHeld,
//           steer { f, r } (the raw forward and right keys, for the paraglider)

export const MOVE = {
  walk: 4.2, sprint: 7.6, swim: 2.4, glide: 6.8,
  accel: 30, brake: 22, airControl: 7,
  jump: 7.2, gravity: 21, glideGravity: 3.2, glideFall: 1.7,
  coyote: 0.12, jumpBuffer: 0.14,
  maxClimb: 1.15, // rise per unit walked that still counts as walkable
  swimDepth: 0.7, // deeper water than this is swum, not waded
  staminaMax: 100, sprintDrain: 15, glideDrain: 11, regen: 24, regenDelay: 0.6, recovered: 30,
  mantleTime: 0.26, mantleReach: 0.65,
};

/**
 * The paraglider (opened with Space when 6 m or more above the ground: off the summit, the ski lift, a
 * flying Pokémon). It flies itself at a steady airspeed and sinks slowly; W speeds up (sinking more),
 * S flares (slower, sinking less), A/D bank it into a turn. No stamina. `airRadius`: how far it goes.
 */
/**
 * Riding a flying Pokémon: a throttle (W up, S down to a hover), A/D bank into turns, Space climbs,
 * Ctrl or C dives, Shift boosts. It keeps clear of the land and the lake, lands when slow near the
 * ground (then it walks), and takes off again with Space. `ceiling`: metres above the meadow.
 */
export const FLY = { slow: 2.5, cruise: 11, fast: 17, boost: 1.35, climb: 6.5, dive: 10, turn: 1.5, clearance: 1.4, ceiling: 140, walk: 3.2, airRadius: 300 };

export const PARA = { drop: 6, speed: 9, fast: 12, slow: 6.2, sink: 1.1, fastSink: 2.1, slowSink: 0.75, turn: 0.95, airRadius: 300 };

export function createPlayer({ x = 0, z = 4 } = {}) {
  return { x, y: 0, z, vx: 0, vy: 0, vz: 0, facing: Math.PI, mode: 'walk', stamina: MOVE.staminaMax, exhausted: false, rest: 0, coyote: 0, buffer: 0, moving: 0, mantle: null };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const LEDGE_PAD = 0.23;

function supportAt(ground, x, z, y) {
  const floor = ground.heightAt(x, z);
  const ledge = ground.ledge;
  return ledge && y >= ledge.top - 0.02 && ledge.contains(x, z) ? Math.max(floor, ledge.top) : floor;
}

function stepMantle(p, dt, ground) {
  const m = p.mantle;
  m.t = Math.min(1, m.t + dt / MOVE.mantleTime);
  const rise = clamp01(m.t / 0.6);
  const across = clamp01((m.t - 0.6) / 0.4);
  const ease = (a) => a * a * (3 - 2 * a);
  const x = m.x0 + (m.x - m.x0) * ease(across);
  const z = m.z0 + (m.z - m.z0) * ease(across);
  if (ground.solid?.(x, z)) {
    p.mantle = null;
    p.mode = 'fall';
    return p;
  }
  p.x = x;
  p.z = z;
  p.y = m.y0 + (m.y - m.y0) * ease(rise);
  if (m.t >= 1) {
    p.mantle = null;
    p.mode = 'walk';
  }
  return p;
}

/** Advance the trainer by `dt` seconds. Changes and returns `p`. */
export function stepPlayer(p, input, dt, ground) {
  if (p.mantle) return stepMantle(p, dt, ground);
  const len = Math.hypot(input.x, input.z);
  const ix = len > 1 ? input.x / len : input.x;
  const iz = len > 1 ? input.z / len : input.z;
  const wants = Math.min(1, len);
  const floor = supportAt(ground, p.x, p.z, p.y);
  const water = ground.waterAt?.(p.x, p.z) ?? null;
  const swimming = water != null && water - floor > MOVE.swimDepth && p.y <= water - MOVE.swimDepth + 0.25;
  const onGround = !swimming && p.y <= floor + 0.02 && p.vy <= 0;

  // Mode.
  p.buffer = input.jump ? MOVE.jumpBuffer : Math.max(0, p.buffer - dt);
  p.coyote = onGround || swimming ? MOVE.coyote : Math.max(0, p.coyote - dt);
  const ledge = ground.ledge;
  if (ledge && !swimming && (p.buffer > 0 || input.jumpHeld) && wants > 0.15) {
    const rise = ledge.top - p.y;
    const toward = (ledge.x - p.x) * ix + (ledge.z - p.z) * iz;
    const reach = MOVE.mantleReach / wants;
    const atFace = !ledge.contains(p.x, p.z) && ledge.contains(p.x + ix * reach, p.z + iz * reach, LEDGE_PAD);
    if (rise >= 0.16 && rise <= 1.2 && toward > 0 && atFace && !ground.solid?.(ledge.x, ledge.z)) {
      p.mantle = { x0: p.x, y0: p.y, z0: p.z, x: ledge.x, y: ledge.top, z: ledge.z, t: 0 };
      Object.assign(p, { mode: 'mantle', vx: 0, vy: 0, vz: 0, moving: 0, buffer: 0, coyote: 0, facing: Math.atan2(ledge.x - p.x, ledge.z - p.z) });
      return stepMantle(p, dt, ground);
    }
  }
  if (p.mode === 'paraglide' && !swimming && !onGround) return stepParaglide(p, input, dt, ground);
  if (swimming) p.mode = 'swim';
  else if (onGround) p.mode = 'walk';
  else if (p.mode !== 'glide') p.mode = 'fall';
  if (p.buffer > 0 && p.coyote > 0 && p.mode !== 'glide') {
    p.vy = MOVE.jump * (swimming ? 0.8 : 1);
    p.mode = 'fall';
    p.buffer = 0;
    p.coyote = 0;
  }
  // High up, Space held on the way down opens the paraglider.
  if ((p.mode === 'fall' || p.mode === 'glide') && input.jumpHeld && p.vy <= 0 && p.y - floor > PARA.drop) {
    p.mode = 'paraglide';
    p.bank = 0;
    return stepParaglide(p, input, dt, ground);
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
  if (p.mode === 'walk' && step > 1e-6 && (supportAt(ground, nx, nz, p.y) - floor) / step > MOVE.maxClimb) {
    nx = p.x; nz = p.z; p.vx = 0; p.vz = 0;
  }
  // Solid things (trees, rocks, ruins): slide along them instead of walking through.
  const blocks = (x, z) => ground.solid?.(x, z) || (ledge && p.y < ledge.top - 0.02 && ledge.contains(x, z, LEDGE_PAD));
  if (blocks(nx, nz)) {
    if (!blocks(nx, p.z)) { nz = p.z; p.vz = 0; } else if (!blocks(p.x, nz)) { nx = p.x; p.vx = 0; } else { nx = p.x; nz = p.z; p.vx = 0; p.vz = 0; }
  }
  // On foot, the Sanctuary's edge; landed further out (from the air), you can walk back in but no further out.
  const r = Math.hypot(nx, nz);
  const limit = Math.max(ground.radius ?? 0, Math.hypot(p.x, p.z));
  if (ground.radius && r > limit) { nx *= limit / r; nz *= limit / r; }
  p.x = nx;
  p.z = nz;

  // Height.
  const here = supportAt(ground, p.x, p.z, p.y);
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

/** One step of the paraglider (see PARA). Pure. */
export function stepParaglide(p, input, dt, ground) {
  const steer = input.steer ?? { f: 0, r: 0 };
  const f = Math.max(-1, Math.min(1, steer.f ?? 0));
  const turn = Math.max(-1, Math.min(1, steer.r ?? 0));
  p.mode = 'paraglide';
  p.bank = (p.bank ?? 0) + (turn - (p.bank ?? 0)) * clamp01(dt * 2.5);
  p.facing -= p.bank * PARA.turn * dt; // (right turns the heading clockwise, seen from above)
  const speed = f >= 0 ? PARA.speed + (PARA.fast - PARA.speed) * f : PARA.speed + (PARA.slow - PARA.speed) * -f;
  const sink = f >= 0 ? PARA.sink + (PARA.fastSink - PARA.sink) * f : PARA.sink + (PARA.slowSink - PARA.sink) * -f;
  const k = clamp01(dt * 1.5);
  p.vx += (Math.sin(p.facing) * speed - p.vx) * k;
  p.vz += (Math.cos(p.facing) * speed - p.vz) * k;
  p.vy += (-sink + (ground.liftAt?.(p.x, p.z) ?? 0) - p.vy) * clamp01(dt * 2);
  let nx = p.x + p.vx * dt;
  let nz = p.z + p.vz * dt;
  const radius = ground.airRadius ?? PARA.airRadius;
  const r = Math.hypot(nx, nz);
  if (r > radius) { nx *= radius / r; nz *= radius / r; }
  p.x = nx;
  p.z = nz;
  p.y += p.vy * dt;
  // Stamina comes back while flying (the wing does the work).
  p.rest += dt;
  if (p.rest >= MOVE.regenDelay) p.stamina = Math.min(MOVE.staminaMax, p.stamina + MOVE.regen * dt);
  if (p.exhausted && p.stamina >= MOVE.recovered) p.exhausted = false;
  // Landing: on the ground (feet first, slowing to a run) or in the lake.
  const here = supportAt(ground, p.x, p.z, p.y);
  const water = ground.waterAt?.(p.x, p.z) ?? null;
  if (water != null && water - here > MOVE.swimDepth && p.y <= water - MOVE.swimDepth) {
    Object.assign(p, { y: water - MOVE.swimDepth, vy: 0, mode: 'swim', bank: 0 });
  } else if (p.y <= here) {
    Object.assign(p, { y: here, vy: 0, mode: 'walk', bank: 0, vx: p.vx * 0.5, vz: p.vz * 0.5 });
  }
  p.moving = Math.hypot(p.vx, p.vz);
  return p;
}

/**
 * One step of riding a flying Pokémon (see FLY). `p.air`: flying (true) or walking on the ground;
 * `p.throttle` 0…1; `p.bank` −1…1. input: { steer { f, r }, jumpHeld (climb), down (dive), sprint
 * (boost) }. Pure.
 */
export function stepFlyer(p, input, dt, ground) {
  const steer = input.steer ?? { f: 0, r: 0 };
  const f = Math.max(-1, Math.min(1, steer.f ?? 0));
  const turn = Math.max(-1, Math.min(1, steer.r ?? 0));
  p.mode = 'ride';
  p.throttle = Math.max(0, Math.min(1, (p.throttle ?? 0.5) + f * dt * 0.7));
  p.bank = (p.bank ?? 0) + (turn * (p.air ? 1 : 0.4) - (p.bank ?? 0)) * clamp01(dt * 3);
  p.facing -= p.bank * FLY.turn * dt * (p.air ? 1 : 1.6);
  const floorAt = (x, z) => {
    const land = ground.heightAt(x, z);
    const water = ground.waterAt?.(x, z);
    return water != null ? Math.max(land, water) : land;
  };
  if (!p.air && input.jumpHeld) { p.air = true; p.vy = Math.max(p.vy, 4); p.throttle = Math.max(p.throttle, 0.35); }
  let speed;
  if (p.air) {
    speed = FLY.slow + (FLY.fast - FLY.slow) * p.throttle;
    if (input.sprint) speed *= FLY.boost;
    const vyWant = (input.jumpHeld ? FLY.climb : 0) - (input.down ? FLY.dive : 0);
    p.vy += (vyWant - p.vy) * clamp01(dt * 2.5);
  } else {
    speed = Math.max(0, f) * FLY.walk; // on the ground it walks (W forward)
    p.vy = 0;
  }
  const k = clamp01(dt * (p.air ? 1.8 : 6));
  p.vx += (Math.sin(p.facing) * speed - p.vx) * k;
  p.vz += (Math.cos(p.facing) * speed - p.vz) * k;
  let nx = p.x + p.vx * dt;
  let nz = p.z + p.vz * dt;
  const radius = ground.airRadius ?? FLY.airRadius;
  if (!p.air) {
    // On foot (the mount walking): the walking area's edge, as for the trainer.
    const limit = Math.max(ground.radius ?? radius, Math.hypot(p.x, p.z));
    const r0 = Math.hypot(nx, nz);
    if (r0 > limit) { nx *= limit / r0; nz *= limit / r0; }
    if (ground.solid?.(nx, nz)) { nx = p.x; nz = p.z; p.vx = 0; p.vz = 0; }
  }
  const r = Math.hypot(nx, nz);
  if (r > radius) { nx *= radius / r; nz *= radius / r; }
  p.x = nx;
  p.z = nz;
  const floor = floorAt(p.x, p.z);
  if (p.air) {
    p.y += p.vy * dt;
    p.y = Math.min(p.y, FLY.ceiling);
    if (p.y < floor + FLY.clearance) {
      // Down near the ground: slow and not climbing, it lands (not on the lake); otherwise it skims up.
      const water = ground.waterAt?.(p.x, p.z) != null;
      if (!water && Math.hypot(p.vx, p.vz) < 4.5 && !input.jumpHeld) {
        Object.assign(p, { air: false, y: ground.heightAt(p.x, p.z), vy: 0, throttle: 0, bank: 0 });
      } else {
        p.y = floor + FLY.clearance;
        p.vy = Math.max(p.vy, 0);
      }
    }
  } else {
    p.y = ground.heightAt(p.x, p.z);
  }
  p.moving = Math.hypot(p.vx, p.vz);
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
