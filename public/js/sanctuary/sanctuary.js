// The Sanctuary: walk your trainer through the meadow among the Pokémon of your own collection.
// Each different Pokémon lives in the habitat of its card's type, wanders about, and can be told
// to follow you, be petted, show its card or go to a battle (the radial wheel, on E or a tap).
//
// The world is the PokéBattles meadow (battle/world.js: the same sky, light, fog, grass and lake),
// the movement is sanctuary/player.js, the zoo's behaviour sanctuary/zoo.js. Without 3D graphics
// (WebGL), the page lists your Pokémon by habitat instead.

import { clear, h } from './../ui.js';
import { joystick, readGamepad } from '../battle/controls.js';
import { addTraversalLedge, buildHabitats, planHabitats, solidAt } from './habitats.js';
import { addLook, approach, createLook, ease, stepLook } from './look.js';
import { buildSkiLift, LIFT_SPEED, seatAt } from './skiLift.js';
import { buildParaglider } from './paraglider.js';
import { clearLoad, createPerf, markLoad } from '../battle/perf.js';
import { createFrameMeter } from '../battle/frameMeter.js';
import { createAmbience } from '../ambience.js';
import { initSanctuaryUI, savedTrainer, savedTrainerModel } from './sanctuaryUI.js';
import { trainerState } from './rig.js';
import { buildTrainer } from './trainer.js';
import { createPlayer, PARA, stepPlayer } from './player.js';
import { createCreature, HABITATS, layoutHabitats, nearest, stepCreature } from './zoo.js';
import { bodyPlan, sizedSpecies } from '../creature/body.js';
import { bringToLife } from '../creature/life.js';

const MAX_MODELS = 24; // full 3D models at once; the rest stand as their cards
const MODEL_RANGE = 30;
const PLATE_RANGE = 14;
const WORLD_RADIUS = 78;
const BATTLE_KEEP = 'pokedex.battleKeep';

let leave = null; // cleans up the running Sanctuary

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const picture = (card) => card.official_url || card.photo_url || '';

/** Hand a Pokémon over to PokéBattles: it is chosen there when the page opens. */
function toBattle(card) {
  try { sessionStorage.setItem(BATTLE_KEEP, String(card.id)); } catch { /* storage unavailable */ }
  location.hash = '#/battles';
}

/** Without WebGL: your Pokémon by habitat, each with its card and a way into a battle. */
function renderFlat(root, spots) {
  clear(root,
    h('div.page-head', h('h1', 'Sanctuary'),
      h('p.muted', 'Your Pokémon, each in the habitat of its type. (This device can’t draw the 3D world, so here they are as a list.)')),
    h('div.sanc-flat', HABITATS.filter((hab) => spots.some((s) => s.habitat === hab)).map((hab) => [
      h('h2', hab.name),
      h('div.sanc-flat-grid', spots.filter((s) => s.habitat === hab).map((s) => h('div.sanc-flat-item',
        h('img', { src: picture(s.card), alt: '', loading: 'lazy' }),
        h('strong', s.card.name),
        h('button.btn.small', { type: 'button', onclick: () => toBattle(s.card) }, 'Battle')))),
    ])));
}

export async function renderSanctuary(root) {
  leave?.();
  clear(root, h('p.muted', 'Opening the Sanctuary…'));
  let cards = [];
  try {
    cards = (await getJson('/api/battles/fighters')).cards;
  } catch (err) {
    clear(root, h('div.empty', h('h2', 'The Sanctuary couldn’t open'), h('p.muted', err.message)));
    return;
  }
  if (!cards.length) {
    clear(root, h('div.empty', h('h2', 'Your Sanctuary is empty'), h('p.muted', 'Add some Pokémon cards to your collection and they will live here.'), h('a.btn.primary', { href: '#/add' }, '+ Add cards')));
    return;
  }
  if (!hasWebGL()) {
    renderFlat(root, layoutHabitats(cards));
    return;
  }
  let world3d;
  try {
    world3d = await Promise.all([import('three'), import('../battle/world.js'), import('../battle/modelLoader.js'), import('../battle/stadiums.js'), import('../battle/surface.js')]);
  } catch (err) {
    console.warn('3D unavailable, listing the Pokémon:', err);
    renderFlat(root, layoutHabitats(cards));
    return;
  }
  try {
    start3d(root, cards, world3d);
  } catch (err) {
    // Anything going wrong while building the 3D world: the list instead, never a broken page.
    console.error('Sanctuary 3D failed, listing the Pokémon:', err);
    leave?.();
    document.body.classList.remove('sanctuary-mode');
    renderFlat(root, layoutHabitats(cards));
  }
}

function start3d(root, cards, world3d) {
  const [THREE, worldKit, { createModelLoader, loadModel, pickClips, warmUp }, stadiumKit, surfaceKit] = world3d;
  const { buildWorld, preferredQuality, saveQuality, terrainHeight, LAKE } = worldKit;

  // ---- the page ----
  const el = h('div.sanc');
  const plates = h('div.sanc-plates');
  const prompt = h('button.sanc-prompt', { type: 'button', hidden: true });
  const touch = matchMedia('(pointer: coarse)').matches;
  const sound = h('button.btn.small', { type: 'button' });
  const quality = h('select', { 'aria-label': 'Graphics quality' }, ['high', 'standard', 'basic'].map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
  el.append(plates, prompt,
    h('h1.sanc-title', `Sanctuary · ${new Set(cards.map((c) => c.name)).size} Pokémon`),
    h('div.sanc-top',
      h('label.btn.small', h('span', 'Graphics '), quality),
      sound,
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/sanctuary/reef'; } }, '🌊 Reef'),
      h('button.btn.small', { type: 'button', onclick: () => ui.openTrainerModal() }, '👤 Trainer'),
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/'; } }, '✕ Leave')),
    h('p.sanc-help', touch ? 'Drag to move or look · hold Jump toward the basalt ledge to climb · tap a Pokémon’s name to interact' : 'WASD walk · Shift sprint · Space jump, hold to climb or glide · drag to look · E interact · 1–8 travel'));
  clear(root, el);
  document.body.classList.add('sanctuary-mode');

  // ---- the world ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'sanc-canvas';
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 4000);
  camera.position.set(0, 3, 10);
  const dark = document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const world = buildWorld({ scene, renderer, camera, dark, mode: 'sanctuary', quality: markLoad(preferredQuality(renderer)) });
  const perf = createPerf(renderer, () => world.pixelTop, world.effects);
  const meter = createFrameMeter(el); // F3: frame times
  const loadTimer = setTimeout(clearLoad, 12000);
  quality.value = world.quality;
  quality.addEventListener('change', () => { world.setQuality(quality.value); saveQuality(world.quality); perf.settle(); resize(); });
  const inWater = (x, z) => terrainHeight(x, z) < LAKE.level - 0.15;
  const ground = {
    heightAt: (x, z) => terrainHeight(x, z),
    waterAt: (x, z) => (inWater(x, z) ? LAKE.level : null),
    radius: WORLD_RADIUS,
  };
  // Each habitat's own scenery (habitats.js); you walk round its trees, rocks and ruins.
  const lake = { x: LAKE.x, z: LAKE.z, level: LAKE.level, shore: worldKit.shoreRadius() };
  const plan = planHabitats({ inWater, lake });
  ground.ledge = addTraversalLedge(plan, terrainHeight);
  const walkingPlan = plan.filter((p) => !p.ledge);
  const sway = { value: 0 };
  const habitats = buildHabitats(scene, plan, {
    THREE, heightAt: terrainHeight, lake, dark, leaves: world.leaves, time: sway, shoreSand: worldKit.SHORE_SAND,
    tree: worldKit.tree, ruins: worldKit.ruins, rockGeometry: worldKit.rockGeometry, noiseTexture: worldKit.noiseTexture,
    palm: stadiumKit.palm, canvasTexture: stadiumKit.canvasTexture, speckle: stadiumKit.speckle, photoWood: (m) => world.photoWood?.(m),
    ...(() => { const m = stadiumKit.palmMaterials({ time: sway, keep: (o) => o }); return { palmTrunk: m.trunkMat, palmFrond: m.frondMat, palmFrondDepth: m.frondDepth }; })(),
    contactShadows: surfaceKit.contactShadows, contactTexture: surfaceKit.contactTexture, addSurfaceDepth: surfaceKit.addSurfaceDepth,
  });
  // The ski lift up the mountain to the east, and the paraglider to fly back down (skiLift.js, paraglider.js).
  const lift = buildSkiLift(THREE, worldKit.LIFT, { heightAt: terrainHeight, planks: worldKit.plankTexture('weathered'), dark });
  scene.add(lift.group);
  const wing = buildParaglider(THREE);
  scene.add(wing.group);
  const liftSolids = lift.solids;
  ground.solid = (x, z) => solidAt(walkingPlan, x, z) || liftSolids.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + 0.3);
  ground.airRadius = 300; // the paraglider (and a flying Pokémon) go anywhere within this
  // A warm updraft over the warm rocks: circle in it to climb.
  const warm = HABITATS.find((hab) => hab.id === 'rocks');
  ground.liftAt = (x, z) => (warm ? 1.9 * Math.max(0, 1 - Math.hypot(x - warm.x, z - warm.z) / 16) : 0);
  const liftStops = { up: seatAt(lift.line, 0, true), down: seatAt(lift.line, lift.line.length, false) };
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

  // ---- the trainer: an original little figure in the chosen colours (trainer.js) ----
  const trainer = buildTrainer(THREE);
  const { avatar, legs, arms, glider, dress } = trainer;
  scene.add(avatar);
  dress(savedTrainer());

  // ---- the zoo ----
  const outside = (x, z) => Math.hypot(x, z) > WORLD_RADIUS - 4;
  const spots = layoutHabitats(cards, {
    blocked: (x, z) => inWater(x, z) || solidAt(plan, x, z, 0.9) || outside(x, z),
    water: (x, z) => inWater(x, z) && !outside(x, z), // swimmers live in the lake
  });
  // Where a creature can't go, by how it moves: swimmers stay in the lake, flyers cross anything.
  const blockedFor = (x, z, mode) => (mode === 'swim' ? !inWater(x, z) : mode === 'fly' ? outside(x, z) : inWater(x, z) || solidAt(plan, x, z, 0.1) || outside(x, z));
  const models = createModelLoader();
  // A trainer model of the owner's own (uploaded in the chooser), animated on its skeleton.
  const wearModel = (id) => trainer.load(id ? `/api/trainers/${id}.glb` : null, { loader: models.loader, loadModel, pickClips, realistic: world.quality !== 'basic', prepare: (o) => warmUp(renderer, o, camera, scene) }).catch(() => null);
  wearModel(savedTrainerModel());
  const textures = new THREE.TextureLoader();
  const cardGeo = new THREE.PlaneGeometry(0.72, 1.0);
  cardGeo.translate(0, 0.62, 0);
  let seed = 12345;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const creatures = spots.map((spot, i) => {
    const c = createCreature(spot, i);
    c.facing = rand() * Math.PI * 2;
    c.group = new THREE.Group();
    // Until (and unless) its 3D model is loaded, a creature stands as its card.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide });
    const src = picture(spot.card);
    if (src) textures.load(src, (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; }, undefined, () => {});
    c.stand = new THREE.Mesh(cardGeo, mat);
    c.stand.castShadow = true;
    c.group.add(c.stand);
    scene.add(c.group);
    c.plate = h('div.sanc-plate', spot.card.name);
    c.plate.style.opacity = '0';
    plates.append(c.plate);
    return c;
  });
  let loading = 0;
  let loaded = 0;
  let queued = false; // a background load is waiting for idle time
  const wantModel = async (c) => {
    c.asked = true;
    loading++;
    try {
      const entry = await getJson(`/api/battles/cards/${c.card.id}`);
      const form = entry.models?.forms?.find((f) => f.form === entry.models.default);
      // Its size and build (the model's own form: a Gigantamax is far bigger than the usual one).
      const species = sizedSpecies(form?.species ?? entry.species);
      if (species && species.heightM !== c.plan.heightM) {
        // (It keeps to the habitat it was given: a swimmer found only now stays where it is, on land.)
        const was = c.plan.mode;
        c.plan = bodyPlan(species, { fallbackHeight: 1 });
        if ((c.plan.mode === 'swim') !== (was === 'swim')) c.plan.mode = was === 'swim' ? 'swim' : 'walk';
      }
      const model = alive ? await loadModel(models.loader, form?.url, c.plan.heightM, { realistic: world.quality !== 'basic', types: entry.battle?.types ?? [], measure: c.plan.measure }) : null;
      if (model && alive) {
        // Brought to life and made ready to draw before it appears, each step in its own task, so a
        // Pokémon arriving never stalls the frames (creature/life.js, modelLoader.js warmUp).
        // Its own animations when it has a walk (idle when standing, walk when moving, a happy one when
        // petted); otherwise it moves in code, the way its body plan says. Either way its eyes blink and
        // its flames burn.
        const clips = pickClips(model.clips);
        await new Promise((r) => setTimeout(r, 0));
        const anim = bringToLife(model, c.plan, { dexId: species?.dexId ?? null, quality: world.quality, animate: !clips.walk });
        await warmUp(renderer, model.object, camera, scene);
        if (!alive) return;
        c.group.remove(c.stand);
        c.group.add(model.object);
        c.model = model;
        if (c.plan.mode === 'swim') c.sink = model.height * 0.65; // a swimmer shows its back and head above the water
        if (clips.walk) {
          c.mixer = new THREE.AnimationMixer(model.object.children[0]);
          c.actions = Object.fromEntries(Object.entries(clips).filter(([, clip]) => clip).map(([k, clip]) => [k, c.mixer.clipAction(clip)]));
          c.playing = null;
        }
        c.anim = anim;
        loaded++;
      }
    } catch { /* it stays a card */ } finally {
      loading--;
    }
  };

  // ---- the overlay: radial wheel, trainer chooser, stamina ring, card ----
  const cardModal = h('div.sanctuary-modal', { hidden: true, role: 'dialog', 'aria-label': 'Card' });
  el.append(cardModal);
  const showCard = (c) => {
    clear(cardModal, h('div.modal-card.sanc-card',
      h('h3', c.card.name),
      h('p.muted', `Lives at the ${c.habitat.name.toLowerCase()}${c.card.set_name ? ` · ${c.card.set_name}` : ''}`),
      picture(c.card) ? h('img', { src: picture(c.card), alt: `${c.card.name} card` }) : '',
      h('div.btn-row',
        h('button.btn.primary', { type: 'button', onclick: () => toBattle(c.card) }, '⚔ Battle'),
        h('button.btn', { type: 'button', onclick: () => { cardModal.hidden = true; } }, 'Close'))));
    cardModal.hidden = false;
  };
  const hearts = (c) => {
    const p = new THREE.Vector3(c.x, c.y + (c.model?.height ?? 1) + 0.3, c.z).project(camera);
    for (let i = 0; i < 5; i++) {
      const heart = h('span.sanc-heart', '♥');
      heart.style.left = `${(p.x * 0.5 + 0.5) * el.clientWidth + (i - 2) * 16}px`;
      heart.style.top = `${(-p.y * 0.5 + 0.5) * el.clientHeight}px`;
      heart.style.color = ['#fb7185', '#f472b6', '#fda4af'][i % 3];
      heart.style.animationDelay = `${i * 0.08}s`;
      el.append(heart);
      setTimeout(() => heart.remove(), 1400);
    }
    c.petted = 0.6; // a happy hop
    if (c.actions?.extra) {
      const a = c.actions.extra;
      a.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.15).play();
      c.playing?.fadeOut(0.15);
      c.playing = a;
      c.extraUntil = performance.now() + Math.min(2500, a.getClip().duration * 1000);
    }
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
  const paused = () => ui.isOpen() || !cardModal.hidden;

  // ---- input ----
  const keys = new Set();
  let jumpPressed = false;
  const look = createLook();
  let distance = 6.5;
  const stick = { x: 0, y: 0 };
  let near = null;
  // Swimming out to the middle of the lake: E dives down to the Reef.
  let atDive = false;
  // The ski lift: E at either station rides a chair up (or down); on the way, Space jumps off into the
  // paraglider when it's high enough. `ride`: { s (metres along the line), ps (before this step), up }.
  let atLift = null;
  let ride = null;
  const SEAT_HIPS = 0.88; // the trainer's hips above their feet, sitting on the seat
  const startLift = (dir) => {
    ride = { s: dir === 'up' ? 0 : lift.line.length, up: dir === 'up' };
    ride.ps = ride.s;
    Object.assign(player, { mode: 'lift', vx: 0, vy: 0, vz: 0, moving: 0, mantle: null, bank: 0 });
  };
  const liftHigh = () => ride && player.y - terrainHeight(player.x, player.z) > PARA.drop;
  const stepLift = (dt, jump) => {
    ride.ps = ride.s;
    ride.s = Math.max(0, Math.min(lift.line.length, ride.s + (ride.up ? 1 : -1) * LIFT_SPEED * dt));
    const seat = seatAt(lift.line, ride.s, ride.up);
    Object.assign(player, { x: seat.x, y: seat.y - SEAT_HIPS, z: seat.z, facing: seat.heading, vx: 0, vy: 0, vz: 0, moving: 0 });
    if (jump && liftHigh()) {
      // Off the chair: falling for a moment until the paraglider (Space still held) opens.
      ride = null;
      Object.assign(player, { mode: 'fall', vy: -0.2, vx: Math.sin(seat.heading) * LIFT_SPEED, vz: Math.cos(seat.heading) * LIFT_SPEED });
      return;
    }
    if (ride.up ? ride.s >= lift.line.length : ride.s <= 0) {
      // Off at the station: a few steps on past the deck, onto the summit's pad (or back towards the plaza).
      const end = ride.up ? lift.line.heads.at(-1) : lift.line.heads[0];
      const x = end.x + Math.sin(seat.heading) * 6; // (the seat faces the way it travels)
      const z = end.z + Math.cos(seat.heading) * 6;
      ride = null;
      Object.assign(player, { x, z, y: terrainHeight(x, z), mode: 'walk' });
    }
  };
  const interact = () => {
    if (player.mode === 'lift') { if (liftHigh()) jumpPressed = true; return; }
    if (atLift && !near && !paused()) { startLift(atLift); return; }
    if (atDive && !near && !paused()) { location.hash = '#/sanctuary/reef'; return; }
    if (near && !paused()) ui.openRadial(near);
  };
  const onKey = (e) => {
    if (e.target?.closest?.('input, select, textarea')) return;
    if (e.type === 'keydown') {
      if (e.code === 'Escape') { ui.closeRadial(); cardModal.hidden = true; return; }
      if (paused()) return;
      if (e.code === 'Space' && !keys.has('Space')) jumpPressed = true;
      if (e.code === 'KeyE' && !e.repeat) interact();
      if (/^Digit[1-8]$/.test(e.code) && !e.repeat) travel(Number(e.code.slice(5)) - 1);
      if (e.code === 'KeyM' && !e.repeat) { ambience.toggleMute(); showSound(); }
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      keys.add(e.code);
    } else {
      keys.delete(e.code);
    }
  };
  let drag = null;
  // A mouse: a double-click locks the pointer to the view (Esc lets go); otherwise drag to look.
  const locked = () => document.pointerLockElement === renderer.domElement;
  const onDown = (e) => { if (e.target === renderer.domElement && !locked()) { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); } };
  const onMove = (e) => {
    if (locked()) { addLook(look, -e.movementX * 0.0025, e.movementY * 0.002); return; }
    if (!drag || e.pointerId !== drag.id) return;
    addLook(look, -(e.clientX - drag.x) * 0.005, (e.clientY - drag.y) * 0.004);
    drag.x = e.clientX;
    drag.y = e.clientY;
  };
  const onDouble = () => { if (!touch) renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); };
  renderer.domElement.addEventListener('dblclick', onDouble);
  // Keys 1–8 (or the gamepad's Select): go straight to a habitat, beside its sign.
  const stops = HABITATS.map((hab) => {
    const sign = plan.find((p) => p.kind === 'sign' && p.habitat === hab.id);
    if (!sign) return { name: hab.name, x: 0, z: 4 };
    const d = Math.hypot(sign.x, sign.z) || 1;
    return { name: hab.name, x: sign.x - (sign.x / d) * 2.5, z: sign.z - (sign.z / d) * 2.5 };
  });
  let stop = -1;
  const travel = (i) => {
    const to = stops[i];
    if (!to || paused()) return;
    stop = i;
    Object.assign(player, { x: to.x, z: to.z, y: terrainHeight(to.x, to.z), vx: 0, vz: 0, vy: 0, mode: 'walk', mantle: null, coyote: 0, buffer: 0, bank: 0 });
    ride = null;
    look.yaw = Math.atan2(-to.x, -to.z); // looking on into the habitat (away from the plaza)
    toast(`→ ${to.name}`);
  };
  const toastEl = h('div.sanc-toast', { hidden: true });
  el.append(toastEl);
  let toastTimer = 0;
  const toast = (text) => { toastEl.textContent = text; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1600); };
  const onUp = (e) => { if (drag?.id === e.pointerId) drag = null; };
  const onWheel = (e) => { distance = Math.min(14, Math.max(3, distance + e.deltaY * 0.01)); e.preventDefault(); };
  const onBlur = () => keys.clear();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointercancel', onUp);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  prompt.addEventListener('click', interact);
  let sprintToggle = false;
  let jumpHeldTouch = false;
  if (touch) {
    el.append(joystick((x, y) => { stick.x = x; stick.y = y; }),
      h('div.sanc-touch',
        h('button.btn', { type: 'button', onpointerdown: (e) => { e.preventDefault(); jumpPressed = true; jumpHeldTouch = true; }, onpointerup: () => { jumpHeldTouch = false; }, onpointercancel: () => { jumpHeldTouch = false; } }, 'Jump'),
        h('button.btn', { type: 'button', onclick: (e) => { sprintToggle = !sprintToggle; e.currentTarget.classList.toggle('primary', sprintToggle); } }, 'Sprint')));
  }

  // ---- gamepad: left stick walk, right stick look, A jump (hold: glide), B or RT sprint, X meet,
  // Start trainer; on the wheel the D-pad picks (up Follow, right Pet, down Card, left Battle), B closes.
  const pad = { memory: {}, x: 0, y: 0, jumpHeld: false, sprint: false };
  const wheelOrder = { 12: 'follow', 15: 'pet', 13: 'inspect', 14: 'battle' };
  const readPad = (dt) => {
    const g = readGamepad(0, pad.memory);
    if (!g) { pad.x = 0; pad.y = 0; pad.jumpHeld = false; pad.sprint = false; return; }
    addLook(look, -g.rx * dt * 2.6, g.ry * dt * 1.6);
    if (ui.isOpen() || !cardModal.hidden) {
      for (const [btn, action] of Object.entries(wheelOrder)) {
        if (g.pressed.has(Number(btn))) el.querySelector(`.radial-btn[data-action="${action}"]`)?.click();
      }
      if (g.pressed.has(1)) { ui.closeRadial(); cardModal.hidden = true; el.querySelector('.sanctuary-modal:not([hidden]) .btn.primary')?.click(); }
      pad.x = 0; pad.y = 0; pad.jumpHeld = false; pad.sprint = false;
      return;
    }
    if (g.pressed.has(2)) interact();
    if (g.pressed.has(9)) ui.openTrainerModal();
    if (g.pressed.has(8)) travel((stop + 1) % stops.length);
    if (g.pressed.has(0)) jumpPressed = true;
    pad.x = g.lx;
    pad.y = -g.ly;
    pad.jumpHeld = g.held.has(0);
    pad.sprint = g.held.has(1) || g.held.has(7);
  };

  // ---- the loop ----
  const player = createPlayer({ x: 0, z: 4 });
  player.y = ground.heightAt(0, 4);
  // Back from the Reef: come up in the middle of the lake.
  try {
    if (sessionStorage.getItem('pokedex.sanctuarySpawn') === 'lake') {
      sessionStorage.removeItem('pokedex.sanctuarySpawn');
      Object.assign(player, { x: LAKE.x, z: LAKE.z + 2, y: LAKE.level - 0.7, mode: 'swim' });
      look.yaw = Math.atan2(LAKE.x, LAKE.z);
    }
  } catch { /* storage unavailable */ }
  // Sound: wind, birdsong, and water near the lake (after the first click or key).
  const ambience = createAmbience('meadow');
  const showSound = () => { sound.textContent = ambience.muted ? '🔇 Sound' : '🔊 Sound'; };
  sound.addEventListener('click', () => { ambience.toggleMute(); showSound(); });
  showSound();
  let alive = true;
  let last = performance.now();
  let acc = 0;
  const STEP = 1 / 60;
  const v = new THREE.Vector3();
  const prevP = { x: player.x, y: player.y, z: player.z, facing: player.facing };
  let trainerAnim = 'idle';
  const P = { x: player.x, y: player.y, z: player.z, facing: player.facing }; // the trainer as drawn (between steps)
  let boom = 1; // how far out the camera is (0…1 of its distance): in at once when something is in the way, out gently
  let camLift = 0; // how far the camera is raised to stay above the ground, eased the same way
  let airZoom = 0; // 0 on the ground … 1 in the air (the camera pulls back further)
  const fogBase = scene.fog?.density ?? 0;
  let figurePhase = 0;
  const pushers = [];
  const pusherPool = Array.from({ length: 6 }, () => ({}));
  let shownPrompt = null;
  renderer.setAnimationLoop((now) => {
    meter.frame(now - last);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    sway.value = t;
    perf.frame(dt * 1000);
    stepLook(look, dt);
    const yaw = look.yaw;
    const pitch = look.pitch;
    readPad(dt);
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      // Where everything was before this step, to draw in between steps (below).
      prevP.x = player.x; prevP.y = player.y; prevP.z = player.z; prevP.facing = player.facing;
      for (const c of creatures) { c.px = c.x; c.py = c.y; c.pz = c.z; c.pf = c.facing; }
      const is = (...codes) => codes.some((c) => keys.has(c));
      const f = paused() ? 0 : (is('KeyW', 'ArrowUp') ? 1 : 0) - (is('KeyS', 'ArrowDown') ? 1 : 0) + stick.y + pad.y;
      const r = paused() ? 0 : (is('KeyD', 'ArrowRight') ? 1 : 0) - (is('KeyA', 'ArrowLeft') ? 1 : 0) + stick.x + pad.x;
      // Forward is away from the camera.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      if (player.mode === 'lift' && ride) stepLift(STEP, jumpPressed && !paused());
      else {
        stepPlayer(player, {
          x: fx * f - fz * r, z: fz * f + fx * r,
          sprint: !paused() && (is('ShiftLeft', 'ShiftRight') || sprintToggle || pad.sprint),
          jump: jumpPressed && !paused(), jumpHeld: !paused() && (is('Space') || jumpHeldTouch || pad.jumpHeld),
          steer: { f: Math.max(-1, Math.min(1, f)), r: Math.max(-1, Math.min(1, r)) },
        }, STEP, ground);
      }
      jumpPressed = false;
      for (const c of creatures) stepCreature(c, STEP, player, rand, { heightAt: ground.heightAt, blocked: blockedFor, waterLevel: LAKE.level });
    }

    // Drawn between the last two steps (the simulation runs 60 times a second, the screen may run at
    // 120 or 144): smooth motion at any refresh rate.
    const alpha = acc / STEP;
    const mix = (a, b) => a + (b - a) * alpha;
    const turnMix = (a, b) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * alpha;
    P.x = mix(prevP.x, player.x); P.y = mix(prevP.y, player.y); P.z = mix(prevP.z, player.z); P.facing = turnMix(prevP.facing, player.facing);
    for (const c of creatures) {
      c.rx = mix(c.px ?? c.x, c.x); c.ry = mix(c.py ?? c.y, c.y); c.rz = mix(c.pz ?? c.z, c.z); c.rf = turnMix(c.pf ?? c.facing, c.facing);
    }

    // The trainer: stride, arms, glider.
    avatar.position.set(P.x, P.y, P.z);
    avatar.rotation.y = P.facing;
    figurePhase += dt * (6 + player.moving); // (a phase that adds up: a speed change never jumps the legs)
    const stride = player.mode === 'walk' ? Math.sin(figurePhase) * Math.min(1, player.moving / 4) : 0;
    legs[0].rotation.x = stride * 0.7;
    legs[1].rotation.x = -stride * 0.7;
    const seated = player.mode === 'lift' || player.mode === 'paraglide';
    if (seated) { legs[0].rotation.x = -1.35; legs[1].rotation.x = -1.35 + Math.sin(t * 1.3) * 0.1; }
    const reach = player.mode === 'mantle' ? -1.8 : player.mode === 'glide' ? Math.PI : player.mode === 'paraglide' ? 2.7 : player.mode === 'lift' ? -0.45 : null;
    arms[0].rotation.x = reach ?? -stride * 0.6;
    arms[1].rotation.x = reach ?? stride * 0.6;
    glider.visible = player.mode === 'glide';
    trainerAnim = trainerState(player, trainerAnim);
    trainer.play(trainerAnim, player.moving, dt, t, player.bank ?? 0); // the owner's model, if one is chosen
    avatar.rotation.x = player.mode === 'glide' || player.mode === 'mantle' ? 0.25 : player.mode === 'swim' ? 0.5 : 0;
    avatar.rotation.z = player.mode === 'paraglide' ? -(player.bank ?? 0) * 0.3 : 0; // swinging out in a turn
    // The paraglider over the harness, and the ski lift's chairs (the ridden one drawn between steps too).
    wing.group.position.set(P.x, P.y + SEAT_HIPS, P.z);
    wing.group.rotation.y = P.facing;
    wing.update(dt, { open: player.mode === 'paraglide', bank: player.bank ?? 0, t, speed: player.moving });
    lift.update(t, ride ? { s: ride.ps + (ride.s - ride.ps) * alpha, up: ride.up } : null);
    // High up, the haze thins so the view opens out.
    if (scene.fog) scene.fog.density = fogBase * (1 - 0.6 * Math.min(1, Math.max(0, (P.y - 8) / 40)));
    world.followSun(P.x, P.y, P.z); // the sharp shadows stay round the trainer

    // The camera orbits behind the trainer, and stays above the ground. In the air (the lift, the
    // paraglider) it pulls back further and swings round behind the way you're going, unless you look round.
    const flying = player.mode === 'paraglide' || player.mode === 'lift';
    airZoom = approach(airZoom, flying ? 1 : 0, dt, 1.5, 1.5);
    if (flying && Math.abs(look.pending[0]) + Math.abs(look.stage[0]) < 0.002) {
      const behind = P.facing + Math.PI;
      look.yaw += ((((behind - look.yaw) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * ease(dt, 1.1);
    }
    const reachOut = distance * (1 + airZoom * 0.8);
    const cp = Math.cos(pitch);
    const ox = Math.sin(look.yaw) * cp * reachOut;
    const oy = Math.sin(pitch) * reachOut;
    const oz = Math.cos(look.yaw) * cp * reachOut;
    // Pulled in when a tree, rock or ruin stands between the trainer and the camera: the boom comes in
    // fast and goes back out slowly, so passing trees never make the view jump in and out.
    let want = 1;
    for (let k = 0.2; k <= 1; k += 0.05) {
      if (solidAt(plan, P.x + ox * k, P.z + oz * k, 0.2)) { want = Math.max(0.25, k - 0.12); break; }
    }
    boom = approach(boom, want, dt, 20, 3);
    v.set(P.x + ox * boom, P.y + 1.5 + oy * boom, P.z + oz * boom);
    // Kept above the ground and the lake, by an eased lift (no hop over each bump).
    camLift = approach(camLift, Math.max(0, ground.heightAt(v.x, v.z) + 0.4 - v.y, LAKE.level + 0.3 - v.y), dt, 3, 20);
    v.y += camLift;
    camera.position.lerp(v, ease(dt, 14)); // the same glide at any frame rate
    camera.lookAt(P.x, P.y + 1.4, P.z);

    // The creatures, their models (the nearest few) and their nameplates.
    const W = el.clientWidth;
    const H = el.clientHeight;
    for (const c of creatures) {
      // Distance to its body: a big Pokémon is seen (and loaded) from further away.
      const d = Math.max(0, Math.hypot(c.rx - P.x, c.rz - P.z) - c.plan.radius);
      if (c.petted > 0) c.petted = Math.max(0, c.petted - dt);
      const happy = c.petted ? Math.abs(Math.sin(c.petted * 10)) * Math.min(0.35, 0.1 + c.plan.heightM * 0.2) : 0;
      // A card (before its model loads) hops along; a model stands where the creature is: on the ground,
      // in the air, or at the lake's surface, and its animator moves its body and limbs.
      const stand = c.model ? 0 : Math.sin(c.hop) * 0.22;
      c.group.position.set(c.rx, c.ry + stand + happy, c.rz);
      c.group.rotation.y = c.model ? c.rf : Math.atan2(camera.position.x - c.rx, camera.position.z - c.rz); // a card faces you
      if (c.anim && d < 40) c.anim.update(dt, { speed: c.speed, air: c.air });
      if (c.mixer && d < 30) {
        if (!(c.extraUntil > now)) {
          const want = (c.speed > 0.3 && c.actions.walk) || c.actions.idle || c.actions.walk;
          if (want !== c.playing) {
            want.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.25).play();
            c.playing?.fadeOut(0.25);
            c.playing = want;
          }
          if (want === c.actions.walk) want.timeScale = Math.max(0.6, Math.min(1.8, c.speed / 1.6));
        }
        c.mixer.update(dt);
      }
      let alpha = 0;
      if (d < PLATE_RANGE) {
        v.set(c.rx, c.ry + (c.model?.height ?? 1) + 0.45, c.rz).project(camera);
        if (v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
          alpha = Math.min(1, (PLATE_RANGE - d) / 5);
          const at = `translate(${Math.round((v.x * 0.5 + 0.5) * W - (c.plateW ??= c.plate.offsetWidth) / 2)}px, ${Math.round((-v.y * 0.5 + 0.5) * H - 24)}px)`;
          if (at !== c.plateAt) { c.plate.style.transform = at; c.plateAt = at; }
        }
      }
      // Styles written only when they change (each write costs the page a style pass).
      const shown = Math.round(alpha * 50) / 50;
      if (shown !== c.plateAlpha) { c.plate.style.opacity = String(shown); c.plateAlpha = shown; }
    }
    near = player.mode === 'lift' || player.mode === 'paraglide' ? null : nearest(creatures, player);
    atLift = null;
    if (player.mode === 'walk' && !near) {
      if (Math.hypot(player.x - liftStops.up.x, player.z - liftStops.up.z) < 3.5) atLift = 'up';
      else if (Math.hypot(player.x - liftStops.down.x, player.z - liftStops.down.z) < 3.5) atLift = 'down';
    }
    // Models load in the background from the start, nearest first and one at a time, in the browser's
    // idle time, so they're ready before you get there; none starts while you sprint or fly (a model's
    // setup still takes the page a moment).
    if (!loading && !queued && loaded < MAX_MODELS && !(player.moving > 6 || player.mode === 'glide')) {
      let pick = null;
      let best = Infinity;
      for (const c of creatures) {
        if (c.asked) continue;
        const d = Math.hypot(c.x - player.x, c.z - player.z) - c.plan.heightM * 2;
        if (d < best) { best = d; pick = c; }
      }
      if (pick) {
        queued = true;
        const start = () => { queued = false; if (alive && !pick.asked) wantModel(pick); };
        if (best < MODEL_RANGE) start(); // close by: now
        else if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 2000 });
        else setTimeout(start, 200);
      }
    }
    // The grass bends aside around the trainer and the creatures walking nearest.
    // (The same few objects every frame: no garbage for the collector to pause the game over.)
    pushers.length = 0;
    pushers.push(Object.assign(pusherPool[0], { x: player.x, z: player.z, radius: 0.7, strength: player.mode === 'walk' ? 1 : 0 }));
    for (const c of creatures) {
      if (pushers.length >= 6) break;
      if (c.plan.mode === 'swim' || c.air || Math.hypot(c.x - player.x, c.z - player.z) > 20) continue;
      pushers.push(Object.assign(pusherPool[pushers.length], { x: c.x, z: c.z, radius: Math.max(0.5, c.plan.radius * 1.6), strength: 1 }));
    }
    world.setGrassPushers?.(pushers);
    atDive = player.mode === 'swim' && Math.hypot(player.x - LAKE.x, player.z - LAKE.z) < LAKE.r * 0.6;
    // The page is touched only when something on it changes (each change costs a style pass).
    const key = touch ? 'Tap' : 'E';
    const say = near ? `${key} · ${near.card.name}`
      : atLift === 'up' ? `${key} · Ride the ski lift up ⛰` : atLift === 'down' ? `${key} · Ride the ski lift down`
        : player.mode === 'lift' && liftHigh() ? `${touch ? 'Tap' : 'Space'} · Jump off and paraglide 🪂`
          : atDive ? `${key} · Dive to the Reef 🌊` : null;
    const hidePrompt = !say || paused();
    if (prompt.hidden !== hidePrompt) prompt.hidden = hidePrompt;
    if (say && say !== shownPrompt) { prompt.textContent = say; shownPrompt = say; }
    ambience.update({ nearWater: Math.max(0, 1 - Math.max(0, Math.hypot(player.x - LAKE.x, player.z - LAKE.z) - LAKE.r) / 14) });
    ui.updateStamina(player.stamina, player.exhausted);
    if (el.dataset.mode !== player.mode) el.dataset.mode = player.mode;
    const nearName = near?.card.name ?? '';
    if (el.dataset.near !== nearName) el.dataset.near = nearName;
    habitats.update(t);
    world.update(t);
    world.render();
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
    habitats.dispose();
    ambience.dispose();
    world.dispose();
    models.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose?.(); m.dispose?.(); }
    });
    meter.dispose();
    renderer.dispose();
  };
  window.addEventListener('hashchange', leave);
  // For the walkthrough test: where things are.
  el.sanctuary = { player, creatures, plan, look, travel, effects: world.effects, lift: { line: lift.line, stops: liftStops, start: startLift, get ride() { return ride; } } };
}
