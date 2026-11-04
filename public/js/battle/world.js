// The PokéBattles world around the fighters: a physically based sky with a sun (dusk in dark mode)
// and drifting clouds, light from that sky on every surface (image-based lighting), soft sun
// shadows, haze, one land surface from the arena to snowy peaks, a lake, dense grass that bends in
// gusts of wind, pine and broadleaf woods, ruins, flowers and pollen, plus post-processing on "High"
// (ambient occlusion, bloom on effects). The look follows the owner's "Hi-Fi v4" battle mock-up.
//
// Everything here is generated in code (procedural textures and shapes): no downloaded assets.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const QUALITY_KEY = 'pokedex.battleGraphics';

/**
 * "high", "standard" or "basic": the saved choice; otherwise basic without a graphics card (software
 * rendering: virtual machines, remote desktops, missing drivers), standard on phones and small
 * machines, high elsewhere.
 */
export function preferredQuality(renderer) {
  try {
    const saved = localStorage.getItem(QUALITY_KEY);
    if (['high', 'standard', 'basic'].includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  let name = '';
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* unknown */ }
  if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'basic';
  if (matchMedia('(max-width: 720px)').matches || (navigator.hardwareConcurrency ?? 8) <= 4) return 'standard';
  return 'high';
}

export function saveQuality(q) {
  try { localStorage.setItem(QUALITY_KEY, q); } catch { /* storage unavailable */ }
}

// ---- small deterministic noise for textures and terrain ----

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tiling canvas texture: a base colour with blotches and speckles of nearby tones. */
function noiseTexture({ size = 512, base, tones, blotches = 900, specks = 9000, seed = 1, repeat = 1, anisotropy = 8 }) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const blot = (x, y, rad, color, alpha) => {
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      grad.addColorStop(0, color.replace('ALPHA', alpha));
      grad.addColorStop(1, color.replace('ALPHA', 0));
      g.fillStyle = grad;
      g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  };
  for (let i = 0; i < blotches; i++) blot(r() * size, r() * size, 6 + r() * 40, tones[Math.floor(r() * tones.length)], 0.18 + r() * 0.2);
  for (let i = 0; i < specks; i++) {
    g.fillStyle = tones[Math.floor(r() * tones.length)].replace('ALPHA', 0.35 + r() * 0.5);
    g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = anisotropy;
  return t;
}

// Value noise / fBm / ridged noise (deterministic), for terrain, mountains and textures.
function hash2(x, y) {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) { sum += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return sum;
}
function ridged(x, y, octaves = 6) {
  let sum = 0;
  let amp = 0.55;
  let f = 1;
  for (let i = 0; i < octaves; i++) { const n = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1); sum += amp * n * n; f *= 2.1; amp *= 0.5; }
  return sum;
}

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** A small lake out in the meadow, front right of the battle camera. */
const LAKE = { x: 27, z: -21, r: 10, level: -0.6 };
const lakeDistance = (x, z) => Math.hypot(x - LAKE.x, z - LAKE.z);
const inLake = (x, z, pad = 0) => lakeDistance(x, z) < LAKE.r * 1.3 + pad;

/**
 * The land, one surface from the arena to the peaks: flat around the arena, a softly uneven meadow,
 * rolling hills, then ridged mountains far out; with a hollow for the lake.
 */
function terrainHeight(x, z, flat = 16) {
  const d = Math.hypot(x, z);
  let h = (fbm(x * 0.035, z * 0.035, 4) - 0.48) * 1.8 * smooth(flat, flat + 14, d);
  h += smooth(flat + 14, 110, d) * (fbm(x * 0.011 + 7.3, z * 0.011 - 2.1, 5) - 0.4) * 16;
  h += smooth(160, 300, d) * ridged(x * 0.0055 + 3.1, z * 0.0055 + 9.4, 5) * 78;
  const lake = 1 - smooth(LAKE.r * 0.5, LAKE.r * 1.3, lakeDistance(x, z));
  return h * (1 - lake) - 2.4 * lake;
}

/**
 * Colour the land by height and slope: meadow (with dirt patches), sand at the lake shore, rock on
 * steep slopes, snow on the peaks. `aBare` says how much of the grass texture to drop (0 = meadow).
 */
function paintTerrain(geo, dark) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const bare = new Float32Array(pos.count);
  const dirt = new THREE.Color(1.15, 0.84, 0.55);
  const sand = new THREE.Color(0xb5a37a);
  const rock = new THREE.Color(dark ? 0x5c5862 : 0x7d7a74);
  const snow = new THREE.Color(dark ? 0xdccfe3 : 0xf1f4f9);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = nor.getY(i);
    c.setScalar(0.82 + fbm(x * 0.05, z * 0.05, 3) * 0.36);
    c.lerp(dirt, smooth(0.55, 0.78, fbm(x * 0.02 + 40, z * 0.02, 4)) * 0.45);
    const sandW = lakeDistance(x, z) < LAKE.r * 1.6 ? smooth(0.15, -0.6, y) : 0;
    const rockW = Math.max(smooth(0.86, 0.66, ny), smooth(16, 32, y) * 0.85);
    const snowW = smooth(34, 50, y + fbm(x * 0.03, z * 0.03, 3) * 12) * smooth(0.45, 0.75, ny);
    c.lerp(sand, sandW).lerp(rock, rockW).lerp(snow, snowW);
    colors.set([c.r, c.g, c.b], i * 3);
    bare[i] = Math.min(1, Math.max(sandW, rockW, snowW));
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aBare', new THREE.BufferAttribute(bare, 1));
}

/** Swap the grass texture for its plain brightness where the land is rock, sand or snow. */
function bareGroundShader(lum) {
  return (shader) => {
    shader.uniforms.uLum = { value: lum };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBare;\nvarying float vBare;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBare = aBare;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBare;\nuniform float uLum;')
      .replace('#include <map_fragment>', `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        float grey = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / uLum;
        diffuseColor *= vec4( mix( sampledDiffuseColor.rgb, vec3( grey ), vBare ), sampledDiffuseColor.a );
      #endif`);
  };
}

// Shared GLSL value noise for the water and grass shaders.
const GLSL_NOISE = `
  float nHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float nValue(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(nHash(i), nHash(i + vec2(1.0, 0.0)), u.x), mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), u.x), u.y); }
  float nFbm3(vec2 p) { float v = 0.0, a = 0.5; mat2 r = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 3; i++) { v += a * nValue(p); p = r * p; a *= 0.5; } return v / 0.875; }
`;

/** The lake: rippling water that reflects the sky (more at grazing angles) with a glint of sun. */
function lake({ dark, sunDir, sunColor, horizon }) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSun: { value: sunDir.clone().normalize() },
      uSunCol: { value: sunColor.clone() },
      uZenith: { value: new THREE.Color(dark ? 0x3a3f75 : 0x3d74c6) },
      uHorizon: { value: horizon.clone() },
      uDeep: { value: new THREE.Color(dark ? 0x141a2a : 0x0d2b36) },
    }]),
    vertexShader: `
      varying vec3 vW;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uSun, uSunCol, uZenith, uHorizon, uDeep;
      varying vec3 vW;
      #include <common>
      #include <fog_pars_fragment>
      ${GLSL_NOISE}
      float wave(vec2 p) { return nFbm3(p * 0.9 + vec2(uTime * 0.08, uTime * 0.05)) * 0.6 + nFbm3(p * 2.3 - vec2(uTime * 0.12, 0.0)) * 0.4; }
      void main() {
        vec2 p = vW.xz; float e = 0.06;
        float h0 = wave(p), hx = wave(p + vec2(e, 0.0)), hz = wave(p + vec2(0.0, e));
        vec3 N = normalize(vec3(-(hx - h0) / e * 0.25, 1.0, -(hz - h0) / e * 0.25));
        vec3 V = normalize(cameraPosition - vW);
        vec3 R = reflect(-V, N);
        float fr = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 sky = mix(uHorizon, uZenith, clamp(R.y * 1.8, 0.0, 1.0));
        vec3 col = mix(uDeep, sky, fr) + uSunCol * pow(max(dot(R, uSun), 0.0), 220.0) * 2.5;
        gl_FragColor = vec4(col, 0.94);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(LAKE.r * 1.4, 72), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(LAKE.x, LAKE.level, LAKE.z);
  return { mesh, uniforms: mat.uniforms };
}

/** Pollen and seeds drifting up through the air around the field. */
function pollen(count, { dark, tex, view }) {
  const cx = view ? view.x + view.fx * 8 : 0;
  const cz = view ? view.z + view.fz * 8 : 0;
  const pos = new Float32Array(count * 3);
  const seeds = [];
  const r = rng(71);
  for (let i = 0; i < count; i++) {
    pos.set([cx + (r() - 0.5) * 26, 0.2 + r() * 4.2, cz + (r() - 0.5) * 22], i * 3);
    seeds.push({ rise: 0.07 + r() * 0.2, phase: r() * Math.PI * 2 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.05, map: tex, color: dark ? 0xffcf8a : 0xfff2c2, transparent: true, opacity: dark ? 0.75 : 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  const update = (t, dt) => {
    const n = geo.drawRange.count === Infinity ? count : Math.min(count, geo.drawRange.count);
    for (let i = 0; i < n; i++) {
      const s = seeds[i];
      pos[i * 3] += Math.sin(t * 0.7 + s.phase) * 0.14 * dt;
      pos[i * 3 + 1] += s.rise * dt;
      pos[i * 3 + 2] += Math.cos(t * 0.5 + s.phase) * 0.1 * dt;
      if (pos[i * 3 + 1] > 4.4) pos[i * 3 + 1] = 0.2;
    }
    geo.attributes.position.needsUpdate = true;
  };
  return { points, update };
}

/** A soft round dot (pollen). */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * A mountain range seen from far away: ridged noise shaped into peaks, coloured by height
 * (meadow → rock → snow). `snow` is the height fraction above which it's white.
 */
function mountainRange({ width, depth, height, seed, snow = 0.62, dark = false }) {
  const geo = new THREE.PlaneGeometry(width, depth, 150, 46);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const meadow = new THREE.Color(dark ? 0x34472f : 0x4f7d3a);
  const forest = new THREE.Color(dark ? 0x26361f : 0x35602c);
  const rock = new THREE.Color(dark ? 0x5c5862 : 0x7d7a74);
  const white = new THREE.Color(dark ? 0xd9cfe0 : 0xf7f9fc);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const back = 1 - Math.abs(z / (depth / 2)); // highest along the middle of the range
    const edge = Math.min(1, (width / 2 - Math.abs(x)) / (width * 0.18)); // taper at the ends
    const r = ridged(x * 0.011 + seed, z * 0.02 + seed * 0.7);
    const hgt = Math.max(0, r * height * back * back * Math.max(0, edge)) + fbm(x * 0.05, z * 0.05) * 3;
    pos.setY(i, hgt);
    const t = hgt / height;
    const jitter = (fbm(x * 0.08 + seed, z * 0.08) - 0.5) * 0.18;
    if (t + jitter > snow) c.copy(white);
    else if (t + jitter > snow - 0.08) c.copy(rock).lerp(white, (t + jitter - (snow - 0.08)) / 0.08);
    else if (t + jitter > 0.22) c.copy(forest).lerp(rock, Math.min(1, (t + jitter - 0.22) / 0.2));
    else c.copy(meadow).lerp(forest, (t + jitter) / 0.22);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
}

/** Drifting clouds on a dome above everything (noise-shaped cumulus, lit from the sun's side). */
function cloudDome({ dark, sunDir }) {
  const uniforms = {
    uTime: { value: 0 },
    uSun: { value: sunDir.clone().normalize() },
    uLit: { value: new THREE.Color(dark ? 0xffb38a : 0xffffff) },
    uShade: { value: new THREE.Color(dark ? 0x5b4a6b : 0xb8c4d6) },
    uCover: { value: dark ? 0.5 : 0.53 },
    uBright: { value: dark ? 0.9 : 1.7 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.BackSide,
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uSun; uniform vec3 uLit; uniform vec3 uShade; uniform float uCover; uniform float uBright;
      varying vec3 vDir;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * n(p); p = p * 2.02 + 11.3; a *= 0.5; } return s; }
      void main() {
        if (vDir.y < 0.0) discard;
        vec2 p = vDir.xz / (vDir.y + 0.12) * 1.15 + vec2(uTime * 0.006, uTime * 0.002);
        float d = fbm(p);
        float cover = smoothstep(uCover, uCover + 0.22, d);
        float horizon = smoothstep(0.0, 0.18, vDir.y);
        float alpha = cover * horizon * 0.95;
        if (alpha < 0.01) discard;
        // Lit on the side facing the sun: compare the density a little further towards it.
        float toward = fbm(p + normalize(uSun.xz + 1e-4) * 0.06);
        float lit = clamp(0.55 + (d - toward) * 4.0, 0.0, 1.0);
        float glow = pow(max(dot(normalize(vDir), uSun), 0.0), 6.0);
        vec3 col = mix(uShade, uLit, lit) * uBright + uLit * glow * 0.6 * (1.0 - cover * 0.5);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
  dome.renderOrder = -1;
  return { mesh: dome, uniforms };
}

/** Cut stone blocks, a little worn and uneven, in a ring around the battle field. */
function stoneRing(radius, mat, seed) {
  const group = new THREE.Group();
  const r = rng(seed);
  let a = 0;
  while (a < Math.PI * 2) {
    const len = 0.55 + r() * 0.45;
    const w = 0.38 + r() * 0.15;
    const h = 0.22 + r() * 0.2;
    const geo = new THREE.BoxGeometry(len, h, w, 2, 1, 1);
    const block = new THREE.Mesh(geo, mat);
    const step = len / radius;
    const mid = a + step / 2;
    block.position.set(Math.cos(mid) * (radius + w / 2), h / 2 - 0.03 + r() * 0.03, Math.sin(mid) * (radius + w / 2));
    block.rotation.set((r() - 0.5) * 0.08, -mid + Math.PI / 2 + (r() - 0.5) * 0.08, (r() - 0.5) * 0.06);
    block.castShadow = block.receiveShadow = true;
    group.add(block);
    a += step + 0.015;
  }
  return group;
}

/** Old broken stone pillars and wall pieces standing in the grass. */
function ruins(mat, seed, spots) {
  const group = new THREE.Group();
  const r = rng(seed);
  for (const [x, z] of spots) {
    const y = terrainHeight(x, z);
    if (r() < 0.55) {
      const h = 1.6 + r() * 2.6;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, h, 10), mat);
      pillar.position.set(x, y + h / 2 - 0.1, z);
      pillar.rotation.set((r() - 0.5) * 0.12, r() * Math.PI, (r() - 0.5) * 0.12);
      pillar.castShadow = pillar.receiveShadow = true;
      group.add(pillar);
      const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 1.2 + r(), 10), mat);
      fallen.rotation.set(Math.PI / 2, 0, r() * Math.PI);
      fallen.position.set(x + 1.2, y + 0.3, z + 0.6);
      fallen.castShadow = fallen.receiveShadow = true;
      group.add(fallen);
    } else {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4 - row; col++) {
          if (r() < 0.2) continue;
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.5), mat);
          b.position.set(x + col * 0.72 + row * 0.3 + (r() - 0.5) * 0.05, y + 0.2 + row * 0.42, z);
          b.rotation.y = (r() - 0.5) * 0.1;
          b.castShadow = b.receiveShadow = true;
          group.add(b);
        }
      }
    }
  }
  return group;
}

/** Little flowers in the grass: pink, white and yellow. */
function flowerField(count, { inner, outer, dark, seed = 41 }) {
  const geo = new THREE.IcosahedronGeometry(0.045, 0);
  geo.scale(1, 0.55, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0xffffff, emissiveIntensity: dark ? 0 : 0.05 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const r = rng(seed);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const palette = [0xff8fc8, 0xffb3d9, 0xffffff, 0xfff2a8, 0xffd23f, 0xd9a6ff];
  for (let i = 0; i < count; i++) {
    // Flowers grow in patches.
    const patch = Math.floor(r() * 60);
    const pr = rng(patch * 97 + seed);
    const pa = pr() * Math.PI * 2;
    const pd = inner + 1 + pr() * (outer - inner - 1);
    let x = Math.cos(pa) * pd + (r() - 0.5) * 3.2;
    const z = Math.sin(pa) * pd + (r() - 0.5) * 3.2;
    if (inLake(x, z, 1)) x = -x; // not in the water
    m.makeTranslation(x, terrainHeight(x, z) + 0.12 + r() * 0.2, z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.setHex(palette[(patch + Math.floor(r() * 2)) % palette.length]));
  }
  mesh.frustumCulled = false;
  return mesh;
}

const paint = (g, hex) => {
  const col = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
};

/** One broadleaf tree shape (trunk and two leafy crowns), for instancing. */
function broadleafGeometry(dark) {
  const trunk = new THREE.CylinderGeometry(0.12, 0.2, 1.6, 6);
  trunk.translate(0, 0.8, 0);
  const top1 = mergeVertices(new THREE.IcosahedronGeometry(1.05, 1));
  top1.scale(1, 1.25, 1);
  top1.translate(0, 2.3, 0);
  const top2 = mergeVertices(new THREE.IcosahedronGeometry(0.75, 1));
  top2.translate(0.25, 3.1, 0.1);
  for (const g of [trunk, top1, top2]) g.deleteAttribute('uv');
  // Merging keeps each part's own smooth normals.
  return mergeGeometries([paint(trunk.toNonIndexed(), 0x6b4a2f), paint(top1.toNonIndexed(), dark ? 0x2c4424 : 0x3f7a2f), paint(top2.toNonIndexed(), dark ? 0x355128 : 0x5a9a3c)]);
}

/** One pine shape, 1 unit tall: a short trunk under three stacked cones with crisp facets. */
function pineGeometry(dark) {
  const trunk = new THREE.CylinderGeometry(0.11, 0.18, 0.4, 6);
  trunk.translate(0, 0.2, 0);
  trunk.deleteAttribute('uv');
  const parts = [paint(trunk.toNonIndexed(), 0x4a3524)];
  const greens = dark ? [0x203820, 0x243e23, 0x294526] : [0x2b5426, 0x30602b, 0x386b31];
  [[0.38, 0.3, 0.55], [0.6, 0.23, 0.45], [0.8, 0.15, 0.35]].forEach(([y, rad, h], i) => {
    const cone = new THREE.ConeGeometry(rad, h, 8, 1);
    cone.translate(0, y, 0);
    cone.deleteAttribute('uv');
    const flat = cone.toNonIndexed();
    flat.computeVertexNormals(); // per face: the faceted look of needles in clumps
    parts.push(paint(flat, greens[i]));
  });
  return mergeGeometries(parts);
}

/**
 * A forest stretching away to the hills, in clumps with meadows between: broadleaf trees and pines,
 * each one shape instanced many times. Returns a group of the two instanced meshes.
 */
function forest(count, { minR, maxR, dark, seed = 61 }) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const pineMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  const broad = new THREE.InstancedMesh(broadleafGeometry(dark), mat, count);
  const pines = new THREE.InstancedMesh(pineGeometry(dark), pineMat, count);
  const r = rng(seed);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  let nb = 0;
  let np = 0;
  for (let tries = 0; nb + np < count && tries < count * 8; tries++) {
    const a = r() * Math.PI * 2;
    const d = minR + r() * (maxR - minR);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (z > 0 && Math.abs(x) < d * 0.6) continue; // the view behind the camera stays open
    if (fbm(x * 0.02, z * 0.02) < 0.5) continue; // woods in clumps, meadows between
    if (inLake(x, z, 3)) continue;
    const y = terrainHeight(x, z);
    if (y > 24) continue; // bare rock and snow above the tree line
    p.set(x, y - 0.2, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    if (r() < 0.42) {
      const k = 6 + r() * 7;
      m.compose(p, q, sc.set(k, k * (0.9 + r() * 0.25), k));
      pines.setMatrixAt(np, m);
      pines.setColorAt(np++, c.setRGB(0.85 + r() * 0.3, 0.85 + r() * 0.3, 0.8 + r() * 0.25));
    } else {
      const k = 1.4 + r() * 1.6;
      m.compose(p, q, sc.set(k, k * (0.9 + r() * 0.4), k));
      broad.setMatrixAt(nb, m);
      broad.setColorAt(nb++, c.setScalar(0.8 + r() * 0.35));
    }
  }
  broad.count = nb;
  pines.count = np;
  const group = new THREE.Group();
  group.add(broad, pines);
  return group;
}

/**
 * Soft banks of mist lying in the distance, spread across what the camera looks at (the battle
 * camera's view, or all around the far side in the showcase).
 */
function mist(dark, tex, view) {
  const group = new THREE.Group();
  const r = rng(83);
  const ox = view?.x ?? 0;
  const oz = view?.z ?? 0;
  const ahead = view ? Math.atan2(view.fz, view.fx) : -Math.PI / 2;
  for (let i = 0; i < 14; i++) {
    const a = ahead + (r() - 0.5) * (view ? 1.5 : 2.4);
    const d = 60 + r() * 130;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: dark ? 0xc9b3c9 : 0xe4ebf2, transparent: true, opacity: 0.18 + r() * 0.14, depthWrite: false }));
    const x = ox + Math.cos(a) * d;
    const z = oz + Math.sin(a) * d;
    sprite.position.set(x, Math.max(terrainHeight(x, z), LAKE.level) + 3 + r() * 3, z);
    sprite.scale.set(40 + d * 0.3 + r() * 30, 9 + d * 0.05 + r() * 6, 1);
    group.add(sprite);
  }
  return group;
}

// ---- grass that sways in the wind ----

/**
 * Grass: up to `count` blades drawn in one call, each a tapered strip bent by gusts of wind that
 * roll across the meadow, darker at the roots and glowing where the sun shines through. With a
 * fixed camera (`view`) the blades go where it looks, densest close by and a little bigger far
 * away; otherwise they spread around the field.
 */
function grassField(count, { inner, outer, dark, view, sunDir, seed = 7 }) {
  const blade = new THREE.PlaneGeometry(1, 1, 1, 5);
  blade.translate(0, 0.5, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(blade.index);
  geo.setAttribute('position', blade.attributes.position);
  geo.setAttribute('uv', blade.attributes.uv);
  const offsets = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  const r = rng(seed);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 14; tries++) {
    const x = (r() * 2 - 1) * outer;
    const z = (r() * 2 - 1) * outer;
    const d = Math.hypot(x, z);
    if (d < inner || d > outer) continue;
    let dc = d - inner;
    if (view) {
      const dx = x - view.x;
      const dz = z - view.z;
      dc = Math.hypot(dx, dz);
      if (dc > 2.5 && (dx * view.fx + dz * view.fz) / dc < 0.35) continue; // behind or beside the camera
    }
    if (r() > Math.min(1, (9 / Math.max(dc, 9)) ** 1.6)) continue;
    const y = terrainHeight(x, z);
    if (y < LAKE.level + 0.2) continue;
    const patch = fbm(x * 0.2, z * 0.2, 3);
    if (r() > 0.35 + patch * 0.9) continue;
    const boost = 1 + Math.max(0, dc - 8) * 0.03;
    offsets.set([x, y - 0.03, z], n * 3);
    params.set([(0.12 + r() * 0.22) * (0.7 + patch * 0.6) * boost, (0.026 + r() * 0.02) * boost, r() * Math.PI * 2, r()], n * 4);
    n++;
  }
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geo.setAttribute('iParams', new THREE.InstancedBufferAttribute(params, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSun: { value: sunDir.clone().normalize() },
      uSunCol: { value: dark ? new THREE.Color(1.0, 0.72, 0.5) : new THREE.Color(1.0, 0.94, 0.85) },
      uSky: { value: dark ? new THREE.Color(0.36, 0.33, 0.48) : new THREE.Color(0.5, 0.58, 0.72) },
      uTint: { value: dark ? new THREE.Color(0.66, 0.62, 0.72) : new THREE.Color(1, 1, 1) },
    }]),
    vertexShader: `
      attribute vec3 iOffset; attribute vec4 iParams; uniform float uTime;
      varying float vH, vVar, vGust; varying vec3 vW, vNh;
      #include <common>
      #include <fog_pars_vertex>
      ${GLSL_NOISE}
      void main() {
        float h = uv.y;
        float hgt = iParams.x, wid = iParams.y, rot = iParams.z, vr = iParams.w;
        float taper = 1.0 - pow(h, 1.5);
        float c = cos(rot), s = sin(rot);
        vec3 p = vec3(position.x * wid * taper * c, position.y * hgt, position.x * wid * taper * s);
        vec3 side = vec3(-s, 0.0, c);
        float gust = nFbm3(iOffset.xz * 0.1 + vec2(-uTime * 0.32, uTime * 0.11));
        float sway = sin(uTime * 2.3 + iOffset.x * 1.3 + iOffset.z * 0.9 + vr * 6.2832) * 0.1;
        float wind = (gust - 0.35) * 1.5 + sway;
        vec3 wd = normalize(vec3(1.0, 0.0, 0.35));
        float bend = pow(h, 1.7) * hgt;
        p += wd * bend * wind * 0.55 + side * bend * (vr - 0.5) * 0.18;
        p.y -= bend * abs(wind) * 0.12;
        vec3 world = p + iOffset;
        vH = h; vVar = vr; vW = world; vGust = gust; vNh = side + wd * 0.25 * h;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uSun, uSunCol, uSky, uTint;
      varying float vH, vVar, vGust; varying vec3 vW, vNh;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 tip = mix(vec3(0.4, 0.64, 0.18), vec3(0.62, 0.66, 0.26), smoothstep(0.7, 1.0, vVar));
        vec3 col = mix(vec3(0.07, 0.14, 0.04), tip, smoothstep(0.0, 1.0, vH));
        col *= 0.85 + vVar * 0.3;
        vec3 V = normalize(cameraPosition - vW);
        vec3 Nh = dot(vNh, V) < 0.0 ? -vNh : vNh;
        vec3 N = normalize(Nh + vec3(0.0, 0.8, 0.0));
        float diff = clamp(dot(N, uSun) * 0.6 + 0.45, 0.0, 1.0);
        float ao = mix(0.3, 1.0, smoothstep(0.0, 0.75, vH));
        col *= (uSky * 0.6 + uSunCol * diff * 0.9) * ao;
        float back = pow(max(dot(-V, uSun), 0.0), 3.0);
        col += vec3(0.45, 0.6, 0.12) * uSunCol * back * vH * 0.8;
        col += vec3(0.05, 0.06, 0.02) * smoothstep(0.5, 0.8, vGust) * vH;
        // Worked out in display colours (like a painted reference); converted to linear light here.
        gl_FragColor = vec4(pow(col * uTint, vec3(2.2)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms: mat.uniforms, max: n };
}

// ---- props ----

/** A soft round puff (mist sprites). */
function cloudPuffTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  const r = rng(91);
  for (let i = 0; i < 40; i++) {
    const x = 30 + r() * 196;
    const y = 40 + r() * 50;
    const rad = 18 + r() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function rockGeometry(r, seed, detail = 2) {
  // Shared vertices, so the jitter keeps it in one piece and the shading is smooth (not faceted).
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
  const pos = g.attributes.position;
  const rand = rng(seed);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(0.75 + rand() * 0.45);
    v.y *= 0.6;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.scale(r, r, r);
  return g;
}

function tree(seed, dark) {
  const r = rng(seed);
  const group = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 });
  const h = 1.6 + r() * 1.4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.18, h, 7), trunkMat);
  trunk.position.y = h / 2;
  trunk.castShadow = true;
  group.add(trunk);
  const greens = dark ? [0x2f4a26, 0x36552a, 0x2a4221] : [0x3f7d2f, 0x4a8c35, 0x356b29, 0x5a9a3c];
  if (r() < 0.45) {
    // Pine: stacked cones.
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.0 - i * 0.25, 1.3, 9), new THREE.MeshStandardMaterial({ color: greens[i % greens.length], roughness: 0.9, flatShading: true }));
      cone.position.y = h * 0.7 + i * 0.6;
      cone.castShadow = true;
      group.add(cone);
    }
  } else {
    // Broadleaf: a cluster of lumpy spheres.
    for (let i = 0; i < 4; i++) {
      const blob = new THREE.Mesh(rockGeometry(0.75 + r() * 0.45, seed * 10 + i), new THREE.MeshStandardMaterial({ color: greens[Math.floor(r() * greens.length)], roughness: 0.9 }));
      blob.position.set((r() - 0.5) * 0.9, h + 0.2 + r() * 0.7, (r() - 0.5) * 0.9);
      blob.scale.y = 1.4;
      blob.castShadow = true;
      group.add(blob);
    }
  }
  group.scale.setScalar(1.1 + r() * 0.7);
  return group;
}

/** Field markings in chalk: the outer ring, the centre line and centre circle. */
function fieldLines(radius) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,250,0.85)';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(512, 512, 470, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(512, 512, 110, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(512 - 470 * Math.cos(0.6), 512 + 470 * Math.sin(0.6));
  g.lineTo(512 + 470 * Math.cos(0.6), 512 - 470 * Math.sin(0.6));
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 1, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Build the world into `scene`. Returns { sun, update(seconds), setQuality(q), render(), resize(w,h), dispose() }.
 */
export function buildWorld({ scene, renderer, camera, dark = false, mode = 'battle', quality = 'high' }) {
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  // Where the (fixed) battle camera stands and looks, on the ground: grass, mist and pollen go there.
  let view = null;
  if (mode !== 'showcase') {
    const dir = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    view = { x: camera.position.x, z: camera.position.z, fx: dir.x, fz: dir.z };
  }

  // Neutral tone mapping keeps the models' colours true (filmic curves wash out reds and yellows).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = dark ? 0.72 : 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Sky (physical atmosphere) and the sun.
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = dark ? 8 : 2.4;
  u.rayleigh.value = dark ? 2.6 : 1.5;
  u.mieCoefficient.value = dark ? 0.008 : 0.003;
  u.mieDirectionalG.value = dark ? 0.86 : 0.78;
  const elevation = dark ? 3.5 : 44;
  const azimuth = dark ? 235 : 150;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // Light from the sky on every surface (reflections and soft fill).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(4000);
  for (const k of Object.keys(u)) envSky.material.uniforms[k].value = u[k].value?.clone?.() ?? u[k].value;
  envScene.add(envSky);
  const env = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = env;
  scene.environmentIntensity = dark ? 0.55 : 0.85;
  envSky.material.dispose();
  envSky.geometry.dispose();

  // Aerial perspective: things fade to a soft blue with distance (the mountains most of all).
  const haze = new THREE.Color(dark ? 0x8e7a8f : 0xb9d3ea);
  scene.fog = new THREE.Fog(haze, 60, 1150);

  const sun = new THREE.DirectionalLight(dark ? 0xffb27a : 0xfff4e0, dark ? 2.2 : 3.2);
  sun.position.copy(sunDir).multiplyScalar(dark ? 20 : 16);
  if (dark) sun.position.y = Math.max(sun.position.y, 6); // a low sun still needs to light the arena
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  const sc = sun.shadow.camera;
  sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 60;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(dark ? 0x8c9bd9 : 0xcfe7ff, dark ? 0x2a2433 : 0x5b6b3a, dark ? 0.35 : 0.45);
  scene.add(hemi);

  // Ground: rolling grass land, flat around the arena.
  const groundGeo = new THREE.PlaneGeometry(640, 640, 220, 220);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, terrainHeight(gp.getX(i), gp.getZ(i)) - 0.03);
  groundGeo.computeVertexNormals();
  paintTerrain(groundGeo, dark);
  const grassTex = track(noiseTexture({
    base: dark ? '#3c5530' : '#5f9a3e', seed: 3, repeat: 170,
    tones: dark ? ['rgba(48,74,38,ALPHA)', 'rgba(70,92,48,ALPHA)', 'rgba(36,56,30,ALPHA)', 'rgba(88,98,58,ALPHA)'] : ['rgba(84,140,56,ALPHA)', 'rgba(118,166,70,ALPHA)', 'rgba(70,118,46,ALPHA)', 'rgba(140,160,80,ALPHA)', 'rgba(96,120,60,ALPHA)'],
  }));
  const groundMat = new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 0.95 });
  // The grass texture's average brightness (linear), so rock and snow keep its detail but not its green.
  groundMat.onBeforeCompile = bareGroundShader(dark ? 0.077 : 0.259);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  const bigSurfaces = [ground];
  ground.receiveShadow = true;
  scene.add(ground);

  // The battle field: packed dirt with chalk lines, ringed by stones.
  const fieldR = mode === 'showcase' ? 4.6 : 6.2;
  const dirtTex = track(noiseTexture({
    base: dark ? '#7a6550' : '#b79b74', seed: 11, repeat: 3, blotches: 1400, specks: 16000,
    tones: dark ? ['rgba(96,80,62,ALPHA)', 'rgba(70,58,46,ALPHA)', 'rgba(120,102,80,ALPHA)'] : ['rgba(160,132,98,ALPHA)', 'rgba(198,176,140,ALPHA)', 'rgba(140,112,82,ALPHA)', 'rgba(214,196,160,ALPHA)'],
  }));
  const field = new THREE.Mesh(new THREE.CircleGeometry(fieldR, 96), new THREE.MeshStandardMaterial({ map: dirtTex, roughness: 0.98 }));
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.002;
  field.receiveShadow = true;
  bigSurfaces.push(field);
  const lines = fieldLines(fieldR - 0.25);
  scene.add(field, lines);
  bigSurfaces.push(lines);

  const stoneTex = track(noiseTexture({
    base: dark ? '#77777c' : '#a7a6a2', seed: 21, repeat: 1, size: 256, blotches: 300, specks: 3000,
    tones: ['rgba(120,120,118,ALPHA)', 'rgba(160,158,150,ALPHA)', 'rgba(90,90,92,ALPHA)', 'rgba(130,140,120,ALPHA)'],
  }));
  const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.85 });
  const rocks = new THREE.Group();
  const rr = rng(5);
  rocks.add(stoneRing(fieldR + 0.05, stoneMat, 9));
  rocks.add(ruins(stoneMat, 13, mode === 'showcase'
    ? [[-7, -9], [8, -11], [-12, -3]]
    : [[-11, -12], [10, -14], [-15, -4], [16, -6], [3, -19]]));
  // Boulders scattered in the grass.
  for (let i = 0; i < 26; i++) {
    const a = rr() * Math.PI * 2;
    const d = fieldR + 3 + rr() * 22;
    if (inLake(Math.cos(a) * d, Math.sin(a) * d, 1)) continue;
    const big = new THREE.Mesh(rockGeometry(0.4 + rr() * 1.1, 300 + i), stoneMat);
    big.position.set(Math.cos(a) * d, terrainHeight(Math.cos(a) * d, Math.sin(a) * d) + 0.1, Math.sin(a) * d);
    big.rotation.y = rr() * Math.PI;
    big.castShadow = big.receiveShadow = true;
    rocks.add(big);
  }
  scene.add(rocks);
  bigSurfaces.push(rocks);

  // Trees around the field, more of them further out; none in front of the camera.
  const trees = new THREE.Group();
  const tr = rng(17);
  let placed = 0;
  for (let i = 0; placed < 18 && i < 400; i++) {
    const a = tr() * Math.PI * 2;
    const d = fieldR + 12 + tr() * 26;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (z > fieldR - 1 && Math.abs(x) < d * 0.75) continue; // keep the view open
    if (inLake(x, z, 3)) continue;
    const t = tree(1000 + i, dark);
    t.position.set(x, terrainHeight(x, z) - 0.05, z);
    trees.add(t);
    placed++;
  }
  scene.add(trees);
  bigSurfaces.push(trees);

  // Snow-capped ranges on the far horizon, behind the land's own hills and peaks, fading into the haze.
  const hills = new THREE.Group();
  const hr = rng(29);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + hr() * 0.25;
    const d = 380 + hr() * 120;
    const range = mountainRange({ width: 420 + hr() * 200, depth: 160, height: 120 + hr() * 90, seed: i * 7.3, dark, snow: 0.5 + hr() * 0.08 });
    range.position.set(Math.cos(a) * d, -6, Math.sin(a) * d);
    range.lookAt(0, -6, 0);
    hills.add(range);
    bigSurfaces.push(range);
  }
  scene.add(hills);
  const woods = forest(1400, { minR: 40, maxR: 190, dark });
  scene.add(woods);
  bigSurfaces.push(woods);
  const mistBanks = mist(dark, track(cloudPuffTexture()), view);
  scene.add(mistBanks);
  const clouds = cloudDome({ dark, sunDir });
  scene.add(clouds.mesh);
  const water = lake({ dark, sunDir, sunColor: sun.color, horizon: haze });
  scene.add(water.mesh);

  // Swaying grass around the field (fewer blades on "Standard", none on "Basic"), flowers, pollen.
  const grass = grassField(60000, { inner: fieldR + 0.6, outer: 60, dark, view, sunDir });
  scene.add(grass.mesh);
  const flowers = flowerField(3000, { inner: fieldR + 0.8, outer: fieldR + 22, dark });
  scene.add(flowers);
  const air = pollen(600, { dark, tex: track(dotTexture()), view });
  scene.add(air.points);

  // Post-processing for "High": ambient occlusion, bloom on bright effects, then filmic output.
  let composer = null;
  let gtao = null;
  let bloom = null;
  const size = new THREE.Vector2();
  const makeComposer = () => {
    renderer.getSize(size);
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12 });
    composer.addPass(gtao);
    // Only really bright things (attack effects, the flash) glow; the sky and ground don't.
    bloom = new UnrealBloomPass(size.clone(), 0.22, 0.25, 1.35);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  };

  let current = null;
  const setQuality = (q) => {
    current = ['high', 'standard', 'basic'].includes(q) ? q : 'standard';
    const high = current === 'high';
    const basic = current === 'basic';
    renderer.setPixelRatio(basic ? 0.75 : Math.min(window.devicePixelRatio || 1, high ? 1.5 : 1.25));
    clouds.mesh.visible = !basic;
    mistBanks.visible = !basic;
    renderer.shadowMap.enabled = !basic;
    sun.castShadow = !basic;
    sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    sun.shadow.radius = high ? 4 : 2;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    // Basic: no sky lighting (image-based light is the costliest part without a graphics card) and
    // cheaper materials on the big surfaces; a brighter fill light makes up for it.
    scene.environment = basic ? null : env;
    hemi.intensity = basic ? (dark ? 0.9 : 1.6) : (dark ? 0.35 : 0.45);
    for (const root of bigSurfaces) {
      root.traverse((mesh) => {
        if (!mesh.isMesh || mesh.material?.type !== (mesh.userData.full ? mesh.userData.full.type : 'MeshStandardMaterial')) return;
        const full = (mesh.userData.full ??= mesh.material);
        mesh.userData.cheap ??= new THREE.MeshLambertMaterial({
          map: full.map, vertexColors: full.vertexColors, color: full.color, transparent: full.transparent,
          depthWrite: full.depthWrite, side: full.side, flatShading: full.flatShading,
        });
        if (full.onBeforeCompile && full.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) mesh.userData.cheap.onBeforeCompile = full.onBeforeCompile;
        mesh.material = basic ? mesh.userData.cheap : full;
      });
    }
    scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; }); // shadows / lighting changes recompile
    grass.mesh.visible = !basic;
    grass.mesh.geometry.instanceCount = Math.min(grass.max, high ? 60000 : 20000);
    air.points.visible = !basic;
    air.points.geometry.setDrawRange(0, high ? 600 : 250);
    flowers.count = high ? 3000 : basic ? 0 : 1000;
    for (const kind of woods.children) {
      kind.userData.max ??= kind.count;
      kind.count = high ? kind.userData.max : Math.round(kind.userData.max * (basic ? 0.25 : 0.5));
    }
    trees.traverse((o) => { if (o.isMesh) o.castShadow = high; });
    if (high && !composer) makeComposer();
    if (!high && composer) {
      composer.dispose?.();
      gtao?.dispose?.();
      bloom?.dispose?.();
      composer = gtao = bloom = null;
    }
    renderer.getSize(size);
    composer?.setSize(size.x, size.y);
  };
  setQuality(quality);
  let last = null;

  return {
    sun,
    get quality() { return current; },
    setQuality,
    update(seconds) {
      const dt = Math.min(0.1, Math.max(0, seconds - (last ?? seconds)));
      last = seconds;
      grass.uniforms.uTime.value = seconds;
      clouds.uniforms.uTime.value = seconds;
      water.uniforms.uTime.value = seconds;
      if (air.points.visible) air.update(seconds, dt);
    },
    render() {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
    resize(w, h) { composer?.setSize(w, h); },
    dispose() {
      composer?.dispose?.();
      gtao?.dispose?.();
      bloom?.dispose?.();
      env.dispose();
      pmrem.dispose();
      for (const d of disposables) d.dispose?.();
    },
  };
}
