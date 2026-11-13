// The weather over a PokéBattle, on screen: falling rain, drifting snow or blowing sand round the
// camera, and a tint of the light, the fog and the sky (sun: warm and bright; rain: dim and blue;
// sandstorm: thick and tan; snow: pale). The kinds follow the fan game PokeBrawl's weather; what
// each does to the battle is in engine.js.

import * as THREE from 'three';

/** How each weather changes the scene: tint colour and strength, fog thickness, light strength. */
export const WEATHER_LOOK = {
  clear: { tint: [1, 1, 1], strength: 0, fog: 1, light: 1 },
  sun: { tint: [1.0, 0.82, 0.45], strength: 0.16, fog: 0.8, light: 1.22 },
  rain: { tint: [0.28, 0.36, 0.52], strength: 0.42, fog: 2.4, light: 0.62 },
  sand: { tint: [0.80, 0.62, 0.36], strength: 0.5, fog: 3.4, light: 0.85 },
  snow: { tint: [0.88, 0.93, 1.0], strength: 0.4, fog: 2.6, light: 0.9 },
};

const BOX = { x: 26, y: 14, z: 26 }; // the space round the camera the particles live in
const wrap = (v, half) => ((((v + half) % (half * 2)) + half * 2) % (half * 2)) - half;

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

/**
 * Add the weather to `scene`. Returns { update(seconds, dt), setQuality(q), dispose() }; null for
 * clear weather. `tint(look)` is called once so the world can colour its sky, fog and lights.
 */
export function buildWeather(kind, { scene, camera, dot }) {
  const look = WEATHER_LOOK[kind];
  if (!look || kind === 'clear') return null;
  if (kind === 'sun') return { look, update() {}, setQuality() {}, dispose() {} };

  const r = rng(kind.length * 131);
  const max = kind === 'rain' ? 2600 : kind === 'sand' ? 2200 : 2400;
  const seeds = new Float32Array(max * 4); // x, y, z in the box, and a speed of its own
  for (let i = 0; i < max; i++) seeds.set([(r() - 0.5) * BOX.x, (r() - 0.5) * BOX.y, (r() - 0.5) * BOX.z, 0.6 + r() * 0.8], i * 4);
  const fall = kind === 'rain' ? new THREE.Vector3(1.6, -24, 0.6) : kind === 'snow' ? new THREE.Vector3(0.5, -1.5, 0.2) : new THREE.Vector3(11, -0.4, 3.5);

  let object;
  let positions;
  if (kind === 'rain') {
    positions = new Float32Array(max * 6); // a short streak each
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xbfd4ee, transparent: true, opacity: 0.42, depthWrite: false, fog: false }));
  } else {
    positions = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    object = new THREE.Points(geo, new THREE.PointsMaterial({
      map: dot, color: kind === 'snow' ? 0xffffff : 0xd9b784, size: kind === 'snow' ? 0.17 : 0.085,
      transparent: true, opacity: kind === 'snow' ? 0.9 : 0.6, depthWrite: false, fog: false, sizeAttenuation: true,
    }));
  }
  object.frustumCulled = false;
  object.renderOrder = 5;
  scene.add(object);
  let count = max;

  const streak = fall.clone().multiplyScalar(0.022);
  return {
    look,
    update(seconds) {
      const c = camera.position;
      for (let i = 0; i < count; i++) {
        const k = seeds[i * 4 + 3];
        let x = wrap(seeds[i * 4] + fall.x * seconds * k, BOX.x / 2);
        const y = wrap(seeds[i * 4 + 1] + fall.y * seconds * k, BOX.y / 2);
        let z = wrap(seeds[i * 4 + 2] + fall.z * seconds * k, BOX.z / 2);
        if (kind !== 'rain') { // snow sways, sand swirls
          x += Math.sin(seconds * (kind === 'snow' ? 0.9 : 2.2) * k + i) * (kind === 'snow' ? 0.35 : 0.2);
          z += Math.cos(seconds * (kind === 'snow' ? 0.7 : 1.9) * k + i * 1.7) * (kind === 'snow' ? 0.35 : 0.2);
        }
        if (kind === 'rain') {
          positions.set([c.x + x, c.y + y, c.z + z, c.x + x + streak.x, c.y + y + streak.y, c.z + z + streak.z], i * 6);
        } else {
          positions.set([c.x + x, c.y + y, c.z + z], i * 3);
        }
      }
      object.geometry.attributes.position.needsUpdate = true;
    },
    setQuality(q) {
      count = Math.round(max * (q === 'high' ? 1 : q === 'basic' ? 0.25 : 0.55));
      object.geometry.setDrawRange(0, kind === 'rain' ? count * 2 : count);
    },
    dispose() {
      scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    },
  };
}
