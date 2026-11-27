// The PokéBattles world around the fighters, ported from the owner's "Hi-Fi v4" battle reference:
// a sky dome that follows the camera (gradient, sun disc and glow, drifting fBm clouds), fog in the
// sky's horizon colour (FogExp2), a hemisphere light and an angled sun with soft shadows under ACES
// tone mapping, one land mesh from the arena to snowy ridged mountains (vertex colours), a lake,
// instanced shader grass bending in gusts, pine and broadleaf woods, ruins, flowers, pollen and mist.
//
// Everything here is generated in code (procedural textures and shapes): no downloaded assets.
//
// Besides this meadow, a battle can be held in three stadiums (stadiums.js) under the same sky dome,
// fog, lights and tone mapping, and in sun, rain, a sandstorm or snow (weatherFx.js).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildStadium, lookFor, starField } from './stadiums.js';
import { addSurfaceDepth, contactShadows, contactTexture, leafCards, leafClusterTexture, needleClusterTexture, skirtGeometry, skyEnvironment } from './surface.js';
import { barkTexture } from './wood.js';
import { buildWeather, WEATHER_LOOK } from './weatherFx.js';
import { addCaustics, buildReef } from '../reef/reef.js';
import { createEffects, MIRROR_GLSL, planarMirror } from './postfx.js';
import { addGroundLayers, hdScenery } from './hdScenery.js';

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

/**
 * `p` ({ x, y, z }) moved onto the shadow map's texel grid, as seen along the light's direction `dir`
 * (unit { x, y, z }): a shadow camera that follows a moving player in whole texels draws the same
 * shadow edges every frame instead of shimmering. Pure.
 */
export function snapToTexel(p, dir, texel) {
  const up0 = Math.abs(dir.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const r0 = cross(up0, dir);
  const rl = Math.hypot(r0.x, r0.y, r0.z) || 1;
  const r = { x: r0.x / rl, y: r0.y / rl, z: r0.z / rl };
  const u = cross(dir, r);
  const a = Math.round(dot(p, r) / texel) * texel;
  const b = Math.round(dot(p, u) / texel) * texel;
  const c = dot(p, dir);
  return { x: a * r.x + b * u.x + c * dir.x, y: a * r.y + b * u.y + c * dir.y, z: a * r.z + b * u.z + c * dir.z };
}

export function rng(seed) {
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
export function noiseTexture({ size = 512, base, tones, blotches = 900, specks = 9000, seed = 1, repeat = 1, anisotropy = 8 }) {
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
export const LAKE = { x: 27, z: -21, r: 10, level: -0.6 };
const lakeDistance = (x, z) => Math.hypot(x - LAKE.x, z - LAKE.z);
const inLake = (x, z, pad = 0) => lakeDistance(x, z) < LAKE.r * 1.3 + pad;
/** The Sanctuary's lake shore: sand out to this far from the lake's middle. */
export const SHORE_SAND = LAKE.r * 1.75;

/**
 * The land, one surface from the arena to the peaks: flat around the arena, a softly uneven meadow,
 * rolling hills, then ridged mountains far out; with a hollow for the lake.
 */
export function terrainHeight(x, z, flat = 16) {
  const d = Math.hypot(x, z);
  let h = (fbm(x * 0.035, z * 0.035, 4) - 0.48) * 1.8 * smooth(flat, flat + 14, d);
  h += smooth(flat + 14, 110, d) * (fbm(x * 0.011 + 7.3, z * 0.011 - 2.1, 5) - 0.4) * 16;
  if (d > 140) {
    // Mountains rising with distance: ridges bent by a slow warp (so they wander like real ranges, not
    // a grid), with crags and gullies on top.
    const wx = x + (fbm(x * 0.008, z * 0.008, 3) - 0.5) * 90;
    const wz = z + (fbm(x * 0.008 + 11, z * 0.008 - 7, 3) - 0.5) * 90;
    const range = ridged(wx * 0.0055 + 3.1, wz * 0.0055 + 9.4, 6);
    h += smooth(150, 270, d) * (range * 85 + ridged(wx * 0.03, wz * 0.03, 3) * 9 * range);
  }
  const lake = 1 - smooth(LAKE.r * 0.5, LAKE.r * 1.3, lakeDistance(x, z));
  return h * (1 - lake) - 2.4 * lake;
}

/**
 * Colour the land by height and slope, as in the Hi-Fi v4 reference: two meadow greens, dirt
 * patches, sand at the lake shore, rock on steep slopes and high up, snow on the peaks.
 * The reference's colours are display (sRGB) values.
 */
function paintTerrain(geo, dark) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  const meadowA = dark ? srgb(0.09, 0.15, 0.07) : srgb(0.10, 0.20, 0.05);
  const meadowB = dark ? srgb(0.17, 0.23, 0.10) : srgb(0.20, 0.31, 0.08);
  const dirt = srgb(0.32, 0.27, 0.17);
  const rock = dark ? srgb(0.33, 0.31, 0.36) : srgb(0.38, 0.39, 0.40);
  const snow = dark ? srgb(0.88, 0.80, 0.90) : srgb(0.93, 0.95, 0.99);
  const sand = srgb(0.58, 0.53, 0.40);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = nor.getY(i);
    c.copy(meadowA).lerp(meadowB, fbm(x * 0.05, z * 0.05, 3));
    c.lerp(dirt, smooth(0.6, 0.8, fbm(x * 0.02 + 40, z * 0.02, 4)) * 0.28); // a few worn patches, not bald ones
    if (lakeDistance(x, z) < LAKE.r * 1.6) c.lerp(sand, smooth(0.15, -0.6, y));
    // Rock: layered in bands (strata), darker on the steepest faces and in the gullies.
    const strata = 0.5 + 0.5 * Math.sin(y * 0.55 + fbm(x * 0.03, z * 0.03, 3) * 5);
    const rockHere = rock.clone().multiplyScalar(0.72 + strata * 0.38 - smooth(0.62, 0.3, ny) * 0.25 + (fbm(x * 0.09, z * 0.09, 3) - 0.5) * 0.3);
    c.lerp(rockHere, Math.max(smooth(0.86, 0.66, ny), smooth(17, 32, y) * 0.85));
    c.lerp(snow, smooth(42, 60, y + fbm(x * 0.03, z * 0.03, 3) * 12) * smooth(0.45, 0.78, ny));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** The reference's detail texture: light grey speckles that break up the vertex colours. */
function speckleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = rng(57);
  g.fillStyle = '#e6e6e6';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const v = Math.floor(170 + r() * 85);
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.beginPath();
    g.arc(r() * 256, r() * 256, 1 + r() * 5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(100, 100);
  t.anisotropy = 8;
  return t;
}

// Shared GLSL value noise for the water and grass shaders.
const GLSL_NOISE = `
  float nHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float nValue(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(nHash(i), nHash(i + vec2(1.0, 0.0)), u.x), mix(nHash(i + vec2(0.0, 1.0)), nHash(i + vec2(1.0, 1.0)), u.x), u.y); }
  float nFbm(vec2 p) { float v = 0.0, a = 0.5; mat2 r = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { v += a * nValue(p); p = r * p; a *= 0.5; } return v; }
  float nFbm3(vec2 p) { float v = 0.0, a = 0.5; mat2 r = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 3; i++) { v += a * nValue(p); p = r * p; a *= 0.5; } return v / 0.875; }
`;

/**
 * The colours the sky, fog and water share. Like the reference, the custom shaders work with
 * display (sRGB) values, so the fog meets the sky's horizon exactly.
 */
function palette(dark, look = null) {
  const c = (r, g, b) => new THREE.Color(r, g, b); // raw display values for the shaders
  if (look) return Object.fromEntries(Object.entries(look.sky).map(([k, v]) => [k, c(...v)]));
  return dark
    ? { horizon: c(0.86, 0.62, 0.58), zenith: c(0.17, 0.17, 0.36), glow: c(1.0, 0.62, 0.38), sunCol: c(1.0, 0.74, 0.52), cloudShade: c(0.38, 0.32, 0.48), cloudLit: c(1.0, 0.76, 0.64), deep: c(0.06, 0.08, 0.14) }
    : { horizon: c(0.74, 0.80, 0.86), zenith: c(0.22, 0.43, 0.78), glow: c(1.0, 0.86, 0.66), sunCol: c(1.0, 0.94, 0.85), cloudShade: c(0.58, 0.63, 0.72), cloudLit: c(1.0, 0.98, 0.95), deep: c(0.05, 0.17, 0.21) };
}

/**
 * The sky dome from the reference: a horizon-to-zenith gradient, the sun's disc and glow, and
 * drifting fBm clouds lit from the sun's side. It follows the camera, so it never gets closer.
 */
function skyDome({ colors, sunDir }) {
  const uniforms = {
    uTime: { value: 0 },
    uClouds: { value: 1 },
    uSunDir: { value: sunDir.clone().normalize() },
    uZenith: { value: colors.zenith },
    uHorizon: { value: colors.horizon },
    uGlow: { value: colors.glow },
    uCloudShade: { value: colors.cloudShade },
    uCloudLit: { value: colors.cloudLit },
  };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    uniforms,
    vertexShader: `varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uTime, uClouds; uniform vec3 uSunDir, uZenith, uHorizon, uGlow, uCloudShade, uCloudLit;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir); float h = d.y; float s = max(dot(d, uSunDir), 0.0);
        float t = pow(clamp(h, 0.0, 1.0), 0.5);
        vec3 col = mix(uHorizon, uZenith, t);
        col = mix(col, uGlow, pow(s, 5.0) * 0.5 * (1.0 - t * 0.5));
        col += uGlow * pow(s, 32.0) * 0.35;
        if (h > 0.0 && uClouds > 0.5) {
          vec2 uv = d.xz / (h + 0.1) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
          float n = nFbm(uv) * 0.65 + nFbm(uv * 2.7 + 5.2) * 0.35;
          vec2 us = uv + uSunDir.xz * 0.06;
          float ns = nFbm(us) * 0.65 + nFbm(us * 2.7 + 5.2) * 0.35;
          float cover = smoothstep(0.45, 0.72, n);
          float lit = clamp(0.55 + (n - ns) * 4.0, 0.0, 1.0);
          vec3 cc = mix(uCloudShade, uCloudLit, lit);
          cc += uGlow * pow(s, 6.0) * 0.6 * (1.0 - cover * 0.5);
          col = mix(col, cc, cover * smoothstep(0.02, 0.3, h));
        }
        col += vec3(1.0, 0.97, 0.9) * smoothstep(0.9990, 0.9996, s) * 1.5;
        if (h < 0.0) col = mix(uHorizon, uHorizon * 0.85, smoothstep(0.0, 0.2, -h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

/** The lake: rippling water that reflects the sky (more at grazing angles) with a glint of sun. */
/** How far from the lake's middle the water meets the land (on average round the lake). */
export function shoreRadius() {
  let sum = 0;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    let d = LAKE.r * 0.5;
    while (d < LAKE.r * 1.6 && terrainHeight(LAKE.x + Math.cos(a) * d, LAKE.z + Math.sin(a) * d) < LAKE.level) d += 0.1;
    sum += d;
  }
  return sum / 32;
}

function lake({ colors, sunDir, mirror }) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    toneMapped: false,
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uSun: { value: sunDir.clone().normalize() },
      uSunCol: { value: colors.sunCol },
      uZenith: { value: colors.zenith },
      uHorizon: { value: colors.horizon },
      uDeep: { value: colors.deep },
      uLake: { value: new THREE.Vector3(LAKE.x, LAKE.z, shoreRadius()) },
      ...mirror.uniforms, // High: what stands round the lake, mirrored in it
    },
    vertexShader: `
      varying vec3 vW;
      ${MIRROR_GLSL.vertexDecl}
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        ${MIRROR_GLSL.vertex}
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uSun, uSunCol, uZenith, uHorizon, uDeep, uLake;
      varying vec3 vW;
      ${MIRROR_GLSL.fragmentDecl}
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
        ${MIRROR_GLSL.mix('sky', 'N.xz * 0.035')}
        vec3 col = mix(uDeep, sky, fr) + uSunCol * pow(max(dot(R, uSun), 0.0), 220.0) * 2.5;
        // Foam where the water laps the shore, washing in and out.
        float edge = uLake.z - length(p - uLake.xy) + sin(uTime * 0.8 + atan(p.y - uLake.y, p.x - uLake.x) * 5.0) * 0.12;
        float foam = smoothstep(0.55, 0.0, abs(edge - 0.25)) * (0.55 + 0.45 * nFbm3(p * 2.5 + uTime * 0.2));
        col = mix(col, vec3(0.97), clamp(foam, 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(col, 0.94);
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
export function ruins(mat, seed, spots) {
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

const PINE_TIERS = [[0.38, 0.3, 0.55], [0.6, 0.23, 0.45], [0.8, 0.15, 0.35]]; // centre, radius, height

/** One pine shape, 1 unit tall: a short trunk under three stacked cones with crisp facets. */
function pineGeometry(dark) {
  const trunk = new THREE.CylinderGeometry(0.11, 0.18, 0.4, 6);
  trunk.translate(0, 0.2, 0);
  trunk.deleteAttribute('uv');
  const parts = [paint(trunk.toNonIndexed(), 0x4a3524)];
  const greens = dark ? [0x203820, 0x243e23, 0x294526] : [0x2b5426, 0x30602b, 0x386b31];
  PINE_TIERS.forEach(([y, rad, h], i) => {
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
function forest(count, { minR, maxR, dark, seed = 61, leaves = null }) {
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
  // Room for each tree: no two crowns overlapping much (a grid of 4 m cells holds who stands where).
  const cells = new Map();
  const cell = (x, z) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  const crowded = (x, z, rad) => {
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (const [ox, oz, orad] of cells.get(cell(x + i * 4, z + j * 4)) ?? []) if (Math.hypot(ox - x, oz - z) < (rad + orad) * 0.75) return true;
      }
    }
    return false;
  };
  const claim = (x, z, rad) => { const k = cell(x, z); if (!cells.has(k)) cells.set(k, []); cells.get(k).push([x, z, rad]); };
  for (let tries = 0; nb + np < count && tries < count * 8; tries++) {
    const a = r() * Math.PI * 2;
    const d = minR + r() * (maxR - minR);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (z > 0 && Math.abs(x) < d * 0.6) continue; // the view behind the camera stays open
    if (fbm(x * 0.02, z * 0.02) < 0.5) continue; // woods in clumps, meadows between
    if (inLake(x, z, 3)) continue;
    const y = terrainHeight(x, z);
    if (y < -0.5 || y > 30) continue; // not in hollows, nor on the bare rock and snow up high
    p.set(x, y - 0.2, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    const pine = r() < 0.42;
    const k = pine ? 6 + r() * 7 : 1.4 + r() * 1.6;
    const rad = pine ? k * 0.3 : k * 1.15;
    if (crowded(x, z, rad)) continue;
    claim(x, z, rad);
    if (pine) {
      m.compose(p, q, sc.set(k, k * (0.9 + r() * 0.25), k));
      pines.setMatrixAt(np, m);
      pines.setColorAt(np++, c.setRGB(0.85 + r() * 0.3, 0.85 + r() * 0.3, 0.8 + r() * 0.25));
    } else {
      m.compose(p, q, sc.set(k, k * (0.9 + r() * 0.4), k));
      broad.setMatrixAt(nb, m);
      // Each tree its own green: some deeper, some fresher and yellower.
      const fresh = r();
      broad.setColorAt(nb++, c.setRGB(0.75 + fresh * 0.4, 0.85 + r() * 0.3, 0.7 + (1 - fresh) * 0.25));
    }
  }
  broad.count = nb;
  pines.count = np;
  const group = new THREE.Group();
  group.add(broad, pines);
  // High: leaf and needle cards over the same trees (one card set per tree shape, instanced alike).
  if (leaves?.needles) {
    const crowns = mergeGeometries([
      leaves.crown(1.05, 71, 26).scale(1, 1.25, 1).translate(0, 2.3, 0),
      leaves.crown(0.78, 73, 14).translate(0.25, 3.1, 0.1),
    ]);
    const skirt = skirtGeometry(PINE_TIERS.map(([y, rad, h]) => [y, rad * 1.05, h]), 75, 9);
    for (const [geo, mat, of] of [[crowns, leaves.matte, broad], [skirt, leaves.needles.material, pines]]) {
      const cards = new THREE.InstancedMesh(geo, mat, count);
      cards.instanceMatrix.array.set(of.instanceMatrix.array);
      cards.count = of.count;
      cards.userData.cards = true;
      group.add(cards);
    }
  }
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
 * The ground under the grass, baked into a texture the grass reads in its shader: red is the height,
 * green whether grass grows there (0–1). It covers the square `half` either side of the middle at
 * `step` metres a texel.
 */
function groundTexture({ half, step = 0.5, allow }) {
  const res = Math.round((half * 2) / step) + 1;
  const data = new Float32Array(res * res * 4);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * step;
      const z = -half + j * step;
      const o = (j * res + i) * 4;
      data[o] = terrainHeight(x, z);
      data[o + 1] = allow(x, z, data[o]);
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  return { tex, box: new THREE.Vector4(-half, -half, half * 2, res) };
}

const PUSHERS = 6; // things that bend the grass aside as they pass (the trainer, creatures nearby)

/**
 * Grass: up to `count` blades drawn in one call, each a tapered strip bent by gusts of wind that
 * roll across the meadow, darker at the roots and glowing where the sun shines through. With a
 * fixed camera (`view`) the blades go where it looks, densest close by and a little bigger far
 * away. With `follow` ({ tile, ground }) the blades fill a `tile`-wide square around the camera
 * evenly, wherever it goes: each blade keeps its place in the world (the square repeats, so none
 * slide), stands on the ground baked in `ground` and only grows where it says grass grows; things in
 * `pushers` bend it aside. Otherwise they spread around the field.
 */
function grassField(count, { inner, outer, dark, view, sunDir, colors, seed = 7, avoid = null, follow = null }) {
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
  if (follow) {
    // Evenly over the tile (its own coordinates; the shader places it around the camera).
    for (; n < count; n++) {
      const x = (r() - 0.5) * follow.tile;
      const z = (r() - 0.5) * follow.tile;
      const patch = fbm(x * 0.2 + 30, z * 0.2, 3);
      offsets.set([x, 0, z], n * 3);
      params.set([(0.2 + r() * 0.3) * (0.75 + patch * 0.55), 0.04 + r() * 0.035, r() * Math.PI * 2, r()], n * 4);
    }
  }
  for (let tries = 0; !follow && n < count && tries < count * 14; tries++) {
    const x = (r() * 2 - 1) * outer;
    const z = (r() * 2 - 1) * outer;
    const d = Math.hypot(x, z);
    if (d < inner || d > outer || avoid?.(x, z)) continue;
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
    params.set([(0.14 + r() * 0.24) * (0.75 + patch * 0.5) * boost, (0.032 + r() * 0.024) * boost, r() * Math.PI * 2, r()], n * 4);
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
      uSunCol: { value: colors.sunCol },
      uSky: { value: dark ? new THREE.Color(0.36, 0.33, 0.48) : new THREE.Color(0.5, 0.58, 0.72) },
      uTint: { value: dark ? new THREE.Color(0.66, 0.62, 0.72) : new THREE.Color(1, 1, 1) },
      uCentre: { value: new THREE.Vector2() },
      uTile: { value: follow?.tile ?? 0 },
      uGround: { value: follow?.ground.tex ?? null },
      uGroundBox: { value: follow?.ground.box ?? new THREE.Vector4() },
      uPush: { value: Array.from({ length: PUSHERS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    }]),
    defines: follow ? { FOLLOW: 1 } : {},
    vertexShader: `
      attribute vec3 iOffset; attribute vec4 iParams; uniform float uTime;
      uniform vec2 uCentre; uniform float uTile; uniform sampler2D uGround; uniform vec4 uGroundBox;
      uniform vec4 uPush[${PUSHERS}];
      varying float vH, vVar, vGust; varying vec3 vW, vNh;
      #include <common>
      #include <fog_pars_vertex>
      ${GLSL_NOISE}
      // The baked ground (height, grows-here) at a point, blended between the four nearest texels.
      vec2 ground(vec2 xz) {
        vec2 t = (xz - uGroundBox.xy) / uGroundBox.z * (uGroundBox.w - 1.0);
        ivec2 i = ivec2(floor(t));
        vec2 f = fract(t);
        int last = int(uGroundBox.w) - 1;
        ivec2 a = clamp(i, ivec2(0), ivec2(last));
        ivec2 b = clamp(i + 1, ivec2(0), ivec2(last));
        vec2 g00 = texelFetch(uGround, ivec2(a.x, a.y), 0).rg;
        vec2 g10 = texelFetch(uGround, ivec2(b.x, a.y), 0).rg;
        vec2 g01 = texelFetch(uGround, ivec2(a.x, b.y), 0).rg;
        vec2 g11 = texelFetch(uGround, ivec2(b.x, b.y), 0).rg;
        return mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y);
      }
      void main() {
        float h = uv.y;
        float hgt = iParams.x, wid = iParams.y, rot = iParams.z, vr = iParams.w;
        vec3 base = iOffset;
        #ifdef FOLLOW
          // Its place in the world: the tile repeats, so it's always the same blade at the same spot.
          vec2 rel = mod(iOffset.xz - uCentre + uTile * 0.5, uTile) - uTile * 0.5;
          vec2 xz = uCentre + rel;
          vec2 g = ground(xz);
          float fade = 1.0 - smoothstep(uTile * 0.36, uTile * 0.5, length(rel));
          hgt *= fade * smoothstep(0.15, 0.6, g.y);
          wid *= step(0.001, hgt);
          base = vec3(xz.x, g.x - 0.03, xz.y);
        #endif
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
        // Pushed aside by the trainer and creatures walking through.
        for (int k = 0; k < ${PUSHERS}; k++) {
          vec4 push = uPush[k];
          if (push.z <= 0.0) continue;
          vec2 away = base.xz - push.xy;
          float d = length(away);
          float k2 = (1.0 - smoothstep(push.z * 0.4, push.z, d)) * push.w;
          p.xz += (away / max(d, 1e-3)) * bend * k2 * 1.2;
          p.y -= bend * k2 * 0.4;
        }
        vec3 world = p + base;
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
        vec3 col = mix(vec3(0.13, 0.24, 0.07), tip, smoothstep(0.0, 1.0, vH));
        col *= 0.85 + vVar * 0.3;
        vec3 V = normalize(cameraPosition - vW);
        vec3 Nh = dot(vNh, V) < 0.0 ? -vNh : vNh;
        vec3 N = normalize(Nh + vec3(0.0, 0.8, 0.0));
        float diff = clamp(dot(N, uSun) * 0.6 + 0.45, 0.0, 1.0);
        float ao = mix(0.55, 1.0, smoothstep(0.0, 0.75, vH));
        col *= (uSky * 0.6 + uSunCol * diff * 0.9) * ao;
        float back = pow(max(dot(-V, uSun), 0.0), 3.0);
        col += vec3(0.45, 0.6, 0.12) * uSunCol * back * vH * 0.8;
        col += vec3(0.05, 0.06, 0.02) * smoothstep(0.5, 0.8, vGust) * vH;
        // As in the reference: display colours, tone mapped, then the fog mixed in (three's own order).
        gl_FragColor = vec4(col * uTint, 1.0);
        #include <tonemapping_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, uniforms: mat.uniforms, max: n, follow: Boolean(follow) };
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

export function rockGeometry(r, seed, detail = 2) {
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

/** Materials shared by all the trees of one world (per `leaves`, or one set without leaf cards). */
const treeMaterials = new WeakMap();
const plainTrees = {};
function treeMats(leaves, dark) {
  const key = leaves ?? plainTrees;
  let m = treeMaterials.get(key)?.[dark ? 'dark' : 'light'];
  if (m) return m;
  const bark = barkTexture(dark);
  const trunk = new THREE.MeshStandardMaterial({ map: bark.color, normalMap: bark.normal, color: dark ? 0x9a8a80 : 0xffffff, roughness: 0.95 });
  trunk.userData.bark = true; // (High/Standard: photo bark, hdScenery.js; one material, so every tree gets it)
  const greens = dark ? [0x2f4a26, 0x36552a, 0x2a4221] : [0x4a8a38, 0x56963f, 0x3f7a33, 0x63a446];
  m = {
    trunk,
    cones: greens.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true })),
    core: new THREE.MeshStandardMaterial({ color: dark ? 0x1d3017 : 0x2b5520, roughness: 0.95 }),
    // Each broadleaf its own shade: from a deep green to a fresh yellow-green.
    shades: dark ? ['#b4bcc4', '#a6b0b8', '#c0c6cc'] : ['#ffffff', '#e6f2d2', '#d7ecc0', '#f4ffe0', '#cfe3b4'],
  };
  treeMaterials.set(key, { ...(treeMaterials.get(key) ?? {}), [dark ? 'dark' : 'light']: m });
  return m;
}

/**
 * A tree: a barked trunk, then either a pine (stacked cones with needle cards down their sides) or a
 * broadleaf whose crown is several separate clumps of leaf cards on branches, each lit as a ball of its
 * own (so the crown reads as clumps with gaps between, not one blob), in the tree's own shade of green.
 */
export function tree(seed, dark, leaves = null, kind = null) {
  const r = rng(seed);
  const mats = treeMats(leaves, dark);
  const group = new THREE.Group();
  const h = 1.6 + r() * 1.4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.19, h, 9), mats.trunk);
  trunk.position.y = h / 2;
  trunk.castShadow = true;
  group.add(trunk);
  if (kind ? kind === 'pine' : r() < 0.45) {
    // Pine: stacked cones, with layers of needle cards down their sides (a ragged, airy edge).
    const tiers = [];
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.0 - i * 0.25, 1.3, 9), mats.cones[i % mats.cones.length]);
      cone.position.y = h * 0.7 + i * 0.6;
      cone.castShadow = true;
      group.add(cone);
      tiers.push([cone.position.y, (1.0 - i * 0.25) * 1.12, 1.3]);
    }
    if (leaves?.needles) {
      const skirt = new THREE.Mesh(skirtGeometry(tiers, seed * 5 + 1, 11), leaves.needles.material);
      skirt.customDepthMaterial = leaves.needles.depthMaterial;
      skirt.castShadow = true;
      skirt.userData.leaves = true;
      group.add(skirt);
    }
  } else {
    // Broadleaf: 3–5 clumps round a higher top clump, each on a branch from the trunk's top.
    const crownR = 1.2 + r() * 0.35;
    const shade = mats.shades[Math.floor(r() * mats.shades.length)];
    const leafMat = leaves ? leaves.tinted?.(shade) ?? leaves.material : null;
    const clumps = 3 + Math.floor(r() * 3);
    const spots = [[0, h + 0.95 + r() * 0.3, 0, crownR * 0.62]];
    for (let i = 0; i < clumps; i++) {
      const a = (i / clumps) * Math.PI * 2 + r() * 0.8;
      const out = crownR * (0.5 + r() * 0.25);
      spots.push([Math.cos(a) * out, h + 0.25 + r() * 0.55, Math.sin(a) * out, crownR * (0.45 + r() * 0.15)]);
    }
    for (const [i, [x, y, z, rad]] of spots.entries()) {
      // The branch up to the clump.
      const from = new THREE.Vector3(0, h * 0.82, 0);
      const to = new THREE.Vector3(x * 0.8, y - rad * 0.3, z * 0.8);
      const len = from.distanceTo(to);
      if (i > 0 && len > 0.2) {
        const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.07, len, 6), mats.trunk);
        branch.position.copy(from).add(to).multiplyScalar(0.5);
        branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
        branch.castShadow = true;
        group.add(branch);
      }
      if (leafMat) {
        const clump = new THREE.Mesh(leaves.crown(rad, seed * 7 + i * 13 + 3, 24), leafMat);
        clump.customDepthMaterial = leaves.depthMaterial;
        clump.position.set(x, y, z);
        clump.castShadow = true;
        clump.userData.leaves = true;
        group.add(clump);
      }
      // A small dark core inside each clump, so it isn't see-through, and its inside reads as shade.
      const core = new THREE.Mesh(rockGeometry(rad * (leafMat ? 0.55 : 0.95), seed * 10 + i), leafMat ? mats.core : mats.cones[i % mats.cones.length]);
      core.position.set(x, y - rad * 0.1, z);
      core.scale.y = 1.15;
      core.castShadow = true;
      group.add(core);
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

/** The Reef arena: the underwater world (reef/reef.js) round a sand field; always clear weather. */
function reefWorld({ scene, renderer, camera, mode, quality }) {
  const fieldR = mode === 'showcase' ? 4.6 : 6.2;
  const reef = buildReef({ scene, renderer, mode: 'battle', fieldR });
  const effects = createEffects(renderer, { threshold: 0.9, bloom: 0.45, fade: [10, 26] }); // (short sight underwater)
  let current = null;
  let pixelTop = 1;
  const setQuality = (q) => {
    current = ['high', 'standard', 'basic'].includes(q) ? q : 'standard';
    pixelTop = current === 'basic' ? 0.75 : Math.min(window.devicePixelRatio || 1, current === 'high' ? 2 : 1.5);
    renderer.setPixelRatio(pixelTop);
    reef.setQuality(current);
    effects.setLevel(current);
  };
  setQuality(quality);
  return {
    sun: reef.sun,
    leaves: null,
    environment: 'reef',
    weather: 'clear',
    get quality() { return current; },
    get pixelTop() { return pixelTop; },
    setQuality,
    update(seconds) { reef.update(seconds, camera); },
    effects,
    render() { effects.render(scene, camera); },
    resize() {},
    dispose() { effects.dispose(); reef.dispose(); },
  };
}

/**
 * Build the world into `scene`. Returns { sun, update(seconds), setQuality(q), render(), resize(w,h), dispose() }.
 */
export function buildWorld({ scene, renderer, camera, dark = false, mode = 'battle', quality = 'high', environment = 'meadow', weather = 'clear' }) {
  if (environment === 'reef') return reefWorld({ scene, renderer, camera, mode, quality });
  const look = lookFor(environment, dark); // null: the meadow
  const wx = WEATHER_LOOK[weather] ?? WEATHER_LOOK.clear;
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  // Where the (fixed) battle camera stands and looks, on the ground: grass, mist and pollen go there.
  let view = null;
  if (mode === 'battle') { // (the showcase and the Sanctuary are seen from all round)
    const dir = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    view = { x: camera.position.x, z: camera.position.z, fx: dir.x, fz: dir.z };
  }

  // The reference's colour pipeline: filmic (ACES) tone mapping at exposure 1, soft sun shadows.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.environment = null;

  // Sky dome (follows the camera) with the sun low over the field; at dusk in dark mode.
  const colors = palette(dark, look);
  // The weather tints the sky (and so the fog, which takes the horizon's colour).
  const tint = new THREE.Color(...wx.tint);
  for (const key of ['horizon', 'zenith', 'cloudShade', 'cloudLit', 'glow']) {
    const lum = Math.max(colors[key].r, colors[key].g, colors[key].b, 0.12);
    colors[key].lerp(tint.clone().multiplyScalar(key === 'zenith' ? lum * 0.9 : lum), wx.strength);
  }
  const sunDir = look ? new THREE.Vector3(...look.skyDir).normalize()
    : dark
      ? new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(84), THREE.MathUtils.degToRad(235))
      : new THREE.Vector3(0.75, 0.32, -0.55).normalize();
  const lightDir = look ? new THREE.Vector3(...look.lightDir).normalize() : sunDir;
  const sky = skyDome({ colors, sunDir });
  scene.add(sky.mesh);
  const stars = look?.stars && weather !== 'sand' ? starField() : null;
  if (stars) scene.add(stars);

  // Fog in the sky's exact horizon colour, thickening with distance (FogExp2, as in the reference).
  const haze = new THREE.Color().setRGB(colors.horizon.r, colors.horizon.g, colors.horizon.b, THREE.SRGBColorSpace);
  scene.fog = new THREE.FogExp2(haze, (look?.fog ?? 0.0034) * wx.fog);

  // Light: sky/ground hemisphere light and an angled sun with soft shadows; no ambient or sky (IBL) light.
  // (Intensities are the reference's ×π: three.js now uses physical light units.)
  const sun = new THREE.DirectionalLight(look ? look.sun[0] : dark ? 0xffb27a : 0xfff0d8, (look ? look.sun[1] : dark ? 1.2 : 1.55) * Math.PI * wx.light);
  sun.color.lerp(new THREE.Color().setRGB(...wx.tint, THREE.SRGBColorSpace), wx.strength * 0.6);
  sun.position.copy(lightDir).multiplyScalar(30);
  if (dark && !look) sun.position.y = Math.max(sun.position.y, 6); // a low sun still needs to light the arena
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  const sc = sun.shadow.camera;
  sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 80;
  scene.add(sun, sun.target);
  const skyLight = wx.strength ? Math.min(1.1, wx.light + 0.15) : 1; // the sky's own light dims less than the sun
  const hemi = look
    ? new THREE.HemisphereLight(look.hemi[0], look.hemi[1], look.hemi[2] * Math.PI * skyLight)
    : new THREE.HemisphereLight(dark ? 0x9a9ad0 : 0xc4d8ff, dark ? 0x3a3326 : 0x4c5a2c, (dark ? 0.5 : 0.65) * Math.PI * skyLight);
  scene.add(hemi);
  const hemiBase = hemi.intensity;
  const fieldR = mode === 'showcase' ? 4.6 : 6.2;
  const bigSurfaces = [];
  const dotTex = track(dotTexture());
  let grass = null;
  let flowers = null;
  let air = null;
  let woods = null;
  let trees = null;
  let mistBanks = null;
  let water = null;
  let stadium = null;
  let ground = null; // the meadow's land and stone material (for hdScenery)
  let stoneMat = null;
  // Depth: soft dark patches under things, leaf-card crowns, and (below) normal maps and sky light.
  const time = { value: 0 };
  const contacts = contactShadows(track(contactTexture()));
  scene.add(contacts.mesh);
  const leafTex = track(leafClusterTexture(dark ? ['#3c5e30', '#2f4a26', '#4a6e38'] : ['#4f9438', '#3f7d2f', '#6aa845', '#356b29']));
  const leaves = leafCards(leafTex, time);
  track(leaves.material);
  track(leaves.depthMaterial);
  // (Brighter greens than a real pine's: in the cards' shade they would otherwise read as black stripes.)
  leaves.needles = leafCards(track(needleClusterTexture(dark ? ['#27452a', '#2e5232', '#365c38'] : ['#3d7a3a', '#4a8a44', '#356e36', '#5a9a4c'])), time, { matte: true });
  track(leaves.needles.material);
  track(leaves.needles.depthMaterial);
  leaves.matte = track(leafCards(leafTex, time, { matte: true }).material); // the far woods' crowns (no sheen)
  // High: occlusion, bloom and mirror water (postfx.js).
  const effects = createEffects(renderer);
  const mirror = planarMirror(renderer);
  track(mirror);

  if (look) {
    // A stadium: its own floor, walls, stands and crowd; the chalk lines are the same everywhere.
    stadium = buildStadium(environment, { fieldR, look, contact: contacts.add, mirror });
    scene.add(stadium.group);
    bigSurfaces.push(stadium.group);
    const lines = fieldLines(fieldR - 0.25);
    lines.position.y = 0.016;
    scene.add(lines);
    bigSurfaces.push(lines);
  } else {

  // Ground: rolling grass land, flat around the arena.
  // One mesh from the arena out to the mountains (fewer segments on phones).
  const phone = matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  const segments = phone ? 180 : 340; // (desktop: about 2.4 m between points, enough for the crags)
  const groundGeo = new THREE.PlaneGeometry(800, 800, segments, segments);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, terrainHeight(gp.getX(i), gp.getZ(i)) - 0.03);
  groundGeo.computeVertexNormals();
  paintTerrain(groundGeo, dark);
  addGroundLayers(groundGeo, { inLake: (x, z) => lakeDistance(x, z) < LAKE.r * 1.6, noise: (x, z) => fbm(x, z, 3) });
  const groundMat = new THREE.MeshStandardMaterial({ map: track(speckleTexture()), vertexColors: true, roughness: 0.95 });
  // Rippling light (caustics) on the lake floor.
  addCaustics(groundMat, time, { strength: 0.8, mask: `clamp((${LAKE.level.toFixed(2)} - 0.05 - cw.y) / 0.9, 0.0, 1.0)` });
  ground = new THREE.Mesh(groundGeo, groundMat);
  bigSurfaces.push(ground);
  ground.receiveShadow = true;
  scene.add(ground);

  // The battle field: packed dirt with chalk lines, ringed by stones.
  const dirtTex = track(noiseTexture({
    base: dark ? '#7a6550' : '#b79b74', seed: 11, repeat: 3, blotches: 1400, specks: 16000,
    tones: dark ? ['rgba(96,80,62,ALPHA)', 'rgba(70,58,46,ALPHA)', 'rgba(120,102,80,ALPHA)'] : ['rgba(160,132,98,ALPHA)', 'rgba(198,176,140,ALPHA)', 'rgba(140,112,82,ALPHA)', 'rgba(214,196,160,ALPHA)'],
  }));
  const field = new THREE.Mesh(new THREE.CircleGeometry(fieldR, 96), new THREE.MeshStandardMaterial({ map: dirtTex, roughness: 0.98 }));
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.002;
  field.receiveShadow = true;
  bigSurfaces.push(field);
  scene.add(field);
  if (mode !== 'sanctuary') { // the Sanctuary's plaza has no battle lines
    const lines = fieldLines(fieldR - 0.25);
    scene.add(lines);
    bigSurfaces.push(lines);
  }

  const stoneTex = track(noiseTexture({
    base: dark ? '#77777c' : '#a7a6a2', seed: 21, repeat: 1, size: 256, blotches: 300, specks: 3000,
    tones: ['rgba(120,120,118,ALPHA)', 'rgba(160,158,150,ALPHA)', 'rgba(90,90,92,ALPHA)', 'rgba(130,140,120,ALPHA)'],
  }));
  stoneMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.85 });
  const rocks = new THREE.Group();
  const rr = rng(5);
  rocks.add(stoneRing(fieldR + 0.05, stoneMat, 9));
  if (mode !== 'sanctuary') rocks.add(ruins(stoneMat, 13, mode === 'showcase'
    ? [[-7, -9], [8, -11], [-12, -3]]
    : [[-11, -12], [10, -14], [-15, -4], [16, -6], [3, -19]]));
  // Boulders scattered in the grass.
  for (let i = 0; i < (mode === 'sanctuary' ? 0 : 26); i++) {
    const a = rr() * Math.PI * 2;
    const d = fieldR + 3 + rr() * 22;
    if (inLake(Math.cos(a) * d, Math.sin(a) * d, 1)) continue;
    const big = new THREE.Mesh(rockGeometry(0.4 + rr() * 1.1, 300 + i), stoneMat);
    big.position.set(Math.cos(a) * d, terrainHeight(Math.cos(a) * d, Math.sin(a) * d) + 0.1, Math.sin(a) * d);
    big.rotation.y = rr() * Math.PI;
    big.castShadow = big.receiveShadow = true;
    big.userData.boulder = true;
    rocks.add(big);
    contacts.add(big.position.x, big.position.y - 0.1, big.position.z, big.geometry.boundingSphere?.radius ?? 1.1);
  }
  scene.add(rocks);
  bigSurfaces.push(rocks);

  // Trees around the field, more of them further out; none in front of the camera.
  trees = new THREE.Group();
  const tr = rng(17);
  let placed = 0;
  for (let i = 0; placed < 18 && i < 400; i++) {
    const a = tr() * Math.PI * 2;
    const d = fieldR + 12 + tr() * 26;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (z > fieldR - 1 && Math.abs(x) < d * 0.75) continue; // keep the view open
    if (inLake(x, z, 3)) continue;
    const t = tree(1000 + i, dark, leaves);
    t.position.set(x, terrainHeight(x, z) - 0.05, z);
    trees.add(t);
    contacts.add(x, terrainHeight(x, z), z, 1.5 * t.scale.x);
    placed++;
  }
  scene.add(trees);
  bigSurfaces.push(trees);

  woods = forest(1400, { minR: 40, maxR: 190, dark, leaves });
  scene.add(woods);
  bigSurfaces.push(woods);
  mistBanks = mist(dark, track(cloudPuffTexture()), view);
  scene.add(mistBanks);
  water = lake({ colors, sunDir, mirror });
  scene.add(water.mesh);

  // Swaying grass around the field (fewer blades on "Standard", none on "Basic"), flowers, pollen.
  // (In the Sanctuary, no grass on the lake shore's sand.)
  // In the Sanctuary the grass goes wherever you walk (a field that follows the camera, on the ground
  // baked below: not in the water, on the shore's sand or the plaza, giving way to rock up the slopes).
  const follow = mode === 'sanctuary' ? {
    tile: 56,
    ground: groundTexture({
      half: 90,
      allow: (x, z, y) => {
        if (y < LAKE.level + 0.2 || lakeDistance(x, z) < SHORE_SAND || Math.hypot(x, z) < fieldR + 0.8) return 0;
        return 1 - smooth(14, 22, y);
      },
    }),
  } : null;
  if (follow) disposables.push(follow.ground.tex);
  grass = grassField(95000, { inner: fieldR + 0.6, outer: 60, dark, view, sunDir, colors, follow, avoid: mode === 'sanctuary' ? (x, z) => lakeDistance(x, z) < SHORE_SAND : null });
  scene.add(grass.mesh);
  flowers = flowerField(3000, { inner: fieldR + 0.8, outer: fieldR + 22, dark });
  scene.add(flowers);
  air = pollen(600, { dark, tex: dotTex, view });
  scene.add(air.points);
  } // the meadow

  // Every painted solid surface gets a normal map worked out from its own texture, and the sky lights
  // the scene (an environment map baked from the sky dome): off on "Basic".
  contacts.finish();
  for (const map of addSurfaceDepth(scene)) track(map);
  const skyEnv = skyEnvironment(renderer, sky.mesh);
  track(skyEnv);
  scene.environmentIntensity = look?.stars ? 0.3 : 0.5;
  // High/Standard: Poly Haven's CC0 photo textures, sky light and rock scans over all this (hdScenery.js).
  const boulders = [];
  scene.traverse((o) => { if (o.userData.boulder) boulders.push(o); });
  const hd = hdScenery({
    renderer, scene, dark, procEnv: skyEnv.texture,
    ground: ground?.material ?? null, stoneMat, boulders, trees, sand: stadium?.sandMaterial ?? null,
    envSlot: look?.stars ? null : dark ? 'sky-sunset' : 'sky-day',
  });

  // Rain, snow or sand round the camera (the sky, fog and lights were tinted above).
  const weatherFx = buildWeather(weather, { scene, camera, dot: dotTex });

  let current = null;
  let pixelTop = 1; // the level's own resolution (perf.js may draw fewer pixels when frames are slow)
  const setQuality = (q) => {
    current = ['high', 'standard', 'basic'].includes(q) ? q : 'standard';
    const high = current === 'high';
    const basic = current === 'basic';
    pixelTop = basic ? 0.75 : Math.min(window.devicePixelRatio || 1, high ? 2 : 1.5);
    renderer.setPixelRatio(pixelTop);
    effects.setLevel(current);
    sky.uniforms.uClouds.value = basic ? 0 : 1;
    if (mistBanks) mistBanks.visible = !basic;
    scene.environment = basic ? null : skyEnv.texture;
    hd.set(!basic);
    hemi.intensity = hemiBase * (basic ? 1 : 0.8); // the sky's own light takes over part of it
    contacts.mesh.visible = !basic;
    stadium?.setQuality(current);
    weatherFx?.setQuality(current);
    renderer.shadowMap.enabled = !basic;
    sun.castShadow = !basic;
    sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    sun.shadow.radius = high ? 4 : 2;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    // Basic: cheaper materials on the big surfaces.
    for (const root of bigSurfaces) {
      root.traverse((mesh) => {
        if (!mesh.isMesh || mesh.material?.type !== (mesh.userData.full ? mesh.userData.full.type : 'MeshStandardMaterial')) return;
        const full = (mesh.userData.full ??= mesh.material);
        mesh.userData.cheap ??= new THREE.MeshLambertMaterial({
          map: full.map, vertexColors: full.vertexColors, color: full.color, transparent: full.transparent,
          depthWrite: full.depthWrite, side: full.side, flatShading: full.flatShading, alphaTest: full.alphaTest, // (keeps leaf cut-outs)
        });
        if (full.onBeforeCompile && full.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) mesh.userData.cheap.onBeforeCompile = full.onBeforeCompile;
        mesh.material = basic ? mesh.userData.cheap : full;
      });
    }
    scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; }); // shadows / lighting changes recompile
    if (!grass) return; // a stadium: no meadow to thin out
    grass.mesh.visible = !basic;
    // The reference's desktop / phone counts; a field that follows you is spread evenly, so it keeps more.
    grass.mesh.geometry.instanceCount = Math.min(grass.max, high ? 95000 : grass.follow ? 55000 : 28000);
    air.points.visible = !basic;
    air.points.geometry.setDrawRange(0, high ? 600 : 250);
    flowers.count = high ? 3000 : basic ? 0 : 1000;
    for (const kind of woods.children) {
      kind.userData.max ??= kind.count;
      kind.count = high ? kind.userData.max : Math.round(kind.userData.max * (basic ? 0.25 : 0.5));
      if (kind.userData.cards) kind.visible = !basic; // leaf cards on Standard too: without them, crowns are smooth blobs
    }
    trees.traverse((o) => { if (o.isMesh) o.castShadow = high; });
  };
  setQuality(quality);
  let last = null;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  let mirrorFrame = 0;
  let mirrorDrawn = false;

  const shadowDir = sun.position.clone().normalize();
  return {
    sun,
    /** Keep the sharp shadows round (x, y, z), moving the shadow camera in whole texels (no shimmer). */
    followSun(x, y, z) {
      const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
      const at = snapToTexel({ x, y, z }, shadowDir, texel);
      sun.target.position.set(at.x, at.y, at.z);
      sun.position.copy(sun.target.position).addScaledVector(shadowDir, 30);
    },
    leaves, // the leaf-card material (it sways with the world's clock): for the Sanctuary's habitats
    environment: look ? environment : 'meadow',
    weather: WEATHER_LOOK[weather] ? weather : 'clear',
    get quality() { return current; },
    get pixelTop() { return pixelTop; },
    setQuality,
    /** Dress a plank material in the scenery set's photo planks on High/Standard (hdScenery.js). */
    photoWood(mat) { hd.wood(mat); },
    /** Things bending the grass aside: [{ x, z, radius, strength }] (the first few count). */
    setGrassPushers(list) {
      if (!grass) return;
      grass.uniforms.uPush.value.forEach((v, i) => {
        const p = list[i];
        if (p) v.set(p.x, p.z, p.radius, p.strength ?? 1);
        else v.set(0, 0, 0, 0);
      });
    },
    update(seconds) {
      const dt = Math.min(0.1, Math.max(0, seconds - (last ?? seconds)));
      last = seconds;
      sky.uniforms.uTime.value = seconds;
      time.value = seconds;
      sky.mesh.position.copy(camera.position); // the sky moves with the camera
      stars?.position.copy(camera.position);
      stadium?.update(seconds);
      weatherFx?.update(seconds, dt);
      if (!grass) return;
      grass.uniforms.uTime.value = seconds;
      if (grass.follow) grass.uniforms.uCentre.value.set(camera.position.x, camera.position.z);
      water.uniforms.uTime.value = seconds;
      if (air.points.visible) air.update(seconds, dt);
    },
    effects, // perf.js turns them off when frames are slow
    render() {
      const mirrored = water?.mesh ?? stadium?.water;
      mirror.on = effects.on && Boolean(mirrored);
      // The mirror is a whole extra render of the scene: only when the water is on screen, and every other
      // frame (a reflection a frame old doesn't show).
      if (mirrored && mirror.on) {
        frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        mirrored.geometry.boundingSphere ?? mirrored.geometry.computeBoundingSphere();
        sphere.copy(mirrored.geometry.boundingSphere).applyMatrix4(mirrored.matrixWorld);
        if (frustum.intersectsSphere(sphere) && (mirrorFrame++ % 2 === 0 || !mirrorDrawn)) {
          mirror.render(scene, camera, mirrored, grass ? [grass.mesh, air.points] : []);
          mirrorDrawn = true;
        }
      }
      effects.render(scene, camera);
    },
    resize() {},
    dispose() {
      effects.dispose();
      hd.dispose();
      for (const d of disposables) d.dispose?.();
      stadium?.dispose();
      weatherFx?.dispose();
      stars?.geometry.dispose();
      stars?.material.dispose();
    },
  };
}
