// Blinking eyes. The game models draw their eyes with a material of their own ("Eye", a texture named
// "…_Eye1.png"); a blink is an eyelid in the body's colour sweeping down over that material and back up,
// measured along the model's own "up" in the eye's (unskinned) shape, so it follows the head as it moves.
// The timing is pure and tested; setupBlink() does the three.js part.

import * as THREE from 'three';
import { patchShader } from '../battle/modelLoader.js';

/** A material (by its name or its texture's) that draws eyes, but not a separate iris or brows. Pure. */
export function isEyeMaterial(name = '', textureName = '') {
  const text = `${name} ${textureName}`;
  return /eye/i.test(text) && !/iris|brow|lash|lid|eyeball_?shine|highlight/i.test(text);
}

/**
 * The blink timing: every 2.5–6 s (now and then twice in a row), shut for about 0.16 s. step(dt) gives
 * how shut the eyes are, 0–1. Pure, with its own random source.
 */
export function blinkTimer(rand = Math.random) {
  let wait = 1 + rand() * 3;
  let t = -1; // time into the current blink, or -1 between blinks
  const length = 0.16;
  return {
    step(dt) {
      if (t < 0) {
        wait -= dt;
        if (wait > 0) return 0;
        t = 0;
      }
      t += dt;
      if (t >= length) {
        t = -1;
        wait = rand() < 0.15 ? 0.12 : 2.5 + rand() * 3.5;
        return 0;
      }
      return 1 - Math.abs(t / length * 2 - 1); // down, then up again
    },
  };
}

/** The average colour of a texture (its middle), for the eyelids; null when it can't be read. */
function averageColour(texture) {
  const img = texture?.image;
  if (!img || !(img.width > 0)) return null;
  try {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, img.width * 0.25, img.height * 0.25, img.width * 0.5, img.height * 0.5, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return n ? new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace) : null;
  } catch {
    return null;
  }
}

/** Make a loaded model blink (modelLoader.loadModel's result.object). Returns { update(dt) }, or null with no eyes. */
export function setupBlink(object, { rand = Math.random } = {}) {
  const eyes = [];
  let body = null;
  let bodySize = 0;
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (isEyeMaterial(m.name, m.map?.name)) eyes.push({ mesh: o, material: m });
      else if (m.map && (o.geometry.attributes.position?.count ?? 0) > bodySize) { body = m; bodySize = o.geometry.attributes.position.count; }
    }
  });
  if (!eyes.length) return null;
  const lid = averageColour(body?.map) ?? body?.color?.clone() ?? new THREE.Color(0.8, 0.7, 0.6);
  const uniforms = { uBlink: { value: 0 } };
  const objectUp = new THREE.Vector3(0, 1, 0).applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()));
  for (const { mesh, material } of eyes) {
    // The model's up, in this mesh's own (unskinned) coordinates, and how far the eye shape spans along it.
    const up = objectUp.clone().applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
    const pos = mesh.geometry.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getX(i) * up.x + pos.getY(i) * up.y + pos.getZ(i) * up.z;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const eyeUniforms = { uBlink: uniforms.uBlink, uLidUp: { value: up }, uLidRange: { value: new THREE.Vector2(lo, Math.max(hi, lo + 1e-6)) }, uLidColour: { value: lid } };
    patchShader(material, 'pokemon-blink', (shader) => {
      Object.assign(shader.uniforms, eyeUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uLidUp;\nuniform vec2 uLidRange;\nvarying float vLid;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLid = (dot(position, uLidUp) - uLidRange.x) / (uLidRange.y - uLidRange.x);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uBlink;\nuniform vec3 uLidColour;\nvarying float vLid;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nif (vLid > 1.0 - uBlink * 1.04) diffuseColor.rgb = uLidColour;');
    });
  }
  const timer = blinkTimer(rand);
  return {
    update(dt) { uniforms.uBlink.value = timer.step(dt); },
  };
}
