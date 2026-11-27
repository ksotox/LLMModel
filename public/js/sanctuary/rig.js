// Skeleton animation made in code, for models that have a skeleton but no animation clips (the
// owner's trainer models; Pokémon models without clips). Pure parts here (no three.js), tested:
//   • findRig(names): which bone is the hips, spine, head, thighs, knees, arms… by bone name
//     (game rigs "LThigh_6", Mixamo "mixamorig:LeftUpLeg", Blender "thigh.L" and the like);
//   • trainerState(player): idle, walk, run, jump, fall, glide or swim, from the movement state;
//   • gait(state, phase, speed): the angles for that moment, in the character's own frame
//     (forward is +, "out" raises an arm sideways). trainer.js turns them into bone rotations.

const norm = (name) => String(name).toLowerCase().replace(/^.*[:|]/, '').replace(/_\d+$/, '').replace(/[^a-z0-9]/g, '');

// For each part: name patterns, tried in order. {side} is filled with the side's spellings.
const PARTS = {
  hips: ['hips', 'pelvis', 'hip'],
  spine: ['spine', 'spine0', 'spine1', 'spine01'],
  chest: ['chest', 'spine2', 'spine3', 'upperchest', 'spine02', 'spine03'],
  neck: ['neck', 'neck1', 'neck01'],
  head: ['head'],
  thigh: ['{s}thigh', '{s}upleg', '{s}upperleg', 'thigh{s}', 'upperleg{s}'],
  knee: ['{s}leg', '{s}calf', '{s}knee', '{s}lowerleg', '{s}shin', 'calf{s}', 'shin{s}', 'lowerleg{s}'],
  foot: ['{s}foot', '{s}ankle', 'foot{s}'],
  shoulder: ['{s}shoulder', '{s}clavicle', 'shoulder{s}', 'clavicle{s}'],
  arm: ['{s}arm', '{s}arma', '{s}upperarm', 'upperarm{s}', 'arm{s}'],
  forearm: ['{s}forearm', '{s}lowerarm', '{s}elbow', 'forearm{s}', 'lowerarm{s}'],
};
const SIDES = { L: ['l', 'left'], R: ['r', 'right'] };

/**
 * Map rig parts to bone names: { hips, spine, chest, neck, head, thighL, thighR, kneeL, kneeR, footL,
 * footR, shoulderL, shoulderR, armL, armR, forearmL, forearmR } (each a name from `names`, or absent).
 */
export function findRig(names) {
  const byNorm = new Map();
  for (const n of names) if (!byNorm.has(norm(n))) byNorm.set(norm(n), n);
  const rig = {};
  for (const [part, patterns] of Object.entries(PARTS)) {
    const sided = patterns.some((p) => p.includes('{s}'));
    for (const side of sided ? ['L', 'R'] : ['']) {
      const key = sided ? part + side : part;
      for (const p of patterns) {
        const hit = (sided ? SIDES[side] : ['']).map((s) => byNorm.get(p.replace('{s}', s))).find(Boolean);
        if (hit) { rig[key] = hit; break; }
      }
    }
  }
  if (rig.chest === rig.spine) delete rig.chest;
  return rig;
}

/** Enough of a human rig to walk with? */
export const isHumanRig = (rig) => Boolean(rig.thighL && rig.thighR && rig.armL && rig.armR);

/**
 * The trainer's animation state from the Sanctuary's player (or the Reef's swimmer). `prev`: the state
 * last time. Walk and run have a margin between starting and stopping (hysteresis), so a sprint that
 * dips a little while turning doesn't flip the animation between run and walk every few frames.
 */
export function trainerState(p, prev = null) {
  if (!p) return 'idle';
  if (p.mode === 'mantle') return 'mantle';
  if (p.mode === 'swim') return 'swim';
  if (p.mode === 'glide') return 'glide';
  if (p.mode === 'lift') return 'sit';
  if (p.mode === 'paraglide') return 'paraglide';
  if (p.mode === 'ride') return 'ride';
  if (p.mode === 'fall') return p.vy > 0.5 ? 'jump' : 'fall';
  const speed = p.moving ?? 0;
  if (speed > 5.5 || (prev === 'run' && speed > 4.4)) return 'run';
  if (speed > 0.4 || ((prev === 'walk' || prev === 'run') && speed > 0.25)) return 'walk';
  return 'idle';
}

/**
 * The pose for `state` at `phase` (radians of the stride) and `speed` (0–1 of a full stride):
 * angles in radians, forward-positive: { lean, hipsBob, thighL, thighR, kneeL, kneeR, armL, armR,
 * forearmL, forearmR, armOutL, armOutR, head }. Missing parts are 0.
 */
export function gait(state, phase, speed = 1, t = 0, bank = 0) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const breathe = Math.sin(t * 1.7) * 0.03;
  const pose = { lean: 0, hipsBob: 0, thighL: 0, thighR: 0, kneeL: 0, kneeR: 0, armL: 0, armR: 0, forearmL: 0.15, forearmR: 0.15, armOutL: 0, armOutR: 0, head: 0 };
  switch (state) {
    case 'mantle':
      Object.assign(pose, { lean: 0.35, thighL: 0.95, thighR: 0.55, kneeL: 1.2, kneeR: 0.8,
        armL: 1.9, armR: 1.9, forearmL: 0.7, forearmR: 0.7 });
      break;
    case 'walk':
    case 'run': {
      const run = state === 'run';
      const a = (run ? 0.85 : 0.5) * Math.min(1, Math.max(0.3, speed));
      Object.assign(pose, {
        lean: run ? 0.2 : 0.06,
        hipsBob: Math.abs(c) * (run ? 0.06 : 0.03),
        thighL: s * a, thighR: -s * a,
        kneeL: Math.max(0, -c) * a * 1.4 + 0.05, kneeR: Math.max(0, c) * a * 1.4 + 0.05,
        armL: -s * a * 0.8, armR: s * a * 0.8,
        forearmL: run ? 1.2 : 0.35, forearmR: run ? 1.2 : 0.35,
      });
      break;
    }
    case 'jump':
      Object.assign(pose, { lean: 0.1, thighL: 0.7, thighR: 0.3, kneeL: 1.1, kneeR: 0.7, armOutL: 0.6, armOutR: 0.6, forearmL: 0.4, forearmR: 0.4 });
      break;
    case 'fall':
      Object.assign(pose, { thighL: 0.25, thighR: 0.1, kneeL: 0.4, kneeR: 0.3, armOutL: 1.1, armOutR: 1.1, forearmL: 0.3, forearmR: 0.3, head: -0.1 });
      break;
    case 'glide': // holding the glider's bar overhead, legs trailing
      Object.assign(pose, { lean: 0.15, thighL: -0.15, thighR: -0.1, kneeL: 0.3, kneeR: 0.2, armOutL: 2.6, armOutR: 2.6, forearmL: 0.2, forearmR: 0.2, head: -0.15 });
      break;
    case 'sit': // on the ski lift's chair: knees bent over the seat's edge, legs swinging a little
      Object.assign(pose, {
        lean: -0.05, thighL: 1.45, thighR: 1.45,
        kneeL: 1.35 + Math.sin(t * 1.3) * 0.12, kneeR: 1.35 + Math.sin(t * 1.3 + 1.1) * 0.12,
        armL: 0.45, armR: 0.45, forearmL: 0.9, forearmR: 0.9,
      });
      break;
    case 'paraglide': { // seated in the harness, hands up on the brakes: the inside one pulled down in a turn
      const pull = Math.max(-1, Math.min(1, bank));
      Object.assign(pose, {
        lean: -0.1, thighL: 1.2, thighR: 1.2, kneeL: 1.0, kneeR: 1.0,
        armOutL: 2.2 - Math.max(0, -pull) * 0.7, armOutR: 2.2 - Math.max(0, pull) * 0.7,
        armL: 0.3, armR: 0.3, forearmL: 0.5, forearmR: 0.5, head: 0.05,
      });
      break;
    }
    case 'ride': { // astride a flying Pokémon: knees gripping, leaning forward, into the turns
      const into = Math.max(-1, Math.min(1, bank));
      Object.assign(pose, {
        lean: 0.35 + Math.abs(into) * 0.1, thighL: 1.15, thighR: 1.15, kneeL: 1.5, kneeR: 1.5,
        armL: 0.95 - into * 0.15, armR: 0.95 + into * 0.15, armOutL: 0.25, armOutR: 0.25, forearmL: 0.7, forearmR: 0.7,
        head: -0.15,
      });
      break;
    }
    case 'swim': // breaststroke arms, a flutter kick
      Object.assign(pose, {
        thighL: Math.sin(phase * 2) * 0.35, thighR: -Math.sin(phase * 2) * 0.35,
        kneeL: 0.25 + Math.max(0, Math.sin(phase * 2)) * 0.4, kneeR: 0.25 + Math.max(0, -Math.sin(phase * 2)) * 0.4,
        armL: 1.4 + s * 0.6, armR: 1.4 + s * 0.6, armOutL: 0.6 + c * 0.5, armOutR: 0.6 + c * 0.5, forearmL: 0.3, forearmR: 0.3,
        head: -0.6,
      });
      break;
    default: // idle: breathing, a slight sway of the arms
      Object.assign(pose, { lean: breathe, armL: Math.sin(t * 0.9) * 0.04, armR: -Math.sin(t * 0.9) * 0.04, armOutL: 0.05, armOutR: 0.05 });
  }
  return pose;
}
