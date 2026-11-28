// The Sanctuary's underwater area, the Reef (#/sanctuary/reef): dive from the meadow's lake and swim
// among your Water-type Pokémon, in kelp forests with light shafts, caustics, a sunken ship, a stone
// whale tail, a purple grotto, manta rays and fish (reef/reef.js, after Abyssal Garden, MIT).
//
// Movement is three-dimensional swimming (player.js stepSwimmer). The radial wheel, the trainer
// chooser, gamepad and touch work as on land. Swim up to the surface (or press Surface) to go back.

import { clear, h } from '../ui.js';
import { joystick, readGamepad } from '../battle/controls.js';
import { clearLoad, createPerf, markLoad } from '../battle/perf.js';
import { createFrameMeter, createGpuTimer } from '../battle/frameMeter.js';
import { actionFor, held, keyLabel, loadSettings, mouseTurn } from '../game/settings.js';
import { createSettingsMenu } from '../game/settingsMenu.js';
import { createEffects } from '../battle/postfx.js';
import { createAmbience } from '../ambience.js';
import { addLook, approach, createLook, ease, stepLook } from './look.js';
import { createSwimmer, stepSwimmer } from './player.js';
import { initSanctuaryUI, savedTrainer, savedTrainerModel } from './sanctuaryUI.js';
import { buildTrainer } from './trainer.js';
import { createCreature, habitatFor, nearest, reefResidents, stepDrifter } from './zoo.js';
import { bodyPlan, sizedSpecies } from '../creature/body.js';
import { bringToLife } from '../creature/life.js';

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

function start(root, residents, [THREE, { buildReef, blockedBy, REEF }, { createModelLoader, loadModel, pickClips, warmUp }, { preferredQuality, saveQuality }]) {
  const el = h('div.sanc.reef');
  const plates = h('div.sanc-plates');
  const prompt = h('button.sanc-prompt', { type: 'button', hidden: true });
  const touch = matchMedia('(pointer: coarse)').matches;
  const quality = h('select', { 'aria-label': 'Graphics quality' }, ['high', 'standard', 'basic'].map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
  const sound = h('button.btn.small', { type: 'button' });
  const topBar = h('div.sanc-top');
  const help = h('p.sanc-help');
  el.append(plates, prompt,
    h('h1.sanc-title', `The Reef · ${residents.length} Water Pokémon`),
    clear(topBar,
      h('label.btn.small', h('span', 'Graphics '), quality),
      sound,
      h('button.btn.small', { type: 'button', onclick: () => ui.openTrainerModal() }, '👤 Trainer'),
      h('button.btn.small', { type: 'button', onclick: toMeadow }, '⬆ Surface'),
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/'; } }, '✕ Leave')),
    help);
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
  const effects = createEffects(renderer, { threshold: 0.9, bloom: 0.45, fade: [10, 26] }); // High: occlusion and bloom (short sight underwater)
  const pixelTop = () => (level === 'basic' ? 0.75 : Math.min(window.devicePixelRatio || 1, level === 'high' ? 2 : 1.5));
  const setLevel = (q) => { level = q; renderer.setPixelRatio(pixelTop()); reef.setQuality(q); effects.setLevel(q); };
  setLevel(level);
  quality.value = level;
  quality.addEventListener('change', () => { setLevel(quality.value); saveQuality(level); perf.settle(); resize(); });
  // The ⚙ settings (game/settings.js), shared with the meadow.
  let settings = loadSettings();
  const perf = createPerf(renderer, pixelTop, effects, { dynamic: () => settings.video.renderScale === 'auto' });
  const meter = createFrameMeter(el); // F3: frame times
  const gpuTimer = createGpuTimer(renderer);
  const applySettings = (s) => {
    settings = s;
    meter.apply(s.overlay);
    if (s.video.renderScale !== 'auto') renderer.setPixelRatio(pixelTop() * s.video.renderScale);
    const k = (a) => keyLabel(s.bindings[a]?.[0]);
    help.textContent = touch ? 'Drag the stick to swim · Up / Down buttons · tap a Pokémon’s name to meet it'
      : `${k('forward')}${k('left')}${k('back')}${k('right')} swim · ${k('jump')} up, ${k('dive')} down · ${k('sprint')} fast · ${s.mouse.look === 'lock' ? 'mouse to look (Esc frees it)' : 'drag to look'} · ${k('meet')} meet · ${k('mute')} sound · ${k('settings')} ⚙`;
  };
  const menu = createSettingsMenu(el, { onChange: (s) => applySettings(s), quality: { get: () => level, set: (q) => { quality.value = q; setLevel(q); saveQuality(level); perf.settle(); resize(); applySettings(settings); } } });
  topBar.prepend(menu.button);
  applySettings(settings);
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
  const trainer = buildTrainer(THREE);
  const { avatar, legs, arms, dress } = trainer;
  scene.add(avatar);
  dress(savedTrainer());

  // The residents, at the reef's open-water spots; cards until their 3D models load.
  const models = createModelLoader();
  const wearModel = (id) => trainer.load(id ? `/api/trainers/${id}.glb` : null, { loader: models.loader, loadModel, pickClips, realistic: level !== 'basic', prepare: (o) => warmUp(renderer, o, camera, scene) }).catch(() => null);
  wearModel(savedTrainerModel());
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
      const form = entry.models?.forms?.find((f) => f.form === entry.models.default);
      const species = sizedSpecies(form?.species ?? entry.species);
      if (species) c.plan = bodyPlan(species, { fallbackHeight: 1 }); // its size, compressed to fit
      const model = alive ? await loadModel(models.loader, form?.url, c.plan.heightM, { realistic: level !== 'basic', types: ['Water'], measure: c.plan.measure }) : null;
      if (model && alive) {
        // Underwater, everyone swims; eyes still blink (a fire Pokémon's flames don't live down here).
        // Made ready to draw before it appears, so its arrival doesn't stall the frames.
        const clips = pickClips(model.clips);
        await new Promise((r) => setTimeout(r, 0));
        const anim = bringToLife(model, { ...c.plan, mode: 'swim' }, { dexId: species?.dexId ?? null, quality: level, animate: !clips.walk });
        await warmUp(renderer, model.object, camera, scene);
        if (!alive) return;
        c.group.remove(c.stand);
        c.group.add(model.object);
        c.model = model;
        if (clips.walk) {
          c.mixer = new THREE.AnimationMixer(model.object.children[0]);
          c.action = c.mixer.clipAction(clips.walk);
          c.action.play();
        }
        c.anim = anim;
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
    const p = new THREE.Vector3(c.x, c.y + (c.model?.height ?? 1) + 0.2, c.z).project(camera);
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
    onSelectTrainer: (preset, model) => { dress(preset); wearModel(model?.id ?? null); },
    onRadialAction: (action, c) => {
      if (action === 'follow') { c.state = c.state === 'follow' ? 'idle' : 'follow'; c.timer = 1; c.plate.classList.toggle('following', c.state === 'follow'); }
      else if (action === 'pet') hearts(c);
      else if (action === 'inspect') showCard(c);
      else if (action === 'battle') toBattle(c.card);
    },
  });
  const paused = () => ui.isOpen() || !cardModal.hidden || menu.isOpen();

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
      const action = actionFor(e.code, settings.bindings);
      if (action === 'settings' && !e.repeat) { e.preventDefault(); menu.open(); return; }
      if (settings.mouse.look === 'lock' && !locked() && !touch) lockPointer();
      if (action === 'meet' && !e.repeat) interact();
      if (action === 'mute' && !e.repeat) { ambience.toggleMute(); showSound(); }
      if (action && ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'dive', 'interact'].includes(action)) e.preventDefault();
      keys.add(e.code);
    } else keys.delete(e.code);
  };
  const locked = () => document.pointerLockElement === renderer.domElement;
  const lockPointer = () => { try { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not now */ } };
  let drag = null;
  const onDown = (e) => {
    if (locked()) return;
    if (settings.mouse.look === 'lock' && e.pointerType === 'mouse' && !paused()) { lockPointer(); return; }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    renderer.domElement.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (locked()) { const turn = mouseTurn(e.movementX, e.movementY, settings.mouse); addLook(look, turn.yaw, turn.pitch); return; }
    if (!drag || e.pointerId !== drag.id) return;
    const turn = mouseTurn(e.clientX - drag.x, e.clientY - drag.y, settings.mouse, 2);
    addLook(look, turn.yaw, turn.pitch);
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
  renderer.domElement.addEventListener('dblclick', () => { if (!touch) lockPointer(); });
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
  // Drawn between the last two 60 Hz steps (like the meadow): smooth at any refresh rate.
  const prevS = { x: swimmer.x, y: swimmer.y, z: swimmer.z, facing: swimmer.facing };
  const S = { x: swimmer.x, y: swimmer.y, z: swimmer.z, facing: swimmer.facing };
  const turnMix = (a, b, k) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * k;
  let lift = 0; // the camera's eased push up off the reef floor (or down from the surface)
  let shownPrompt = null;
  let cpuMs = null;
  renderer.setAnimationLoop((now) => {
    if (settings.video.frameLimit && now - last < 1000 / settings.video.frameLimit - 1) return;
    const cpuStart = performance.now();
    meter.frame(now - last, { cpu: cpuMs, gpu: gpuTimer });
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (paused() && locked()) document.exitPointerLock?.();
    const t = now / 1000;
    perf.frame(dt * 1000);
    readPad(dt);
    stepLook(look, dt);
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      prevS.x = swimmer.x; prevS.y = swimmer.y; prevS.z = swimmer.z; prevS.facing = swimmer.facing;
      for (const c of creatures) { c.px = c.x; c.py = c.y; c.pz = c.z; c.pf = c.facing; c.ph = c.hop; }
      const is = (action) => held(action, keys, settings.bindings);
      const f = paused() ? 0 : (is('forward') ? 1 : 0) - (is('back') ? 1 : 0) + stick.y + pad.y;
      const r = paused() ? 0 : (is('right') ? 1 : 0) - (is('left') ? 1 : 0) + stick.x + pad.x;
      const up = paused() ? 0 : (is('jump') || is('interact') ? 1 : 0) - (is('dive') || keys.has('KeyQ') ? 1 : 0) + stick.up + pad.up;
      const fx = -Math.sin(look.yaw);
      const fz = -Math.cos(look.yaw);
      stepSwimmer(swimmer, { x: fx * f - fz * r, z: fz * f + fx * r, up, fast: !paused() && (is('sprint') || pad.fast) }, STEP, world);
      for (const c of creatures) stepDrifter(c, STEP, swimmer, rand, { heightAt: reef.heightAt, top: REEF.top, blocked });
    }
    // Holding up at the surface for a moment takes you back to the meadow's lake.
    surfaced = swimmer.atSurface && swimmer.vy >= 0 && (held('jump', keys, settings.bindings) || held('interact', keys, settings.bindings) || stick.up > 0 || pad.up > 0) ? surfaced + dt : 0;
    if (surfaced > 0.6) { toMeadow(); return; }

    const alpha = acc / STEP;
    S.x = prevS.x + (swimmer.x - prevS.x) * alpha;
    S.y = prevS.y + (swimmer.y - prevS.y) * alpha;
    S.z = prevS.z + (swimmer.z - prevS.z) * alpha;
    S.facing = turnMix(prevS.facing, swimmer.facing, alpha);
    avatar.position.set(S.x, S.y - 1, S.z);
    avatar.rotation.set(1.1, S.facing, 0, 'YXZ'); // lying forward, swimming
    const kick = Math.sin(t * (4 + swimmer.moving * 1.5)) * Math.min(1, 0.3 + swimmer.moving / 4);
    legs[0].rotation.x = kick * 0.6;
    legs[1].rotation.x = -kick * 0.6;
    arms[0].rotation.x = -2.6 + Math.sin(t * 2.2) * 0.5;
    arms[1].rotation.x = -2.6 - Math.sin(t * 2.2) * 0.5;
    trainer.play('swim', swimmer.moving, dt, t); // the owner's model, if one is chosen
    reef.sun.position.set(S.x + 8, 30, S.z - 6);
    reef.sun.target.position.set(S.x, 0, S.z);

    const cp = Math.cos(look.pitch);
    v.set(S.x + Math.sin(look.yaw) * cp * distance, S.y + 0.6 + Math.sin(look.pitch) * distance, S.z + Math.cos(look.yaw) * cp * distance);
    // Kept between the floor and the surface by an eased push (no hop over each coral head).
    const push = Math.max(0, reef.heightAt(v.x, v.z) + 0.6 - v.y) + Math.min(0, REEF.top - 0.3 - v.y);
    lift = approach(lift, push, dt, push < 0 ? 20 : 3, push > 0 ? 20 : 3);
    v.y += lift;
    camera.position.lerp(v, ease(dt, 12));
    camera.lookAt(S.x, S.y + 0.4, S.z);

    const W = el.clientWidth;
    const H = el.clientHeight;
    for (const c of creatures) {
      const rx = (c.px ?? c.x) + (c.x - (c.px ?? c.x)) * alpha;
      const ry = (c.py ?? c.y) + (c.y - (c.py ?? c.y)) * alpha;
      const rz = (c.pz ?? c.z) + (c.z - (c.pz ?? c.z)) * alpha;
      const hop = Math.abs(c.hop - (c.ph ?? c.hop)) < 1 ? (c.ph ?? c.hop) + (c.hop - (c.ph ?? c.hop)) * alpha : c.hop; // (it wraps at π)
      const d = Math.max(0, Math.hypot(rx - S.x, ry - S.y, rz - S.z) - c.plan.radius);
      if (c.petted > 0) c.petted = Math.max(0, c.petted - dt);
      c.group.position.set(rx, ry + Math.sin(hop) * 0.12 + (c.petted ? Math.sin(c.petted * 12) * 0.25 : 0), rz);
      c.group.rotation.y = c.model ? turnMix(c.pf ?? c.facing, c.facing, alpha) : Math.atan2(camera.position.x - rx, camera.position.z - rz);
      if (c.petted && c.model) c.group.rotation.y += c.petted * 8; // a happy spin
      if (!c.asked && d < 30 && loading < 2) wantModel(c);
      if (c.mixer && d < 30) c.mixer.update(dt);
      if (c.anim && d < 40) c.anim.update(dt, { speed: c.speed });
      let shown = 0;
      if (d < 14) {
        v.set(rx, ry + (c.model?.height ?? 1) + 0.3, rz).project(camera);
        if (v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
          shown = Math.min(1, (14 - d) / 5);
          const at = `translate(${Math.round((v.x * 0.5 + 0.5) * W - (c.plateW ??= c.plate.offsetWidth) / 2)}px, ${Math.round((-v.y * 0.5 + 0.5) * H - 24)}px)`;
          if (at !== c.plateAt) { c.plate.style.transform = at; c.plateAt = at; }
        }
      }
      shown = Math.round(shown * 50) / 50;
      if (shown !== c.plateAlpha) { c.plate.style.opacity = String(shown); c.plateAlpha = shown; }
    }
    near = nearest(creatures, swimmer, 3.4);
    if (near && Math.abs(near.y - swimmer.y) > 3) near = null;
    const hidePrompt = !near || paused();
    if (prompt.hidden !== hidePrompt) prompt.hidden = hidePrompt;
    const say = near ? `${touch ? 'Tap' : 'F'} · ${near.card.name}` : null;
    if (say && say !== shownPrompt) { prompt.textContent = say; shownPrompt = say; }
    ui.updateStamina(swimmer.stamina, swimmer.exhausted);
    ambience.update({ speed: swimmer.moving, depth: 1 - swimmer.y / REEF.top });
    reef.update(t, camera, swimmer);
    if (meter.timingGpu) gpuTimer.begin();
    effects.render(scene, camera);
    if (meter.timingGpu) gpuTimer.end();
    cpuMs = performance.now() - cpuStart;
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
    effects.dispose();
    reef.dispose();
    models.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); for (const m of [].concat(o.material ?? [])) { m.map?.dispose?.(); m.dispose?.(); } });
    meter.dispose();
    gpuTimer.dispose();
    menu.dispose();
    renderer.dispose();
  };
  window.addEventListener('hashchange', leave);
  el.reef = { swimmer, creatures, look };
}
