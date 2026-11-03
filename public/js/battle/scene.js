// The PokéBattles 3D stage (three.js, served locally from /vendor/three).
//
// Each fighter starts as its card: the card drops in, lands on its platform, glows in its type's
// colour, and the Pokémon's 3D model pops out of it (a "summon", like an AR card demo, but no
// scanning: picking the card is enough). Then the stage plays what the battle engine says:
// attacks (lunge + a type-coloured effect), hits (shake, red flash, damage number), healing,
// charging, power-ups and fainting. Models without animations are animated here; a model's own
// animation clip plays when it has one. Without a model, the card itself stands up and fights.
//
// All methods return promises that resolve when the animation is done, so the page can play the
// engine's events one after another.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const TYPE_COLORS = {
  Grass: 0x4caf50, Fire: 0xff6d1f, Water: 0x2f8cff, Lightning: 0xffd21f, Psychic: 0xb44cff, Fighting: 0xd2691e,
  Darkness: 0x5b3a8c, Metal: 0xb0bec5, Fairy: 0xff7fd0, Dragon: 0xd4a017, Colorless: 0xf2f2f2,
};
export const typeColor = (type) => TYPE_COLORS[type] ?? TYPE_COLORS.Colorless;

const CARD_RATIO = 88 / 63;
const ease = {
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t) => { const c = 1.9; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
};

/** True when this browser can draw WebGL. */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** A rounded-rectangle shape with UVs running 0..1 across it (for card faces). */
function roundedCardGeometry(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ShapeGeometry(s, 6);
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - x) / w;
    uv[i * 2 + 1] = (pos.getY(i) - y) / h;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** The back of every card: drawn here (our own design, not the real card back). */
function cardBackTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 358;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 179, 10, 128, 179, 220);
  grad.addColorStop(0, '#3b82f6');
  grad.addColorStop(1, '#0b1f4d');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 358);
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 10;
  g.strokeRect(10, 10, 236, 338);
  g.fillStyle = '#ef4444';
  g.beginPath();
  g.arc(128, 179, 52, Math.PI, 0);
  g.fill();
  g.fillStyle = '#f8fafc';
  g.beginPath();
  g.arc(128, 179, 52, 0, Math.PI);
  g.fill();
  g.fillStyle = '#0f172a';
  g.fillRect(76, 175, 104, 8);
  g.beginPath();
  g.arc(128, 179, 16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f8fafc';
  g.beginPath();
  g.arc(128, 179, 9, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.font = '700 18px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('MY POKÉDEX', 128, 300);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A plain card face with the name, for cards without a usable picture. */
function nameCardTexture(name, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 358;
  const g = c.getContext('2d');
  g.fillStyle = '#facc15';
  g.fillRect(0, 0, 256, 358);
  g.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  g.fillRect(14, 14, 228, 330);
  g.fillStyle = '#111827';
  g.font = '700 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(String(name).slice(0, 16), 128, 190);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sky(dark) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  if (dark) {
    grad.addColorStop(0, '#0b1023');
    grad.addColorStop(0.6, '#1e2a4a');
    grad.addColorStop(1, '#2d3b5e');
  } else {
    grad.addColorStop(0, '#7cc4ff');
    grad.addColorStop(0.6, '#cfe9ff');
    grad.addColorStop(1, '#f6fbff');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class BattleStage {
  /**
   * @param {HTMLElement} host  element to draw into (gets a canvas and an overlay layer)
   * @param {{mode?: 'battle'|'showcase', dark?: boolean}} options
   */
  constructor(host, { mode = 'battle', dark = false } = {}) {
    this.host = host;
    this.mode = mode;
    this.slots = [null, null];
    this.anchors = new Set();
    // The card is the Pokémon's base (as in an AR card scanner): big enough to stand on.
    this.cardW = mode === 'showcase' ? 1.3 : 1.1;
    this.cardH = this.cardW * CARD_RATIO;
    this.tweens = new Set();
    this.effects = new Set();
    this.clock = new THREE.Clock();
    this.skipping = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'stage-canvas';
    this.overlay = document.createElement('div');
    this.overlay.className = 'stage-overlay';
    host.append(this.renderer.domElement, this.overlay);

    this.scene = new THREE.Scene();
    this.scene.background = sky(dark);
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
    if (mode === 'showcase') {
      this.camera.position.set(0, 3.0, 4.4);
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.set(0, 0.6, 0);
      this.controls.enablePan = false;
      this.controls.minDistance = 2.5;
      this.controls.maxDistance = 9;
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.controls.update();
    } else {
      this.camera.position.set(0.5, 3.2, 6.4);
      this.camera.lookAt(0.2, 0.45, -0.3);
    }

    this.scene.add(new THREE.HemisphereLight(dark ? 0x8ea4ff : 0xffffff, dark ? 0x1a1a2e : 0x9db38a, dark ? 1.4 : 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, dark ? 1.4 : 2.2);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);
    this.flash = new THREE.PointLight(0xffffff, 0, 6);
    this.scene.add(this.flash);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshStandardMaterial({ color: dark ? 0x24304a : 0x9fd89a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.scene.add(ground);

    this.dot = softCircleTexture();
    this.backTexture = cardBackTexture();
    this.textureLoader = new THREE.TextureLoader();
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    this.loader.setDRACOLoader(draco);
    this.draco = draco;

    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Where each side stands. In a showcase, slot 1 is the practice target. */
  position(slot) {
    if (this.mode === 'showcase') return slot === 0 ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(2.4, 0, -2.6);
    return slot === 0 ? new THREE.Vector3(-1.55, 0, 1.0) : new THREE.Vector3(1.75, 0, -1.6);
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    for (const tw of [...this.tweens]) {
      const t = this.skipping ? 1 : Math.min(1, (now - tw.start) / tw.ms);
      tw.update(tw.ease(t), t);
      if (t >= 1) {
        this.tweens.delete(tw);
        tw.done();
      }
    }
    for (const fx of [...this.effects]) if (fx.update(dt) === false) { this.scene.remove(fx.object); fx.dispose?.(); this.effects.delete(fx); }
    for (const s of this.slots) {
      if (!s) continue;
      s.mixer?.update(dt);
      if (s.ready && !s.fainted) {
        const t = now / 1000 + s.phase;
        s.body.position.y = s.lift + Math.sin(t * 2.2) * 0.035;
        s.body.scale.setScalar(s.scale * (1 + Math.sin(t * 2.2 + 1) * 0.012));
        if (s.aura) s.aura.material.opacity = 0.35 + Math.sin(t * 6) * 0.2;
      }
    }
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.#placeAnchors();
  }

  /**
   * Keep an HTML label floating above a fighter (like an AR info banner), inside the stage.
   * The label follows the camera (orbiting in the showcase) and goes away with its element.
   */
  anchor(el, slot) {
    el.classList.add('anchored');
    this.anchors.add({ el, slot });
  }

  #placeAnchors() {
    if (!this.anchors.size) return;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    for (const a of [...this.anchors]) {
      if (!a.el.isConnected) { this.anchors.delete(a); continue; }
      const s = this.slots[a.slot];
      if (!s) continue;
      const p = s.base.clone().setY(s.lift + s.height + 0.25).project(this.camera);
      const w = a.el.offsetWidth;
      const h = a.el.offsetHeight;
      const x = Math.min(W - w / 2 - 8, Math.max(w / 2 + 8, (p.x * 0.5 + 0.5) * W));
      const y = Math.min(H - 8, Math.max(h + 8, (-p.y * 0.5 + 0.5) * H));
      a.el.style.transform = `translate(${Math.round(x - w / 2)}px, ${Math.round(y - h)}px)`;
    }
  }

  tween(ms, update, easing = ease.inOut) {
    return new Promise((done) => this.tweens.add({ start: performance.now(), ms, update, ease: easing, done }));
  }

  wait(ms) {
    return this.skipping ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }

  /** Fast-forward the summon sequence (the "Skip" button) until `resume()`. */
  skip() {
    this.skipping = true;
  }

  resume() {
    this.skipping = false;
  }

  /** The platform under a fighter: a disc with a rim in the fighter's type colour. */
  #platform(pos, color) {
    const k = this.cardW * 0.95;
    const group = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.95 * k, 1.05 * k, 0.12, 48), new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.8 }));
    disc.position.y = 0.06;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0 * k, 0.035, 8, 64), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.12;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 32), new THREE.MeshBasicMaterial({ map: this.dot, color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.125;
    group.add(disc, rim, shadow);
    group.position.copy(pos);
    this.scene.add(group);
    return group;
  }

  async #texture(urls, name, color) {
    for (const url of urls.filter(Boolean)) {
      try {
        const t = await this.textureLoader.loadAsync(url);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return t;
      } catch { /* try the next picture */ }
    }
    return nameCardTexture(name, color);
  }

  /** A fighter's 3D model, normalised to `height` and standing on y = 0 (null if it can't load). */
  async #model(url, height) {
    if (!url) return null;
    try {
      const gltf = await this.loader.loadAsync(url);
      const root = gltf.scene;
      root.traverse((o) => {
        if (o.isMesh) {
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
          o.frustumCulled = false;
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
        attackClip: clips.find((c) => !/faint|dizzy|down|die|dead|sleep|hurt|damage|idle/i.test(c.name)) ?? null,
        faintClip: clips.find((c) => /faint|dizzy|down|die|dead|sleep/i.test(c.name)) ?? null,
      };
    } catch (err) {
      console.warn('3D model unavailable:', err?.message ?? err);
      return null;
    }
  }

  /**
   * Put a fighter on the stage, still hidden in its card. `info`: { name, types, modelUrl, cardUrls[] }.
   * Returns { hasModel }.
   */
  async addFighter(slot, info) {
    this.removeFighter(slot);
    const color = typeColor(info.types?.[0]);
    const pos = this.position(slot);
    const platform = this.#platform(pos, color);
    const height = this.mode === 'showcase' ? 1.2 : 1.05; // about the card's width, as in an AR card scanner
    const [front, model] = await Promise.all([this.#texture(info.cardUrls ?? [], info.name, color), this.#model(info.modelUrl, height)]);

    const card = new THREE.Group();
    const CARD_W = this.cardW;
    const CARD_H = this.cardH;
    const geo = roundedCardGeometry(CARD_W, CARD_H, 0.05);
    const faceMat = new THREE.MeshStandardMaterial({ map: front, roughness: 0.45, metalness: 0.1, transparent: true, side: THREE.FrontSide });
    const backMat = new THREE.MeshStandardMaterial({ map: this.backTexture, roughness: 0.6, transparent: true, side: THREE.FrontSide });
    const face = new THREE.Mesh(geo, faceMat);
    const back = new THREE.Mesh(geo, backMat);
    back.rotation.y = Math.PI;
    face.position.z = 0.004;
    back.position.z = -0.004;
    card.add(face, back);
    card.visible = false;
    this.scene.add(card);

    // The Pokémon stands on the card's upper half; its Poké Ball sits on the lower half.
    const base = pos.clone().add(new THREE.Vector3(0, 0, -CARD_H * 0.14));
    const body = new THREE.Group();
    body.position.copy(base);
    const target = this.position(1 - slot);
    const faceAngle = Math.atan2(target.x - pos.x, target.z - pos.z);
    // Face the opponent, turned a little towards the camera so the front side shows.
    body.rotation.y = this.mode === 'showcase' ? 0 : faceAngle * 0.65 + (slot === 0 ? 0.25 : -0.15);
    let fighterObject;
    if (model) {
      fighterObject = model.object;
    } else {
      // No model: the card stands up and is the fighter.
      const stand = new THREE.Group();
      const standCard = new THREE.Mesh(geo, faceMat.clone());
      const standBack = new THREE.Mesh(geo, backMat.clone());
      standBack.rotation.y = Math.PI;
      standCard.position.set(0, CARD_H / 2 * 1.25, 0.004);
      standBack.position.set(0, CARD_H / 2 * 1.25, -0.004);
      stand.add(standCard, standBack);
      stand.scale.setScalar(1.25);
      fighterObject = stand;
    }
    body.add(fighterObject);
    body.visible = false;
    this.scene.add(body);
    const mixer = model?.clips.length ? new THREE.AnimationMixer(model.object.children[0]) : null;
    const ball = this.#pokeBall(this.mode === 'showcase' ? 0.15 : 0.13);
    ball.group.position.copy(pos).add(new THREE.Vector3(CARD_W * 0.22, 0, CARD_H * 0.3));
    ball.group.visible = false;
    this.scene.add(ball.group);

    this.slots[slot] = {
      slot, info, color, pos, base, platform, card, faceMat, backMat, body, model, mixer, ball,
      height: model?.height ?? CARD_H * 1.25 * 1.25,
      lift: 0, scale: 1, phase: slot * 1.7, ready: false, fainted: false, aura: null,
    };
    return { hasModel: Boolean(model) };
  }

  removeFighter(slot) {
    const s = this.slots[slot];
    if (!s) return;
    this.scene.remove(s.platform, s.card, s.body, s.ball?.group);
    this.slots[slot] = null;
  }

  /** A Poké Ball (our own simple model): the top half is hinged at the back so it can open. */
  #pokeBall(r) {
    const group = new THREE.Group();
    const red = new THREE.MeshStandardMaterial({ color: 0xe11d2a, roughness: 0.35, metalness: 0.05 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    const bottom = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, r * 0.14, 32, 1, true), black);
    const button = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.26, r * 0.26, r * 0.12, 24), white);
    button.rotation.x = Math.PI / 2;
    button.position.z = r * 0.98;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.36, r * 0.36, r * 0.08, 24), black);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = r * 0.95;
    const lid = new THREE.Group(); // hinge at the back edge
    lid.position.z = -r;
    const top = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), red);
    top.position.z = r;
    lid.add(top);
    const inner = new THREE.Group();
    inner.position.y = r;
    inner.add(bottom, band, ring, button, lid);
    group.add(inner);
    // Face the camera with its button.
    group.userData.radius = r;
    return { group, lid, radius: r };
  }

  /**
   * The summon: the card lands face up, a Poké Ball drops onto it and pops open, and the
   * Pokémon comes out standing on the card (like an AR card scanner, but no scanning needed).
   */
  async summon(slot) {
    const s = this.slots[slot];
    if (!s) return;
    const { card, pos, color, ball } = s;
    card.visible = true;
    card.position.set(pos.x, 3.2, pos.z + 0.4);
    card.rotation.set(-0.2, 0, 0.3);
    // 1. The card falls in, spinning, and lands flat (face up) on the platform.
    await this.tween(650, (t) => {
      card.position.y = 3.2 + (0.135 - 3.2) * t;
      card.position.z = pos.z + 0.4 * (1 - t);
      card.rotation.x = -0.2 + (-Math.PI / 2 + 0.2) * t + Math.sin(t * Math.PI) * 0.6;
      card.rotation.z = 0.3 * (1 - t) + Math.PI * 2 * t;
    }, ease.out);
    card.rotation.set(-Math.PI / 2, 0, 0);
    this.#burst(new THREE.Vector3(pos.x, 0.15, pos.z), 0xffffff, { count: 24, speed: 1.2, life: 0.45, size: 0.06 });

    // 2. The Poké Ball drops onto the card and bounces.
    const bx = ball.group.position.x;
    const bz = ball.group.position.z;
    ball.group.rotation.y = Math.atan2(this.camera.position.x - bx, this.camera.position.z - bz);
    ball.group.visible = true;
    ball.lid.rotation.x = 0;
    await this.tween(650, (t) => {
      const bounce = Math.abs(Math.cos(t * Math.PI * 2.5)) * (1 - t) ** 1.6;
      ball.group.position.y = 0.135 + bounce * 2.2;
      ball.group.rotation.z = Math.sin(t * 20) * 0.15 * (1 - t);
    }, (t) => t);
    ball.group.position.y = 0.135;

    // 3. Charge-up: the ball wobbles, a ring and a beam of light rise in the type colour.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.base.x, 0.15, s.base.z);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 2.6, 32, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(s.base.x, 1.4, s.base.z);
    this.scene.add(ring, beam);
    this.#sparkles(new THREE.Vector3(pos.x, 0.2, pos.z), color, 0.9);
    await this.tween(800, (t) => {
      ball.group.rotation.z = Math.sin(t * Math.PI * 6) * 0.25 * Math.sin(t * Math.PI);
      ring.scale.setScalar(1 + t * 1.4);
      ring.material.opacity = 0.9 * (1 - t * 0.6);
      beam.material.opacity = Math.sin(t * Math.PI) * 0.45;
      beam.scale.set(1, 0.3 + t * 0.7, 1);
      s.faceMat.emissive = new THREE.Color(color);
      s.faceMat.emissiveIntensity = Math.sin(t * Math.PI) * 0.6;
    });
    ball.group.rotation.z = 0;

    // 4. The ball pops open with a flash, and the Pokémon comes out onto the card.
    this.flash.color.set(color);
    this.flash.position.set(s.base.x, 1, s.base.z + 0.6);
    s.body.visible = true;
    s.body.scale.setScalar(0.001);
    s.body.position.set(s.base.x, -0.3, s.base.z);
    const ballTop = ball.group.position.clone().setY(0.135 + ball.radius * 2);
    this.#burst(ballTop, 0xffffff, { count: 40, speed: 2.2, life: 0.6, size: 0.08 });
    this.#burst(new THREE.Vector3(s.base.x, 0.4, s.base.z), color, { count: 70, speed: 2.6, life: 0.8, size: 0.09 });
    await this.tween(700, (t) => {
      ball.lid.rotation.x = -1.9 * Math.min(1, t * 2.2);
      s.body.scale.setScalar(Math.max(0.001, t));
      s.body.position.y = -0.3 + 0.44 * Math.min(1, t * 1.2);
      this.flash.intensity = 25 * Math.sin(Math.min(1, t * 1.6) * Math.PI);
      beam.material.opacity = 0.45 * (1 - t);
      ring.material.opacity = 0.35 * (1 - t);
    }, ease.back);
    this.flash.intensity = 0;
    this.scene.remove(ring, beam);
    s.faceMat.emissiveIntensity = 0;
    s.lift = 0.14;
    s.scale = 1;
    s.ready = true;
    if (s.model?.attackClip && s.mixer) this.#playClip(s, s.model.attackClip);
    // The ball closes again and stays on the card.
    await this.tween(350, (t) => { ball.lid.rotation.x = -1.9 * (1 - t); });
  }

  #playClip(s, clip) {
    const action = s.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.play();
  }

  /** Screen position (px, relative to the host) of a point above a fighter, for floating text. */
  screenPoint(slot, y = 1.6) {
    const s = this.slots[slot];
    const p = (s ? (s.base ?? s.pos).clone() : this.position(slot)).setY(s?.height ? s.lift + s.height * 0.8 : y).project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.host.clientWidth, y: (-p.y * 0.5 + 0.5) * this.host.clientHeight };
  }

  float(slot, text, kind = 'damage') {
    const { x, y } = this.screenPoint(slot);
    const el = document.createElement('div');
    el.className = `stage-float ${kind}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.overlay.append(el);
    setTimeout(() => el.remove(), 1400);
  }

  /** Lunge at the other side and send a type-coloured effect. */
  async attack(slot, { type } = {}) {
    const s = this.slots[slot];
    if (!s?.ready) return;
    const color = typeColor(type ?? s.info.types?.[0]);
    const from = s.base.clone();
    const to = this.slots[1 - slot]?.base?.clone() ?? this.position(1 - slot);
    const dir = to.clone().sub(from).setY(0).normalize();
    if (s.model?.attackClip && s.mixer) this.#playClip(s, s.model.attackClip);
    await this.tween(260, (t) => s.body.position.set(from.x + dir.x * 0.7 * t, s.body.position.y, from.z + dir.z * 0.7 * t), ease.out);
    const projectile = this.#projectile(from.clone().setY(0.9), to.clone().setY(0.8), color, type);
    await this.tween(260, (t) => s.body.position.set(from.x + dir.x * 0.7 * (1 - t), s.body.position.y, from.z + dir.z * 0.7 * (1 - t)));
    await projectile;
  }

  /** Take a hit: shake, a red flash, and the damage number. */
  async hit(slot, { amount = 0, weakness = false } = {}) {
    const s = this.slots[slot];
    if (!s) return;
    this.float(slot, amount > 0 ? `-${amount}` : 'No damage', weakness ? 'damage weak' : amount > 0 ? 'damage' : 'miss');
    if (amount <= 0) return this.wait(300);
    const mats = [];
    s.body.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if ('emissive' in m) mats.push([m, m.emissive.clone(), m.emissiveIntensity]); });
    const x0 = s.base.x;
    await this.tween(420, (t) => {
      s.body.position.x = x0 + Math.sin(t * Math.PI * 8) * 0.12 * (1 - t);
      const k = Math.sin(t * Math.PI * 3) > 0 ? 1 : 0;
      for (const [m] of mats) { m.emissive.setRGB(k, 0.05 * k, 0.05 * k); m.emissiveIntensity = k * 0.9; }
    }, (t) => t);
    for (const [m, e, i] of mats) { m.emissive.copy(e); m.emissiveIntensity = i; }
    s.body.position.x = x0;
  }

  async heal(slot, amount) {
    const s = this.slots[slot];
    if (!s) return;
    this.float(slot, `+${amount}`, 'heal');
    this.#sparkles(s.pos.clone().setY(0.2), 0x4ade80, 1.4);
    await this.wait(700);
  }

  async charge(slot, amount = 1) {
    const s = this.slots[slot];
    if (!s) return;
    this.float(slot, `+${amount} energy`, 'energy');
    this.#sparkles(s.pos.clone().setY(0.2), 0xfacc15, 1.1);
    await this.wait(600);
  }

  /** Power-up from an ability: a glowing ring stays around the fighter until its next attack. */
  async boost(slot, on = true) {
    const s = this.slots[slot];
    if (!s) return;
    if (s.aura) { this.scene.remove(s.aura); s.aura = null; }
    if (!on) return;
    const aura = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.05, 8, 64), new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    aura.rotation.x = Math.PI / 2;
    aura.position.copy(s.base).setY(0.3);
    this.scene.add(aura);
    s.aura = aura;
    this.float(slot, 'Powered up!', 'energy');
    this.#burst(s.pos.clone().setY(0.6), s.color, { count: 40, speed: 1.6, life: 0.7, size: 0.07 });
    await this.wait(700);
  }

  async faint(slot) {
    const s = this.slots[slot];
    if (!s) return;
    s.fainted = true;
    if (s.aura) { this.scene.remove(s.aura); s.aura = null; }
    if (s.model?.faintClip && s.mixer) this.#playClip(s, s.model.faintClip);
    const mats = [];
    s.body.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) { m.transparent = true; mats.push(m); } });
    const y0 = s.body.position.y;
    await this.tween(1100, (t) => {
      s.body.position.y = y0 - t * 0.5;
      s.body.rotation.z = t * 0.5 * (s.slot === 0 ? -1 : 1);
      for (const m of mats) m.opacity = 1 - t;
      s.faceMat.opacity = 1 - t * 0.45;
    });
    s.body.visible = false;
  }

  // ---- effects ----

  #points(count, color, size) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({ color, size, map: this.dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    return new THREE.Points(geo, mat);
  }

  /** Particles bursting out from a point. */
  #burst(at, color, { count = 40, speed = 2, life = 0.7, size = 0.08, gravity = -2.5 } = {}) {
    const pts = this.#points(count, color, size);
    const pos = pts.geometry.attributes.position;
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos.setXYZ(i, at.x, at.y, at.z);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.7));
      vel.push(v);
    }
    let age = 0;
    this.scene.add(pts);
    this.effects.add({
      object: pts,
      dispose: () => { pts.geometry.dispose(); pts.material.dispose(); },
      update: (dt) => {
        age += dt;
        for (let i = 0; i < count; i++) {
          vel[i].y += gravity * dt;
          pos.setXYZ(i, pos.getX(i) + vel[i].x * dt, pos.getY(i) + vel[i].y * dt, pos.getZ(i) + vel[i].z * dt);
        }
        pos.needsUpdate = true;
        pts.material.opacity = Math.max(0, 1 - age / life);
        return age < life;
      },
    });
  }

  /** Sparkles rising around a spot (charge, heal, summon). */
  #sparkles(at, color, life = 1) {
    const count = 40;
    const pts = this.#points(count, color, 0.07);
    const pos = pts.geometry.attributes.position;
    const seeds = Array.from({ length: count }, () => ({ a: Math.random() * Math.PI * 2, r: 0.2 + Math.random() * 0.5, v: 0.6 + Math.random() * 1.2 }));
    let age = 0;
    this.scene.add(pts);
    this.effects.add({
      object: pts,
      dispose: () => { pts.geometry.dispose(); pts.material.dispose(); },
      update: (dt) => {
        age += dt;
        seeds.forEach((s, i) => {
          const a = s.a + age * 3;
          pos.setXYZ(i, at.x + Math.cos(a) * s.r, at.y + age * s.v, at.z + Math.sin(a) * s.r);
        });
        pos.needsUpdate = true;
        pts.material.opacity = Math.max(0, 1 - age / life);
        return age < life;
      },
    });
  }

  /** The move itself: a stream of particles in an arc, a zig-zag bolt for Lightning, then a burst. */
  #projectile(from, to, color, type) {
    return new Promise((resolve) => {
      const count = 46;
      const pts = this.#points(count, color, type === 'Water' ? 0.1 : 0.12);
      const pos = pts.geometry.attributes.position;
      const offsets = Array.from({ length: count }, () => [Math.random() * 0.25, (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25]);
      let age = 0;
      const life = 0.45;
      let bolt = null;
      if (type === 'Lightning') {
        const pointsArr = [];
        for (let i = 0; i <= 10; i++) {
          const p = to.clone().setY(3.2 - i * 0.26);
          if (i > 0 && i < 10) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4));
          pointsArr.push(p);
        }
        bolt = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pointsArr), new THREE.LineBasicMaterial({ color: 0xfff7a0, transparent: true }));
        bolt.visible = false;
        this.scene.add(bolt);
      }
      this.scene.add(pts);
      this.effects.add({
        object: pts,
        dispose: () => { pts.geometry.dispose(); pts.material.dispose(); if (bolt) { this.scene.remove(bolt); bolt.geometry.dispose(); } },
        update: (dt) => {
          age += dt;
          const k = Math.min(1, age / life);
          for (let i = 0; i < count; i++) {
            const lag = Math.max(0, Math.min(1, k * 1.3 - offsets[i][0]));
            const p = from.clone().lerp(to, lag);
            p.y += Math.sin(lag * Math.PI) * 0.6;
            pos.setXYZ(i, p.x + offsets[i][1], p.y + offsets[i][2], p.z + offsets[i][1]);
          }
          pos.needsUpdate = true;
          if (bolt) bolt.visible = k > 0.6 && Math.random() > 0.3;
          if (k >= 1) {
            this.#burst(to, color, { count: 60, speed: 2.4, life: 0.6, size: 0.09 });
            this.flash.color.set(color);
            this.flash.position.copy(to).setY(1.2);
            this.flash.intensity = 12;
            setTimeout(() => { this.flash.intensity = 0; }, 140);
            resolve();
            return false;
          }
          return true;
        },
      });
      if (this.skipping) resolve();
    });
  }

  /** A practice target for the showcase (slot 1): a simple ring target on a post. */
  addTarget() {
    const pos = this.position(1);
    const group = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x8b5a2b }));
    post.position.y = 0.45;
    group.add(post);
    [[0.45, 0xef4444], [0.32, 0xffffff], [0.19, 0xef4444]].forEach(([r, c], i) => {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 40), new THREE.MeshStandardMaterial({ color: c, side: THREE.DoubleSide }));
      disc.position.set(0, 1.25, 0.01 * i);
      group.add(disc);
    });
    group.position.copy(pos);
    group.lookAt(this.position(0).setY(0));
    this.scene.add(group);
    this.slots[1] = { slot: 1, info: { types: ['Colorless'] }, pos, base: pos.clone(), height: 1.5, body: group, card: new THREE.Group(), faceMat: new THREE.MeshBasicMaterial(), platform: new THREE.Group(), lift: 0, scale: 1, phase: 0, ready: false, fainted: false };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    this.controls?.dispose();
    this.draco.dispose();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose?.(); m.dispose?.(); }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}

/**
 * The same stage without WebGL: the cards themselves on a flat arena, with CSS animations.
 * Same methods as BattleStage, so the page doesn't care which one it got.
 */
export class FlatStage {
  constructor(host, { mode = 'battle' } = {}) {
    this.host = host;
    this.mode = mode;
    this.el = document.createElement('div');
    this.el.className = `flat-stage ${mode}`;
    this.overlay = document.createElement('div');
    this.overlay.className = 'stage-overlay';
    host.append(this.el, this.overlay);
    this.slots = [null, null];
  }

  wait(ms) { return this.skipping ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)); }
  skip() { this.skipping = true; }
  resume() { this.skipping = false; }

  async addFighter(slot, info) {
    const el = document.createElement('div');
    el.className = `flat-fighter slot-${slot}`;
    const img = document.createElement('img');
    img.alt = info.name;
    img.src = info.cardUrls?.find(Boolean) ?? '';
    el.append(img);
    el.style.setProperty('--type', `#${typeColor(info.types?.[0]).toString(16).padStart(6, '0')}`);
    this.el.append(el);
    this.slots[slot] = el;
    return { hasModel: false };
  }

  addTarget() {
    const el = document.createElement('div');
    el.className = 'flat-fighter slot-1 target';
    el.textContent = '🎯';
    this.el.append(el);
    this.slots[1] = el;
  }

  async #anim(slot, cls, ms) {
    const el = this.slots[slot];
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    await this.wait(ms);
    el.classList.remove(cls);
  }

  screenPoint(slot) {
    const el = this.slots[slot];
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    return { x: r.left - h.left + r.width / 2, y: r.top - h.top + 10 };
  }

  float(slot, text, kind = 'damage') {
    const { x, y } = this.screenPoint(slot);
    const el = document.createElement('div');
    el.className = `stage-float ${kind}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.overlay.append(el);
    setTimeout(() => el.remove(), 1400);
  }

  summon(slot) { return this.#anim(slot, 'summon', 900); }
  attack(slot) { return this.#anim(slot, `lunge-${slot}`, 500); }
  async hit(slot, { amount = 0, weakness = false } = {}) {
    this.float(slot, amount > 0 ? `-${amount}` : 'No damage', weakness ? 'damage weak' : amount > 0 ? 'damage' : 'miss');
    if (amount > 0) await this.#anim(slot, 'shake', 450);
  }
  async heal(slot, amount) { this.float(slot, `+${amount}`, 'heal'); await this.wait(600); }
  async charge(slot, amount = 1) { this.float(slot, `+${amount} energy`, 'energy'); await this.wait(500); }
  async boost(slot, on = true) { this.slots[slot]?.classList.toggle('boosted', on); if (on) this.float(slot, 'Powered up!', 'energy'); await this.wait(on ? 500 : 0); }
  async faint(slot) { this.slots[slot]?.classList.add('fainted'); await this.wait(900); }
  dispose() { this.el.remove(); this.overlay.remove(); }
}
