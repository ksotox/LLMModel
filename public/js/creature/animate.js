// Moves a Pokémon model the way its body plan says (creature/body.js), in code: most models in the
// Pokémon 3D API have a skeleton but no animations of their own. Bones are found by their names
// (the game rigs name them "LThigh", "RArm", "Tail3", "Spine2", "LFeeler1"…); each is turned about
// an axis of the model (sideways for a stride, front-to-back for a wing beat, upright for a tail wag),
// whatever way the bone itself happens to point. Models without a skeleton move as a whole: bobbing,
// rolling, hopping and leaning.

import * as THREE from 'three';
import { creaturePose, gaitRate } from './body.js';

const norm = (name) => String(name).replace(/[_.]\d+$/, '').replace(/^.*[:|]/, '');
const sideOf = (name) => (/^L(?=[A-Z])|^Left|[._]L$|[._]l$/.test(name) ? 1 : /^R(?=[A-Z])|^Right|[._]R$|[._]r$/.test(name) ? -1 : 0);
const numberOf = (name) => Number(name.match(/(\d+)$/)?.[1] ?? 0);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** The model's bones, sorted into the parts creaturePose() moves. Pure on names (tested). */
export function sortBones(names, { flies = false } = {}) {
  const parts = { thigh: [], knee: [], arm: [], forearm: [], wing: [], tail: [], spine: [], head: [] };
  for (const raw of names) {
    const n = norm(raw);
    const side = sideOf(n);
    const bare = n.replace(/^(L|R)(?=[A-Z])|^(Left|Right)|[._][LRlr]$/g, '').toLowerCase();
    if (/wing/.test(bare) && side) parts.wing.push({ name: raw, side, order: numberOf(n) });
    else if (/^(thigh|upleg|upperleg)$/.test(bare) && side) parts.thigh.push({ name: raw, side });
    else if (/^(leg|calf|knee|lowerleg|shin)$/.test(bare) && side) parts.knee.push({ name: raw, side });
    else if (/^(arm|arma|upperarm)$/.test(bare) && side) parts.arm.push({ name: raw, side });
    else if (/^(forearm|lowerarm)$/.test(bare) && side) parts.forearm.push({ name: raw, side });
    // In the game rigs a flyer's wings (and a fish's fins) are "feelers": the first of each chain.
    else if (flies && /^feeler(a)?1$/.test(bare) && side) parts.wing.push({ name: raw, side, order: 1 });
    else if (/^tail\d*$/.test(bare)) parts.tail.push({ name: raw, order: numberOf(n) });
    else if (/^(spine\d*|waist|chest|neck\d*)$/.test(bare)) parts.spine.push({ name: raw, order: /neck/.test(bare) ? 10 + numberOf(n) : /waist/.test(bare) ? 0 : 1 + numberOf(n) });
    else if (bare === 'head') parts.head.push({ name: raw });
  }
  parts.tail.sort((a, b) => a.order - b.order);
  parts.spine.sort((a, b) => a.order - b.order);
  // A rig with only some wing bones named "Wing" may list several per side: keep the root of each.
  for (const s of [1, -1]) {
    const mine = parts.wing.filter((w) => w.side === s).sort((a, b) => a.order - b.order);
    for (const extra of mine.slice(1)) parts.wing.splice(parts.wing.indexOf(extra), 1);
  }
  return parts;
}

/**
 * An animator for one loaded model (modelLoader.loadModel's result.object) with this body plan.
 * update(dt, { speed (m/s, real), air, posing }) each frame; `posing` false leaves the bones to a
 * playing animation clip and only moves the whole body.
 */
export function createAnimator(object, plan) {
  const root = object.children[0] ?? object;
  const rest = { position: root.position.clone(), quaternion: root.quaternion.clone(), scale: root.scale.clone() };
  object.updateMatrixWorld(true);
  const bonesByName = new Map();
  root.traverse((o) => { if (o.isBone && !bonesByName.has(o.name)) bonesByName.set(o.name, o); });
  const parts = sortBones([...bonesByName.keys()], { flies: plan.mode === 'fly' || plan.mode === 'swim' });
  const objectQ = object.getWorldQuaternion(new THREE.Quaternion()).invert();
  // For each bone: its rest rotation and its parent's rest orientation in the model's frame.
  const joint = (name) => {
    const bone = bonesByName.get(name);
    if (!bone) return null;
    const parentQ = bone.parent ? objectQ.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion();
    const position = bone.getWorldPosition(new THREE.Vector3());
    object.worldToLocal(position);
    return { bone, rest: bone.quaternion.clone(), parentQ, parentInv: parentQ.clone().invert(), x: position.x };
  };
  const pick = (list) => list.map((p) => ({ ...p, j: joint(p.name) })).filter((p) => p.j);
  const thighs = pick(parts.thigh);
  const knees = pick(parts.knee);
  const arms = pick(parts.arm);
  const wings = pick(parts.wing);
  const tail = pick(parts.tail);
  const spine = pick(parts.spine);
  const head = pick(parts.head)[0] ?? null;
  const hasBones = thighs.length + arms.length + wings.length + tail.length + spine.length > 0;
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();

  // Turn a bone by `angle` about `axis` of the model (not of the bone), on top of its rest pose.
  const rotate = (j, axis, angle) => {
    if (!angle) return;
    turn.setFromAxisAngle(axis, angle);
    q.copy(j.parentInv).multiply(turn).multiply(j.parentQ); // the model's axis, seen from the parent
    j.bone.quaternion.premultiply(q);
  };
  const reset = () => {
    for (const list of [thighs, knees, arms, wings, tail, spine]) for (const p of list) p.j.bone.quaternion.copy(p.j.rest);
    if (head) head.j.bone.quaternion.copy(head.j.rest);
  };

  let phase = Math.random() * Math.PI * 2;
  let t = Math.random() * 10;
  return {
    plan,
    hasBones,
    update(dt, { speed = 0, air = false, posing = true } = {}) {
      t += dt;
      phase = (phase + dt * gaitRate(plan, speed) * Math.PI * 2) % (Math.PI * 200);
      const move = Math.min(1, speed / Math.max(0.1, plan.runSpeed));
      const p = creaturePose(plan, phase, { move, t, air });
      // The whole body: lift, lean, roll and squash (scaled to the model's own height).
      const h = object.userData.height ?? 1;
      root.position.copy(rest.position);
      root.position.y += p.lift * h;
      root.quaternion.copy(rest.quaternion);
      root.quaternion.premultiply(turn.setFromAxisAngle(X, p.pitch));
      root.quaternion.premultiply(turn.setFromAxisAngle(Z, p.roll));
      // A model with no bones to bend snakes and swims with its whole body instead.
      if (!hasBones && p.waveAmp) root.quaternion.premultiply(turn.setFromAxisAngle(Y, Math.sin(p.wave) * p.waveAmp * 0.5));
      if (!hasBones && p.wing) root.quaternion.premultiply(turn.setFromAxisAngle(Z, p.wing * 0.08));
      root.scale.copy(rest.scale).multiply(new THREE.Vector3(1 - p.squash * 0.5, 1 + p.squash, 1 - p.squash * 0.5));
      if (!posing || !hasBones) return;
      reset();
      // Legs and arms swing forwards and back (about the model's sideways axis; forward is −X turn).
      for (const { side, j } of thighs) rotate(j, X, -(side > 0 ? p.thighL : p.thighR));
      for (const { side, j } of knees) rotate(j, X, side > 0 ? p.kneeL : p.kneeR);
      for (const { side, j } of arms) rotate(j, X, -(side > 0 ? p.armL : p.armR));
      // Wings beat up and down (about the front-to-back axis, mirrored for each side).
      // A wing on the model's left (+X, as it faces +Z) rises with a positive turn, one on the right negative.
      for (const { side, j } of wings) rotate(j, Z, (Math.abs(j.x) > 1e-4 ? Math.sign(j.x) : side || 1) * p.wing);
      // A body wave runs down the spine and tail; a tail also wags on its own.
      spine.forEach(({ j }, i) => rotate(j, Y, p.waveAmp ? Math.sin(p.wave - i * 0.7) * p.waveAmp * 0.6 : 0));
      tail.forEach(({ j }, i) => rotate(j, Y, (p.waveAmp ? Math.sin(p.wave - (spine.length + i) * 0.7) * p.waveAmp : 0) + p.tail * (0.4 + i * 0.12)));
      if (head) rotate(head.j, Y, p.head);
    },
    dispose() { reset(); root.position.copy(rest.position); root.quaternion.copy(rest.quaternion); root.scale.copy(rest.scale); },
  };
}
