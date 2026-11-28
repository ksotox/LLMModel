// Arms that move on a Pokémon animated by its own clips. Many models' idle and walk clips leave the arms
// still (the clip moves the legs, body and head, but the arms hang stiff). For such models, a little
// motion is laid over the clip each frame: a sway with the breathing when standing, a swing with the
// stride when walking. Arms the clips do move are left to the clips.

import * as THREE from 'three';
import { gaitRate } from './body.js';
import { sortBones } from './animate.js';

/** How far a quaternion track turns (radians): the largest angle from its first key to any other. Pure. */
export function trackTurn(values) {
  if (!values || values.length < 8) return 0;
  const [x0, y0, z0, w0] = values;
  let most = 0;
  for (let i = 4; i + 3 < values.length; i += 4) {
    const dot = Math.min(1, Math.abs(x0 * values[i] + y0 * values[i + 1] + z0 * values[i + 2] + w0 * values[i + 3]));
    most = Math.max(most, 2 * Math.acos(dot));
  }
  return most;
}

/**
 * The arm bones (names) the clips leave still: no rotation track in any clip, or one turning less than
 * `still` radians. `clips`: [{ tracks: [{ name: 'Bone.quaternion', values }] }]. Pure.
 */
export function stillArms(armNames, clips = [], still = 0.12) {
  const moved = new Set();
  for (const clip of clips) {
    for (const track of clip.tracks ?? []) {
      const [bone, property] = String(track.name).split(/\.(?=[^.]+$)/);
      if (property === 'quaternion' && trackTurn(track.values) >= still) moved.add(bone);
    }
  }
  return armNames.filter((name) => !moved.has(name));
}

/**
 * The swing for this moment (radians, forward positive): { L, R, foreL, foreR }. Standing: a slow sway,
 * not mirrored (the two arms drift a little apart). Moving (`move` 0…1): a swing against the stride. Pure.
 */
export function armSwing(phase, t, move = 0) {
  const m = Math.min(1, Math.max(0, move));
  const sway = 0.1 * (1 - m);
  const swing = 0.45 * m;
  const L = Math.sin(t * 1.3) * sway + 0.06 - Math.sin(phase) * swing;
  const R = Math.sin(t * 1.3 + 2.2) * sway + 0.06 + Math.sin(phase) * swing;
  return { L, R, foreL: 0.12 + Math.max(0, L) * 0.5, foreR: 0.12 + Math.max(0, R) * 0.5 };
}

/**
 * For a model moved by `clips` (its THREE.AnimationClips) with body plan `plan`: the arm overlay, or null
 * when it has no arms or the clips already move them. update(dt, { speed }) after the mixer each frame.
 */
export function createArmSwing(object, plan, clips = []) {
  if (!plan || plan.mode === 'fly' || plan.mode === 'quad' || plan.mode === 'slither') return null; // wings / legs / none
  const root = object.children[0] ?? object;
  const bones = new Map();
  root.traverse((o) => { if (o.isBone && !bones.has(o.name)) bones.set(o.name, o); });
  const parts = sortBones([...bones.keys()]);
  const stiff = new Set(stillArms([...parts.arm, ...parts.forearm].map((p) => p.name), clips));
  const arms = parts.arm.filter((p) => stiff.has(p.name));
  if (!arms.length) return null;
  const forearms = parts.forearm.filter((p) => stiff.has(p.name) && arms.some((a) => a.side === p.side));
  // Each bone turns about the model's sideways axis, seen from its parent at rest (as animate.js does).
  object.updateMatrixWorld(true);
  const objectQ = object.getWorldQuaternion(new THREE.Quaternion()).invert();
  const joint = ({ name, side }) => {
    const bone = bones.get(name);
    const parentQ = objectQ.clone().multiply(bone.parent.getWorldQuaternion(new THREE.Quaternion()));
    return { bone, side, base: bone.quaternion.clone(), written: null, parentQ, parentInv: parentQ.clone().invert() };
  };
  const joints = [...arms.map((a) => ({ ...joint(a), fore: false })), ...forearms.map((f) => ({ ...joint(f), fore: true }))];
  const X = new THREE.Vector3(1, 0, 0);
  const turn = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  let phase = Math.random() * Math.PI * 2;
  let t = Math.random() * 10;
  return {
    update(dt, { speed = 0 } = {}) {
      t += dt;
      phase = (phase + dt * gaitRate(plan, speed) * Math.PI * 2) % (Math.PI * 200);
      const s = armSwing(phase, t, speed / Math.max(0.1, plan.runSpeed ?? 3));
      for (const j of joints) {
        // A bone the playing clip didn't set this frame still holds our last turn: start again from under it
        // (so the turn never adds up frame after frame).
        if (j.written && j.bone.quaternion.equals(j.written)) j.bone.quaternion.copy(j.base);
        j.base.copy(j.bone.quaternion);
        const left = j.side > 0;
        const angle = j.fore ? (left ? s.foreL : s.foreR) : (left ? s.L : s.R);
        turn.setFromAxisAngle(X, -angle);
        q.copy(j.parentInv).multiply(turn).multiply(j.parentQ);
        j.bone.quaternion.premultiply(q);
        (j.written ??= new THREE.Quaternion()).copy(j.bone.quaternion);
      }
    },
  };
}
