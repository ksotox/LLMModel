// A frame-time readout for the 3D pages (F3, or "?fps" in the address): frames a second, the slowest
// frame and how many frames ran long in the last few seconds. It shows where a hitch comes from (when
// a Pokémon appears, while running, turning…), on the device that has it.

import { loadSettings, saveSettings } from '../game/settings.js';

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

/**
 * The GPU's own time for the frames drawn between begin() and end(), from the browser's timer queries
 * (EXT_disjoint_timer_query_webgl2, on most desktop GPUs). Results arrive a few frames late; `ms` is
 * the latest (null when the browser can't tell). Returns { begin(), end(), ms, supported, dispose() }.
 */
export function createGpuTimer(renderer) {
  const gl = renderer.getContext?.();
  const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2');
  if (!gl || !ext || typeof gl.createQuery !== 'function') return { begin() {}, end() {}, ms: null, supported: false, dispose() {} };
  const waiting = [];
  let active = null;
  const timer = {
    supported: true,
    ms: null,
    begin() {
      if (active || waiting.length > 4) return; // (the GPU is behind: skip this frame's measure)
      active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      waiting.push(active);
      active = null;
      // Collect what's ready (oldest first).
      while (waiting.length) {
        const q = waiting[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        if (!disjoint) timer.ms = timer.ms == null ? ns / 1e6 : timer.ms * 0.85 + (ns / 1e6) * 0.15;
        gl.deleteQuery(q);
        waiting.shift();
      }
    },
    dispose() { for (const q of waiting) gl.deleteQuery(q); waiting.length = 0; },
  };
  return timer;
}

/**
 * The readout in `host` (an element): frames a second, and (by the settings, ⚙ → Performance) the CPU's
 * and the GPU's time per frame and how much of each frame that is. Call frame(ms) once a frame, with
 * cpu (ms of the page's own work that frame) and the GPU timer. F3 (or "?fps") shows or hides it all.
 * Returns { frame(ms, { cpu, gpu }), apply(overlay), timingGpu, dispose() }.
 */
export function createFrameMeter(host) {
  const box = document.createElement('div');
  box.className = 'frame-meter';
  box.setAttribute('aria-live', 'off');
  box.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:30;padding:4px 8px;border-radius:6px;'
    + 'background:rgba(0,0,0,0.6);color:#d1fae5;font:12px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre';
  let shown = loadSettings().overlay;
  try { if (/[?&]fps\b/.test(location.search + location.hash)) shown = { fps: true, cpu: true, gpu: true }; } catch { /* no location */ }
  const any = () => shown.fps || shown.cpu || shown.gpu;
  box.hidden = !any();
  host.append(box);
  const ring = new Float32Array(240); // the last few seconds
  let count = 0;
  let head = 0;
  let since = 0;
  let cpuAvg = null;
  const onKey = (e) => {
    const settings = loadSettings();
    if (!settings.bindings.overlay.includes(e.code) || e.target?.closest?.('input, select, textarea')) return;
    e.preventDefault();
    shown = any() ? { fps: false, cpu: false, gpu: false } : { fps: true, cpu: true, gpu: true };
    box.hidden = !any();
    saveSettings({ ...settings, overlay: shown });
  };
  window.addEventListener('keydown', onKey);
  return {
    frame(ms, { cpu = null, gpu = null } = {}) {
      if (!(ms > 0) || ms > 1000) return;
      ring[head] = ms;
      head = (head + 1) % ring.length;
      count = Math.min(ring.length, count + 1);
      if (cpu != null) cpuAvg = cpuAvg == null ? cpu : cpuAvg * 0.9 + cpu * 0.1;
      since += ms;
      if (box.hidden || since < 500) return;
      since = 0;
      const recent = [];
      for (let i = 0; i < count; i++) recent.push(ring[(head - count + i + ring.length) % ring.length]);
      const s = frameStats(recent);
      const frameMs = 1000 / Math.max(1, s.fps);
      const pct = (x) => `${Math.min(100, Math.round((x / frameMs) * 100))}%`;
      const lines = [];
      if (shown.fps) lines.push(`${s.fps} fps · screen ${s.refresh} ms`, `slowest ${s.worst} ms · 95% ${s.p95} ms · long ${s.long}/${count}`);
      if (shown.cpu) lines.push(cpuAvg == null ? 'CPU —' : `CPU ${cpuAvg.toFixed(1)} ms · ${pct(cpuAvg)} of the frame`);
      if (shown.gpu) lines.push(gpu?.supported === false ? 'GPU — (this browser can’t time it)' : gpu?.ms == null ? 'GPU measuring…' : `GPU ${gpu.ms.toFixed(1)} ms · ${pct(gpu.ms)} of the frame`);
      box.textContent = lines.join('\n');
    },
    /** New overlay settings ({ fps, cpu, gpu }) from the menu. */
    apply(overlay) { shown = { ...overlay }; box.hidden = !any(); },
    /** Whether the GPU line is showing (so the page times the GPU only then). */
    get timingGpu() { return !box.hidden && shown.gpu; },
    dispose() { window.removeEventListener('keydown', onKey); box.remove(); },
  };
}
