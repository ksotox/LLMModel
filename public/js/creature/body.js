// How a Pokémon is built and how it gets about, from its real size and build (server/species.js:
// height and weight from the Pokédex, body shape, game types, Levitate). Pure (no three.js, no DOM):
// the Sanctuary, the Reef and the battles draw what these decide, and the tests run them in Node.
//
//   • movementMode(species): 'walk' (on two legs), 'quad' (four), 'slither', 'swim', 'fly', 'hover'
//     or 'hop' (round bodies that bounce along);
//   • bodyPlan(species): that, plus its size and natural speeds. Walking speed follows the size of the
//     legs as it does for real animals (the same "Froude number": a Pikachu scurries, an Onix lumbers);
//   • gaitRate(plan, speed): steps (or wing beats, or body waves) a second at that speed;
//   • creaturePose(plan, phase, …): the pose at that moment of the gait, as angles and offsets that
//     creature/animate.js applies to the model's bones (or to the whole model when it has none);
//   • displayHeight / sizedSpecies: the size it is drawn at. Real heights run from 10 cm (Joltik) to
//     100 m (Eternamax Eternatus), too wide a range for one screen, so sizes are compressed on a power
//     curve around a reference height: bigger always looks bigger, but a small one stays visible and a
//     giant still fits.

export const TRAINER_HEIGHT = 1.75; // the trainer, in metres: the Sanctuary's scale
const G = 9.81;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** How big things are drawn in the Sanctuary and the Reef (beside the 1.75 m trainer) and in battles. */
export const SANCTUARY_SIZES = { anchor: TRAINER_HEIGHT, power: 0.55, min: 0.3, max: 7 };
export const BATTLE_SIZES = { anchor: 1, power: 0.5, min: 0.3, max: 6 };

/**
 * The height (m) a Pokémon `realM` tall is drawn at: `anchor` stays as it is, the rest is pulled
 * towards it on a power curve (power 1 = true scale, 0.5 = by the square root), within [min, max].
 * Order is kept: taller in life is taller on screen (until the cap).
 */
export function displayHeight(realM, { anchor = TRAINER_HEIGHT, power = 0.55, min = 0.3, max = 7 } = {}) {
  if (!(realM > 0)) return anchor;
  return clamp(anchor * (realM / anchor) ** power, min, max);
}

/** The species at the size it is drawn at (`heightM`), keeping its real height as `realHeightM`. */
export function sizedSpecies(species, sizes = SANCTUARY_SIZES) {
  if (!species?.heightM) return species ?? null;
  return { ...species, realHeightM: species.heightM, heightM: displayHeight(species.heightM, sizes) };
}

/** How it moves, from its body shape, types and abilities. */
export function movementMode({ shape = '', types = [], levitates = false } = {}) {
  const t = new Set(types.map((x) => String(x).toLowerCase()));
  const flying = t.has('flying');
  const water = t.has('water');
  if (levitates) return 'hover';
  if (shape === 'fish') return 'swim';
  if (shape === 'squiggle') return water ? 'swim' : flying ? 'fly' : 'slither';
  if (shape === 'wings' || shape === 'bug-wings') return flying || shape === 'bug-wings' ? 'fly' : 'walk';
  if (shape === 'tentacles') return water ? 'swim' : 'hover';
  if (flying && (shape === 'upright' || shape === 'humanoid')) return 'fly'; // Charizard, Dragonite
  if ((t.has('ghost') || flying) && ['ball', 'blob', 'arms'].includes(shape)) return 'hover';
  if (shape === 'quadruped') return 'quad';
  if (shape === 'ball' || shape === 'blob' || shape === 'arms') return 'hop';
  return 'walk'; // upright, humanoid, legs, heads, armor, unknown
}

/**
 * Its body plan: { heightM, weightKg, mode, measure, long, walkSpeed, runSpeed, perches, hoverHeight,
 * cruise, radius }. `measure`: which side of the model the Pokédex size is ('height' for most;
 * 'length' for serpents and fish). `perches`: a flyer that lands to rest (all but the serpents).
 */
export function bodyPlan(species, { fallbackHeight = 0.8 } = {}) {
  const heightM = species?.heightM > 0 ? species.heightM : fallbackHeight;
  const weightKg = species?.weightKg > 0 ? species.weightKg : 30 * heightM ** 3;
  const mode = species ? movementMode(species) : 'walk';
  const long = species?.shape === 'squiggle' || species?.shape === 'fish';
  // Legs: about half the height of a biped, a little more of a four-legged one.
  const leg = heightM * (mode === 'quad' ? 0.55 : 0.45);
  let walkSpeed;
  let runSpeed;
  switch (mode) {
    case 'slither': walkSpeed = 0.12 * Math.sqrt(G * heightM); runSpeed = walkSpeed * 2.2; break;
    case 'swim': walkSpeed = 0.3 * Math.sqrt(G * heightM); runSpeed = walkSpeed * 2.5; break;
    case 'fly': walkSpeed = 0.6 * Math.sqrt(G * Math.max(heightM, 0.3)) + 0.8; runSpeed = walkSpeed * 2; break;
    case 'hover': walkSpeed = 0.3 * Math.sqrt(G * heightM) + 0.3; runSpeed = walkSpeed * 2; break;
    case 'hop': walkSpeed = 0.35 * Math.sqrt(G * heightM); runSpeed = walkSpeed * 2.4; break;
    default: walkSpeed = Math.sqrt(G * leg * 0.25); runSpeed = Math.sqrt(G * leg * 2.5); // Froude 0.25 and 2.5
  }
  return {
    heightM,
    weightKg,
    mode,
    measure: long ? 'length' : 'height',
    long,
    walkSpeed,
    runSpeed,
    perches: mode === 'fly' && species?.shape !== 'squiggle',
    hoverHeight: mode === 'hover' ? clamp(heightM * 0.35, 0.15, 3) : 0,
    cruise: mode === 'fly' ? clamp(1.6 + heightM * 1.2, 2, 30) : 0, // flying height above the ground
    // How far its body reaches from its centre, on the ground (for spacing, reach and hits).
    radius: heightM * (long ? 0.32 : mode === 'quad' ? 0.4 : mode === 'fly' ? 0.45 : 0.3),
  };
}

/**
 * Gait cycles a second at `speed` (m/s): steps for walkers, wing beats for flyers, body waves for
 * swimmers and snakes, bounces for hoppers. Small Pokémon step quickly, big ones slowly.
 */
export function gaitRate(plan, speed = 0) {
  const h = Math.max(0.1, plan.heightM);
  switch (plan.mode) {
    case 'fly': return clamp(2.2 / Math.sqrt(h), 0.5, 14) * (speed > 0.2 ? 1 : 0.75);
    case 'hover': return clamp(0.9 / Math.sqrt(h), 0.25, 2.5);
    case 'slither': case 'swim': return clamp(0.3 + speed / (h * 0.9), 0.25, 6);
    case 'hop': return speed > 0.1 ? clamp(speed / (h * 0.9), 0.6, 6) : 0;
    default: {
      const stride = h * (plan.mode === 'quad' ? 1.1 : 0.85); // a full cycle: two steps
      return speed > 0.05 ? clamp(speed / stride, 0.3, 8) : 0;
    }
  }
}

/**
 * The scale for a battle: real metres, unless the taller Pokémon is taller than the field allows;
 * then both shrink together, so they stay to scale with each other.
 */
export function battleScale(heights, { maxHeight = 2.4 } = {}) {
  const tallest = Math.max(...heights.filter((h) => h > 0), 0.1);
  return Math.min(1, maxHeight / tallest);
}

/**
 * The pose for this moment: `phase` (radians of the gait cycle), `move` (0 standing … 1 at full run),
 * `t` (seconds, for idle motion), `air` (off the ground). Angles in radians, forward or up positive;
 * `lift`, `squash` as shares of the height. Missing parts are 0:
 *   { lift, pitch, roll, squash, thighL, thighR, kneeL, kneeR, armL, armR, forearmL, forearmR, wing,
 *     wingAmp, wingFold, tail, wave, waveAmp, head }
 * `wave`/`waveAmp`: a body wave travelling down the spine and tail (snakes, fish, serpents).
 * `wing` is the beat now; `wingAmp` its size, so the animator can lag it down the wing (the tip
 * follows the shoulder); `wingFold` 0–1 tucks the wings in (a flyer resting on the ground).
 */
export function creaturePose(plan, phase, { move = 0, t = 0, air = false } = {}) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const breathe = Math.sin(t * 1.8) * 0.012;
  // Standing still, arms hang with the elbows a little bent and sway with the breathing.
  const sway = Math.sin(t * 1.1) * 0.07;
  const p = { lift: 0, pitch: 0, roll: 0, squash: breathe, thighL: 0, thighR: 0, kneeL: 0, kneeR: 0, armL: 0.04 + sway, armR: 0.04 - sway,
    forearmL: 0.25 + Math.max(0, sway) * 0.8, forearmR: 0.25 + Math.max(0, -sway) * 0.8, wing: 0, wingAmp: 0, wingFold: 0,
    tail: Math.sin(t * 1.3) * 0.12, wave: phase, waveAmp: 0, head: Math.sin(t * 0.45) * 0.15 };
  const m = clamp(move, 0, 1);
  switch (plan.mode) {
    case 'walk': {
      const a = 0.25 + m * 0.45;
      if (m > 0.02) Object.assign(p, {
        lift: Math.abs(c) * 0.03 * (0.5 + m), roll: s * 0.04, pitch: m * 0.12,
        thighL: s * a, thighR: -s * a, kneeL: Math.max(0, -c) * a * 1.3, kneeR: Math.max(0, c) * a * 1.3,
        armL: -s * a * 0.7, armR: s * a * 0.7, forearmL: 0.3 + Math.max(0, -s) * a * 0.9, forearmR: 0.3 + Math.max(0, s) * a * 0.9,
        tail: s * 0.25, head: 0,
      });
      break;
    }
    case 'quad': {
      // Front legs are its "arms": no hanging sway for them, they stand.
      Object.assign(p, { armL: 0, armR: 0, forearmL: 0, forearmR: 0 });
      const a = 0.3 + m * 0.4;
      if (m > 0.02) Object.assign(p, { // a trot: diagonal legs together
        lift: Math.abs(Math.sin(phase * 2)) * 0.02 * (0.5 + m), pitch: Math.sin(phase * 2) * 0.03,
        thighL: s * a, thighR: -s * a, armL: -s * a, armR: s * a,
        kneeL: Math.max(0, -c) * a, kneeR: Math.max(0, c) * a, tail: Math.sin(phase * 2) * 0.3, head: 0,
      });
      break;
    }
    case 'slither':
      Object.assign(p, { waveAmp: 0.12 + m * 0.3, tail: 0, head: 0, lift: 0 });
      break;
    case 'swim':
      Object.assign(p, { waveAmp: 0.1 + m * 0.25, lift: s * 0.03, armL: s * 0.3, armR: s * 0.3, forearmL: 0.2, forearmR: 0.2, tail: 0, roll: s * 0.04 });
      break;
    case 'fly':
      if (air) {
        const amp = 0.75 + m * 0.2;
        Object.assign(p, {
          wing: s * amp, wingAmp: amp, lift: -s * 0.04, pitch: m * 0.3, roll: Math.sin(t * 0.7) * 0.06,
          thighL: -0.5, thighR: -0.5, kneeL: 0.8, kneeR: 0.8, tail: Math.sin(phase * 0.5) * 0.15,
          // Arms (when they aren't the wings) held in, moving with the beat.
          armL: 0.45 + s * 0.12, armR: 0.45 + s * 0.12, forearmL: 0.7, forearmR: 0.7,
        });
      } else {
        // Perched: wings folded, with the odd small shuffle.
        Object.assign(p, { wingFold: 1, wing: Math.sin(t * 0.8) * 0.04, wingAmp: 0.04 });
      }
      break;
    case 'hover':
      Object.assign(p, { lift: s * 0.06, roll: Math.sin(t * 0.9) * 0.06, pitch: m * 0.15, armL: 0.25 + s * 0.15, armR: 0.25 + s * 0.15, forearmL: 0.4 + s * 0.1, forearmR: 0.4 + s * 0.1 });
      break;
    case 'hop':
      if (m > 0.02 || air) Object.assign(p, { lift: Math.abs(s) * 0.35, squash: Math.abs(s) < 0.25 ? -0.12 * (1 - Math.abs(s) * 4) : 0.06 * Math.abs(s), pitch: m * 0.1 });
      break;
    default:
  }
  if (air && plan.mode !== 'fly' && plan.mode !== 'hover') Object.assign(p, { thighL: 0.6, thighR: 0.4, kneeL: 0.9, kneeR: 0.7, armL: 0.5, armR: 0.5, forearmL: 0.6, forearmR: 0.6 });
  return p;
}

/**
 * Its body in a real-time battle at `scale` (battleScale()): { height, radius, speed, gravity, air }.
 * Light and flying Pokémon are quicker, heavy ones slower (within a fair range); flyers and
 * levitators fall slowly from a jump; `air` is how high a flyer or levitator floats (drawn only).
 */
export function battleBody(plan, scale = 1) {
  const height = plan.heightM * scale;
  const build = { fly: 1.12, hover: 1, quad: 1.08, slither: 0.9, swim: 0.92, hop: 0.96, walk: 1 }[plan.mode] ?? 1;
  const weight = 1.1 - 0.06 * Math.log2(Math.max(0.5, plan.weightKg) / 10);
  return {
    height,
    radius: clamp(plan.radius * scale, 0.22, 1.3),
    speed: clamp(build * weight, 0.8, 1.2),
    gravity: plan.mode === 'fly' ? 0.4 : plan.mode === 'hover' ? 0.55 : 1,
    // Floating: flyers, levitators, and swimmers (out of the water they swim through the air, as in the games).
    air: plan.mode === 'fly' ? clamp(0.25 + height * 0.25, 0.3, 0.9) : plan.mode === 'hover' ? clamp(plan.hoverHeight * scale, 0.1, 0.5) : plan.mode === 'swim' ? clamp(height * 0.06, 0.05, 0.25) : 0,
  };
}
