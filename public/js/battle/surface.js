// Depth for the battle worlds' surfaces, all made in code (no downloaded maps):
//   • normal maps worked out from each painted texture, so stone, dirt, sand and bricks catch the
//     sun at a low angle instead of looking flat;
//   • light from the sky itself (an environment map baked from the sky dome), so shaded sides get
//     the sky's colour and smooth things reflect it;
//   • soft dark patches on the ground under rocks, trees and props, so they sit in the terrain;
//   • leaf cards: flat cut-out clusters of leaves for tree crowns, lit as one rounded crown.

import * as THREE from 'three';

/** Heights (0–1) from a picture's brightness, then a normal map from their slopes (tiling). */
export function normalsFromHeights(heights, w, h, strength = 2) {
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (x, y) => heights[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out[i] = (-dx / len * 0.5 + 0.5) * 255;
      out[i + 1] = (dy / len * 0.5 + 0.5) * 255; // (flipped with the texture's y)
      out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

const made = new WeakMap(); // colour texture → its normal map

/** The normal map for a painted (canvas) texture: darker paint is lower. Made once per texture. */
export function normalMapFor(texture, strength = 2.2) {
  if (made.has(texture)) return made.get(texture);
  const src = texture.image;
  if (!src?.getContext || !src.width) return null;
  const w = Math.min(512, src.width);
  const h = Math.min(512, src.height);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) heights[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255;
  g.putImageData(new ImageData(normalsFromHeights(heights, w, h, strength), w, h), 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.wrapS = texture.wrapS;
  map.wrapT = texture.wrapT;
  map.repeat.copy(texture.repeat);
  map.anisotropy = texture.anisotropy;
  made.set(texture, map);
  return map;
}

/**
 * Give every painted, solid surface under `root` its normal map. Cut-out and see-through ones
 * (leaves, chalk lines) are left alone. Returns the maps made, to dispose of with the world.
 */
export function addSurfaceDepth(root) {
  const maps = new Set();
  root.traverse((o) => {
    for (const m of [].concat(o.material ?? [])) {
      if (!m.isMeshStandardMaterial || !m.map || m.normalMap || m.transparent || m.alphaTest > 0) continue;
      const map = normalMapFor(m.map);
      if (!map) continue;
      m.normalMap = map;
      m.normalScale = new THREE.Vector2(0.9, 0.9);
      m.needsUpdate = true;
      maps.add(map);
    }
  });
  return [...maps];
}

/** Light from the sky: an environment map baked from the sky dome (its sun, gradient and clouds). */
export function skyEnvironment(renderer, skyMesh) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const parent = skyMesh.parent;
  const at = skyMesh.position.clone();
  scene.add(skyMesh);
  skyMesh.position.set(0, 0, 0);
  const target = pmrem.fromScene(scene, 0.02, 1, 5000);
  skyMesh.position.copy(at);
  parent?.add(skyMesh);
  pmrem.dispose();
  return target;
}

/** A soft dark round patch, for the ground under things. */
export function contactTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.62)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** All the contact shadows of a world, as one instanced mesh: add(x, y, z, radius) then finish(). */
export function contactShadows(texture, max = 256) {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const m = new THREE.Matrix4();
  return {
    mesh,
    add(x, y, z, radius) {
      if (mesh.count >= max) return;
      mesh.setMatrixAt(mesh.count++, m.makeScale(radius, 1, radius).setPosition(x, y + 0.03, z));
    },
    finish() { mesh.instanceMatrix.needsUpdate = true; return mesh; },
  };
}

/** A cluster of leaves on a see-through background, for leaf cards. */
export function leafClusterTexture(colors, seed = 5) {
  let a = seed >>> 0;
  const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let i = 0; i < 150; i++) {
    const d = Math.sqrt(r()) * 108;
    const ang = r() * Math.PI * 2;
    const x = 128 + Math.cos(ang) * d;
    const y = 128 + Math.sin(ang) * d;
    g.save();
    g.translate(x, y);
    g.rotate(r() * Math.PI);
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    g.beginPath();
    g.ellipse(0, 0, 17 + r() * 9, 8 + r() * 4, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A spray of pine needles on a see-through background, for needle cards: twigs that fan out from
 * the top middle and droop, each bristling with short needles.
 */
export function needleClusterTexture(colors, seed = 9) {
  let a = seed >>> 0;
  const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  for (let t = 0; t < 16; t++) {
    // A twig: from near the top middle, out and down in a gentle curve.
    let x = 128 + (r() - 0.5) * 40;
    let y = 6 + r() * 60;
    let ang = Math.PI / 2 + (r() - 0.5) * 1.5; // pointing down, fanned
    const steps = 10 + Math.floor(r() * 8);
    for (let i = 0; i < steps; i++) {
      const nx = x + Math.cos(ang) * 9;
      const ny = y + Math.sin(ang) * 9;
      g.strokeStyle = colors[Math.floor(r() * colors.length)];
      g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      // Needles on both sides, swept forward.
      g.lineWidth = 1.6;
      for (const side of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const px = x + (nx - x) * (k / 4);
          const py = y + (ny - y) * (k / 4);
          const na = ang + side * (0.75 + r() * 0.35);
          const len = 8 + r() * 6;
          g.strokeStyle = colors[Math.floor(r() * colors.length)];
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * len, py + Math.sin(na) * len); g.stroke();
        }
      }
      x = nx; y = ny;
      ang += (Math.cos(ang) > 0 ? 1 : -1) * 0.02 + (r() - 0.5) * 0.12; // droop a little more as it goes
      if (x < 12 || x > 244 || y > 244) break;
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Cards laid round cones (a pine's tiers), sloping down their sides like layers of branches.
 * `tiers`: [[centreY, radius, height], ...] as the cones are built. Pure geometry, for the tests.
 */
export function skirtGeometry(tiers, seed = 1, perRing = 9) {
  let a = seed >>> 0;
  const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  for (const [cy, rad, h] of tiers) {
    for (const [s, turn] of [[0.32, 0], [0.72, 0.5]]) { // two rings per tier: near the top, near the hem
      const y = cy + h / 2 - h * s;
      const ringR = rad * s * 1.08;
      const n = Math.max(5, Math.round(perRing * (0.55 + s)));
      for (let i = 0; i < n; i++) {
        const th = ((i + turn + (r() - 0.5) * 0.4) / n) * Math.PI * 2;
        const cx = Math.cos(th);
        const cz = Math.sin(th);
        const slant = Math.hypot(rad, h);
        const dx = (cx * rad) / slant; const dy = -h / slant; const dz = (cz * rad) / slant; // down the side
        const tx = -cz; const tz = cx; // round the cone
        const wide = ((2 * Math.PI * ringR) / n) * 1.7;
        const len = slant * 0.5;
        const nl = Math.hypot(cx * h, rad, cz * h);
        const nx = (cx * h) / nl; const ny = rad / nl; const nz = (cz * h) / nl;
        const base = pos.length / 3;
        for (const [u, v] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
          pos.push(cx * ringR + tx * u * wide * 0.5 + dx * -v * len * 0.5, y + dy * -v * len * 0.5, cz * ringR + tz * u * wide * 0.5 + dz * -v * len * 0.5);
          nor.push(nx, ny, nz);
          uv.push(u * 0.5 + 0.5, v * 0.5 + 0.5);
        }
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A crown of leaf cards: `count` cut-out planes scattered in a rounded crown, their normals pointing
 * out from its middle (so it is lit as one soft ball of leaves), swaying in the wind (uTime).
 * Returns { material, depthMaterial, crown(radius, seed) → geometry }.
 */
export function leafCards(texture, time, { matte = false } = {}) {
  const sway = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
      `#include <begin_vertex>
       float lw = sin(uTime * 1.6 + position.x * 2.1 + position.z * 1.7 + modelMatrix[3].x) * 0.035;
       transformed.x += lw; transformed.y += lw * 0.5;`);
    // A card is lit by the normal it was given (out from its crown, up from its cone) on both sides:
    // three.js turns the normal round for a card's back, which lit half the leaves (and every needle
    // card, wound the other way) from inside, as black patches.
    if (shader.fragmentShader) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n  normal = normalize(vNormal);\n  nonPerturbedNormal = normal;');
    }
  };
  // (`matte`: no sheen at all, for cards often seen edge-on, such as needles along a pine's sides.)
  const material = matte
    ? new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  material.onBeforeCompile = sway;
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: texture, alphaTest: 0.5 });
  depthMaterial.onBeforeCompile = sway;
  // The same leaves in another shade (each tree its own green), made once per shade.
  const shades = new Map();
  const tinted = (hex) => {
    if (!shades.has(hex)) {
      const m = material.clone();
      m.color.set(hex);
      m.onBeforeCompile = sway;
      shades.set(hex, m);
    }
    return shades.get(hex);
  };
  const crown = (radius, seed, count = 22) => {
    let a = seed >>> 0;
    const r = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
    const pos = [];
    const nor = [];
    const uv = [];
    const idx = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // A point on (or a little inside) a squashed ball, and a card there turned any way.
      const u = r() * 2 - 1;
      const th = r() * Math.PI * 2;
      const k = Math.sqrt(1 - u * u) * radius * (0.55 + r() * 0.45);
      const centre = new THREE.Vector3(Math.cos(th) * k, u * radius * 0.75, Math.sin(th) * k);
      const size = radius * (0.5 + r() * 0.3);
      q.setFromEuler(e.set(r() * Math.PI, r() * Math.PI, r() * Math.PI));
      const base = pos.length / 3;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        v.set(x * size * 0.5, y * size * 0.5, 0).applyQuaternion(q).add(centre);
        pos.push(v.x, v.y, v.z);
        const n = v.clone().normalize().lerp(new THREE.Vector3(0, 1, 0), 0.25).normalize();
        nor.push(n.x, n.y, n.z);
        uv.push(x * 0.5 + 0.5, y * 0.5 + 0.5);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  };
  return { material, depthMaterial, crown, tinted, shades };
}
