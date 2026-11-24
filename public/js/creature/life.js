// Everything that makes a loaded Pokémon (or trainer) model alive, in one place for the Sanctuary, the
// Reef and battles: a skeleton when it came without one (autoRig.js), its gait (animate.js), blinking
// eyes (blink.js) and burning flames (flames.js).

import { autoRig } from './autoRig.js';
import { createAnimator } from './animate.js';
import { setupBlink } from './blink.js';
import { setupFlames } from './flames.js';

/**
 * Bring a model to life. `model`: modelLoader.loadModel's result; `plan`: its body plan (body.js).
 * `animate` false when the model moves with animation clips of its own (only blinking and flames then).
 * Returns { anim, update(dt, { speed, air, posing }), gesture(), dispose() }.
 */
export function bringToLife(model, plan, { dexId = null, quality = 'high', animate = true } = {}) {
  if (animate && plan) autoRig(model.object, plan.mode);
  const anim = animate && plan ? createAnimator(model.object, plan) : null;
  const blink = setupBlink(model.object);
  const flames = setupFlames(model.object, { dexId, quality });
  return {
    anim,
    blinks: Boolean(blink),
    burns: Boolean(flames),
    update(dt, state = {}) {
      anim?.update(dt, state);
      blink?.update(dt);
      flames?.update(dt);
    },
    gesture() { anim?.gesture(); },
    dispose() { flames?.dispose(); anim?.dispose(); },
  };
}
