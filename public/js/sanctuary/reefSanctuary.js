// The Sanctuary's underwater area, the Reef (#/sanctuary/reef): dive from the meadow's lake and swim
// among your Water-type Pokémon, in kelp forests with light shafts, caustics, a sunken ship, a stone
// whale tail, a purple grotto, manta rays and fish (reef/reef.js, after Abyssal Garden, MIT).
//
// Movement is three-dimensional swimming (player.js stepSwimmer). The radial wheel, the trainer
// chooser, gamepad and touch work as on land. Swim up to the surface (or press Surface) to go back.

import { clear, h } from '../ui.js';
import { joystick, readGamepad } from '../battle/controls.js';
import { clearLoad, createPerf, markLoad } from '../battle/perf.js';
import { createAmbience } from '../ambience.js';
import { addLook, createLook, ease, stepLook } from './look.js';
import { createSwimmer, stepSwimmer } from './player.js';
import { initSanctuaryUI, savedTrainer } from './sanctuaryUI.js';
import { buildTrainer } from './trainer.js';
import { createCreature, habitatFor, nearest, reefResidents, stepDrifter } from './zoo.js';

const BATTLE_KEEP = 'pokedex.battleKeep';
const SPAWN_KEY = 'pokedex.sanctuarySpawn';
let leave = null;

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const picture = (card) => card.official_url || card.photo_url || '';
const toBattle = (card) => {
  try { sessionStorage.setItem(BATTLE_KEEP, String(card.id)); } catch { /* storage unavailable */ }
  location.hash = '#/battles';
};
const toMeadow = () => {
  try { sessionStorage.setItem(SPAWN_KEY, 'lake'); } catch { /* storage unavailable */ }
  location.hash = '#/sanctuary';
};

export async function renderReef(root) {
  leave?.();
  clear(root, h('p.muted', 'Diving…'));
  let cards = [];
  try {
    cards = (await getJson('/api/battles/fighters')).cards;
  } catch (err) {
    clear(root, h('div.empty', h('h2', 'The Reef couldn’t open'), h('p.muted', err.message)));
    return;
  }
  const residents = reefResidents(cards);
  let mods;
  try {
    const gl = document.createElement('canvas');
    if (!(gl.getContext('webgl2') || gl.getContext('webgl'))) throw new Error('no WebGL');
    mods = await Promise.all([import('three'), import('../reef/reef.js'), import('../battle/modelLoader.js'), import('../battle/world.js')]);
  } catch {
    clear(root, h('div.page-head', h('h1', 'The Reef'), h('p.muted', 'This device can’t draw the underwater world. Your Water-type Pokémon:')),
      h('div.sanc-flat-grid', residents.map((c) => h('div.sanc-flat-item', h('img', { src: picture(c), alt: '' }), h('strong', c.name), h('button.btn.small', { type: 'button', onclick: () => toBattle(c) }, 'Battle')))));
    return;
  }
  try {
    start(root, residents, mods);
  } catch (err) {
    console.error('Reef 3D failed:', err);
    leave?.();
    document.body.classList.remove('sanctuary-mode');
    clear(root, h('div.empty', h('h2', 'The Reef couldn’t open'), h('p.muted', err.message), h('a.btn', { href: '#/sanctuary' }, 'Back to the meadow')));
  }
}

function start(root, residents, [THREE, { buildReef, blockedBy, REEF }, { createModelLoader, loadModel, pickClips }, { preferredQuality, saveQuality }]) {
  const el = h('div.sanc.reef');
  const plates = h('div.sanc-plates');
  const prompt = h('button.sanc-prompt', { type: 'button', hidden: true });
  const touch = matchMedia('(pointer: coarse)').matches;
  const quality = h('select', { 'aria-label': 'Graphics quality' }, ['high', 'standard', 'basic'].map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
  const sound = h('button.btn.small', { type: 'button' });
  el.append(plates, prompt,
    h('h1.sanc-title', `The Reef · ${residents.length} Water Pokémon`),
    h('div.sanc-top',
      h('label.btn.small', h('span', 'Graphics '), quality),
      sound,
      h('button.btn.small', { type: 'button', onclick: () => ui.openTrainerModal() }, '👤 Trainer'),
      h('button.btn.small', { type: 'button', onclick: toMeadow }, '⬆ Surface'),
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/'; } }, '✕ Leave')),
    h('p.sanc-help', touch ? 'Drag the stick to swim · Up / Down buttons · tap a Pokémon’s name to meet it'
      : 'WASD swim · Space or E up, Ctrl or Q down · Shift fast · drag to look (double-click: mouse look) · F meet · M sound'));
  if (!residents.length) el.append(h('p.sanc-note', 'Water-type Pokémon live here. Add one to your collection and it will swim in the Reef.'));
  clear(root, el);
  document.body.classList.add('sanctuary-mode');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
  const reef = buildReef({ scene, renderer, mode: 'sanctuary' });
  let level = markLoad(preferredQuality(renderer));
  const pixelTop = () => (level === 'basic' ? 0.75 : Math.min(window.devicePixelRatio || 1, level === 'high' ? 2 : 1.5));
  const setLevel = (q) => { level = q; renderer.setPixelRatio(pixelTop()); reef.setQuality(q); };
  setLevel(level);
  quality.value = level;
  quality.addEventListener('change', () => { setLevel(quality.value); saveQuality(level); resize(); });
  const perf = createPerf(renderer, pixelTop);
  const loadTimer = setTimeout(clearLoad, 12000);
  const resize = () => {
    const w = Math.max(1, el.clientWidth);
    const hgt = Math.max(1, el.clientHeight);
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(el);
  resize();

  // Sound: the Reef's ambience (after Abyssal Garden), started by the first click or key.
  const ambience = createAmbience('reef');
  const showSound = () => { sound.textContent = ambience.muted ? '🔇 Sound' : '🔊 Sound'; };
  sound.addEventListener('click', () => { ambience.toggleMute(); showSound(); });
  showSound();

  const world = { heightAt: reef.heightAt, top: REEF.top, radius: REEF.radius - 2, obstacles: reef.layout.obstacles };
  const { avatar, legs, arms, dress } = buildTrainer(THREE);
  scene.add(avatar);
  dress(savedTrainer());

  // The residents, at the reef's open-water spots; cards until their 3D models load.
  const models = createModelLoader();
  const textures = new THREE.TextureLoader();
  const cardGeo = new THREE.PlaneGeometry(0.72, 1.0);
  cardGeo.translate(0, 0.5, 0);
  let seed = 4242;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const creatures = residents.map((card, i) => {
    const spot = reef.layout.spots[i % reef.layout.spots.length];
    const c = createCreature({ card, habitat: habitatFor(card), x: spot.x, z: spot.z, home: { x: spot.x, z: spot.z } }, i);
    c.y = spot.y;
    c.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide });
    if (picture(card)) textures.load(picture(card), (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; }, undefined, () => {});
    c.stand = new THREE.Mesh(cardGeo, mat);
    c.group.add(c.stand);
    scene.add(c.group);
    c.plate = h('div.sanc-plate', card.name);
    c.plate.style.opacity = '0';
    plates.append(c.plate);
    return c;
  });
  let alive = true;
  let loading = 0;
  const wantModel = async (c) => {
    c.asked = true;
    loading++;
    try {
      const entry = await getJson(`/api/battles/cards/${c.card.id}`);
      const url = entry.models?.forms?.find((f) => f.form === entry.models.default)?.url;
      const model = alive ? await loadModel(models.loader, url, 1.0) : null;
      if (model && alive) {
        c.group.remove(c.stand);
        c.group.add(model.object);
        c.model = model;
        const clips = pickClips(model.clips);
        if (clips.idle || clips.walk) {
          c.mixer = new THREE.AnimationMixer(model.object.children[0]);
          c.action = c.mixer.clipAction(clips.walk ?? clips.idle);
          c.action.play();
        }
      }
    } catch { /* it stays a card */ } finally {
      loading--;
    }
  };

  // The wheel, the trainer chooser, the card.
  const cardModal = h('div.sanctuary-modal', { hidden: true, role: 'dialog', 'aria-label': 'Card' });
  el.append(cardModal);
  const showCard = (c) => {
    clear(cardModal, h('div.modal-card.sanc-card', h('h3', c.card.name), h('p.muted', 'Lives in the Reef'),
      picture(c.card) ? h('img', { src: picture(c.card), alt: `${c.card.name} card` }) : '',
      h('div.btn-row', h('button.btn.primary', { type: 'button', onclick: () => toBattle(c.card) }, '⚔ Battle'), h('button.btn', { type: 'button', onclick: () => { cardModal.hidden = true; } }, 'Close'))));
    cardModal.hidden = false;
  };
  const hearts = (c) => {
    const p = new THREE.Vector3(c.x, c.y + 1.2, c.z).project(camera);
    for (let i = 0; i < 5; i++) {
      const heart = h('span.sanc-heart', '♥');
      heart.style.left = `${(p.x * 0.5 + 0.5) * el.clientWidth + (i - 2) * 16}px`;
      heart.style.top = `${(-p.y * 0.5 + 0.5) * el.clientHeight}px`;
      heart.style.color = ['#7dd3fc', '#a5f3fc', '#fda4af'][i % 3];
      heart.style.animationDelay = `${i * 0.08}s`;
      el.append(heart);
      setTimeout(() => heart.remove(), 1400);
    }
    c.petted = 0.8;
  };
  const ui = initSanctuaryUI(el, {
    onSelectTrainer: dress,
    onRadialAction: (action, c) => {
      if (action === 'follow') { c.state = c.state === 'follow' ? 'idle' : 'follow'; c.timer = 1; c.plate.classList.toggle('following', c.state === 'follow'); }
      else if (action === 'pet') hearts(c);
      else if (action === 'inspect') showCard(c);
      else if (action === 'battle') toBattle(c.card);
    },
  });
  const paused = () => ui.isOpen() || !cardModal.hidden;

  // Input: keyboard, mouse (drag or pointer lock), touch, gamepad.
  const keys = new Set();
  const look = createLook({ pitch: 0.18, min: -1.1, max: 1.2 });
  let distance = 6;
  let near = null;
  const interact = () => { if (near && !paused()) ui.openRadial(near); };
  const onKey = (e) => {
    if (e.target?.closest?.('input, select, textarea')) return;
    if (e.type === 'keydown') {
      if (e.code === 'Escape') { ui.closeRadial(); cardModal.hidden = true; return; }
      if (paused()) return;
      if (e.code === 'KeyF' && !e.repeat) interact();
      if (e.code === 'KeyM' && !e.repeat) { ambience.toggleMute(); showSound(); }
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      keys.add(e.code);
    } else keys.delete(e.code);
  };
  const locked = () => document.pointerLockElement === renderer.domElement;
  let drag = null;
  const onDown = (e) => { if (!locked()) { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); } };
  const onMove = (e) => {
    if (locked()) { addLook(look, -e.movementX * 0.0025, e.movementY * 0.002); return; }
    if (!drag || e.pointerId !== drag.id) return;
    addLook(look, -(e.clientX - drag.x) * 0.005, (e.clientY - drag.y) * 0.004);
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const onUp = (e) => { if (drag?.id === e.pointerId) drag = null; };
  const onWheel = (e) => { distance = Math.min(12, Math.max(3, distance + e.deltaY * 0.01)); e.preventDefault(); };
  const onBlur = () => keys.clear();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointercancel', onUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  renderer.domElement.addEventListener('dblclick', () => { if (!touch) renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); });
  prompt.addEventListener('click', interact);
  const stick = { x: 0, y: 0, up: 0 };
  if (touch) {
    const hold = (label, v) => h('button.btn', { type: 'button', onpointerdown: (e) => { e.preventDefault(); stick.up = v; }, onpointerup: () => { stick.up = 0; }, onpointercancel: () => { stick.up = 0; } }, label);
    el.append(joystick((x, y) => { stick.x = x; stick.y = y; }), h('div.sanc-touch', hold('Up', 1), hold('Down', -1)));
  }
  const pad = { memory: {}, x: 0, y: 0, up: 0, fast: false };
  const wheelOrder = { 12: 'follow', 15: 'pet', 13: 'inspect', 14: 'battle' };
  const readPad = (dt) => {
    const g = readGamepad(0, pad.memory);
    if (!g) { Object.assign(pad, { x: 0, y: 0, up: 0, fast: false }); return; }
    addLook(look, -g.rx * dt * 2.6, g.ry * dt * 1.6);
    if (paused()) {
      for (const [btn, action] of Object.entries(wheelOrder)) if (g.pressed.has(Number(btn))) el.querySelector(`.radial-btn[data-action="${action}"]`)?.click();
      if (g.pressed.has(1)) { ui.closeRadial(); cardModal.hidden = true; }
      Object.assign(pad, { x: 0, y: 0, up: 0, fast: false });
      return;
    }
    if (g.pressed.has(2)) interact();
    if (g.pressed.has(9)) ui.openTrainerModal();
    pad.x = g.lx;
    pad.y = -g.ly;
    pad.up = (g.held.has(0) ? 1 : 0) - (g.held.has(1) ? 1 : 0);
    pad.fast = g.held.has(7);
  };

  // The loop.
  const swimmer = createSwimmer({ x: 0, y: REEF.top - 2.5, z: 8 });
  let last = performance.now();
  let acc = 0;
  let surfaced = 0;
  const STEP = 1 / 60;
  const v = new THREE.Vector3();
  const blocked = (x, y, z) => blockedBy(reef.layout.obstacles, x, y, z, 0.6);
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    perf.frame(dt * 1000);
    readPad(dt);
    stepLook(look, dt);
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      const is = (...codes) => codes.some((c) => keys.has(c));
      const f = paused() ? 0 : (is('KeyW', 'ArrowUp') ? 1 : 0) - (is('KeyS', 'ArrowDown') ? 1 : 0) + stick.y + pad.y;
      const r = paused() ? 0 : (is('KeyD', 'ArrowRight') ? 1 : 0) - (is('KeyA', 'ArrowLeft') ? 1 : 0) + stick.x + pad.x;
      const up = paused() ? 0 : (is('Space', 'KeyE') ? 1 : 0) - (is('ControlLeft', 'ControlRight', 'KeyQ') ? 1 : 0) + stick.up + pad.up;
      const fx = -Math.sin(look.yaw);
      const fz = -Math.cos(look.yaw);
      stepSwimmer(swimmer, { x: fx * f - fz * r, z: fz * f + fx * r, up, fast: !paused() && (is('ShiftLeft', 'ShiftRight') || pad.fast) }, STEP, world);
      for (const c of creatures) stepDrifter(c, STEP, swimmer, rand, { heightAt: reef.heightAt, top: REEF.top, blocked });
    }
    // Holding up at the surface for a moment takes you back to the meadow's lake.
    surfaced = swimmer.atSurface && swimmer.vy >= 0 && (keys.has('Space') || keys.has('KeyE') || stick.up > 0 || pad.up > 0) ? surfaced + dt : 0;
    if (surfaced > 0.6) { toMeadow(); return; }

    avatar.position.set(swimmer.x, swimmer.y - 1, swimmer.z);
    avatar.rotation.set(1.1, swimmer.facing, 0, 'YXZ'); // lying forward, swimming
    const kick = Math.sin(t * (4 + swimmer.moving * 1.5)) * Math.min(1, 0.3 + swimmer.moving / 4);
    legs[0].rotation.x = kick * 0.6;
    legs[1].rotation.x = -kick * 0.6;
    arms[0].rotation.x = -2.6 + Math.sin(t * 2.2) * 0.5;
    arms[1].rotation.x = -2.6 - Math.sin(t * 2.2) * 0.5;
    reef.sun.position.set(swimmer.x + 8, 30, swimmer.z - 6);
    reef.sun.target.position.set(swimmer.x, 0, swimmer.z);

    const cp = Math.cos(look.pitch);
    v.set(swimmer.x + Math.sin(look.yaw) * cp * distance, swimmer.y + 0.6 + Math.sin(look.pitch) * distance, swimmer.z + Math.cos(look.yaw) * cp * distance);
    v.y = Math.min(REEF.top - 0.3, Math.max(v.y, reef.heightAt(v.x, v.z) + 0.6));
    camera.position.lerp(v, ease(dt, 12));
    camera.lookAt(swimmer.x, swimmer.y + 0.4, swimmer.z);

    const W = el.clientWidth;
    const H = el.clientHeight;
    for (const c of creatures) {
      const d = Math.hypot(c.x - swimmer.x, c.y - swimmer.y, c.z - swimmer.z);
      if (c.petted > 0) c.petted = Math.max(0, c.petted - dt);
      c.group.position.set(c.x, c.y + Math.sin(c.hop) * 0.12 + (c.petted ? Math.sin(c.petted * 12) * 0.25 : 0), c.z);
      c.group.rotation.y = c.model ? c.facing : Math.atan2(camera.position.x - c.x, camera.position.z - c.z);
      if (c.petted && c.model) c.group.rotation.y += c.petted * 8; // a happy spin
      if (!c.asked && d < 30 && loading < 2) wantModel(c);
      if (c.mixer && d < 30) c.mixer.update(dt);
      let alpha = 0;
      if (d < 14) {
        v.set(c.x, c.y + 1.3, c.z).project(camera);
        if (v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
          alpha = Math.min(1, (14 - d) / 5);
          c.plate.style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * W - c.plate.offsetWidth / 2)}px, ${Math.round((-v.y * 0.5 + 0.5) * H - 24)}px)`;
        }
      }
      c.plate.style.opacity = String(alpha);
    }
    near = nearest(creatures, swimmer, 3.4);
    if (near && Math.abs(near.y - swimmer.y) > 3) near = null;
    prompt.hidden = !near || paused();
    if (near) prompt.textContent = `${touch ? 'Tap' : 'F'} · ${near.card.name}`;
    ui.updateStamina(swimmer.stamina, swimmer.exhausted);
    ambience.update({ speed: swimmer.moving, depth: 1 - swimmer.y / REEF.top });
    reef.update(t, camera, swimmer);
    renderer.render(scene, camera);
  });

  leave = () => {
    if (!alive) return;
    alive = false;
    leave = null;
    renderer.setAnimationLoop(null);
    clearTimeout(loadTimer);
    clearLoad();
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    observer.disconnect();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('hashchange', leave);
    document.body.classList.remove('sanctuary-mode');
    ambience.dispose();
    reef.dispose();
    models.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); for (const m of [].concat(o.material ?? [])) { m.map?.dispose?.(); m.dispose?.(); } });
    renderer.dispose();
  };
  window.addEventListener('hashchange', leave);
  el.reef = { swimmer, creatures, look };
}
