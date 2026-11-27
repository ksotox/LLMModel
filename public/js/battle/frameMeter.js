// A frame-time readout for the 3D pages (F3, or "?fps" in the address): frames a second, the slowest
// frame and how many frames ran long in the last few seconds. It shows where a hitch comes from (when
// a Pokémon appears, while running, turning…), on the device that has it.

/**
 * Statistics of frame intervals `ms` (milliseconds, oldest first): { fps, worst, p95, long, refresh }.
 * `refresh` is the screen's interval (the quickest fifth of the frames); a frame is "long" when it took
 * more than 1.5 of those (a frame the screen had to show twice). Pure.
 */
export function frameStats(ms) {
  const n = ms.length;
  if (!n) return { fps: 0, worst: 0, p95: 0, long: 0, refresh: 0 };
  const sorted = [...ms].sort((a, b) => a - b);
  const total = ms.reduce((a, b) => a + b, 0);
  const refresh = sorted[Math.floor(n * 0.2)];
  return {
    fps: Math.round((n * 1000) / total),
    worst: Math.round(sorted[n - 1] * 10) / 10,
    p95: Math.round(sorted[Math.min(n - 1, Math.floor(n * 0.95))] * 10) / 10,
    long: ms.filter((x) => x > refresh * 1.5).length,
    refresh: Math.round(refresh * 10) / 10,
  };
}

/** Whether the readout starts shown: "?fps" in the address, or it was left on (F3). */
function startShown() {
  try {
    return /[?&]fps\b/.test(location.search + location.hash) || localStorage.getItem('pokedex.fps') === '1';
  } catch {
    return false;
  }
}

/**
 * The readout in `host` (an element). Call frame(ms) once a frame; F3 shows or hides it.
 * Returns { frame(ms), dispose() }.
 */
export function createFrameMeter(host) {
  const box = document.createElement('div');
  box.className = 'frame-meter';
  box.setAttribute('aria-live', 'off');
  box.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:30;padding:4px 8px;border-radius:6px;'
    + 'background:rgba(0,0,0,0.6);color:#d1fae5;font:12px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre';
  box.hidden = !startShown();
  host.append(box);
  const ring = new Float32Array(240); // the last few seconds
  let count = 0;
  let head = 0;
  let since = 0;
  const onKey = (e) => {
    if (e.code !== 'F3') return;
    e.preventDefault();
    box.hidden = !box.hidden;
    try { localStorage.setItem('pokedex.fps', box.hidden ? '0' : '1'); } catch { /* storage unavailable */ }
  };
  window.addEventListener('keydown', onKey);
  return {
    frame(ms) {
      if (!(ms > 0) || ms > 1000) return;
      ring[head] = ms;
      head = (head + 1) % ring.length;
      count = Math.min(ring.length, count + 1);
      since += ms;
      if (box.hidden || since < 500) return;
      since = 0;
      const recent = [];
      for (let i = 0; i < count; i++) recent.push(ring[(head - count + i + ring.length) % ring.length]);
      const s = frameStats(recent);
      box.textContent = `${s.fps} fps · screen ${s.refresh} ms\nslowest ${s.worst} ms · 95% ${s.p95} ms\nlong frames ${s.long} / ${count}`;
    },
    dispose() { window.removeEventListener('keydown', onKey); box.remove(); },
  };
}
