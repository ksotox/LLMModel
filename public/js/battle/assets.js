// The High/Standard scenery set: CC0 photo textures, skies and rock models from Poly Haven
// (polyhaven.com), kept in public/assets/realism/ (fetched by scripts/fetch-realism-assets.mjs; its
// manifest.json lists each asset's id and page). Everything here loads lazily and resolves to null
// on any failure, so callers keep the procedural look.

import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const REALISM_BASE = '/assets/realism/';

/** The surface sets the scenery uses, and how many world units one texture tile covers. */
export const SURFACES = { grass: 4, soil: 5, rock: 6, cliff: 9, sand: 4, snow: 7, bark: 1 };

let manifest = null;
const cache = new Map();
const once = (key, make) => {
  if (!cache.has(key)) cache.set(key, make().catch(() => null));
  return cache.get(key);
};

/** The manifest (or null when the set isn't there). */
export function realismManifest() {
  manifest ??= fetch(`${REALISM_BASE}manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return manifest;
}

const textureLoader = new THREE.TextureLoader();
const loadTex = (url, srgb) => textureLoader.loadAsync(url).then((t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
});

/** A surface's maps: { color, normal, rough }, or null. */
export function surface(slot) {
  return once(`surface:${slot}`, async () => {
    const m = await realismManifest();
    if (!m?.assets?.[slot]) return null;
    const base = `${REALISM_BASE}${slot}/`;
    const [color, normal, rough] = await Promise.all([loadTex(`${base}color.jpg`, true), loadTex(`${base}normal.jpg`), loadTex(`${base}rough.jpg`)]);
    return { color, normal, rough, tile: SURFACES[slot] ?? 4 };
  });
}

/** A sky for lighting ('sky-day' or 'sky-sunset'), prefiltered for PBR; or null. */
export function skyLight(renderer, slot) {
  return once(`sky:${slot}`, async () => {
    const m = await realismManifest();
    if (!m?.assets?.[slot]) return null;
    const hdr = await new HDRLoader().loadAsync(`${REALISM_BASE}${slot}/sky.hdr`);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromEquirectangular(hdr);
    hdr.dispose();
    pmrem.dispose();
    return target;
  });
}

/** A model set's meshes (geometry + material each), e.g. 'rocks'; or null. */
export function modelSet(slot) {
  return once(`model:${slot}`, async () => {
    const m = await realismManifest();
    if (!m?.assets?.[slot]) return null;
    const gltf = await new GLTFLoader().loadAsync(`${REALISM_BASE}${slot}/model.gltf`);
    const meshes = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const c = box.getCenter(new THREE.Vector3());
      geo.translate(-c.x, -box.min.y, -c.z); // stand it on the ground, centred
      geo.computeBoundingSphere();
      meshes.push({ geometry: geo, material: o.material });
    });
    return meshes.length ? meshes : null;
  });
}

/**
 * How much of each ground layer a terrain point gets (pure, for the tests): { soil, sand, rock, snow }
 * (grass is the rest). `ny`: the surface normal's up component; `lake`: whether it's by the lake;
 * `n1`, `n2`: noise in 0–1 for patchiness.
 */
export function groundWeights({ y, ny, lake = false, n1 = 0.5, n2 = 0.5 }) {
  const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  return {
    soil: smooth(0.55, 0.78, n1) * 0.6,
    sand: lake ? smooth(0.15, -0.6, y) : 0,
    rock: Math.max(smooth(0.86, 0.66, ny), smooth(17, 32, y) * 0.85),
    snow: smooth(42, 60, y + n2 * 12) * smooth(0.45, 0.78, ny),
  };
}
