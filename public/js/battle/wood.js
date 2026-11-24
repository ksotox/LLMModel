// Wood that looks like wood, made in code so it's there on every graphics level (and before any
// photo texture loads): bark with deep vertical furrows, sawn planks with grain, knots and seams, and
// weathered board for signs. Each comes as a colour map and a matching bump (normal) map. Drawn once
// per page and shared; the scenery's photo textures (Poly Haven, hdScenery.js) replace them on High.

import * as THREE from 'three';
import { normalsFromHeights } from './surface.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

const cache = new Map();

/** A canvas `w`×`h` painted by `paint(g, r, heights)`; returns { color, normal } textures (cached by `key`). */
function make(key, w, h, paint, { repeat = [1, 1], strength = 2 } = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  paint(g, rng(key.length * 7919 + w));
  const d = g.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);
  for (let i = 0; i < heights.length; i++) heights[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
  const color = new THREE.CanvasTexture(c);
  color.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.DataTexture(normalsFromHeights(heights, w, h, strength), w, h);
  normal.needsUpdate = true;
  normal.generateMipmaps = true;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  for (const t of [color, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
    t.anisotropy = 8;
  }
  const out = { color, normal };
  cache.set(key, out);
  return out;
}

/** Bark: dark furrows running up the trunk between rough ridges, mottled with lichen. */
export function barkTexture(dark = false) {
  return make(`bark${dark ? '-dark' : ''}`, 256, 512, (g, r) => {
    g.fillStyle = dark ? '#3a2c22' : '#5b4331';
    g.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 70; i++) {
      // A ridge: a wavering lighter band up the trunk.
      const x0 = r() * 256;
      const w = 4 + r() * 10;
      const shade = 40 + r() * 50;
      g.strokeStyle = `rgba(${shade + 70},${shade + 50},${shade + 30},${0.35 + r() * 0.4})`;
      g.lineWidth = w;
      g.beginPath();
      let x = x0;
      g.moveTo(x, 0);
      for (let y = 0; y <= 512; y += 16) { x += (r() - 0.5) * 6; g.lineTo(x, y); }
      g.stroke();
    }
    for (let i = 0; i < 50; i++) {
      // A furrow: a thin dark crack.
      g.strokeStyle = `rgba(20,14,10,${0.5 + r() * 0.4})`;
      g.lineWidth = 1.5 + r() * 2.5;
      g.beginPath();
      let x = r() * 256;
      const y0 = r() * 512;
      g.moveTo(x, y0);
      for (let y = y0; y < y0 + 60 + r() * 160; y += 12) { x += (r() - 0.5) * 5; g.lineTo(x, y); }
      g.stroke();
    }
    for (let i = 0; i < 40; i++) {
      // Lichen.
      g.fillStyle = `rgba(${120 + r() * 40},${140 + r() * 30},${90 + r() * 30},${0.12 + r() * 0.15})`;
      g.beginPath();
      g.ellipse(r() * 256, r() * 512, 4 + r() * 10, 3 + r() * 8, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }, { repeat: [1, 2], strength: 3 });
}

/** Sawn planks side by side: grain lines along each board, a knot or two, dark seams between. */
export function plankTexture(tone = 'weathered') {
  const base = { weathered: [150, 122, 88], warm: [138, 96, 58], grey: [128, 120, 108] }[tone] ?? [150, 122, 88];
  return make(`planks-${tone}`, 512, 512, (g, r) => {
    const boards = 4;
    const bw = 512 / boards;
    for (let b = 0; b < boards; b++) {
      const v = (r() - 0.5) * 30;
      g.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.8},${base[2] + v * 0.6})`;
      g.fillRect(b * bw, 0, bw, 512);
      for (let i = 0; i < 26; i++) {
        // Grain: long gently wavering lines along the board.
        const x = b * bw + r() * bw;
        g.strokeStyle = `rgba(${60 + r() * 30},${40 + r() * 20},${25 + r() * 15},${0.12 + r() * 0.22})`;
        g.lineWidth = 0.8 + r() * 1.8;
        g.beginPath();
        g.moveTo(x, 0);
        const amp = 2 + r() * 5;
        const ph = r() * 6;
        for (let y = 0; y <= 512; y += 8) g.lineTo(x + Math.sin(y * 0.02 + ph) * amp, y);
        g.stroke();
      }
      if (r() < 0.8) {
        // A knot, with the grain curling round it.
        const kx = b * bw + bw * (0.3 + r() * 0.4);
        const ky = r() * 512;
        for (let k = 5; k > 0; k--) {
          g.strokeStyle = `rgba(55,35,20,${0.18 + (5 - k) * 0.08})`;
          g.lineWidth = 1.5;
          g.beginPath();
          g.ellipse(kx, ky, k * 2.2, k * 4.5, 0, 0, Math.PI * 2);
          g.stroke();
        }
      }
      // The seam between boards.
      g.fillStyle = 'rgba(30,20,12,0.85)';
      g.fillRect(b * bw, 0, 3, 512);
    }
    // Weathering: pale patches and grime.
    for (let i = 0; i < 60; i++) {
      g.fillStyle = r() < 0.5 ? `rgba(230,220,200,${r() * 0.08})` : `rgba(30,25,20,${r() * 0.1})`;
      g.beginPath();
      g.ellipse(r() * 512, r() * 512, 8 + r() * 30, 4 + r() * 12, 0, 0, Math.PI * 2);
      g.fill();
    }
  }, { strength: 2.5 });
}
