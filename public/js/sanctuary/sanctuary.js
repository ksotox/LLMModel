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
import { createFrameMeter, createGpuTimer } from '../battle/frameMeter.js';
import { actionFor, GRASS_DENSITY, held, keyLabel, loadSettings, mouseTurn, VIEW_DISTANCE } from '../game/settings.js';
import { createSettingsMenu } from '../game/settingsMenu.js';
import { createAmbience } from '../ambience.js';
import { initSanctuaryUI, savedTrainer, savedTrainerModel } from './sanctuaryUI.js';
import { trainerState } from './rig.js';
import { buildTrainer } from './trainer.js';
import { createPlayer, PARA, stepFlyer, stepPlayer } from './player.js';
import { createCreature, HABITATS, layoutHabitats, nearest, stepCreature } from './zoo.js';
import { bodyPlan, sizedSpecies } from '../creature/body.js';
import { bringToLife } from '../creature/life.js';

const MAX_MODELS = 24; // full 3D models at once; the rest stand as their cards
const AIRBORNE = new Set(['glide', 'paraglide', 'lift', 'fall', 'ride']); // no model loads in these (any hitch shows)
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
  const [THREE, worldKit, { createModelLoader, loadModel, pickClips, precompile, shaderChecks, warmUp }, stadiumKit, surfaceKit] = world3d;
  const { buildWorld, preferredQuality, saveQuality, terrainHeight, LAKE } = worldKit;

  // ---- the page ----
  const el = h('div.sanc');
  const plates = h('div.sanc-plates');
  const prompt = h('button.sanc-prompt', { type: 'button', hidden: true });
  const touch = matchMedia('(pointer: coarse)').matches;
  const sound = h('button.btn.small', { type: 'button' });
  const quality = h('select', { 'aria-label': 'Graphics quality' }, ['high', 'standard', 'basic'].map((q) => h('option', { value: q }, q[0].toUpperCase() + q.slice(1))));
  const help = h('p.sanc-help');
  const topBar = h('div.sanc-top');
  el.append(plates, prompt,
    h('h1.sanc-title', `Sanctuary · ${new Set(cards.map((c) => c.name)).size} Pokémon`),
    clear(topBar,
      h('label.btn.small', h('span', 'Graphics '), quality),
      sound,
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/sanctuary/reef'; } }, '🌊 Reef'),
      h('button.btn.small', { type: 'button', onclick: () => ui.openTrainerModal() }, '👤 Trainer'),
      h('button.btn.small', { type: 'button', onclick: () => { location.hash = '#/'; } }, '✕ Leave')),
    help);
  clear(root, el);
  document.body.classList.add('sanctuary-mode');

  // ---- the world ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  shaderChecks(renderer);
  renderer.domElement.className = 'sanc-canvas';
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 4000);
  camera.position.set(0, 3, 10);
  const dark = document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const world = buildWorld({ scene, renderer, camera, dark, mode: 'sanctuary', quality: markLoad(preferredQuality(renderer)) });
  // The ⚙ settings (game/settings.js): key bindings, the mouse, graphics and the performance readout.
  let settings = loadSettings();
  const perf = createPerf(renderer, () => world.pixelTop, world.effects, { dynamic: () => settings.video.renderScale === 'auto' });
  const meter = createFrameMeter(el); // F3: frame times
  const gpuTimer = createGpuTimer(renderer);
  const loadTimer = setTimeout(clearLoad, 12000);
  quality.value = world.quality;
  const setLevel = (q) => { quality.value = q; world.setQuality(q); saveQuality(world.quality); perf.settle(); resize(); precompile(renderer, scene, camera); };
  quality.addEventListener('change', () => setLevel(quality.value));
  const applySettings = (s) => {
    settings = s;
    world.setOptions({ grass: GRASS_DENSITY[s.video.grass], shadows: s.video.shadows, effects: s.video.effects, scale: s.video.renderScale === 'auto' ? null : s.video.renderScale });
    camera.far = VIEW_DISTANCE[s.video.viewDistance].far;
    camera.updateProjectionMatrix();
    meter.apply(s.overlay);
    perf.settle();
    const k = (a) => keyLabel(s.bindings[a]?.[0]);
    help.textContent = touch
      ? 'Drag to move or look · hold Jump toward the basalt ledge to climb · tap a Pokémon’s name to interact'
      : `${k('forward')}${k('left')}${k('back')}${k('right')} move · ${k('sprint')} sprint · ${k('jump')} jump, hold to climb or glide · ${s.mouse.look === 'lock' ? 'mouse to look (Esc frees it)' : 'drag to look'} · ${k('interact')} interact · 1–8 travel · ${k('settings')} ⚙`;
  };
  const menu = createSettingsMenu(el, { onChange: (s) => applySettings(s), quality: { get: () => world.quality, set: setLevel } });
  topBar.prepend(menu.button);
  applySettings(settings);
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
    c.rideable = () => Boolean(c.model) && c.plan.mode === 'fly'; // a flying Pokémon, its model loaded
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
      else if (action === 'ride') startRide(c);
    },
  });
  const paused = () => ui.isOpen() || !cardModal.hidden || menu.isOpen();

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
  // Riding a flying Pokémon (the wheel's Ride): it grows to carry the trainer (mount.k: its ride size)
  // and flies where you steer it (player.js stepFlyer); E gets off, into the paraglider when high up.
  let mount = null;
  const RIDE_HEIGHT = 2.4; // a mount is at least this tall while ridden
  const startRide = (c) => {
    if (!c?.model || c.plan.mode !== 'fly' || mount || paused()) return;
    mount = { c, grow: 0, k: Math.max(1, RIDE_HEIGHT / (c.model.height || 1)) };
    Object.assign(c, { ridden: true, state: 'ridden', shrink: false, dropLift: 0 });
    c.plate.style.opacity = '0';
    c.plateAlpha = 0;
    const y = terrainHeight(c.x, c.z);
    Object.assign(player, { x: c.x, y, z: c.z, facing: c.facing, mode: 'ride', air: false, throttle: 0, bank: 0, vx: 0, vy: 0, vz: 0, moving: 0, mantle: null });
    prevP.x = player.x; prevP.y = player.y; prevP.z = player.z; prevP.facing = player.facing;
    toast(`Riding ${c.card.name} · Space to take off`);
  };
  const endRide = () => {
    if (!mount) return;
    const { c } = mount;
    const groundY = terrainHeight(player.x, player.z);
    const high = player.air && player.y - groundY > PARA.drop;
    // It goes back to its own life (shrinking back, and drifting down if let go up high).
    Object.assign(c, { ridden: false, state: 'idle', timer: 1.5, x: player.x, z: player.z, facing: player.facing, shrink: true, dropLift: player.air ? Math.max(0, player.y - groundY) : 0 });
    c.group.rotation.set(0, c.group.rotation.y, 0);
    mount = null;
    if (!player.air) {
      // Step off beside it.
      const x = player.x + Math.cos(player.facing) * 1.4 * (c.plan.radius + 0.6);
      const z = player.z - Math.sin(player.facing) * 1.4 * (c.plan.radius + 0.6);
      Object.assign(player, { x, z, y: terrainHeight(x, z), mode: 'walk', vx: 0, vy: 0, vz: 0, bank: 0 });
    } else if (high) {
      Object.assign(player, { mode: 'paraglide', vy: 0, bank: 0 });
    } else {
      Object.assign(player, { mode: 'fall', vy: 0, bank: 0 });
    }
  };
  const seatAtMount = new THREE.Vector3();
  const interact = () => {
    if (mount) { endRide(); return; }
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
      const action = actionFor(e.code, settings.bindings);
      if (action === 'settings' && !e.repeat) { e.preventDefault(); menu.open(); return; }
      // The mouse takes the camera on the first key press (a browser allows it only on a key or a click).
      if (settings.mouse.look === 'lock' && !locked() && !touch) lockPointer();
      if (action === 'jump' && !held('jump', keys, settings.bindings)) jumpPressed = true;
      if (action === 'interact' && !e.repeat) interact();
      if (/^Digit[1-8]$/.test(e.code) && !e.repeat) travel(Number(e.code.slice(5)) - 1);
      if (action === 'mute' && !e.repeat) { ambience.toggleMute(); showSound(); }
      if (action && ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'dive'].includes(action)) e.preventDefault();
      keys.add(e.code);
    } else {
      keys.delete(e.code);
    }
  };
  let drag = null;
  // The mouse: by default it turns the camera as soon as you press a key or click (the pointer is locked
  // to the view; Esc lets go). The ⚙ setting "left-click and drag" turns it with a drag instead (and a
  // double-click still locks it).
  const locked = () => document.pointerLockElement === renderer.domElement;
  const lockPointer = () => { try { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not now */ } };
  const onDown = (e) => {
    if (e.target !== renderer.domElement || locked()) return;
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
  const onDouble = () => { if (!touch) lockPointer(); };
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
    if (mount) endRide();
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
  let diveTouch = false; // riding a flying Pokémon: the Dive button
  if (touch) {
    el.append(joystick((x, y) => { stick.x = x; stick.y = y; }),
      h('div.sanc-touch',
        h('button.btn', { type: 'button', onpointerdown: (e) => { e.preventDefault(); jumpPressed = true; jumpHeldTouch = true; }, onpointerup: () => { jumpHeldTouch = false; }, onpointercancel: () => { jumpHeldTouch = false; } }, 'Jump'),
        h('button.btn.touch-dive', { type: 'button', onpointerdown: (e) => { e.preventDefault(); diveTouch = true; }, onpointerup: () => { diveTouch = false; }, onpointercancel: () => { diveTouch = false; } }, 'Dive'),
        h('button.btn', { type: 'button', onclick: (e) => { sprintToggle = !sprintToggle; e.currentTarget.classList.toggle('primary', sprintToggle); } }, 'Sprint')));
  }

  // ---- gamepad: left stick walk, right stick look, A jump (hold: glide), B or RT sprint, X meet,
  // Start trainer; on the wheel the D-pad picks (up Follow, right Pet, down Card, left Battle), B closes.
  const pad = { memory: {}, x: 0, y: 0, jumpHeld: false, sprint: false, down: false };
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
    pad.down = g.held.has(6); // LT: dive (riding)
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
  const view = new THREE.Frustum();
  const viewMatrix = new THREE.Matrix4();
  const viewSphere = new THREE.Sphere();
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
  let cpuMs = null; // the page's own work last frame (the ⚙ performance readout)
  // Every shader now, the paraglider's, the glider's and the lift's too, so nothing stalls when it first
  // appears (the browser compiles them in the background while the page settles).
  precompile(renderer, scene, camera);
  renderer.setAnimationLoop((now) => {
    // A frame limit (⚙ Graphics): skip screen refreshes until it's time (1 ms early, so 60 on a 60 Hz
    // screen doesn't drop to 30).
    if (settings.video.frameLimit && now - last < 1000 / settings.video.frameLimit - 1) return;
    const cpuStart = performance.now();
    meter.frame(now - last, { cpu: cpuMs, gpu: gpuTimer });
    // (Never below 0: the browser's frame time can be a moment before the clock read at setup, and a
    // step backwards would push everything drawn between steps far off.)
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    // A dialog open: the cursor comes back (the wheel, a card, the settings take clicks).
    if (paused() && locked()) document.exitPointerLock?.();
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
      const is = (action) => held(action, keys, settings.bindings);
      const f = paused() ? 0 : (is('forward') ? 1 : 0) - (is('back') ? 1 : 0) + stick.y + pad.y;
      const r = paused() ? 0 : (is('right') ? 1 : 0) - (is('left') ? 1 : 0) + stick.x + pad.x;
      // Forward is away from the camera.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      if (player.mode === 'lift' && ride) stepLift(STEP, jumpPressed && !paused());
      else if (player.mode === 'ride' && mount) {
        stepFlyer(player, {
          steer: { f: Math.max(-1, Math.min(1, f)), r: Math.max(-1, Math.min(1, r)) },
          jumpHeld: !paused() && (is('jump') || jumpHeldTouch || pad.jumpHeld),
          down: !paused() && (is('dive') || diveTouch || pad.down),
          sprint: !paused() && (is('sprint') || sprintToggle || pad.sprint),
        }, STEP, ground);
        Object.assign(mount.c, { x: player.x, y: player.y, z: player.z, facing: player.facing });
      } else {
        stepPlayer(player, {
          x: fx * f - fz * r, z: fz * f + fx * r,
          sprint: !paused() && (is('sprint') || sprintToggle || pad.sprint),
          jump: jumpPressed && !paused(), jumpHeld: !paused() && (is('jump') || jumpHeldTouch || pad.jumpHeld),
          steer: { f: Math.max(-1, Math.min(1, f)), r: Math.max(-1, Math.min(1, r)) },
        }, STEP, ground);
      }
      jumpPressed = false;
      for (const c of creatures) if (!c.ridden) stepCreature(c, STEP, player, rand, { heightAt: ground.heightAt, blocked: blockedFor, waterLevel: LAKE.level });
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
    // Riding: the Pokémon (grown to carry you) where you are, pitching with the climb and rolling into
    // turns; the trainer astride its back.
    let rideTop = 0;
    avatar.rotation.order = mount ? 'YXZ' : 'XYZ';
    if (mount) {
      const { c } = mount;
      mount.grow = approach(mount.grow, 1, dt, 2.5, 2.5);
      const k = 1 + (mount.k - 1) * mount.grow;
      const pitch = player.air ? -Math.atan2(player.vy, Math.max(2, player.moving)) * 0.7 : 0;
      const roll = player.air ? (player.bank ?? 0) * 0.5 : 0;
      c.group.scale.setScalar(k);
      c.group.rotation.order = 'YXZ';
      c.group.rotation.set(pitch, P.facing, roll);
      c.group.position.set(P.x, P.y, P.z);
      c.group.updateMatrixWorld(true);
      const hgt = c.model.height || 1;
      seatAtMount.set(0, hgt * 0.62, -hgt * 0.04).applyMatrix4(c.group.matrixWorld);
      avatar.position.set(seatAtMount.x, seatAtMount.y - SEAT_HIPS, seatAtMount.z);
      avatar.rotation.set(pitch, P.facing, roll);
      rideTop = seatAtMount.y - P.y;
    }
    // High up, the haze thins so the view opens out.
    if (scene.fog) scene.fog.density = fogBase * VIEW_DISTANCE[settings.video.viewDistance].fog * (1 - 0.6 * Math.min(1, Math.max(0, (P.y - 8) / 40)));
    world.followSun(P.x, P.y, P.z); // the sharp shadows stay round the trainer

    // The camera orbits behind the trainer, and stays above the ground. In the air (the lift, the
    // paraglider) it pulls back further and swings round behind the way you're going, unless you look round.
    const flying = player.mode === 'paraglide' || player.mode === 'lift' || (player.mode === 'ride' && player.air);
    airZoom = approach(airZoom, flying ? 1 : 0, dt, 1.5, 1.5);
    if (flying && Math.abs(look.pending[0]) + Math.abs(look.stage[0]) < 0.002) {
      const behind = P.facing + Math.PI;
      look.yaw += ((((behind - look.yaw) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * ease(dt, 1.1);
    }
    const reachOut = distance * (1 + airZoom * 0.8) + rideTop * 1.3;
    const cp = Math.cos(pitch);
    const ox = Math.sin(look.yaw) * cp * reachOut;
    const oy = Math.sin(pitch) * reachOut;
    const oz = Math.cos(look.yaw) * cp * reachOut;
    // Pulled in when a tree, rock or ruin stands between the trainer and the camera: the boom comes in
    // fast and goes back out slowly, so passing trees never make the view jump in and out.
    // (Only what stands as high as the camera: flying over the woods, the trees below are not in the way.)
    let want = 1;
    for (let k = 0.2; k <= 1; k += 0.05) {
      const x = P.x + ox * k;
      const z = P.z + oz * k;
      if (P.y + 1.5 + rideTop + oy * k - ground.heightAt(x, z) > 9) continue;
      if (solidAt(plan, x, z, 0.2)) { want = Math.max(0.25, k - 0.12); break; }
    }
    boom = approach(boom, want, dt, 20, 3);
    v.set(P.x + ox * boom, P.y + 1.5 + rideTop + oy * boom, P.z + oz * boom);
    // Kept above the ground and the lake, by an eased lift (no hop over each bump).
    camLift = approach(camLift, Math.max(0, ground.heightAt(v.x, v.z) + 0.4 - v.y, LAKE.level + 0.3 - v.y), dt, 3, 20);
    v.y += camLift;
    camera.position.lerp(v, ease(dt, 14)); // the same glide at any frame rate
    camera.lookAt(P.x, P.y + 1.4 + rideTop, P.z);

    // The creatures, their models (the nearest few) and their nameplates.
    const W = el.clientWidth;
    const H = el.clientHeight;
    // What the camera sees: a Pokémon out of view isn't animated (it carries on when it comes back).
    camera.updateMatrixWorld();
    view.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const seen = (c, d) => d < 6 || view.intersectsSphere(viewSphere.set(viewSphere.center.set(c.rx, c.ry + (c.model?.height ?? 1) * 0.5, c.rz), Math.max(1.5, (c.model?.height ?? 1) * 0.9, c.plan.radius * 1.5)));
    for (const c of creatures) {
      // Distance to its body: a big Pokémon is seen (and loaded) from further away.
      const d = Math.max(0, Math.hypot(c.rx - P.x, c.rz - P.z) - c.plan.radius);
      if (c.petted > 0) c.petted = Math.max(0, c.petted - dt);
      const happy = c.petted ? Math.abs(Math.sin(c.petted * 10)) * Math.min(0.35, 0.1 + c.plan.heightM * 0.2) : 0;
      // A card (before its model loads) hops along; a model stands where the creature is: on the ground,
      // in the air, or at the lake's surface, and its animator moves its body and limbs.
      if (c.ridden) {
        // (Placed with the trainer above.) Its wings work with the flight: hard climbing or hovering, wide
        // fast beats; diving or going fast, wings held out to glide.
        const effort = player.air ? Math.max(0.05, Math.min(1.5, 1 + player.vy * 0.09 - Math.max(0, player.moving - 9) * 0.07 + Math.max(0, 4 - player.moving) * 0.1)) : null;
        c.anim?.update(dt, { speed: player.moving / (mount?.k ?? 1), air: Boolean(player.air), effort });
        if (c.mixer) {
          const want = (player.air || player.moving > 0.3 ? c.actions.walk : c.actions.idle) ?? c.actions.idle ?? c.actions.walk;
          if (want && want !== c.playing) { want.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.25).play(); c.playing?.fadeOut(0.25); c.playing = want; }
          c.mixer.update(dt);
        }
        continue;
      }
      if (c.shrink) {
        const s = approach(c.group.scale.x, 1, dt, 2, 2);
        c.group.scale.setScalar(Math.abs(s - 1) < 0.005 ? 1 : s);
        if (c.group.scale.x === 1) c.shrink = false;
      }
      if (c.dropLift > 0.01) c.dropLift *= Math.exp(-dt * 0.6); else c.dropLift = 0;
      const stand = c.model ? 0 : Math.sin(c.hop) * 0.22;
      c.group.position.set(c.rx, c.ry + stand + happy + (c.dropLift ?? 0), c.rz);
      c.group.rotation.y = c.model ? c.rf : Math.atan2(camera.position.x - c.rx, camera.position.z - c.rz); // a card faces you
      const visible = (c.anim && d < 40) || (c.mixer && d < 30) ? seen(c, d) : false;
      if (c.anim && d < 40 && visible) c.anim.update(dt, { speed: c.speed, air: c.air });
      if (c.mixer && d < 30 && visible) {
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
    near = player.mode === 'lift' || player.mode === 'paraglide' || mount ? null : nearest(creatures, player);
    if (near?.ridden) near = null;
    atLift = null;
    if (player.mode === 'walk' && !near) {
      if (Math.hypot(player.x - liftStops.up.x, player.z - liftStops.up.z) < 3.5) atLift = 'up';
      else if (Math.hypot(player.x - liftStops.down.x, player.z - liftStops.down.z) < 3.5) atLift = 'down';
    }
    // Models load in the background from the start, nearest first and one at a time, in the browser's
    // idle time, so they're ready before you get there; none starts while you sprint, ride, glide or fly
    // (reading a model still takes the page a moment, and in the air any hitch shows).
    if (!loading && !queued && loaded < MAX_MODELS && !(player.moving > 6 || player.air || mount || AIRBORNE.has(player.mode))) {
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
      if (c.ridden || c.plan.mode === 'swim' || c.air || Math.hypot(c.x - player.x, c.z - player.z) > 20) continue;
      pushers.push(Object.assign(pusherPool[pushers.length], { x: c.x, z: c.z, radius: Math.max(0.5, c.plan.radius * 1.6), strength: 1 }));
    }
    world.setGrassPushers?.(pushers);
    atDive = player.mode === 'swim' && Math.hypot(player.x - LAKE.x, player.z - LAKE.z) < LAKE.r * 0.6;
    // The page is touched only when something on it changes (each change costs a style pass).
    const key = touch ? 'Tap' : 'E';
    const say = mount ? (player.air && player.y - terrainHeight(player.x, player.z) > PARA.drop ? `${key} · Jump off and paraglide 🪂` : `${key} · Get off ${mount.c.card.name}`)
      : near ? `${key} · ${near.card.name}`
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
    if (meter.timingGpu) gpuTimer.begin();
    world.render();
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
    habitats.dispose();
    ambience.dispose();
    world.dispose();
    models.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose?.(); m.dispose?.(); }
    });
    meter.dispose();
    gpuTimer.dispose();
    menu.dispose();
    renderer.dispose();
  };
  window.addEventListener('hashchange', leave);
  // For the walkthrough test: where things are.
  el.sanctuary = { player, creatures, plan, look, travel, camera, effects: world.effects, lift: { line: lift.line, stops: liftStops, start: startLift, get ride() { return ride; } }, riding: { start: startRide, end: endRide, get mount() { return mount; } } };
}
