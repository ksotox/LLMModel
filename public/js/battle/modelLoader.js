// Loading a Pokémon 3D model (glTF, Draco-compressed, served by /api/battles/models): shared by the
// battle stage and the gallery's 3D Pop-out pictures.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { normalsFromHeights } from './surface.js';

/** A glTF loader with the Draco decoder (served locally, no CDN). Call `dispose()` when done. */
export function createModelLoader() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  return { loader, dispose: () => draco.dispose() };
}

/**
 * Load a model and stand it at the origin, scaled to `height` (wide models by their width), with
 * its own materials. Returns { object, height, clips, attackClip, faintClip }, or null if it can't
 * be loaded. `measure`: 'fit' (the default: the tallest or widest side), 'height' (it stands
 * `height` tall: a Pokémon's real height) or 'length' (its longest side: serpents and fish).
 */
export async function loadModel(loader, url, height, { shadows = true, realistic = false, types = [], measure = 'fit' } = {}) {
  if (!url) return null;
  try {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    root.traverse((o) => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        for (const m of [].concat(o.material)) {
          if (m.map) m.map.anisotropy = 8;
          if ('envMapIntensity' in m) m.envMapIntensity = 1;
        }
        if (realistic) o.material = Array.isArray(o.material) ? o.material.map((m) => realisticMaterial(m, types)) : realisticMaterial(o.material, types);
        o.frustumCulled = false;
        o.castShadow = shadows;
        o.receiveShadow = shadows;
      }
    });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const side = measure === 'height' ? size.y : measure === 'length' ? Math.max(size.x, size.y, size.z) : Math.max(size.y, size.x * 0.8, size.z * 0.8);
    const s = height / Math.max(side, 1e-3);
    root.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(root);
    const c = box2.getCenter(new THREE.Vector3());
    root.position.set(-c.x, -box2.min.y, -c.z);
    const wrap = new THREE.Group();
    wrap.add(root);
    wrap.userData.height = box2.max.y - box2.min.y;
    const clips = gltf.animations ?? [];
    return {
      object: wrap,
      height: box2.max.y - box2.min.y,
      clips,
      attackClip: clips.find((cl) => !/faint|dizzy|down|die|dead|sleep|hurt|damage|idle/i.test(cl.name)) ?? null,
      faintClip: clips.find((cl) => /faint|dizzy|down|die|dead|sleep/i.test(cl.name)) ?? null,
    };
  } catch (err) {
    console.warn('3D model unavailable:', err?.message ?? err);
    return null;
  }
}

/**
 * A model's idle, walk and "extra" (a happy or attack move) animations, picked by their names;
 * any can be null. With one clip only, it is the idle.
 */
export function pickClips(clips = []) {
  const find = (re, skip = null) => clips.find((c) => re.test(c.name) && c !== skip) ?? null;
  const idle = find(/idle|stand|wait|breath|loop/i);
  const walk = find(/walk|run|move|locomot/i, idle);
  const extra = find(/happy|joy|jump|cry|attack|special/i, idle);
  return { idle: idle ?? (clips.length === 1 ? clips[0] : null), walk, extra: extra && extra !== walk ? extra : null };
}

// ---- Realistic look (High / Standard) ----
// The models are game-style: often unlit or flat. On the better graphics levels each material becomes a
// physically based one lit by the scene and its sky (sheen for fur, a clear coat for skin, shells and
// water, metal for Metal types), gets fine surface relief made from its own colour texture, and a soft
// rim of light so it stands out from the scenery. Basic keeps the models as they come.

/**
 * What a material probably is, from the Pokémon's card types and its texture's average saturation
 * and brightness (0–1): 'metal', 'wet', 'hard', 'skin' or 'fur'. Pure, for the tests.
 */
export function surfaceKind({ types = [], sat = 0.3, lum = 0.5 } = {}) {
  const t = new Set([].concat(types).map((x) => String(x).toLowerCase().trim()));
  if (t.has('metal')) return 'metal';
  if (t.has('water')) return 'wet';
  if (t.has('fighting') || t.has('dragon')) return 'hard';
  if (sat > 0.5 || lum > 0.78) return 'skin'; // bright, smooth colours: skin, plastic-like shells
  return 'fur';
}

const SURFACE = {
  fur: { roughness: 0.85, sheen: 0.7, sheenRoughness: 0.55 },
  skin: { roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.45 },
  hard: { roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.35 },
  metal: { roughness: 0.32, metalness: 0.6, clearcoat: 0.5, clearcoatRoughness: 0.2 },
  wet: { roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 },
};

const looked = new WeakMap(); // texture → { stats, normal }

/** Average saturation and brightness of a texture, and a normal map made from it (null if unreadable). */
function textureLook(texture) {
  if (!texture?.image) return null;
  if (looked.has(texture)) return looked.get(texture);
  let out = null;
  try {
    const src = texture.image;
    const w = Math.min(256, src.width);
    const h = Math.min(256, src.height);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const heights = new Float32Array(w * h);
    let sat = 0;
    let lum = 0;
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4] / 255;
      const gg = px[i * 4 + 1] / 255;
      const b = px[i * 4 + 2] / 255;
      const mx = Math.max(r, gg, b);
      const mn = Math.min(r, gg, b);
      sat += mx > 0 ? (mx - mn) / mx : 0;
      heights[i] = r * 0.3 + gg * 0.59 + b * 0.11;
      lum += heights[i];
    }
    g.putImageData(new ImageData(normalsFromHeights(heights, w, h, 1.2), w, h), 0, 0);
    const normal = new THREE.CanvasTexture(c);
    normal.flipY = texture.flipY;
    normal.wrapS = texture.wrapS;
    normal.wrapT = texture.wrapT;
    normal.channel = texture.channel;
    out = { stats: { sat: sat / (w * h), lum: lum / (w * h) }, normal };
  } catch { /* unreadable: keep the plain upgrade */ }
  looked.set(texture, out);
  return out;
}

/** A soft rim of light on the edges facing away from the camera (view-space normal and position). */
function addRim(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `{
        float rim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 3.0);
        outgoingLight += diffuseColor.rgb * rim * 0.22;
      }
      #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'pokemon-rim';
}

/** The realistic version of one of a model's materials (the original is disposed of). */
export function realisticMaterial(m, types = []) {
  if (!m || m.isMeshPhysicalMaterial || m.isShaderMaterial) return m;
  const look = textureLook(m.map);
  const kind = surfaceKind({ types, ...(look?.stats ?? {}) });
  const p = new THREE.MeshPhysicalMaterial({
    name: m.name,
    color: m.color ?? new THREE.Color(0xffffff),
    map: m.map ?? null,
    normalMap: m.normalMap ?? look?.normal ?? null,
    emissive: m.emissive ?? new THREE.Color(0x000000),
    emissiveMap: m.emissiveMap ?? null,
    alphaMap: m.alphaMap ?? null,
    transparent: m.transparent,
    opacity: m.opacity,
    alphaTest: m.alphaTest,
    side: m.side,
    vertexColors: m.vertexColors,
    envMapIntensity: 1,
    ...SURFACE[kind],
  });
  if (!m.normalMap && look?.normal) p.normalScale.set(0.35, 0.35);
  if (kind === 'fur' && m.color) p.sheenColor.copy(m.color).lerp(new THREE.Color(0xffffff), 0.5);
  if (p.map) p.map.anisotropy = 8;
  addRim(p);
  p.userData.surface = kind;
  m.dispose();
  return p;
}

/**
 * Life for a model that has a skeleton but no animation clips: slow breathing through its spine and
 * neck bones and a gentle look about with the head. Returns { update(t) }, or null with no bones.
 */
export function breathing(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone && /spine|chest|body|torso|neck|head/i.test(o.name)) bones.push(o); });
  if (!bones.length) return null;
  const rest = bones.map((b) => b.quaternion.clone());
  const turn = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const seed = Math.random() * 10;
  return {
    update(t) {
      bones.forEach((b, i) => {
        const head = /neck|head/i.test(b.name);
        b.quaternion.copy(rest[i]);
        b.quaternion.multiply(turn.setFromAxisAngle(X, Math.sin(t * 1.6 + seed) * (head ? 0.04 : 0.025)));
        if (head) b.quaternion.multiply(turn.setFromAxisAngle(Y, Math.sin(t * 0.45 + seed) * 0.18));
      });
    },
  };
}
