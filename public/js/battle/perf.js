// Keeping the 3D pages smooth on any computer, after the MIT-licensed Abyssal Garden's approach:
//   • dynamic resolution: every second, if frames take too long, draw fewer pixels (down to 60% of
//     the graphics level's own resolution), and more again when there is room;
//   • a crash-safe start: a 3D page marks that it is loading; if the browser tab crashed during the
//     load, the mark is still there next time and that visit starts one graphics level lower.

const LOAD_KEY = 'pokedex.3dLoad';
const LEVELS = ['high', 'standard', 'basic'];

/**
 * The pixel ratio to use next, given the average frame time (ms) over the last second, the
 * current ratio and the level's own (the ceiling). Pure, for the tests.
 */
export function nextPixelRatio(frameMs, ratio, top, { floor = 0.6, slow = 19, fast = 13.5 } = {}) {
  const min = top * floor;
  if (frameMs > slow) return Math.max(min, ratio * Math.max(0.7, 16.7 / frameMs));
  if (frameMs < fast && ratio < top) return Math.min(top, ratio * 1.12);
  return ratio;
}

/** Watches the frame times and adjusts `renderer`'s pixel ratio. `top()`: the level's own ratio now. */
export function createPerf(renderer, top) {
  let sum = 0;
  let n = 0;
  let wait = 2000; // let the page settle first
  return {
    frame(dtMs) {
      if (dtMs > 250) return; // a hidden tab or a pause: not a measure
      sum += dtMs;
      n++;
      wait -= dtMs;
      if (wait > 0) return;
      const average = sum / n;
      sum = 0;
      n = 0;
      wait = 1000;
      const now = renderer.getPixelRatio();
      const next = nextPixelRatio(average, now, top());
      if (Math.abs(next - now) > 0.01) renderer.setPixelRatio(next);
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
