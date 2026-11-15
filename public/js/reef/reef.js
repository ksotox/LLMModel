// The Reef: an underwater world made in code, after the ideas of Abyssal Garden by Maksymilian
// Dendura (github.com/Noniv/abyssal-garden, MIT licence, © 2026 Maksymilian Dendura): towering kelp
// with gold and green sparkles, light shafts from a wavy surface, caustics on the sand, fog that
// turns from cyan near the surface to deep blue below, rock arches and floating boulders, a sunken
// ship and a stone whale tail, a purple grotto with magenta ground cover, coral and barrel sponges,
// manta rays, fish schools, bubbles and drifting specks.
//
// That project draws with raw WebGPU; this is our own three.js version of its scene. The manta ray's
// and the fish's shape formulas are ported from its world.js (MIT; notice above).
//
// Used by the Sanctuary's underwater area (sanctuary/reefSanctuary.js) and by the Reef battle arena
// (battle/world.js). Pure layout helpers (reefLayout, stepSchool) are tested in Node.

import * as THREE from 'three';

export const REEF = {
  top: 14, // the water's surface
  radius: 58, // the world's edge (canyon walls rise beyond it)
  fieldR: 6.2,
};

// ---------------------------------------------------------------------------
// Pure parts: the seabed's height, where things go, and the fish

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x); const yi = Math.floor(y);
  const xf = x - xi; const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf); const v = yf * yf * (3 - 2 * yf);
  return (hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u) * (1 - v) + (hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u) * v;
}
const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.03, y * 2.03) * 0.27 + vnoise(x * 4.1, y * 4.1) * 0.15 + vnoise(x * 8.3, y * 8.3) * 0.08;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** The seabed's height at (x, z): sand dunes, a flat field in the middle (battles), canyon walls at the edge. */
export function reefHeight(x, z, { flat = 0 } = {}) {
  const r = Math.hypot(x, z);
  let h = (fbm(x * 0.06 + 3, z * 0.06 - 1) - 0.45) * 2.4 + Math.sin(x * 0.18 + z * 0.07) * 0.25;
  h += smooth(REEF.radius - 14, REEF.radius + 6, r) * (8 + fbm(x * 0.05, z * 0.05) * 9); // the canyon walls
  h -= smooth(26, 0, Math.hypot(x - 10, z + 6)) * 1.2; // a shallow basin
  if (flat) h *= smooth(flat, flat + 4, r);
  return h + 0; // (never −0)
}

/**
 * Where the big things go: kelp columns, the grotto, the wreck, the whale tail, the arches, boulders
 * and the spots creatures start from. Obstacles are spheres { x, y, z, r } you swim round.
 * `clear`: a radius left open in the middle (the battle field). The same every time.
 */
export function reefLayout({ clear = 0, seed = 11 } = {}) {
  const r = rngFrom(seed);
  const open = (x, z, room) => Math.hypot(x, z) > clear + room;
  const wreck = { x: -22, z: -18, turn: 0.6 };
  const fluke = { x: 24, z: 20 };
  const grotto = { x: -26, z: 24, r: 11 };
  const arches = [{ x: 30, z: -16, turn: 1.1, R: 6 }, { x: -6, z: 36, turn: -0.3, R: 5 }];
  const kelp = [];
  for (let i = 0, tries = 0; i < 46 && tries < 900; tries++) {
    const a = r() * Math.PI * 2;
    const d = 12 + Math.sqrt(r()) * (REEF.radius - 18);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (!open(x, z, 4)) continue;
    if (Math.hypot(x - wreck.x, z - wreck.z) < 9 || Math.hypot(x - fluke.x, z - fluke.z) < 7 || Math.hypot(x - grotto.x, z - grotto.z) < grotto.r) continue;
    if (arches.some((ar) => Math.hypot(x - ar.x, z - ar.z) < ar.R + 2)) continue;
    if (kelp.some((k) => Math.hypot(k.x - x, k.z - z) < 2.4)) continue;
    kelp.push({ x, z, h: 7 + r() * (REEF.top - 9), strands: 2 + Math.floor(r() * 3), phase: r() * Math.PI * 2 });
    i++;
  }
  const obstacles = [];
  // The wreck (a row of spheres along the hull), the whale tail's stem, the arches (along their arc).
  for (let k = -3; k <= 3; k++) obstacles.push({ x: wreck.x + Math.cos(wreck.turn) * k * 1.6, y: reefHeight(wreck.x, wreck.z) + 1.3, z: wreck.z + Math.sin(wreck.turn) * k * 1.6, r: 1.6 });
  for (let k = 0; k < 4; k++) obstacles.push({ x: fluke.x, y: reefHeight(fluke.x, fluke.z) + 1 + k * 1.8, z: fluke.z, r: 1.3 - k * 0.15 });
  for (const ar of arches) {
    for (let k = 0; k <= 10; k++) {
      const t = (k / 10) * Math.PI;
      obstacles.push({ x: ar.x + Math.cos(ar.turn) * Math.cos(t) * ar.R, y: reefHeight(ar.x, ar.z) + Math.sin(t) * ar.R, z: ar.z + Math.sin(ar.turn) * Math.cos(t) * ar.R, r: 1.25 });
    }
  }
  const boulders = [];
  for (let i = 0, tries = 0; i < 9 && tries < 400; tries++) {
    const a = r() * Math.PI * 2;
    const d = 14 + r() * 30;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (!open(x, z, 6) || kelp.some((k) => Math.hypot(k.x - x, k.z - z) < 4)) continue;
    const b = { x, y: reefHeight(x, z) + 5 + r() * 5, z, r: 1 + r() * 1.6 };
    boulders.push(b);
    obstacles.push(b);
    i++;
  }
  // Where creatures start: in the open water round the middle, above the sand, clear of obstacles.
  const spots = [];
  for (let i = 0, tries = 0; i < 60 && tries < 2000; tries++) {
    const a = r() * Math.PI * 2;
    const d = 6 + r() * 30;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const y = reefHeight(x, z) + 1.2 + r() * 4;
    if (!open(x, z, 2) || blockedBy(obstacles, x, y, z, 1.2) || kelp.some((k) => Math.hypot(k.x - x, k.z - z) < 1.6)) continue;
    spots.push({ x, y, z });
    i++;
  }
  return { kelp, obstacles, boulders, wreck, fluke, grotto, arches, spots };
}

/** Is (x, y, z) inside an obstacle (with a margin)? */
export function blockedBy(obstacles, x, y, z, pad = 0) {
  for (const o of obstacles) if (Math.hypot(x - o.x, y - o.y, z - o.z) < o.r + pad) return true;
  return false;
}

/**
 * Fish schools: each fish keeps near its school's moving centre (cohesion), turns with its
 * neighbours' heading (alignment, through the shared centre's velocity), keeps a little apart, and
 * darts away from `avoid` (the trainer). Positions stay inside the reef. Pure; changes `school`.
 */
export function stepSchool(school, t, dt, avoid = null) {
  const c = school.centre;
  const px = c.x;
  const pz = c.z;
  c.x = school.home.x + Math.cos(t * school.speed + school.phase) * school.loop;
  c.z = school.home.z + Math.sin(t * school.speed * 1.3 + school.phase) * school.loop * 0.7;
  c.y = school.home.y + Math.sin(t * 0.4 + school.phase) * 1.2;
  const vx = (c.x - px) / Math.max(dt, 1e-6);
  const vz = (c.z - pz) / Math.max(dt, 1e-6);
  for (const f of school.fish) {
    const tx = c.x + f.ox;
    const ty = c.y + f.oy;
    const tz = c.z + f.oz;
    let ax = (tx - f.x) * 2.2 + vx * 0.3;
    let ay = (ty - f.y) * 2.2;
    let az = (tz - f.z) * 2.2 + vz * 0.3;
    if (avoid) {
      const dx = f.x - avoid.x;
      const dy = f.y - avoid.y;
      const dz = f.z - avoid.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 3.5 && d > 1e-3) { const k = (3.5 - d) * 9 / d; ax += dx * k; ay += dy * k; az += dz * k; }
    }
    f.vx += (ax - f.vx) * Math.min(1, dt * 3);
    f.vy += (ay - f.vy) * Math.min(1, dt * 3);
    f.vz += (az - f.vz) * Math.min(1, dt * 3);
    const sp = Math.hypot(f.vx, f.vy, f.vz);
    if (sp > 7) { f.vx *= 7 / sp; f.vy *= 7 / sp; f.vz *= 7 / sp; }
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.z += f.vz * dt;
    const rr = Math.hypot(f.x, f.z);
    if (rr > REEF.radius - 4) { f.x *= (REEF.radius - 4) / rr; f.z *= (REEF.radius - 4) / rr; }
    f.y = Math.min(REEF.top - 0.6, Math.max(reefHeight(f.x, f.z) + 0.4, f.y));
  }
  return school;
}

export function makeSchool({ home, count, seed, speed = 0.12, loop = 10 }) {
  const r = rngFrom(seed);
  const fish = Array.from({ length: count }, () => {
    const o = { ox: (r() - 0.5) * 3.2, oy: (r() - 0.5) * 1.4, oz: (r() - 0.5) * 3.2 };
    return { ...o, x: home.x + o.ox, y: home.y + o.oy, z: home.z + o.oz, vx: 0, vy: 0, vz: 0 };
  });
  return { home, centre: { ...home }, fish, speed, loop, phase: r() * Math.PI * 2 };
}

// ---------------------------------------------------------------------------
// Shaders shared with other places: caustics

const CAUSTIC_GLSL = `
  float causticAt(vec2 p, float t) {
    float c = 0.0;
    for (int i = 0; i < 2; i++) {
      vec2 q = p * (0.55 + float(i) * 0.37) + vec2(t * 0.21, -t * 0.17) * (1.0 + float(i));
      float a = sin(q.x + sin(q.y * 1.3 + t * 0.6));
      float b = sin(q.y + sin(q.x * 1.1 - t * 0.5));
      c += pow(1.0 - abs(a * b), 7.0);
    }
    return c * 0.5;
  }
`;

/**
 * Add moving caustics (rippling light) to a standard material, where `mask(world position)` (GLSL
 * float expression of `cw`, the world position) is above 0: on the seabed, the lake floor, the
 * beach's shallows. `time` is a { value } the caller advances.
 */
export function addCaustics(material, time, { strength = 0.55, color = [0.75, 0.95, 1.0], scale = 1, mask = '1.0' } = {}) {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    shader.uniforms.uCausticTime = time;
    shader.vertexShader = `varying vec3 vCausticPos;\n${shader.vertexShader}`.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 cw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        cw = instanceMatrix * cw;
      #endif
      vCausticPos = (modelMatrix * cw).xyz;`);
    shader.fragmentShader = `uniform float uCausticTime;\nvarying vec3 vCausticPos;\n${CAUSTIC_GLSL}\n${shader.fragmentShader}`.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 cw = vCausticPos;
        float m = clamp(${mask}, 0.0, 1.0);
        totalEmissiveRadiance += vec3(${color.map((c) => c.toFixed(3)).join(', ')}) * causticAt(cw.xz * ${(0.9 * scale).toFixed(3)}, uCausticTime) * ${strength.toFixed(3)} * m * diffuseColor.rgb;
      }`);
  };
  material.customProgramCacheKey = () => `caustics-${strength}-${mask}`;
  material.needsUpdate = true;
  return material;
}

// ---------------------------------------------------------------------------
// Making it (three.js)

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const dotTexture = () => canvasTexture(64, 64, (g) => {
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
});

/** The manta ray's body, ported from Abyssal Garden's meshManta (MIT): span along x, nose to +z. */
function mantaGeometry() {
  const NU = 40;
  const M = 14;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= NU; j++) {
    const u = (j / NU) * 2 - 1;
    const au = Math.abs(u);
    let zl = 0.52 - 0.74 * au ** 1.35 + 0.07 * Math.exp(-(((au - 0.13) / 0.05) ** 2)) - 0.05 * Math.exp(-((au / 0.05) ** 2)) - 0.08 * au ** 5;
    const zt = -0.5 + 0.3 * au ** 0.8 + 0.02 - 0.08 * au ** 5;
    if (zl < zt + 0.004) zl = zt + 0.004;
    const th = 0.08 * (1 - au) ** 1.15 + 0.004 + 0.12 * Math.exp(-((u / 0.2) ** 2));
    for (let k = 0; k < M; k++) {
      const a = (k / M) * Math.PI * 2;
      pos.push(u, th * Math.sin(a) * (0.62 + 0.38 * Math.cos(a)), zt + (zl - zt) * (0.5 + 0.5 * Math.cos(a)));
    }
  }
  for (let j = 0; j < NU; j++) {
    for (let k = 0; k < M; k++) {
      const a = j * M + k;
      const b = (j + 1) * M + k;
      const c = (j + 1) * M + ((k + 1) % M);
      const d = j * M + ((k + 1) % M);
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A small fish, after Abyssal Garden's meshFish (MIT): a body of 5 rings and a forked tail; nose to +x. */
function fishGeometry() {
  const X = [0.5, 0.3, 0.05, -0.22, -0.34];
  const H = [0.01, 0.13, 0.17, 0.09, 0.035];
  const W = [0.01, 0.05, 0.065, 0.03, 0.012];
  const pos = [];
  const idx = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; pos.push(X[i], Math.sin(a) * H[i], Math.cos(a) * W[i]); }
  for (let i = 0; i < 4; i++) for (let k = 0; k < 6; k++) { const a = i * 6 + k; const b = (i + 1) * 6 + k; const c = (i + 1) * 6 + ((k + 1) % 6); const d = i * 6 + ((k + 1) % 6); idx.push(a, b, c, a, c, d); }
  const t = pos.length / 3;
  pos.push(-0.33, 0, 0, -0.56, 0.2, 0, -0.47, 0, 0, -0.56, -0.2, 0);
  idx.push(t, t + 1, t + 2, t, t + 2, t + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Build the Reef into `scene`. `mode`: 'sanctuary' (open water to explore) or 'battle' (a flat sand
 * field in the middle for the fighters). Returns { heightAt, layout, top, update(seconds, camera),
 * setQuality(q), dispose() }; the fog, light and background are set on `scene`.
 */
export function buildReef({ scene, renderer, mode = 'sanctuary', fieldR = REEF.fieldR }) {
  const flat = mode === 'battle' ? fieldR + 1.5 : 0;
  const heightAt = (x, z) => reefHeight(x, z, { flat });
  const layout = reefLayout({ clear: mode === 'battle' ? fieldR + 2 : 0 });
  const group = new THREE.Group();
  const kept = [];
  const keep = (o) => { kept.push(o); return o; };
  const time = { value: 0 };
  const dot = keep(dotTexture());
  const r = rngFrom(5);

  // Water: fog and background from cyan (shallow) to deep blue; soft light from above.
  const shallow = new THREE.Color(0x3cb2c4);
  const deep = new THREE.Color(0x0a2c4c);
  const fogColor = shallow.clone();
  scene.fog = new THREE.FogExp2(fogColor, 0.04);
  scene.background = fogColor;
  scene.environment = null;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const hemi = new THREE.HemisphereLight(0x9ae6ef, 0x0b2034, 1.6 * Math.PI * 0.5);
  const sun = new THREE.DirectionalLight(0xdff8ff, 1.8 * Math.PI * 0.5);
  sun.position.set(8, 30, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 70 });
  sun.shadow.bias = -0.0005;
  group.add(hemi, sun, sun.target);

  // The seabed: sand with rock on the slopes, caustics rippling over it.
  const bedGeo = new THREE.PlaneGeometry(REEF.radius * 2 + 40, REEF.radius * 2 + 40, 180, 180);
  bedGeo.rotateX(-Math.PI / 2);
  const bp = bedGeo.attributes.position;
  const colors = new Float32Array(bp.count * 3);
  const sand = new THREE.Color(0xb3a37c);
  const rock = new THREE.Color(0x4f5a5c);
  const purple = new THREE.Color(0x4a2d5e);
  const col = new THREE.Color();
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i);
    const z = bp.getZ(i);
    const y = heightAt(x, z);
    bp.setY(i, y);
    const steep = Math.min(1, Math.abs(heightAt(x + 0.8, z) - y) + Math.abs(heightAt(x, z + 0.8) - y));
    col.copy(sand).lerp(rock, Math.max(steep * 1.6, smooth(REEF.radius - 16, REEF.radius - 4, Math.hypot(x, z))));
    col.lerp(purple, smooth(layout.grotto.r, layout.grotto.r * 0.4, Math.hypot(x - layout.grotto.x, z - layout.grotto.z)) * 0.8);
    col.multiplyScalar(0.85 + vnoise(x * 0.9, z * 0.9) * 0.3);
    colors.set([col.r, col.g, col.b], i * 3);
  }
  bedGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  bedGeo.computeVertexNormals();
  const bedMat = keep(addCaustics(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), time, { strength: 0.6 }));
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.receiveShadow = true;
  group.add(bed);
  if (mode === 'battle') {
    const ring = new THREE.Mesh(new THREE.RingGeometry(fieldR - 0.1, fieldR + 0.1, 96), new THREE.MeshBasicMaterial({ color: 0xe8f6ff, transparent: true, opacity: 0.6 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
  }

  // The surface seen from below: bright where you look straight up, ripples, darker at a slant.
  const surfaceMat = keep(new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: time, uShallow: { value: shallow } },
    vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uTime; uniform vec3 uShallow; varying vec3 vW;
      ${CAUSTIC_GLSL}
      void main() {
        vec3 V = normalize(vW - cameraPosition);
        float up = clamp(V.y, 0.0, 1.0);
        float ripple = causticAt(vW.xz * 0.45, uTime * 1.3);
        vec3 col = mix(uShallow * 0.8, vec3(0.85, 1.0, 1.0), pow(up, 2.5)) + ripple * 0.25 * up;
        float d = length(vW - cameraPosition);
        gl_FragColor = vec4(col, clamp(0.9 - d / 160.0, 0.0, 0.9));
      }`,
  }));
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1), surfaceMat);
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = REEF.top;
  surface.renderOrder = 3;
  group.add(surface);

  // Light shafts: soft additive cones from the surface, swaying and fading with depth.
  const shaftMat = keep(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: time },
    vertexShader: 'varying vec2 vUv; varying float vH; void main() { vUv = uv; vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; varying vec2 vUv; varying float vH;
      void main() {
        float stripes = 0.55 + 0.45 * sin(vUv.x * 40.0 + uTime * 0.6) * sin(vUv.x * 17.0 - uTime * 0.4);
        float a = pow(vH, 1.6) * 0.16 * stripes * smoothstep(0.0, 0.08, vH);
        gl_FragColor = vec4(vec3(0.75, 0.95, 1.0) * a, a);
      }`,
  }));
  const shafts = new THREE.Group();
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 34;
    const h = REEF.top + 2;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.6 + r() * 1.2, 2.5 + r() * 3, h, 16, 1, true), shaftMat);
    cone.position.set(Math.cos(a) * d, h / 2 - 0.5, Math.sin(a) * d);
    cone.rotation.set(-0.12, r(), 0.18);
    cone.renderOrder = 4;
    shafts.add(cone);
  }
  group.add(shafts);

  // Kelp: leaf cards on twisting stems, swaying more the higher they grow, with sparkles.
  const leafTex = keep(canvasTexture(64, 192, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#9bc04a');
    grad.addColorStop(0.5, '#4f8a2f');
    grad.addColorStop(1, '#2c5a26');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(w / 2, h);
    g.bezierCurveTo(w * 0.05, h * 0.65, w * 0.1, h * 0.2, w / 2, 0);
    g.bezierCurveTo(w * 0.9, h * 0.2, w * 0.95, h * 0.65, w / 2, h);
    g.fill();
    g.strokeStyle = 'rgba(30,60,20,0.6)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 4); g.stroke();
  }));
  const sway = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 kw = instanceMatrix * vec4(transformed, 1.0);
      float lift = max(kw.y, 0.0);
      float s = sin(uTime * 0.7 + kw.x * 0.15 + kw.z * 0.11) * 0.05 + sin(uTime * 1.9 + kw.y * 0.6) * 0.012;
      transformed += (inverse(mat3(instanceMatrix)) * vec3(s * lift, 0.0, s * lift * 0.6));`);
  };
  const leafMat = keep(new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.7 }));
  leafMat.onBeforeCompile = sway;
  const leafDepth = keep(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.45 }));
  leafDepth.onBeforeCompile = sway;
  const leafGeo = new THREE.PlaneGeometry(0.6, 1.7);
  leafGeo.translate(0, 0.85, 0);
  const leaves = [];
  const sparks = [];
  for (const k of layout.kelp) {
    const base = heightAt(k.x, k.z);
    for (let s = 0; s < k.strands; s++) {
      for (let y = 0; y < k.h; y += 0.24) {
        const a = k.phase + (s / k.strands) * Math.PI * 2 + y * 0.22;
        const rad = 0.3 * (1 - y / k.h * 0.5);
        leaves.push({ x: k.x + Math.cos(a) * rad, y: base + y, z: k.z + Math.sin(a) * rad, turn: a + r() * 0.8, tilt: 0.5 + r() * 0.7, size: 0.7 + r() * 0.6 * (1 - y / k.h * 0.5) });
        if (r() < 0.28) sparks.push(k.x + Math.cos(a) * (rad + 0.4), base + y, k.z + Math.sin(a) * (rad + 0.4), r());
      }
    }
  }
  const kelp = new THREE.InstancedMesh(leafGeo, leafMat, leaves.length);
  kelp.customDepthMaterial = leafDepth;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  leaves.forEach((l, i) => {
    q.setFromEuler(e.set(l.tilt, l.turn, 0, 'YXZ'));
    m.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3(l.size, l.size, l.size));
    kelp.setMatrixAt(i, m);
  });
  kelp.castShadow = true;
  kelp.frustumCulled = false;
  kelp.userData.max = leaves.length;
  group.add(kelp);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(sparks.filter((_, i) => i % 4 !== 3), 3));
  sparkGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(sparks.filter((_, i) => i % 4 === 3), 1));
  const sparkMat = keep(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: time, uMap: { value: dot } },
    vertexShader: `uniform float uTime; attribute float aSeed; varying float vA; varying vec3 vC;
      void main() { vec4 mv = modelViewMatrix * vec4(position + vec3(sin(uTime * 0.8 + aSeed * 30.0) * 0.1, 0.0, 0.0), 1.0);
        vA = (0.4 + 0.6 * sin(uTime * (2.0 + aSeed * 3.0) + aSeed * 50.0)) * clamp(1.0 - (-mv.z) / 45.0, 0.0, 1.0);
        vC = mix(vec3(1.0, 0.85, 0.35), vec3(0.55, 1.0, 0.45), step(0.5, aSeed));
        gl_PointSize = 70.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: 'uniform sampler2D uMap; varying float vA; varying vec3 vC; void main() { gl_FragColor = texture2D(uMap, gl_PointCoord) * vec4(vC, max(vA, 0.0)); }',
  }));
  const sparkPts = new THREE.Points(sparkGeo, sparkMat);
  sparkPts.frustumCulled = false;
  group.add(sparkPts);

  // Rocks: boulders on the sand and floating ones; the arches.
  const rockMat = keep(addCaustics(new THREE.MeshStandardMaterial({ color: 0x5a6466, roughness: 0.92, flatShading: true }), time, { strength: 0.45 }));
  const rockGeo = (rad, seed, detail = 1) => {
    const g = new THREE.IcosahedronGeometry(rad, detail);
    const p = g.attributes.position;
    const rr = rngFrom(seed);
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.8 + rr() * 0.4), p.getY(i) * (0.7 + rr() * 0.4), p.getZ(i) * (0.8 + rr() * 0.4));
    g.computeVertexNormals();
    return g;
  };
  for (const b of layout.boulders) {
    const mesh = new THREE.Mesh(rockGeo(b.r, 100 + Math.round(b.x * 7)), rockMat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2;
    const d = (mode === 'battle' ? fieldR + 3 : 4) + r() * 44;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const mesh = new THREE.Mesh(rockGeo(0.3 + r() * 1.1, 200 + i), rockMat);
    mesh.position.set(x, heightAt(x, z) + 0.1, z);
    mesh.rotation.y = r() * Math.PI;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (const ar of layout.arches) {
    const arch = new THREE.Mesh(new THREE.TorusGeometry(ar.R, 1.3, 10, 28, Math.PI), rockMat);
    arch.position.set(ar.x, heightAt(ar.x, ar.z) - 0.3, ar.z);
    arch.rotation.y = -ar.turn;
    arch.castShadow = arch.receiveShadow = true;
    group.add(arch);
  }

  // The sunken ship: a split hull of planks, ribs, a broken mast; tilted in the sand.
  const wood = keep(addCaustics(new THREE.MeshStandardMaterial({ color: 0x4e3b2a, roughness: 0.95 }), time, { strength: 0.35 }));
  const ship = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12, 0.2, Math.PI * 2 - 0.9, Math.PI / 2, Math.PI / 2), keep(new THREE.MeshStandardMaterial({ color: 0x5a4532, roughness: 0.95, side: THREE.DoubleSide })));
  hull.scale.set(6, 2.4, 2.1);
  ship.add(hull);
  for (let k = -4; k <= 4; k++) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.09, 6, 14, Math.PI), wood);
    rib.position.set(k * 1.25, 0.15, 0);
    rib.rotation.set(Math.PI, Math.PI / 2, 0);
    rib.scale.set(1, 1.15 * (1 - Math.abs(k) * 0.06), 1);
    ship.add(rib);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 7, 8), wood);
  mast.position.set(1, 3, 0);
  mast.rotation.z = -0.35;
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4, 6), wood);
  yard.position.set(2.1, 5.4, 0);
  yard.rotation.set(0.3, 0, Math.PI / 2 - 0.35);
  ship.add(mast, yard);
  ship.position.set(layout.wreck.x, heightAt(layout.wreck.x, layout.wreck.z) + 1.2, layout.wreck.z);
  ship.rotation.set(0.08, -layout.wreck.turn, 0.22);
  ship.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(ship);

  // The stone whale tail: a tapering stem rising from the sand, and two broad flukes.
  const stone = keep(addCaustics(new THREE.MeshStandardMaterial({ color: 0x7c8a8c, roughness: 0.85 }), time, { strength: 0.5 }));
  const fb = heightAt(layout.fluke.x, layout.fluke.z);
  const stem = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0.4, 3, 0.2), new THREE.Vector3(-0.3, 6, 0), new THREE.Vector3(0, 7.6, -0.4)]), 24, 1, 10), stone);
  const tp = stem.geometry.attributes.position;
  for (let i = 0; i < tp.count; i++) { const k = 1 - Math.min(1, Math.max(0, tp.getY(i) / 8)) * 0.6; tp.setX(i, tp.getX(i) * k); tp.setZ(i, tp.getZ(i) * k); }
  stem.geometry.computeVertexNormals();
  const fluke = new THREE.Group();
  for (const s of [-1, 1]) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 10), stone);
    f.scale.set(3.2, 0.35, 1.3);
    f.position.set(s * 2.4, 8.1, -0.3);
    f.rotation.set(0, s * 0.25, s * 0.35);
    fluke.add(f);
  }
  fluke.add(stem);
  fluke.position.set(layout.fluke.x, fb, layout.fluke.z);
  fluke.rotation.y = 0.7;
  fluke.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(fluke);

  // The purple grotto: magenta ground cover, coral fans and barrel sponges.
  const cover = new THREE.InstancedMesh(new THREE.ConeGeometry(0.08, 0.32, 5), keep(new THREE.MeshStandardMaterial({ color: 0xd63fa8, emissive: 0x9a1c78, emissiveIntensity: 0.6, roughness: 0.6 })), 900);
  for (let i = 0; i < 900; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * layout.grotto.r;
    const x = layout.grotto.x + Math.cos(a) * d;
    const z = layout.grotto.z + Math.sin(a) * d;
    m.compose(new THREE.Vector3(x, heightAt(x, z) + 0.12, z), q.setFromEuler(e.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5)), new THREE.Vector3(1, 0.7 + r() * 0.8, 1));
    cover.setMatrixAt(i, m);
  }
  cover.userData.max = 900;
  group.add(cover);
  const fanTex = keep(canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#e46ad0';
    g.lineCap = 'round';
    const branch = (x, y, a, len, depth) => {
      if (depth === 0 || len < 3) return;
      const x2 = x + Math.cos(a) * len;
      const y2 = y + Math.sin(a) * len;
      g.lineWidth = depth * 0.9;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      branch(x2, y2, a - 0.35, len * 0.78, depth - 1);
      branch(x2, y2, a + 0.35, len * 0.78, depth - 1);
    };
    branch(w / 2, h, -Math.PI / 2, 30, 6);
  }));
  const fanMat = keep(new THREE.MeshStandardMaterial({ map: fanTex, alphaTest: 0.4, side: THREE.DoubleSide, emissive: 0x6a1c5a, emissiveIntensity: 0.5 }));
  const sponge = keep(addCaustics(new THREE.MeshStandardMaterial({ color: 0xb87a3c, roughness: 0.9 }), time, { strength: 0.35 }));
  const spongeGeo = new THREE.LatheGeometry([[0.0, 0], [0.55, 0], [0.62, 0.4], [0.7, 1.0], [0.62, 1.2], [0.48, 1.25], [0.5, 0.4], [0.0, 0.35]].map(([x, y]) => new THREE.Vector2(x, y)), 16);
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * layout.grotto.r * 1.2;
    const x = layout.grotto.x + Math.cos(a) * d;
    const z = layout.grotto.z + Math.sin(a) * d;
    const y = heightAt(x, z);
    if (i % 2) {
      const fan = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), fanMat);
      fan.geometry.translate(0, 0.7, 0);
      fan.position.set(x, y - 0.05, z);
      fan.rotation.y = r() * Math.PI;
      fan.scale.setScalar(0.8 + r() * 0.9);
      group.add(fan);
    } else {
      const s = new THREE.Mesh(spongeGeo, sponge);
      s.position.set(x, y - 0.05, z);
      s.scale.setScalar(0.7 + r() * 1.1);
      s.castShadow = true;
      group.add(s);
    }
  }

  // Manta rays gliding on wide loops, flapping (the wings bend with distance from the body).
  const mantaMat = keep(new THREE.MeshStandardMaterial({ color: 0x2c3a4a, roughness: 0.6, side: THREE.DoubleSide }));
  mantaMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
      float sp = abs(position.x);
      transformed.y += sin(uTime * 1.6 - sp * 2.2 + modelMatrix[3].x) * 0.32 * sp * sp;`);
  };
  const mantaGeo = mantaGeometry();
  const mantas = [0, 1, 2].map((i) => {
    const mesh = new THREE.Mesh(mantaGeo, mantaMat);
    mesh.scale.setScalar(2.4 + i * 0.4);
    mesh.castShadow = true;
    group.add(mesh);
    return { mesh, R: 16 + i * 9, y: REEF.top - 3 - i * 2.2, speed: 0.06 + i * 0.015, phase: i * 2.1 };
  });

  // Fish schools (instanced), darting away from the trainer.
  const fishGeo = fishGeometry();
  const fishMat = keep(new THREE.MeshStandardMaterial({ color: 0xc8d6e0, metalness: 0.3, roughness: 0.4 }));
  const schools = [
    makeSchool({ home: { x: 8, y: 5, z: -10 }, count: 40, seed: 1 }),
    makeSchool({ home: { x: -14, y: 6, z: 14 }, count: 34, seed: 2, speed: 0.1, loop: 8 }),
    makeSchool({ home: { x: 18, y: 4, z: 14 }, count: 30, seed: 3, speed: 0.14, loop: 12 }),
  ];
  const fishCount = schools.reduce((n, s) => n + s.fish.length, 0);
  const fish = new THREE.InstancedMesh(fishGeo, fishMat, fishCount);
  fish.frustumCulled = false;
  const fishColor = new THREE.Color();
  let fi = 0;
  for (const s of schools) for (let i = 0; i < s.fish.length; i++) fish.setColorAt(fi++, fishColor.setHSL(0.52 + (s.home.x % 3) * 0.05 + r() * 0.04, 0.35, 0.65));
  group.add(fish);

  // Bubbles rising, and specks drifting in the water.
  const BUB = 160;
  const bub = new Float32Array(BUB * 3);
  const bubSeed = Array.from({ length: BUB }, () => [(r() - 0.5) * 80, (r() - 0.5) * 80, r() * REEF.top, 0.8 + r() * 1.4]);
  const bubGeo = new THREE.BufferGeometry();
  bubGeo.setAttribute('position', new THREE.BufferAttribute(bub, 3));
  const bubbles = new THREE.Points(bubGeo, keep(new THREE.PointsMaterial({ map: dot, color: 0xe6fbff, size: 0.22, transparent: true, depthWrite: false, opacity: 0.75 })));
  bubbles.frustumCulled = false;
  group.add(bubbles);
  const SPECK = 900;
  const specks = new Float32Array(SPECK * 3);
  for (let i = 0; i < SPECK; i++) specks.set([(r() - 0.5) * 100, r() * REEF.top, (r() - 0.5) * 100], i * 3);
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute('position', new THREE.BufferAttribute(specks, 3));
  const speckPts = new THREE.Points(speckGeo, keep(new THREE.PointsMaterial({ map: dot, color: 0xbfeff2, size: 0.06, transparent: true, depthWrite: false, opacity: 0.6 })));
  speckPts.frustumCulled = false;
  group.add(speckPts);

  scene.add(group);
  const dummy = new THREE.Object3D();
  let last = null;
  let level = 'high';
  return {
    heightAt,
    layout,
    top: REEF.top,
    sun,
    group,
    get quality() { return level; },
    /** Advance: `seconds` the clock; `camera` for the depth-tinted fog; `avoid` the trainer, for the fish. */
    update(seconds, camera = null, avoid = null) {
      const dt = Math.min(0.1, Math.max(0, seconds - (last ?? seconds)));
      last = seconds;
      time.value = seconds;
      if (camera) {
        const depth = Math.min(1, Math.max(0, (REEF.top - camera.position.y) / REEF.top));
        fogColor.copy(shallow).lerp(deep, depth * 0.85);
        scene.fog.density = 0.034 + depth * 0.016;
        shafts.position.x = camera.position.x * 0.3;
        shafts.position.z = camera.position.z * 0.3;
      }
      for (const mt of mantas) {
        const a = seconds * mt.speed + mt.phase;
        mt.mesh.position.set(Math.cos(a) * mt.R, mt.y + Math.sin(seconds * 0.3 + mt.phase) * 0.8, Math.sin(a) * mt.R * 0.8);
        mt.mesh.rotation.set(0, -a + Math.PI, Math.sin(seconds * 0.5 + mt.phase) * 0.12);
      }
      let n = 0;
      for (const s of schools) {
        if (dt > 0) stepSchool(s, seconds, dt, avoid);
        for (const f of s.fish) {
          dummy.position.set(f.x, f.y, f.z);
          dummy.rotation.set(0, Math.atan2(-f.vz, f.vx), Math.atan2(f.vy, Math.hypot(f.vx, f.vz)) * 0.5);
          dummy.updateMatrix();
          fish.setMatrixAt(n++, dummy.matrix);
        }
      }
      fish.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < BUB; i++) {
        const [x, z, y0, sp] = bubSeed[i];
        const y = (y0 + seconds * sp) % REEF.top;
        bub.set([x + Math.sin(seconds * 2 + i) * 0.15, y, z], i * 3);
      }
      bubGeo.attributes.position.needsUpdate = true;
      speckPts.position.y = Math.sin(seconds * 0.2) * 0.3;
      speckPts.rotation.y = seconds * 0.004;
    },
    setQuality(q) {
      level = q;
      const high = q === 'high';
      const basic = q === 'basic';
      kelp.count = Math.round(kelp.userData.max * (high ? 1 : basic ? 0.3 : 0.6));
      cover.count = Math.round(cover.userData.max * (high ? 1 : basic ? 0.3 : 0.6));
      shafts.visible = !basic;
      sparkPts.visible = !basic;
      speckPts.visible = !basic;
      renderer.shadowMap.enabled = !basic;
      sun.castShadow = !basic;
      sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      scene.traverse((o) => { if (o.material) for (const mat of [].concat(o.material)) mat.needsUpdate = true; });
    },
    dispose() {
      scene.remove(group);
      for (const o of kept) o.dispose?.();
      group.traverse((o) => o.geometry?.dispose?.());
      scene.fog = null;
      scene.background = null;
    },
  };
}
