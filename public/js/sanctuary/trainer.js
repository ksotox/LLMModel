// The Sanctuary's trainer: an original little low-poly figure (no game character), in the colours
// of the chosen preset, with a glider for long falls; or a trainer model (Ash, Iris and May come with
// the app; you can add your own). Shared by the meadow, the Reef and the battles.

import { autoRig } from '../creature/autoRig.js';
import { findRig, gait, isHumanRig } from './rig.js';
import { MOVE } from './player.js';

/** States posed in code even on a model with its own clips (seated, or in freefall: no clip has them). */
const SEATED = new Set(['sit', 'paraglide', 'ride', 'skydive']);

/**
 * Build it with `THREE`. Returns { avatar, legs, arms, glider, dress(preset), load(url, opts), play(state,
 * speed, dt, t, bank, reach), hold(reach), hasModel, rigged }: `load` swaps in a model of the owner's own,
 * `play` animates it, `hold` points the figure's arms at { L, R } (points in the world).
 */
export function buildTrainer(THREE) {
  const avatar = new THREE.Group();
  const mats = {
    hat: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    shirt: new THREE.MeshStandardMaterial({ roughness: 0.85 }),
    skin: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.9 }),
    pack: new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 }),
    glider: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7, side: THREE.DoubleSide }),
  };
  const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; avatar.add(m); return m; };
  const legs = [part(new THREE.CapsuleGeometry(0.11, 0.42, 4, 8), mats.dark, -0.13, 0.36, 0), part(new THREE.CapsuleGeometry(0.11, 0.42, 4, 8), mats.dark, 0.13, 0.36, 0)];
  part(new THREE.CapsuleGeometry(0.26, 0.42, 4, 10), mats.shirt, 0, 1.02, 0);
  // Arms hinge at the shoulder (a turn of the group swings the arm, not a capsule about its middle).
  const arms = [-0.36, 0.36].map((x) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.3, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), mats.shirt);
    arm.position.y = -0.25;
    arm.castShadow = true;
    shoulder.add(arm);
    avatar.add(shoulder);
    return shoulder;
  });
  part(new THREE.SphereGeometry(0.22, 16, 12), mats.skin, 0, 1.58, 0);
  part(new THREE.CylinderGeometry(0.235, 0.235, 0.14, 16), mats.hat, 0, 1.74, 0);
  part(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 12), mats.hat, 0, 1.68, 0.24).scale.set(1.2, 1, 1);
  part(new THREE.BoxGeometry(0.36, 0.44, 0.18), mats.pack, 0, 1.05, -0.3);
  const gliderGeo = new THREE.BufferGeometry();
  gliderGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1.5, 0, -0.5, 1.5, 0, -0.5, 0, 0.15, 0.9], 3));
  gliderGeo.computeVertexNormals();
  const glider = new THREE.Mesh(gliderGeo, mats.glider);
  glider.position.y = 2.25;
  glider.castShadow = true;
  glider.visible = false;
  avatar.add(glider);
  // The figure's hands on something (a point in the world): each arm turned to point at it.
  const down = new THREE.Vector3(0, -1, 0);
  const toward = new THREE.Vector3();
  const hold = (reach) => {
    avatar.updateMatrixWorld(true);
    for (const [i, side] of [[0, 'R'], [1, 'L']]) {
      if (!reach?.[side]) continue;
      toward.copy(reach[side]);
      avatar.worldToLocal(toward).sub(arms[i].position).normalize();
      arms[i].rotation.set(0, 0, 0);
      arms[i].quaternion.setFromUnitVectors(down, toward);
    }
  };
  const dress = (t) => { mats.hat.color.setHex(t.hat); mats.shirt.color.setHex(t.shirt); mats.skin.color.setHex(t.skin); };
  const figure = avatar.children.filter((c) => c !== glider); // the built-in figure (the fallback)

  // ---- a model of the owner's own (uploaded in the trainer picker; server/trainers.js) ----
  let model = null; // { object, mixer, actions, driver }
  let phase = 0;
  let stride = 2.2; // the stride's rate, eased (no jump in the legs' rhythm when walk turns to run)
  let playing = null;
  const unload = () => {
    if (!model) return;
    avatar.remove(model.object);
    model.mixer?.stopAllAction();
    model = null;
    for (const c of figure) c.visible = true;
  };
  /** Swap the built-in figure for a .glb at `url` (null: back to the figure). Resolves to the model's info. */
  const load = async (url, { loader, loadModel, pickClips, realistic = false, prepare = null } = {}) => {
    unload();
    if (!url) return null;
    const loaded = await loadModel(loader, url, 1.75, { realistic });
    if (!loaded) return null;
    const object = loaded.object;
    // A model exported without a skeleton (like the Ash that comes with the app) gets one, so it walks.
    if (!loaded.clips?.length) autoRig(object, 'walk');
    const all = loaded.clips ?? [];
    const clips = pickClips(all);
    const extraClips = {
      run: /sprint|run/i, jump: /jump|take.?off/i, fall: /fall|airborne/i,
      mantle: /mantle|climb|vault/i, glide: /glide/i, swim: /swim/i,
    };
    for (const [state, pattern] of Object.entries(extraClips)) {
      const clip = all.find((c) => pattern.test(c.name) && !/idle/i.test(c.name));
      if (clip && clip === clips.idle) clips.idle = null;
      clips[state] = clip;
    }
    const next = { object, mixer: null, actions: {}, driver: null, rigged: false };
    if (Object.entries(clips).some(([key, clip]) => key !== 'extra' && clip)) {
      next.mixer = new THREE.AnimationMixer(object.children[0]);
      for (const [k, clip] of Object.entries(clips)) if (k !== 'extra' && clip) next.actions[k] = next.mixer.clipAction(clip);
      // Seated poses (the ski lift, the paraglider, a flying Pokémon) aren't among a model's clips: those
      // are posed in code on its skeleton instead.
      next.poser = rigDriver(THREE, object);
    } else {
      next.driver = rigDriver(THREE, object);
    }
    next.rigged = Boolean(next.mixer || next.driver);
    await prepare?.(object); // ready to draw before it appears (modelLoader.js warmUp)
    for (const c of figure) c.visible = false;
    avatar.add(object);
    model = next;
    return { rigged: next.rigged };
  };
  /**
   * Animate the movement state selected by rig.js trainerState.
   * `speed`: metres a second; `dt`: seconds; `t`: the clock. `reach`: { L, R } points in the world for
   * the hands to hold (the paraglider's brake handles, a ridden Pokémon's back), or null. Returns false
   * when there's no model.
   */
  const play = (state, speed, dt, t, bank = 0, reach = null) => {
    if (!model) return false;
    const seated = SEATED.has(state);
    const rate = state === 'run' ? 9 : state === 'swim' ? 3 : 2.2 + speed * 1.2;
    stride += (rate - stride) * (1 - Math.exp(-dt * 6));
    phase += dt * stride;
    if (model.mixer && seated && model.poser) {
      if (playing) { model.mixer.stopAllAction(); playing = null; }
      model.poser.pose(gait(state, phase, 0, t, bank), reach);
    } else if (model.mixer) {
      const moving = ['walk', 'run', 'swim'].includes(state);
      const named = model.actions[state];
      const want = named ?? (moving ? model.actions.walk : model.actions.idle) ?? model.actions.idle ?? model.actions.walk;
      if ((want ?? null) !== playing) {
        playing?.fadeOut(0.15);
        if (want) {
          const oneShot = named === want && (state === 'jump' || state === 'mantle');
          want.reset().setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
          want.clampWhenFinished = oneShot;
          want.fadeIn(state === 'mantle' ? 0.08 : 0.15).play();
        }
        playing = want ?? null;
      }
      if (want && (want === model.actions.walk || want === model.actions.run)) want.setEffectiveTimeScale(Math.max(0.6, Math.min(2.2, speed / 2.5)));
      if (want && state === 'mantle' && want === named) want.setEffectiveTimeScale(want.getClip().duration / MOVE.mantleTime);
      model.mixer.update(dt);
    } else if (model.driver) {
      const g = gait(state, phase, Math.min(1, speed / 4), t, bank);
      model.driver.pose(g, seated ? reach : null);
      model.object.position.y = g.hipsBob;
    } else {
      // No skeleton: the whole model bobs and leans as it goes.
      const moving = ['walk', 'run'].includes(state);
      model.object.position.y = moving ? Math.abs(Math.sin(phase)) * 0.06 : Math.sin(t * 1.7) * 0.01;
      model.object.rotation.z = moving ? Math.sin(phase) * 0.05 : 0;
    }
    return true;
  };
  return { avatar, legs, arms, glider, dress, load, play, hold, get hasModel() { return Boolean(model); }, get rigged() { return Boolean(model?.rigged); } };
}

/**
 * Pose a skinned model's skeleton from rig.js angles. Each angle is a turn about the character's own
 * side (X) or forward (Z) axis, carried into the bone's local frame through its parent's current
 * world rotation, so it works whatever axes the rig's bones use. Arms in a T- or A-pose are first
 * brought down to the sides. pose(angles, reach) then bends each arm so its hand holds `reach.L` /
 * `reach.R` (points in the world), when given: two-bone IK (reachArm). Returns { pose(angles, reach) } or
 * null for a model with no usable skeleton.
 */
export function rigDriver(THREE, root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  if (!bones.length) return null;
  const byName = new Map(bones.map((b) => [b.name, b]));
  const names = findRig(bones.map((b) => b.name));
  if (!isHumanRig(names)) return null;
  const part = (k) => (names[k] ? byName.get(names[k]) : null);
  const rest = new Map(bones.map((b) => [b, b.quaternion.clone()]));
  const rootQ = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  const tmp = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const order = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'armL', 'armR', 'forearmL', 'forearmR', 'handL', 'handR', 'thighL', 'thighR', 'kneeL', 'kneeR'];
  const driven = order.map(part).filter(Boolean);

  /** Turn `bone` by `q` given in the model's frame. */
  const apply = (bone, q) => {
    root.getWorldQuaternion(rootQ);
    bone.parent.getWorldQuaternion(parentQ);
    parentQ.premultiply(tmp.copy(rootQ).invert()); // the parent in the model's frame
    // local' = P⁻¹ · q · P · local
    bone.quaternion.premultiply(tmp.copy(parentQ).invert().multiply(q).multiply(parentQ));
    bone.updateMatrixWorld(true);
  };
  const about = (axis, angle) => turn.setFromAxisAngle(axis, angle);

  // Arms down: the turn that points each upper arm from its bind direction to down by the side.
  const armDown = {};
  root.updateMatrixWorld(true);
  const inModel = (v) => root.worldToLocal(v);
  for (const side of ['L', 'R']) {
    const arm = part(`arm${side}`);
    const fore = part(`forearm${side}`);
    if (!arm || !fore) continue;
    const a = inModel(arm.getWorldPosition(new THREE.Vector3()));
    const f = inModel(fore.getWorldPosition(new THREE.Vector3()));
    const dir = f.sub(a).normalize();
    const out = Math.sign(dir.x) || (side === 'L' ? 1 : -1); // which way this arm points out
    armDown[side] = { q: new THREE.Quaternion().setFromUnitVectors(dir, new THREE.Vector3(0.22 * out, -1, 0).normalize()), out };
  }
  // Where each hand is, in its forearm's own frame (so it turns with the forearm): the hand (wrist) bone
  // when the rig has one, else as far past the elbow as the upper arm is long (autoRig's arms).
  const handLocal = {};
  for (const side of ['L', 'R']) {
    const arm = part(`arm${side}`);
    const fore = part(`forearm${side}`);
    if (!arm || !fore) continue;
    const hand = part(`hand${side}`) ?? fore.children.find((c) => c.isBone);
    const e = fore.getWorldPosition(new THREE.Vector3());
    const at = hand ? hand.getWorldPosition(new THREE.Vector3()) : e.clone().multiplyScalar(2).sub(arm.getWorldPosition(new THREE.Vector3()));
    handLocal[side] = fore.worldToLocal(at);
  }

  // ---- hands that hold things: two-bone IK on the upper arm and forearm, in the world's frame ----
  const S = new THREE.Vector3();
  const E = new THREE.Vector3();
  const H = new THREE.Vector3();
  const T = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  const n = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const pq = new THREE.Quaternion();
  const dq = new THREE.Quaternion();
  /** Turn `bone` by `q` given in the world (about the bone's own origin). */
  const turnWorld = (bone, q) => {
    bone.getWorldQuaternion(wq);
    bone.parent.getWorldQuaternion(pq);
    bone.quaternion.copy(pq.invert().multiply(q).multiply(wq));
    bone.updateMatrixWorld(true);
  };
  /** Where the hand is now, in the world. */
  const handAt = (side, out) => part(`forearm${side}`).localToWorld(out.copy(handLocal[side]));
  const reachArm = (side, target) => {
    const arm = part(`arm${side}`);
    const fore = part(`forearm${side}`);
    if (!arm || !fore || !target || !handLocal[side]) return;
    arm.getWorldPosition(S);
    fore.getWorldPosition(E);
    handAt(side, H);
    T.copy(target);
    const a = S.distanceTo(E);
    const b = E.distanceTo(H);
    if (a < 1e-4 || b < 1e-4) return;
    const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, S.distanceTo(T)));
    // 1. The elbow: bent until shoulder-to-hand is the distance to the target (the law of cosines).
    u.subVectors(E, S);
    w.subVectors(H, E);
    n.crossVectors(u, w);
    if (n.lengthSq() < 1e-10) {
      // A straight arm: bend it in the plane that puts the elbow down and out (the pole).
      root.getWorldQuaternion(wq);
      pole.set(side === 'L' ? 0.4 : -0.4, -1, -0.3).applyQuaternion(wq);
      n.crossVectors(u, pole);
    }
    n.normalize();
    const now = u.clone().negate().angleTo(w); // the angle inside the elbow
    const want = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
    turnWorld(fore, dq.setFromAxisAngle(n, now - want));
    // 2. The whole arm swung from the shoulder so the hand comes to the target.
    handAt(side, H);
    turnWorld(arm, dq.setFromUnitVectors(H.sub(S).normalize(), u.subVectors(T, S).normalize()));
    // 3. Turned about the shoulder-to-target line so the elbow points down and out, as arms do.
    fore.getWorldPosition(E);
    root.getWorldQuaternion(wq);
    pole.set(side === 'L' ? 0.4 : -0.4, -1, -0.3).applyQuaternion(wq);
    const axis = u; // (still the unit shoulder-to-target line)
    const elbow = w.subVectors(E, S).addScaledVector(axis, -w.dot(axis));
    const wantDir = pole.addScaledVector(axis, -pole.dot(axis));
    if (elbow.lengthSq() > 1e-8 && wantDir.lengthSq() > 1e-8) {
      elbow.normalize();
      wantDir.normalize();
      const twist = Math.atan2(n.crossVectors(elbow, wantDir).dot(axis), elbow.dot(wantDir));
      turnWorld(arm, dq.setFromAxisAngle(axis, twist));
    }
  };

  return {
    pose(g, reach = null) {
      for (const b of driven) b.quaternion.copy(rest.get(b));
      root.updateMatrixWorld(true);
      const hips = part('hips');
      if (hips) { hips.position.copy(hips.userData.rest ??= hips.position.clone()); }
      const lean = part('chest') ?? part('spine');
      if (lean) apply(lean, about(X, g.lean));
      const head = part('head');
      if (head) apply(head, about(X, g.head));
      for (const side of ['L', 'R']) {
        const arm = part(`arm${side}`);
        const fore = part(`forearm${side}`);
        const down = armDown[side];
        if (arm && down) {
          apply(arm, down.q);
          apply(arm, about(Z, (g[`armOut${side}`] ?? 0) * down.out)); // out to the side (and up)
          apply(arm, about(X, -(g[`arm${side}`] ?? 0))); // forward swing
        }
        if (fore) apply(fore, about(X, -(g[`forearm${side}`] ?? 0))); // bend the elbow forward
        const thigh = part(`thigh${side}`);
        const knee = part(`knee${side}`);
        if (thigh) apply(thigh, about(X, -(g[`thigh${side}`] ?? 0)));
        if (knee) apply(knee, about(X, g[`knee${side}`] ?? 0));
      }
      if (reach) for (const side of ['L', 'R']) reachArm(side, reach[side]);
    },
  };
}
