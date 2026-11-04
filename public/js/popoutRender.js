// 3D Pop-out pictures: each Pokémon's 3D model, drawn once as a picture with a transparent
// background, laid over its tilted card in the gallery so the Pokémon seems to step out of it.
//
// One picture per model (form + Pokédex number) is shared by every card of that Pokémon, and is
// saved by the server (data/popout), so each one is drawn only once for all devices. Tiles ask for
// their picture as they scroll into view; missing pictures are drawn one at a time with a single
// offscreen WebGL renderer that's only loaded when needed. Without WebGL or a model the tile simply
// keeps its tilted card.

import { api } from './api.js';

const W = 480;
const H = 508; // the tile's picture area is 1 : 1.06

const info = new Map(); // card id → Promise<{ form, id, model, snapshot, has } | null>
const pictures = new Map(); // "form/id" → Promise<string|null> (picture URL)
let waiting = new Map(); // card id → [resolve] for the next batch request
let batchTimer = null;
let painter = null; // Promise of the offscreen renderer
let queue = Promise.resolve();

const observer = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      fill(e.target);
    }
  }, { rootMargin: '300px 0px' })
  : null;

/** Called for each tile's empty picture slot: fills it once the tile is (nearly) on screen. */
export function watchModelSlot(img, card) {
  img.dataset.cardId = card.id;
  if (observer) observer.observe(img);
  else fill(img);
}

async function fill(img) {
  const id = Number(img.dataset.cardId);
  try {
    const m = await modelFor(id);
    if (!m) return;
    const url = await pictureFor(m);
    if (!url || !img.isConnected) return;
    img.onload = () => img.classList.add('ready');
    img.src = url;
  } catch (err) {
    console.warn('3D Pop-out picture unavailable:', err?.message ?? err);
  }
}

/** Which model a card has, asked for in batches as tiles come into view. */
function modelFor(id) {
  if (!info.has(id)) {
    info.set(id, new Promise((resolve) => {
      waiting.set(id, resolve);
      clearTimeout(batchTimer);
      batchTimer = setTimeout(flush, 60);
    }));
  }
  return info.get(id);
}

async function flush() {
  const batch = waiting;
  waiting = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    let models = {};
    try {
      ({ models } = await api.popoutModels(part));
    } catch { /* offline or signed out: tiles keep their card */ }
    for (const id of part) batch.get(id)(models[id] ?? null);
  }
}

/** The saved picture, or draw it now (one at a time) and save it. */
function pictureFor(m) {
  const key = `${m.form}/${m.id}`;
  if (!pictures.has(key)) {
    pictures.set(key, m.has ? Promise.resolve(m.picture) : (queue = queue.then(() => draw(m)).catch(() => null)));
  }
  return pictures.get(key);
}

async function draw(m) {
  painter ??= makePainter();
  const p = await painter;
  if (!p) return null;
  const blob = await p.paint(m.model);
  if (!blob) return null;
  api.savePopoutPicture(m.form, m.id, blob).catch(() => {}); // next time it comes from the server
  return URL.createObjectURL(blob);
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** The offscreen renderer: soft studio light, a rim light, the model turned a little towards you. */
async function makePainter() {
  if (!webglAvailable()) return null;
  const THREE = await import('three');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const { createModelLoader, loadModel } = await import('./battle/modelLoader.js');
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2, 4, 5);
  const rim = new THREE.DirectionalLight(0xdcc8ff, 2.2);
  rim.position.set(-3, 3, -4);
  scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x8a7fb0, 0.6));
  // Framed so a model about as tall as the tile stands with its feet near the card's lower edge.
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
  camera.position.set(0, 0.62, 3.6);
  camera.lookAt(0, 0.6, 0);
  const { loader } = createModelLoader();

  return {
    async paint(url) {
      const model = await loadModel(loader, url, 1.25, { shadows: false });
      if (!model) return null;
      model.object.rotation.y = -0.38; // a three-quarter view, as in the reference art
      // Tall Pokémon stand about as high as the card; long ones (Linoone, Onix…) may use the width.
      const size = new THREE.Box3().setFromObject(model.object).getSize(new THREE.Vector3());
      model.object.scale.multiplyScalar(Math.min(1.3 / Math.max(size.y, 1e-3), 1.65 / Math.max(size.x, size.z * 0.6, 1e-3)));
      model.object.position.y = -0.06;
      scene.add(model.object);
      renderer.render(scene, camera);
      scene.remove(model.object);
      model.object.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const mat of [].concat(o.material)) { mat.map?.dispose(); mat.dispose(); }
      });
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    },
  };
}
