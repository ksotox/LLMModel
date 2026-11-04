// Loading a Pokémon 3D model (glTF, Draco-compressed, served by /api/battles/models): shared by the
// battle stage and the gallery's 3D Pop-out pictures.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

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
 * be loaded.
 */
export async function loadModel(loader, url, height, { shadows = true } = {}) {
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
        o.frustumCulled = false;
        o.castShadow = shadows;
        o.receiveShadow = shadows;
      }
    });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = height / Math.max(size.y, size.x * 0.8, size.z * 0.8, 1e-3);
    root.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(root);
    const c = box2.getCenter(new THREE.Vector3());
    root.position.set(-c.x, -box2.min.y, -c.z);
    const wrap = new THREE.Group();
    wrap.add(root);
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
