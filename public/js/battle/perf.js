// Keeping the 3D pages smooth on any computer, after the MIT-licensed Abyssal Garden's approach:
//   • dynamic resolution: every second, if frames take too long, first turn off the High level's
//     extra passes (postfx.js: occlusion, bloom, mirror water), then draw fewer pixels (down to 60%
//     of the graphics level's own resolution), and more again when there is room. "Too long" is
//     measured against the screen's own refresh rate (60, 120, 144 Hz…; nothing caps the frame rate):
//     a fast screen is kept as fast as the device can draw, trading a little sharpness, not much;
//   • a crash-safe start: a 3D page marks that it is loading; if the browser tab crashed during the
//     load, the mark is still there next time and that visit starts one graphics level lower.

const LOAD_KEY = 'pokedex.3dLoad';
const LEVELS = ['high', 'standard', 'basic'];

/**
 * The pixel ratio to use next, given the average frame time (ms) over the last second, the
 * current ratio and the level's own (the ceiling). Pure, for the tests.
 */
export function nextPixelRatio(frameMs, ratio, top, { floor = 0.6, slow = 19, fast = 13.5, target = 16.7 } = {}) {
  const min = top * floor;
  if (frameMs > slow) return Math.max(min, ratio * Math.max(0.7, Math.min(1, target / frameMs)));
  if (frameMs < fast && ratio < top) return Math.min(top, ratio * 1.12);
  return ratio;
}

/**
 * What counts as slow and fast frames on a screen refreshing every `refreshMs` (16.7 at 60 Hz, 6.9 at
 * 144 Hz): { slow, fast, floor, target } for nextPixelRatio(). A 60 Hz screen keeps the usual thresholds; a
 * faster one aims for its own rate, but never gives up more than a quarter of the resolution. Pure.
 */
export function frameTargets(refreshMs = 16.7) {
  const ms = Math.min(16.7, Math.max(4, refreshMs));
  if (ms > 14) return { slow: 19, fast: 13.5, floor: 0.6, target: 16.7 };
  const slow = Math.max(8, ms * 1.3);
  return { slow, fast: slow * 0.7, floor: 0.75, target: ms };
}

/**
 * One step: { ratio, drop }. With the extra passes on (`effects`), slow frames drop them first and
 * leave the pixels as they are. Pure, for the tests.
 */
export function perfStep(frameMs, ratio, top, effects = false, options = {}) {
  // The High passes go only when frames are slow even for a 60 Hz screen (they're worth keeping).
  if (effects && frameMs > Math.max(19, options.slow ?? 19)) return { ratio, drop: true };
  return { ratio: nextPixelRatio(frameMs, ratio, top, options), drop: false };
}

/**
 * Watches the frame times and adjusts `renderer`'s pixel ratio. `top()`: the level's own ratio now;
 * `effects`: the High passes ({ on, drop() }, from postfx.js createEffects), if the page has them.
 */
export function createPerf(renderer, top, effects = null) {
  let sum = 0;
  let n = 0;
  let wait = 2000; // let the page settle first (and learn the screen's refresh rate meanwhile)
  const settling = [];
  let targets = null;
  return {
    get targets() { return targets; },
    frame(dtMs) {
      if (dtMs > 250) return; // a hidden tab or a pause: not a measure
      sum += dtMs;
      n++;
      wait -= dtMs;
      if (!targets) settling.push(dtMs);
      if (wait > 0) return;
      if (!targets) {
        // The screen's refresh interval: the quickest frames (a fifth of the way up) in the first seconds.
        settling.sort((a, b) => a - b);
        targets = frameTargets(settling[Math.floor(settling.length * 0.2)] ?? 16.7);
      }
      const average = sum / n;
      sum = 0;
      n = 0;
      wait = 1000;
      const now = renderer.getPixelRatio();
      const { ratio: next, drop } = perfStep(average, now, top(), Boolean(effects?.on), targets);
      if (drop) effects.drop();
      else if (Math.abs(next - now) > 0.01) renderer.setPixelRatio(next);
    },
  };
}

/**
 * A 3D page is loading: mark it. Returns the level to use: one lower than `level` when the last
 * load never finished (the tab crashed).
 */
export function markLoad(level, storage = globalThis.localStorage) {
  let crashed = false;
  try {
    crashed = Boolean(storage?.getItem(LOAD_KEY));
    storage?.setItem(LOAD_KEY, '1');
  } catch { /* storage unavailable */ }
  if (!crashed) return level;
  return LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + 1)] ?? level;
}

/** The page has drawn for a while: the load is over. */
export function clearLoad(storage = globalThis.localStorage) {
  try { storage?.removeItem(LOAD_KEY); } catch { /* storage unavailable */ }
}
