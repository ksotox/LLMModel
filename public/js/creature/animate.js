// Moves a Pokémon model the way its body plan says (creature/body.js), in code: most models in the
// Pokémon 3D API have a skeleton but no animations of their own. Bones are found by their names
// (the game rigs name them "LThigh", "RArm", "Tail3", "Spine2", "LFeeler1"…); each is turned about
// an axis of the model (sideways for a stride, front-to-back for a wing beat, upright for a tail wag),
// whatever way the bone itself happens to point. Models without a skeleton move as a whole: bobbing,
// rolling, hopping and leaning.

import * as THREE from 'three';
import { creaturePose, gaitRate } from './body.js';

// "LThigh_6", "mixamorig:LeftUpLeg", and "050 Head" / "050_Head" (a numbered rig; three.js turns the space into _).
const norm = (name) => String(name).replace(/[_.]\d+$/, '').replace(/^.*[:|]/, '').replace(/^\d+[ _]+/, '');
const sideOf = (name) => (/^L(?=[A-Z])|^Left|[._]L$|[._]l$/.test(name) ? 1 : /^R(?=[A-Z])|^Right|[._]R$|[._]r$/.test(name) ? -1 : 0);
const numberOf = (name) => Number(name.match(/(\d+)$/)?.[1] ?? 0);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * The model's bones, sorted into the parts creaturePose() moves. Pure on names (tested).
 * `wing` holds bones named as wings; with `flies`, the roots of the feeler chains ("LFeeler1",
 * "RFeelerA1") are kept as `feeler` candidates: a dragon's wings are feelers, while a bird's wings are
 * its arms. createAnimator() picks, for each side, whichever reaches further out (wingSide()).
 */
export function sortBones(names, { flies = false } = {}) {
  const parts = { thigh: [], knee: [], shoulder: [], arm: [], forearm: [], wing: [], feeler: [], tail: [], spine: [], head: [] };
  for (const raw of names) {
    const n = norm(raw);
    const side = sideOf(n);
    const bare = n.replace(/^(L|R)(?=[A-Z])|^(Left|Right)|[._][LRlr]$/g, '').toLowerCase();
    if (/wing/.test(bare) && side) parts.wing.push({ name: raw, side, order: numberOf(n) });
    else if (/^(thigh|upleg|upperleg)$/.test(bare) && side) parts.thigh.push({ name: raw, side });
    else if (/^(leg|calf|knee|lowerleg|shin)$/.test(bare) && side) parts.knee.push({ name: raw, side });
    else if (/^(shoulder|clavicle)$/.test(bare) && side) parts.shoulder.push({ name: raw, side });
    else if (/^(arm|arma|upperarm)$/.test(bare) && side) parts.arm.push({ name: raw, side });
    else if (/^(forearm|lowerarm)$/.test(bare) && side) parts.forearm.push({ name: raw, side });
    // In the game rigs a dragon's wings (and a fish's fins) are "feelers": the first of each chain.
    else if (flies && /^feeler(a)?0?1$/.test(bare) && side) parts.feeler.push({ name: raw, side });
    else if (/^tail\d*$/.test(bare)) parts.tail.push({ name: raw, order: numberOf(n) });
    else if (/^(spine\d*|waist|chest|neck\d*)$/.test(bare)) parts.spine.push({ name: raw, order: /neck/.test(bare) ? 10 + numberOf(n) : /waist/.test(bare) ? 0 : 1 + numberOf(n) });
    else if (bare === 'head') parts.head.push({ name: raw });
  }
  parts.tail.sort((a, b) => a.order - b.order);
  parts.spine.sort((a, b) => a.order - b.order);
  // A rig with several bones named "Wing" per side: keep the root of each.
  for (const s of [1, -1]) {
    const mine = parts.wing.filter((w) => w.side === s).sort((a, b) => a.order - b.order);
    for (const extra of mine.slice(1)) parts.wing.splice(parts.wing.indexOf(extra), 1);
  }
  return parts;
}

/**
 * Which chain is a flyer's wing on one side: one named as a wing; otherwise the arm chain or the feeler
 * chain, whichever reaches further out from the body (`armReach`, `feelerReach`: how far the chain's
 * bones go sideways). Returns 'wing', 'arm', 'feeler' or null. Pure (tested).
 */
export function wingSide({ named = false, armReach = 0, feelerReach = 0 } = {}) {
  if (named) return 'wing';
  if (!armReach && !feelerReach) return null;
  return feelerReach > armReach * 1.1 ? 'feeler' : 'arm';
}

/**
 * An animator for one loaded model (modelLoader.loadModel's result.object) with this body plan.
 * update(dt, { speed (m/s, real), air, posing }) each frame; `posing` false leaves the bones to a
 * playing animation clip and only moves the whole body. gesture() swings the arms forward for a
 * moment (an attack).
 */
export function createAnimator(object, plan) {
  const root = object.children[0] ?? object;
  const rest = { position: root.position.clone(), quaternion: root.quaternion.clone(), scale: root.scale.clone() };
  object.updateMatrixWorld(true);
  const bonesByName = new Map();
  root.traverse((o) => { if (o.isBone && !bonesByName.has(o.name)) bonesByName.set(o.name, o); });
  const flies = plan.mode === 'fly';
  const parts = sortBones([...bonesByName.keys()], { flies: flies || plan.mode === 'swim' });
  const objectQ = object.getWorldQuaternion(new THREE.Quaternion()).invert();
  const local = (bone) => object.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
  // For each bone: its rest rotation and its parent's rest orientation in the model's frame.
  const jointOf = (bone) => {
    const parentQ = bone.parent ? objectQ.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion();
    return { bone, rest: bone.quaternion.clone(), parentQ, parentInv: parentQ.clone().invert(), x: local(bone).x };
  };
  const joint = (name) => (bonesByName.get(name) ? jointOf(bonesByName.get(name)) : null);
  const pick = (list) => list.map((p) => ({ ...p, j: joint(p.name) })).filter((p) => p.j);
  // A chain: the bone and up to `depth` bones down its first line of children (shoulder → hand).
  const chainOf = (bone, depth = 3) => {
    const out = [bone];
    for (let b = bone; out.length <= depth;) {
      b = b.children.find((c) => c.isBone);
      if (!b) break;
      out.push(b);
    }
    return out;
  };
  // How far a chain reaches out sideways from its own root.
  const reach = (bone) => {
    let most = 0;
    const x0 = Math.abs(local(bone).x);
    bone.traverse((o) => { if (o.isBone) most = Math.max(most, Math.abs(local(o).x) - x0); });
    return most;
  };
  const thighs = pick(parts.thigh);
  const knees = pick(parts.knee);
  const forearms = pick(parts.forearm);
  const tail = pick(parts.tail);
  const spine = pick(parts.spine);
  const head = pick(parts.head)[0] ?? null;
  let arms = pick(parts.arm);
  // Wings, per side: a chain of joints, the root first.
  const wings = [];
  for (const side of [1, -1]) {
    const named = parts.wing.find((w) => w.side === side);
    const armRoot = bonesByName.get(parts.shoulder.find((b) => b.side === side)?.name) ?? bonesByName.get(parts.arm.find((b) => b.side === side)?.name);
    const feelerRoot = bonesByName.get(parts.feeler.find((b) => b.side === side)?.name);
    const choice = flies || plan.mode === 'swim'
      ? wingSide({ named: Boolean(named), armReach: flies && armRoot ? reach(armRoot) : 0, feelerReach: feelerRoot ? reach(feelerRoot) : 0 })
      : named ? 'wing' : null;
    const rootBone = choice === 'wing' ? bonesByName.get(named.name) : choice === 'arm' ? armRoot : choice === 'feeler' ? feelerRoot : null;
    if (!rootBone) continue;
    wings.push({ side, chain: chainOf(rootBone).map(jointOf) });
    // A bird's arms are its wings: they don't also swing as arms.
    if (choice === 'arm') arms = arms.filter((a) => a.side !== side);
  }
  const hasBones = thighs.length + arms.length + wings.length + tail.length + spine.length > 0;
  const all = [...thighs, ...knees, ...arms, ...forearms, ...tail, ...spine, ...(head ? [head] : [])].map((p) => p.j)
    .concat(wings.flatMap((w) => w.chain));
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion();

  // Turn a bone by `angle` about `axis` of the model (not of the bone), on top of its rest pose.
  const rotate = (j, axis, angle) => {
    if (!angle) return;
    turn.setFromAxisAngle(axis, angle);
    q.copy(j.parentInv).multiply(turn).multiply(j.parentQ); // the model's axis, seen from the parent
    j.bone.quaternion.premultiply(q);
  };
  const reset = () => { for (const j of all) j.bone.quaternion.copy(j.rest); };

  let phase = Math.random() * Math.PI * 2;
  let t = Math.random() * 10;
  let gestureT = 0; // seconds left of an attack gesture
  return {
    plan,
    hasBones,
    wings: wings.length,
    gesture(seconds = 0.55) { gestureT = seconds; },
    update(dt, { speed = 0, air = false, posing = true, effort = null } = {}) {
      t += dt;
      gestureT = Math.max(0, gestureT - dt);
      // (A ridden flyer's effort quickens or slows its wing beat as well as widening it.)
      const beat = effort == null ? 1 : 0.45 + Math.max(0, Math.min(1.5, effort)) * 0.55;
      phase = (phase + dt * gaitRate(plan, speed) * beat * Math.PI * 2) % (Math.PI * 200);
      const move = Math.min(1, speed / Math.max(0.1, plan.runSpeed));
      const p = creaturePose(plan, phase, { move, t, air, effort });
      if (gestureT > 0) {
        // An attack: both arms thrown forward and back again.
        const k = Math.sin((1 - gestureT / 0.55) * Math.PI);
        p.armL = p.armR = Math.max(p.armL, 1.3 * k);
        p.forearmL = p.forearmR = 0.2 + 0.5 * k;
      }
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
      for (const { side, j } of forearms) if (arms.some((a) => a.side === side)) rotate(j, X, -(side > 0 ? p.forearmL : p.forearmR));
      // Wings beat up and down about the front-to-back axis: a wing on the model's left (+X, as it faces
      // +Z) rises with a positive turn. Down the wing the beat comes a little later and smaller, so the
      // tip follows through. Folded, the wing sweeps back and down along the body.
      for (const { side, chain } of wings) {
        const dir = Math.abs(chain[0].x) > 1e-4 ? Math.sign(chain[0].x) : side;
        chain.forEach((j, k) => {
          const lagged = p.wingAmp ? Math.sin(phase - k * 0.45) * p.wingAmp : p.wing;
          rotate(j, Z, dir * lagged * (k === 0 ? 1 : 0.35));
          if (k === 0 && p.wingFold) {
            // Down to the side, then swept back along the body (a left wing, along +X, turns towards −Z).
            rotate(j, Z, -dir * 0.6 * p.wingFold);
            rotate(j, Y, dir * 1.0 * p.wingFold);
          }
        });
      }
      // A body wave runs down the spine and tail; a tail also wags on its own.
      spine.forEach(({ j }, i) => rotate(j, Y, p.waveAmp ? Math.sin(p.wave - i * 0.7) * p.waveAmp * 0.6 : 0));
      tail.forEach(({ j }, i) => rotate(j, Y, (p.waveAmp ? Math.sin(p.wave - (spine.length + i) * 0.7) * p.waveAmp : 0) + p.tail * (0.4 + i * 0.12)));
      if (head) rotate(head.j, Y, p.head);
    },
    dispose() { reset(); root.position.copy(rest.position); root.quaternion.copy(rest.quaternion); root.scale.copy(rest.scale); },
  };
}
