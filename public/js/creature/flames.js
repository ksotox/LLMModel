// Fire that burns: a Charmander's tail tip, a Magmar's flames, a Ponyta's mane. The game models draw
// their flames as parts of their own (materials or textures named "FireCore…", "FireSten…"; a Ponyta's
// burning mane is its "Hair"). Those parts glow and flicker, embers and tongues of flame rise from them
// (following the bone that carries them), and on the best graphics a small warm light goes with them.

import * as THREE from 'three';
import { patchShader } from '../battle/modelLoader.js';

/** Burning parts named otherwise, by National Pokédex number: Ponyta and Rapidash's manes and tails. */
const FLAME_PARTS = { 77: /hair/i, 78: /hair/i };
/** A flame at the tip of the tail whose part can't be told by name (Charizard's model): embers there. */
const TAIL_FLAME = new Set([4, 5, 6]);

/** A part (by its material's name or its texture's) that is fire. Pure. */
export function isFlame(name = '', textureName = '', dexId = null) {
  const text = `${name} ${textureName}`;
  return /fire|flame|blaze|ember/i.test(text) || Boolean(FLAME_PARTS[dexId]?.test(text));
}

/** Whether a texture is (nearly) grey: a flame's shape only, with no fire colours of its own. */
function greyTexture(texture) {
  const img = texture?.image;
  if (!img || !(img.width > 0)) return false;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      const hi = Math.max(d[i], d[i + 1], d[i + 2]);
      sat += hi ? (hi - Math.min(d[i], d[i + 1], d[i + 2])) / hi : 0;
    }
    return sat / (d.length / 4) < 0.12;
  } catch {
    return false;
  }
}

let emberTexture = null;
/** A soft round spot, white in the middle (tinted by each sprite). */
function ember() {
  if (emberTexture) return emberTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  emberTexture = new THREE.CanvasTexture(c);
  emberTexture.colorSpace = THREE.SRGBColorSpace;
  return emberTexture;
}

const HOT = [new THREE.Color(0xfff3b0), new THREE.Color(0xffb23a), new THREE.Color(0xff5a1a), new THREE.Color(0x7a1d08)];
const heat = (k, out) => {
  const i = Math.min(HOT.length - 2, Math.floor(k * (HOT.length - 1)));
  return out.copy(HOT[i]).lerp(HOT[i + 1], k * (HOT.length - 1) - i);
};

/**
 * Light up a loaded model's flames (modelLoader.loadModel's result.object). `quality`: 'high' adds a light
 * and the most embers, 'basic' a few. Returns { update(dt), dispose() }, or null when it has no fire.
 */
export function setupFlames(object, { dexId = null, quality = 'high' } = {}) {
  const parts = [];
  object.traverse((o) => {
    if (!o.isMesh) return;
    if ([].concat(o.material).some((m) => isFlame(m.name, m.map?.name, dexId))) parts.push(o);
  });
  const height = object.userData.height ?? 1;
  const time = { value: 0 };
  const emitters = [];
  if (!parts.length && TAIL_FLAME.has(dexId)) {
    // The deepest tail bone: the tip, where the flame burns.
    let tip = null;
    let deepest = -1;
    object.traverse((o) => {
      if (!o.isBone || !/tail/i.test(o.name)) return;
      let depth = 0;
      for (let p = o.parent; p; p = p.parent) depth++;
      if (depth > deepest) { deepest = depth; tip = o; }
    });
    if (tip) {
      const anchor = new THREE.Object3D();
      tip.add(anchor);
      emitters.push(anchor);
    }
  }
  if (!parts.length && !emitters.length) return null;
  for (const mesh of parts) {
    mesh.geometry.computeBoundingBox();
    // The ripple of the flame's surface, a few per cent of its own size (models use their own units).
    const wobble = { value: mesh.geometry.boundingBox.getSize(new THREE.Vector3()).length() * 0.03 };
    const glowing = [].concat(mesh.material).map((old) => {
      // Fire is light: it isn't shaded, it glows in its own colours. A grey "stencil" texture (only the
      // flame's shape) becomes a fire-coloured glow in that shape, added onto what's behind it.
      const stencil = /sten|mask/i.test(`${old.name} ${old.map?.name ?? ''}`) || greyTexture(old.map);
      const m = stencil
        ? new THREE.MeshBasicMaterial({ name: old.name, color: 0xff7a1a, alphaMap: old.map ?? null, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false })
        : new THREE.MeshBasicMaterial({ name: old.name, map: old.map ?? null, color: old.color ?? 0xffffff, transparent: old.transparent, alphaTest: old.alphaTest, opacity: old.opacity, side: old.side, toneMapped: false });
      old.dispose();
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? glowing : glowing[0];
    mesh.castShadow = false;
    for (const m of glowing) {
      patchShader(m, 'pokemon-flame', (shader) => {
        shader.uniforms.uFlameTime = time;
        shader.uniforms.uFlameWobble = wobble;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uFlameTime;\nuniform float uFlameWobble;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            transformed += normal * (sin(uFlameTime * 13.0 + position.y * 0.3 / uFlameWobble) * 0.5 + sin(uFlameTime * 7.3 + position.x * 0.4 / uFlameWobble) * 0.5) * uFlameWobble;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uFlameTime;')
          .replace('#include <opaque_fragment>', `outgoingLight *= 0.85 + 0.25 * sin(uFlameTime * 17.0) * sin(uFlameTime * 5.1 + 1.3);
            #include <opaque_fragment>`);
      });
    }
    // Where the flame is: its centre, carried by the bone that moves most of it.
    const centre = mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
    const anchor = new THREE.Object3D();
    if (mesh.isSkinnedMesh && mesh.skeleton) {
      const idx = mesh.geometry.attributes.skinIndex;
      const wts = mesh.geometry.attributes.skinWeight;
      const votes = new Map();
      for (let i = 0; i < idx.count; i++) {
        for (let k = 0; k < 4; k++) votes.set(idx.getComponent(i, k), (votes.get(idx.getComponent(i, k)) ?? 0) + wts.getComponent(i, k));
      }
      const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0];
      const bone = mesh.skeleton.bones[best];
      if (bone) {
        anchor.position.copy(centre).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[best]);
        bone.add(anchor);
      } else mesh.add(anchor.translateX(centre.x).translateY(centre.y).translateZ(centre.z));
    } else {
      anchor.position.copy(centre);
      mesh.add(anchor);
    }
    emitters.push(anchor);
  }
  // Embers: sprites rising from the flames in the model's frame (they drift up and fade, cooling).
  const count = { high: 18, standard: 10, basic: 4 }[quality] ?? 8;
  const sprites = [];
  const material = () => new THREE.SpriteMaterial({ map: ember(), color: 0xffb23a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  for (let i = 0; i < count * emitters.length; i++) {
    const s = new THREE.Sprite(material());
    s.visible = false;
    s.userData = { life: 0, max: 1, from: emitters[i % emitters.length], v: new THREE.Vector3() };
    object.add(s);
    sprites.push(s);
  }
  const light = quality === 'high' ? new THREE.PointLight(0xff8a3a, 1.2, height * 3, 2) : null;
  if (light) emitters[0].add(light);
  const at = new THREE.Vector3();
  let t = 0;
  let spawn = 0;
  return {
    update(dt) {
      t += dt;
      time.value = t;
      if (light) light.intensity = 1.2 * (0.8 + 0.25 * Math.sin(t * 13) * Math.sin(t * 7.1));
      spawn += dt * sprites.length / 0.7; // the whole pool turns over in about 0.7 s
      for (const s of sprites) {
        const u = s.userData;
        if (u.life <= 0 && spawn >= 1) {
          spawn -= 1;
          u.from.getWorldPosition(at);
          object.worldToLocal(at);
          s.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.05).multiplyScalar(height));
          u.max = u.life = 0.35 + Math.random() * 0.5;
          u.v.set((Math.random() - 0.5) * 0.08, 0.35 + Math.random() * 0.3, (Math.random() - 0.5) * 0.08).multiplyScalar(height);
          u.size = height * (0.05 + Math.random() * 0.06);
          s.visible = true;
        }
        if (u.life <= 0) continue;
        u.life -= dt;
        if (u.life <= 0) { s.visible = false; continue; }
        const k = 1 - u.life / u.max; // 0 new … 1 gone
        s.position.addScaledVector(u.v, dt);
        s.scale.setScalar(u.size * (1 - k * 0.6));
        heat(0.2 + k * 0.8, s.material.color); // born orange-yellow, cooling to red
        s.material.opacity = (1 - k) * 0.9;
      }
    },
    dispose() {
      for (const s of sprites) { s.parent?.remove(s); s.material.dispose(); }
      light?.parent?.remove(light);
    },
  };
}
