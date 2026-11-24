// The Sanctuary's trainer: an original little low-poly figure (no game character), in the colours
// of the chosen preset, with a glider for long falls; or a trainer model (Ash, Iris and May come with
// the app; you can add your own). Shared by the meadow, the Reef and the battles.

import { autoRig } from '../creature/autoRig.js';
import { findRig, gait, isHumanRig } from './rig.js';
import { MOVE } from './player.js';

/**
 * Build it with `THREE`. Returns { avatar, legs, arms, glider, dress(preset), load(url, opts), play(state,
 * speed, dt, t), hasModel, rigged }: `load` swaps in a model of the owner's own, `play` animates it.
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
  const arms = [part(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), mats.shirt, -0.36, 1.05, 0), part(new THREE.CapsuleGeometry(0.08, 0.4, 4, 8), mats.shirt, 0.36, 1.05, 0)];
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
  const dress = (t) => { mats.hat.color.setHex(t.hat); mats.shirt.color.setHex(t.shirt); mats.skin.color.setHex(t.skin); };
  const figure = avatar.children.filter((c) => c !== glider); // the built-in figure (the fallback)

  // ---- a model of the owner's own (uploaded in the trainer picker; server/trainers.js) ----
  let model = null; // { object, mixer, actions, driver }
  let phase = 0;
  let playing = null;
  const unload = () => {
    if (!model) return;
    avatar.remove(model.object);
    model.mixer?.stopAllAction();
    model = null;
    for (const c of figure) c.visible = true;
  };
  /** Swap the built-in figure for a .glb at `url` (null: back to the figure). Resolves to the model's info. */
  const load = async (url, { loader, loadModel, pickClips, realistic = false } = {}) => {
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
    } else {
      next.driver = rigDriver(THREE, object);
    }
    next.rigged = Boolean(next.mixer || next.driver);
    for (const c of figure) c.visible = false;
    avatar.add(object);
    model = next;
    return { rigged: next.rigged };
  };
  /**
   * Animate the movement state selected by rig.js trainerState.
   * `speed`: metres a second; `dt`: seconds; `t`: the clock. Returns false when there's no model.
   */
  const play = (state, speed, dt, t) => {
    if (!model) return false;
    phase += dt * (state === 'run' ? 9 : state === 'swim' ? 3 : 2.2 + speed * 1.2);
    if (model.mixer) {
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
      const g = gait(state, phase, Math.min(1, speed / 4), t);
      model.driver.pose(g);
      model.object.position.y = g.hipsBob;
    } else {
      // No skeleton: the whole model bobs and leans as it goes.
      const moving = ['walk', 'run'].includes(state);
      model.object.position.y = moving ? Math.abs(Math.sin(phase)) * 0.06 : Math.sin(t * 1.7) * 0.01;
      model.object.rotation.z = moving ? Math.sin(phase) * 0.05 : 0;
    }
    return true;
  };
  return { avatar, legs, arms, glider, dress, load, play, get hasModel() { return Boolean(model); }, get rigged() { return Boolean(model?.rigged); } };
}

/**
 * Pose a skinned model's skeleton from rig.js angles. Each angle is a turn about the character's own
 * side (X) or forward (Z) axis, carried into the bone's local frame through its parent's current
 * world rotation, so it works whatever axes the rig's bones use. Arms in a T- or A-pose are first
 * brought down to the sides. Returns { pose(angles) } or null for a model with no usable skeleton.
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
  const order = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'armL', 'armR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'kneeL', 'kneeR'];
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

  return {
    pose(g) {
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
    },
  };
}
