// Trainers in battles: each side's trainer stands behind its Pokémon, cheers when it attacks and slumps
// when it faints. The trainer is the Sanctuary's (sanctuary/trainer.js): a trainer model (Ash, Iris and
// May come with the app; your own too) or the simple figure in your colours.

import { buildTrainer } from '../sanctuary/trainer.js';
import { BATTLE_SIZES, displayHeight } from '../creature/body.js';

/**
 * Where a side's trainer stands: behind its Pokémon (away from the rival) and a step to the side, so it
 * doesn't block the camera's view of the field. `me`, `rival`: { x, z }. Pure (tested).
 */
export function trainerSpot(me, rival, { back = 1.1, aside = 1.0 } = {}) {
  const dx = me.x - rival.x;
  const dz = me.z - rival.z;
  const d = Math.hypot(dx, dz) || 1;
  const ax = dx / d;
  const az = dz / d;
  // "Aside" is to the trainer's right as it faces the rival, which keeps both trainers off the line the
  // camera looks along (the camera stands behind the near side, to its left).
  const rx = az;
  const rz = -ax;
  return { x: me.x + ax * back + rx * aside, z: me.z + az * back + rz * aside, facing: Math.atan2(-ax, -az) };
}

/**
 * A trainer for one side. `model`: { url } of a trainer model, or null for the figure in `preset`'s
 * colours. `scale`: the battle's scale (body.js battleScale). Returns { avatar, ready (a promise),
 * update(dt, t), cheer(), slump(), dispose() }.
 */
export function battleTrainer(THREE, { model = null, preset = null, scale = 1, loader, loadModel, pickClips, realistic = false, prepare = null } = {}) {
  const trainer = buildTrainer(THREE);
  if (preset) trainer.dress(preset);
  // A trainer is a person: drawn on the same compressed scale as the Pokémon (body.js displayHeight).
  const height = displayHeight(1.75, BATTLE_SIZES) * scale;
  trainer.avatar.scale.setScalar(height / 1.75);
  const ready = model?.url ? trainer.load(model.url, { loader, loadModel, pickClips, realistic, prepare }).catch(() => null) : Promise.resolve(null);
  let cheering = 0;
  let slumped = false;
  let lean = 0;
  return {
    avatar: trainer.avatar,
    ready,
    update(dt, t) {
      cheering = Math.max(0, cheering - dt);
      const state = cheering > 0 ? 'jump' : 'idle';
      trainer.play(state, 0, dt, t);
      // A little hop while cheering; a slow slump when its Pokémon is down.
      const hop = cheering > 0 ? Math.abs(Math.sin(cheering * 9)) * 0.12 * height : 0;
      lean += ((slumped ? 0.35 : 0) - lean) * Math.min(1, dt * 3);
      trainer.avatar.position.y = hop;
      trainer.avatar.rotation.x = lean;
      if (!trainer.hasModel) {
        // The figure's limbs: arms up while cheering.
        const up = cheering > 0 ? -2.6 : 0;
        trainer.arms[0].rotation.x = up;
        trainer.arms[1].rotation.x = up;
      }
    },
    cheer(seconds = 0.9) { cheering = seconds; slumped = false; },
    slump() { slumped = true; cheering = 0; },
    dispose() { trainer.avatar.parent?.remove(trainer.avatar); },
  };
}
