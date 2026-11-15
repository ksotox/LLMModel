// Ambient sound, made live with the Web Audio API (no sound files).
//
// The Reef's soundscape is ported from Abyssal Garden's audio.js by Maksymilian Dendura
// (github.com/Noniv/abyssal-garden), MIT licence:
//   Copyright (c) 2026 Maksymilian Dendura. Permission is hereby granted, free of charge, to any person
//   obtaining a copy of this software and associated documentation files (the "Software"), to deal in
//   the Software without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
//   whom the Software is furnished to do so, subject to the following conditions: The above copyright
//   notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
// Its layers: a deep rumble, a surface wash, a rush that follows how fast you swim, a slow drone,
// bubbles, soft chimes and distant whale calls. The meadow's (wind, birdsong, water near the lake)
// is our own, built the same way.
//
// Nothing plays until the first click, tap or key (browsers require it). M mutes; remembered.

const MUTE_KEY = 'pokedex.sound';

export function isMuted(storage = globalThis.localStorage) {
  try { return storage?.getItem(MUTE_KEY) === 'off'; } catch { return false; }
}

function saveMuted(muted, storage = globalThis.localStorage) {
  try { storage?.setItem(MUTE_KEY, muted ? 'off' : 'on'); } catch { /* storage unavailable */ }
}

const rnd = Math.random;
const rr = (a, b) => a + (b - a) * rnd();

/** Build the graph for `kind` ('reef' or 'meadow'); returns tick(state) for a 10 Hz timer, and the output gain. */
function build(ac, kind) {
  const sr = ac.sampleRate;
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => { const n = sr * secs | 0; const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; };
  // A seamless brown-noise loop (its end cross-fades into its start).
  const nb = noise(11, (d, n) => { for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } } });
  // A reverb: 4 s of noise that fades out and darkens.
  const ir = noise(4, (d, n) => { for (let i = 0, b = 0; i < n; i++) { const t = i / sr; b += (rnd() * 2 - 1 - b) * (0.04 + 0.5 * Math.exp(-t * 2)); d[i] = b * (1 - Math.exp(-t * 30)) * Math.exp(-t * 1.5) * (1 - i / n); } });
  const lim = N(DynamicsCompressorNode, { threshold: -6, knee: 6, ratio: 20, attack: 0.003, release: 0.3 }, ac.destination);
  const out = G(0, lim);
  const wet = N(ConvolverNode, { buffer: ir }, out);
  const src = (playbackRate, ...to) => N(AudioBufferSourceNode, { buffer: nb, loop: true, playbackRate }, ...to);
  const pool = (n, send, type) => Array.from({ length: n }, () => { const p = N(StereoPannerNode, {}, out, G(send, wet)); const g = G(0, p); return { p, g, o: N(OscillatorNode, { type }, g) }; });
  const play = (vs, t, f0, f1, dur, vol, att) => {
    const v = vs.shift(); vs.push(v);
    const f = v.o.frequency;
    const g = v.g.gain;
    v.p.pan.setValueAtTime(rr(-0.7, 0.7), t);
    f.setValueAtTime(f0, t); f.exponentialRampToValueAtTime(f1, t + dur);
    g.setValueAtTime(0, t); g.linearRampToValueAtTime(vol, t + att); g.setTargetAtTime(0, t + att, (dur - att) / 5);
  };
  let lt = ac.currentTime;

  if (kind === 'reef') {
    const rum = G(0.34, out); src(1, BQ('lowpass', 150, 0.7, rum)); lfo(0.07, 0.11, rum.gain); lfo(0.113, 0.08, rum.gain);
    const wash = G(0.25, out); const wave = G(1, wash); const rush = G(0, out); const rushF = BQ('bandpass', 300, 0.9, rush);
    src(0.63, BQ('bandpass', 420, 0.5, wave), rushF); lfo(0.09, 0.3, wave.gain); lfo(0.151, 0.25, wave.gain);
    const pad = G(1, out, G(1.5, wet));
    [73.42, 110, 164.81, 246.94, 369.99].forEach((f, i) => { const g = G(0.022 - i * 0.003, pad); N(OscillatorNode, { frequency: f }, g); N(OscillatorNode, { frequency: f + rr(0.03, 0.11) }, g); });
    const bub = pool(4, 0.12); const chime = pool(3, 1.2); const whale = pool(2, 2, 'triangle');
    const NOTES = [0, 2, 5, 7, 9, 12, 14, 17, 19];
    let tB = lt + 1.5; let tC = lt + 5; let tW = lt + 12;
    return {
      out,
      tick({ speed = 0, depth = 0.5 } = {}) {
        const now = ac.currentTime; const t = now + 0.05;
        rush.gain.setTargetAtTime(0.5 * Math.min(speed / 8, 1) ** 1.2, t, 0.3); rushF.frequency.setTargetAtTime(220 + speed * 40, t, 0.3);
        const s = Math.min(1, Math.max(0, 1 - depth)); wash.gain.setTargetAtTime(0.25 + 0.55 * s * s, t, 0.5);
        if (t > tB) { let tt = t; for (let n = 1 + (rnd() * rnd() * 6 | 0); n--;) { const f = rr(380, 1300); play(bub, tt, f, f * rr(1.4, 2.2), 0.05 + 40 / f, rr(0.03, 0.08), 0.006); tt += rr(0.07, 0.2); } tB = tt + rr(0.5, 5); }
        if (t > tC) { const f = 440 * 2 ** (NOTES[rnd() * 9 | 0] / 12); play(chime, t, f, f, 5, rr(0.02, 0.04), 0.03); tC = t + rr(2.5, 9); }
        if (t > tW) { let tt = t; for (let n = 2 + (rnd() * 2 | 0); n--;) { const f = rr(170, 380); const d = rr(1.6, 3.2); play(whale, tt, f, f * rr(0.6, 1.7), d, 0.08, d * 0.4); tt += d * 0.8; } tW = tt + rr(20, 50); }
      },
    };
  }

  // The meadow: wind in the grass, birdsong, and water when near the lake.
  const wind = G(0.16, out); const windF = BQ('bandpass', 600, 0.4, wind);
  src(0.9, windF); lfo(0.05, 0.08, wind.gain); lfo(0.031, 250, windF.frequency);
  const water = G(0, out); src(0.55, BQ('bandpass', 900, 0.7, water));
  const birds = pool(3, 0.3); const chirp = pool(2, 0.2, 'triangle');
  let tB = lt + 3;
  return {
    out,
    tick({ nearWater = 0 } = {}) {
      const t = ac.currentTime + 0.05;
      water.gain.setTargetAtTime(0.22 * nearWater, t, 0.6);
      if (t > tB) {
        // A little phrase of 2–5 quick, sliding notes.
        let tt = t;
        const base = rr(2200, 3600);
        for (let n = 2 + (rnd() * 4 | 0); n--;) { const f = base * rr(0.8, 1.25); play(rnd() < 0.7 ? birds : chirp, tt, f, f * rr(0.7, 1.4), rr(0.06, 0.16), rr(0.015, 0.04), 0.01); tt += rr(0.08, 0.2); }
        tB = tt + rr(2, 9);
      }
    },
  };
}

/**
 * Ambient sound for a place ('reef' or 'meadow'). It starts on the first click, tap or key.
 * Returns { update(state), toggleMute() → muted, dispose() }.
 */
export function createAmbience(kind) {
  let ac = null;
  let graph = null;
  let timer = 0;
  let state = {};
  let muted = isMuted();
  const VOL = 0.7;
  const start = () => {
    if (!globalThis.AudioContext) return;
    if (!ac) {
      ac = new AudioContext({ latencyHint: 'playback' });
      graph = build(ac, kind);
      graph.out.gain.setTargetAtTime(muted ? 0 : VOL, ac.currentTime, 1);
      timer = setInterval(() => graph.tick(state), 100);
    }
    if (ac.state === 'suspended' && !document.hidden) ac.resume().catch(() => {});
  };
  const onVisible = () => { if (ac) (document.hidden ? ac.suspend() : ac.resume()).catch(() => {}); };
  const events = ['pointerdown', 'keydown', 'touchstart'];
  for (const e of events) window.addEventListener(e, start, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  return {
    update(s) { state = s; },
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      saveMuted(muted);
      if (ac) graph.out.gain.setTargetAtTime(muted ? 0 : VOL, ac.currentTime, 0.08);
      return muted;
    },
    dispose() {
      for (const e of events) window.removeEventListener(e, start);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
      ac?.close().catch(() => {});
    },
  };
}
