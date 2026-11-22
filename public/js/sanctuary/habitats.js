// The Sanctuary's habitats, each with scenery of its own: a grove for Grass types, warm red rocks
// round a fire pit for Fire, tall grass on the open plain for Lightning, old ruins for Psychic, a
// stony ridge for Fighting and Metal, a shady hollow of dark pines and glowing mushrooms for
// Darkness, Dragon and Fairy, and a sandy beach with palms, a boat and a pier on the lake for Water.
// A painted sign at each one says where you are. All made in code.
//
// planHabitats() decides where everything goes (pure, tested in Node); buildHabitats() makes it.

import { HABITATS } from './zoo.js';

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What each habitat is made of: [kind, how many, how far out (share of its radius, from–to), size]. */
const RECIPES = {
  woods: [['tree', 14, 0.35, 1.0, 1], ['fern', 10, 0.2, 0.9, 1], ['log', 3, 0.3, 0.8, 1]],
  rocks: [['redRock', 10, 0.45, 1.0, 1], ['slab', 4, 0.3, 0.8, 1], ['firePit', 1, 0.15, 0.2, 1]],
  plain: [['tuft', 34, 0.1, 1.0, 1], ['post', 4, 0.5, 0.9, 1]],
  ruins: [['ruin', 5, 0.45, 0.95, 1], ['stoneRing', 1, 0, 0, 1]],
  ridge: [['crag', 12, 0.35, 1.0, 1], ['cliff', 1, 0.95, 1.0, 1]],
  dusk: [['pine', 10, 0.6, 1.05, 1], ['mushroom', 14, 0.15, 0.85, 1], ['fireflies', 1, 0, 0, 1]],
  shore: [['palm', 3, 0, 0, 1], ['boat', 1, 0, 0, 1], ['pier', 1, 0, 0, 1]],
};

/** How wide (for walking into it) each kind of prop is; 0: you can walk through it. */
const SOLID = { tree: 0.45, log: 0.5, redRock: 0.9, slab: 0.8, firePit: 0.9, post: 0.25, ruin: 1.3, crag: 1.0, cliff: 3.2, pine: 0.45, palm: 0.35, boat: 1.4 };

/**
 * Where every prop goes: [{ kind, habitat, x, z, size, turn, solid }], kept out of the water, off
 * the plaza and apart from each other. `lake`: { x, z, shore } (the water's edge from its middle).
 * The same every time.
 */
export function planHabitats({ inWater, lake, plaza = 9, seed = 23 }) {
  const r = rngFrom(seed);
  const out = [];
  const clear = (x, z, room) => !inWater(x, z) && Math.hypot(x, z) > plaza && out.every((o) => Math.hypot(o.x - x, o.z - z) > room + (o.solid || 0.3));
  for (const habitat of HABITATS) {
    const recipe = RECIPES[habitat.id];
    if (!recipe) continue;
    for (const [kind, count, from, to, size] of recipe) {
      if (habitat.id === 'shore') {
        // Round the lake: palms on the sand, the boat pulled up on it, the pier out over the water.
        const toward = Math.atan2(-lake.z, -lake.x); // the side facing the plaza
        const spots = kind === 'palm' ? [toward - 0.5, toward + 0.75, toward + 1.6] : kind === 'boat' ? [toward + 0.25] : [toward - 1.2];
        for (const a of spots.slice(0, count)) {
          const d = kind === 'pier' ? lake.shore - 1.2 : lake.shore + (kind === 'palm' ? 3.2 + r() * 1.5 : 1.6);
          out.push({ kind, habitat: habitat.id, x: lake.x + Math.cos(a) * d, z: lake.z + Math.sin(a) * d, size: size * (0.85 + r() * 0.3), turn: a, solid: kind === 'pier' ? 0 : SOLID[kind] ?? 0 });
        }
        continue;
      }
      if (from === 0 && to === 0) { // the habitat's middle
        out.push({ kind, habitat: habitat.id, x: habitat.x, z: habitat.z, size, turn: r() * Math.PI * 2, solid: SOLID[kind] ?? 0 });
        continue;
      }
      for (let i = 0, tries = 0; i < count && tries < count * 40; tries++) {
        const a = r() * Math.PI * 2;
        const d = habitat.r * (from + r() * (to - from));
        const x = habitat.x + Math.cos(a) * d;
        const z = habitat.z + Math.sin(a) * d;
        const solid = SOLID[kind] ?? 0;
        if (!clear(x, z, Math.max(solid, 0.4))) continue;
        out.push({ kind, habitat: habitat.id, x, z, size: size * (0.75 + r() * 0.5), turn: r() * Math.PI * 2, solid });
        i++;
      }
    }
  }
  // A sign at each habitat, on the side facing the plaza.
  for (const habitat of HABITATS) {
    if (habitat.id === 'meadow') continue;
    const d = Math.hypot(habitat.x, habitat.z) || 1;
    const back = habitat.id === 'shore' ? lake.shore + 5.5 : habitat.r * 0.8;
    out.push({ kind: 'sign', habitat: habitat.id, name: habitat.name, x: habitat.x - (habitat.x / d) * back, z: habitat.z - (habitat.z / d) * back, size: 1, turn: Math.atan2(-habitat.x, -habitat.z), solid: 0.2 });
  }
  return out;
}

/** Is (x, z) inside a solid prop? (For the trainer, who walks round them.) */
export function solidAt(plan, x, z, pad = 0.35) {
  for (const p of plan) if (p.solid && Math.hypot(p.x - x, p.z - z) < p.solid + pad) return true;
  return false;
}

/** Give one basalt slab the same dimensions in the scene and in the trainer's collider. */
export function addTraversalLedge(plan, heightAt) {
  const prop = plan.find((p) => p.kind === 'slab');
  if (!prop) return null;
  const { x, z, turn, size } = prop;
  const floor = heightAt(x, z);
  const width = 1.6 * size;
  const depth = 1.0 * size;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  prop.ledge = {
    x, z, width, depth, bottom: floor - 0.25, top: floor + 0.85,
    contains(px, pz, pad = 0) {
      const dx = px - x;
      const dz = pz - z;
      return Math.abs(dx * cos - dz * sin) <= width / 2 + pad
        && Math.abs(dx * sin + dz * cos) <= depth / 2 + pad;
    },
  };
  return prop.ledge;
}

// ---------------------------------------------------------------------------
// Making it (three.js)

/**
 * Build the habitats into `scene`. `kit`: what the world shares with us (THREE, terrainHeight,
 * LAKE, shore radius, tree, ruins, rockGeometry, palm, canvasTexture, speckle, leaves, contact
 * shadows, the surface-depth helper). Returns { update(seconds), dispose() }.
 */
export function buildHabitats(scene, plan, kit) {
  const { THREE, heightAt, lake, dark, leaves, time } = kit;
  const group = new THREE.Group();
  const kept = [];
  const keep = (o) => { kept.push(o); return o; };
  const std = (opts) => keep(new THREE.MeshStandardMaterial({ roughness: 0.92, ...opts }));
  const contacts = kit.contactShadows(keep(kit.contactTexture()));
  const at = (p, y = 0) => new THREE.Vector3(p.x, heightAt(p.x, p.z) + y, p.z);
  const add = (o, p, shadow = 0) => {
    group.add(o);
    if (shadow) contacts.add(p.x, heightAt(p.x, p.z), p.z, shadow);
    return o;
  };
  const shade = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };
  const r = rngFrom(97);

  // Shared materials.
  const stoneTex = keep(kit.noiseTexture({ base: dark ? '#6f7072' : '#9c9b96', seed: 61, size: 256, blotches: 300, specks: 3000, tones: ['rgba(120,120,118,ALPHA)', 'rgba(160,158,150,ALPHA)', 'rgba(90,90,92,ALPHA)'] }));
  const stone = std({ map: stoneTex, roughness: 0.88 });
  const redRock = std({ map: keep(kit.noiseTexture({ base: '#9a5a3f', seed: 63, size: 256, blotches: 300, specks: 3000, tones: ['rgba(120,62,40,ALPHA)', 'rgba(170,96,60,ALPHA)', 'rgba(90,48,34,ALPHA)'] })), roughness: 0.9, flatShading: true });
  const basalt = std({ color: 0x3a3836, roughness: 0.85, flatShading: true });
  const bark = std({ color: 0x5b4029, roughness: 0.95 });
  const fernTex = keep(kit.canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = dark ? '#2f5228' : '#3f7d2f';
    g.lineWidth = 3;
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.32;
      g.beginPath(); g.moveTo(w / 2, h); g.quadraticCurveTo(w / 2 + Math.cos(a) * 30, h / 2, w / 2 + Math.cos(a) * 58, h * 0.1 + Math.abs(i - 3) * 9); g.stroke();
      for (let k = 1; k < 9; k++) {
        const t = k / 9;
        const x = w / 2 + Math.cos(a) * 58 * t;
        const y = h - (h * 0.9 - Math.abs(i - 3) * 9) * t;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - 6 * (1 - t), y - 6); g.moveTo(x, y); g.lineTo(x + 6 * (1 - t), y - 6); g.stroke();
      }
    }
  }));
  fernTex.wrapS = fernTex.wrapT = THREE.ClampToEdgeWrapping;
  const tuftTex = keep(kit.canvasTexture(64, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 22; i++) {
      const x = 8 + (i / 22) * (w - 16);
      g.strokeStyle = ['#6b9a3a', '#8bb04a', '#5a8a30', '#a8b860'][i % 4];
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, h); g.quadraticCurveTo(x + (i % 3 - 1) * 6, h * 0.5, x + (i % 5 - 2) * 5, 6 + (i % 4) * 10); g.stroke();
    }
  }));
  tuftTex.wrapS = tuftTex.wrapT = THREE.ClampToEdgeWrapping;
  const sway = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
      `#include <begin_vertex>
       transformed.x += sin(uTime * 1.8 + modelMatrix[3].x * 0.7 + modelMatrix[3].z * 0.5) * 0.12 * max(position.y, 0.0);`);
  };
  const card = (tex, w, h) => {
    const mat = keep(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 }));
    mat.onBeforeCompile = sway;
    const geo = keep(new THREE.PlaneGeometry(w, h));
    geo.translate(0, h / 2, 0);
    return (p) => {
      const g = new THREE.Group();
      for (let k = 0; k < 3; k++) { const m = new THREE.Mesh(geo, mat); m.rotation.y = (k / 3) * Math.PI; g.add(m); }
      g.position.copy(at(p, -0.03));
      g.rotation.y = p.turn;
      g.scale.setScalar(p.size);
      return g;
    };
  };
  const fern = card(fernTex, 1.1, 1.0);
  const tuft = card(tuftTex, 0.7, 1.3);

  // Flickering things and fireflies, moved in update().
  const flicker = [];
  let flies = null;
  const glowTex = keep(kit.canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }));
  const glow = (color, size) => {
    const s = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })));
    s.scale.setScalar(size);
    return s;
  };

  for (const p of plan) {
    switch (p.kind) {
      case 'tree': {
        const t = kit.tree(400 + Math.round(p.x * 13 + p.z * 7), dark, leaves, 'broadleaf');
        t.position.copy(at(p, -0.05));
        add(shade(t), p, 1.6 * p.size);
        break;
      }
      case 'pine': {
        const t = kit.tree(500 + Math.round(p.x * 11 + p.z * 5), true, null, 'pine');
        t.position.copy(at(p, -0.05));
        add(shade(t), p, 1.4);
        break;
      }
      case 'fern': add(fern(p), p); break;
      case 'tuft': add(tuft(p), p); break;
      case 'log': {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 2.4 * p.size, 9), bark);
        log.rotation.set(Math.PI / 2, 0, p.turn);
        log.position.copy(at(p, 0.2));
        add(shade(log), p, 1.3);
        break;
      }
      case 'redRock': case 'crag': {
        const rock = new THREE.Mesh(kit.rockGeometry((p.kind === 'crag' ? 0.9 : 0.75) * p.size, 700 + Math.round(p.x * 3 + p.z), 1), p.kind === 'crag' ? stone : redRock);
        if (p.kind === 'crag') rock.scale.y = 1.6;
        rock.position.copy(at(p, 0.15));
        rock.rotation.y = p.turn;
        add(shade(rock), p, 1.2 * p.size);
        break;
      }
      case 'slab': {
        const tiltX = (r() - 0.5) * 0.2;
        const tiltZ = (r() - 0.5) * 0.2;
        const ledge = p.ledge;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(1.6 * p.size, ledge ? ledge.top - ledge.bottom : 0.35, 1.0 * p.size), basalt);
        slab.position.copy(at(p, 0.12));
        slab.rotation.set(tiltX, p.turn, tiltZ);
        if (ledge) {
          slab.position.y = (ledge.top + ledge.bottom) / 2;
          slab.rotation.set(0, p.turn, 0);
        }
        add(shade(slab), p, 1.1);
        break;
      }
      case 'firePit': {
        const pit = new THREE.Group();
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * Math.PI * 2;
          const s = new THREE.Mesh(kit.rockGeometry(0.22, 900 + k, 1), basalt);
          s.position.set(Math.cos(a) * 0.7, 0.08, Math.sin(a) * 0.7);
          pit.add(s);
        }
        const embers = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0xff7a2a }));
        embers.rotation.x = -Math.PI / 2;
        embers.position.y = 0.04;
        pit.add(embers);
        const fire = glow(0xff9a40, 2.2);
        fire.position.y = 0.7;
        pit.add(fire);
        const light = new THREE.PointLight(0xff8a3a, 6, 9, 2);
        light.position.y = 1;
        pit.add(light);
        flicker.push({ fire, light });
        pit.position.copy(at(p));
        add(shade(pit), p, 1.6);
        break;
      }
      case 'post': {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.4, 6), stone);
        post.position.copy(at(p, 0.6));
        post.rotation.z = (r() - 0.5) * 0.15;
        add(shade(post), p, 0.5);
        break;
      }
      case 'ruin': add(shade(kit.ruins(stone, 300 + Math.round(p.x + p.z), [[p.x, p.z]])), p, 1.8); break;
      case 'stoneRing': {
        const ring = new THREE.Group();
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2 + p.turn;
          const h = 1.2 + r() * 0.9;
          const s = new THREE.Mesh(new THREE.BoxGeometry(0.5, h, 0.35), stone);
          s.position.set(Math.cos(a) * 3, h / 2 - 0.1, Math.sin(a) * 3);
          s.rotation.y = -a;
          ring.add(s);
        }
        ring.position.copy(at(p));
        add(shade(ring), p);
        break;
      }
      case 'cliff': {
        const cliff = new THREE.Mesh(kit.rockGeometry(3.2, 1234, 2), stone);
        cliff.scale.set(1.3, 1.5, 0.8);
        cliff.position.copy(at(p, 0.8));
        cliff.rotation.y = p.turn;
        add(shade(cliff), p, 4);
        break;
      }
      case 'mushroom': {
        const m = new THREE.Group();
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.3, 6), std({ color: 0xe8e0d0 }));
        stem.position.y = 0.15;
        const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), std({ color: 0x7c5cff, emissive: 0x6a48ff, emissiveIntensity: 1.2 }));
        cap.position.y = 0.28;
        const g = glow(0x9a7dff, 0.9);
        g.position.y = 0.32;
        m.add(stem, cap, g);
        m.position.copy(at(p));
        m.scale.setScalar(p.size * 1.2);
        add(m, p);
        break;
      }
      case 'fireflies': {
        const n = 70;
        const pos = new Float32Array(n * 3);
        const seeds = Array.from({ length: n }, () => [r() * Math.PI * 2, 2 + r() * 9, 0.4 + r() * 2, r() * 10]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(geo, keep(new THREE.PointsMaterial({ map: glowTex, color: 0xd9ff8a, size: 0.35, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
        pts.frustumCulled = false;
        flies = { pts, pos, seeds, x: p.x, z: p.z, y: heightAt(p.x, p.z) };
        group.add(pts);
        break;
      }
      case 'palm': {
        const t = kit.palm({ height: 4 * p.size, lean: p.turn + Math.PI + 0.4, seed: 600 + Math.round(p.x), trunkMat: kit.palmTrunk, frondMat: kit.palmFrond, frondDepth: kit.palmFrondDepth });
        t.position.copy(at(p, -0.1));
        add(t, p, 0.8);
        break;
      }
      case 'boat': {
        const boat = new THREE.Group();
        const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 9, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), std({ color: 0x2c4a6e, side: THREE.DoubleSide, roughness: 0.7 }));
        hull.scale.set(1.9, 0.6, 0.65);
        boat.add(hull);
        for (const x of [-0.7, 0.2, 1.0]) {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 1.05 - Math.abs(x) * 0.3), std({ color: 0xc9b48c }));
          seat.position.set(x, -0.1, 0);
          boat.add(seat);
        }
        boat.position.copy(at(p, 0.5));
        boat.rotation.set(0.1, -p.turn + Math.PI / 2, 0.05);
        add(shade(boat), p, 2);
        break;
      }
      case 'pier': {
        const pier = new THREE.Group();
        const plank = std({ color: 0x9a7a55 });
        for (let d = 0; d < 7; d += 0.42) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.07, 1.7), plank);
          b.position.set(-d, 0, 0);
          pier.add(b);
        }
        for (let d = 0.5; d < 7; d += 2.2) {
          for (const z of [-0.8, 0.8]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 7), plank);
            post.position.set(-d, -0.6, z);
            pier.add(post);
          }
        }
        // It starts on the shore and runs out over the water, towards the lake's middle.
        pier.position.set(p.x, lake.level + 0.45, p.z);
        pier.rotation.y = -p.turn;
        add(shade(pier), p);
        break;
      }
      case 'sign': {
        const sign = new THREE.Group();
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.6, 6), bark);
        post.position.y = 0.8;
        const tex = keep(kit.canvasTexture(256, 96, (g, w, h) => {
          g.fillStyle = '#7a5634';
          g.fillRect(0, 0, w, h);
          g.fillStyle = 'rgba(0,0,0,0.18)';
          for (let y = 12; y < h; y += 18) g.fillRect(0, y, w, 2);
          g.fillStyle = '#fbf3df';
          g.font = 'bold 34px system-ui, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(p.name, w / 2, h / 2 + 2, w - 20);
        }));
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.56, 0.06), [bark, bark, bark, bark, std({ map: tex }), std({ map: tex })]);
        board.position.y = 1.45;
        sign.add(post, board);
        sign.position.copy(at(p));
        sign.rotation.y = p.turn;
        sign.userData.sign = p.name;
        add(shade(sign), p, 0.5);
        break;
      }
      default: break;
    }
  }

  // The lake shore's sand: a ring round the water, fading into the meadow.
  const sandTex = keep(kit.canvasTexture(256, 256, (g, w, h) => {
    const q = rngFrom(31);
    g.fillStyle = dark ? '#cbbd9c' : '#e8dcbc';
    g.fillRect(0, 0, w, h);
    kit.speckle(g, w, h, q, 9000, 0.1);
  }, { repeat: [6, 6] }));
  const fade = keep(kit.canvasTexture(256, 256, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.72, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }));
  const R = kit.shoreSand;
  const sandGeo = new THREE.CircleGeometry(R, 96, 0, Math.PI * 2);
  sandGeo.rotateX(-Math.PI / 2);
  const sp = sandGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) sp.setY(i, Math.max(lake.level - 0.3, heightAt(lake.x + sp.getX(i), lake.z + sp.getZ(i)) + 0.04));
  sandGeo.computeVertexNormals();
  const sand = new THREE.Mesh(sandGeo, std({ map: sandTex, alphaMap: fade, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  sand.position.set(lake.x, 0, lake.z);
  sand.receiveShadow = true;
  sand.renderOrder = 1;
  group.add(sand);

  contacts.finish();
  group.add(contacts.mesh);
  scene.add(group);
  for (const map of kit.addSurfaceDepth(group)) keep(map);
  return {
    group,
    update(seconds) {
      for (const f of flicker) {
        const k = 0.8 + Math.sin(seconds * 13) * 0.08 + Math.sin(seconds * 7.3) * 0.12;
        f.fire.scale.setScalar(2.2 * k);
        f.light.intensity = 6 * k;
      }
      if (flies) {
        flies.seeds.forEach(([a, d, h, ph], i) => {
          const t = seconds * 0.4 + ph;
          flies.pos.set([flies.x + Math.cos(a + t * 0.3) * d + Math.sin(t * 1.7) * 0.6, flies.y + h + Math.sin(t * 2.3) * 0.4, flies.z + Math.sin(a + t * 0.3) * d + Math.cos(t * 1.3) * 0.6], i * 3);
        });
        flies.pts.geometry.attributes.position.needsUpdate = true;
        flies.pts.material.opacity = 0.6 + Math.sin(seconds * 3) * 0.3;
      }
    },
    dispose() {
      scene.remove(group);
      for (const o of kept) o.dispose?.();
      group.traverse((o) => { o.geometry?.dispose?.(); });
    },
  };
}
