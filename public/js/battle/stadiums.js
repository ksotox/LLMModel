// The three stadiums a PokéBattle can happen in besides the meadow. Their idea and layout follow
// the open-source fan game PokeBrawl (github.com/xjoje6/PokeBrawl, MIT):
//   • Night Stadium: a packed, walled stadium at night under a roof ring of floodlights, with a
//     strip of pink light over the stands and a cyan line round the field;
//   • Floating Stadium: a platform on a pillar over a deep, dark pit with water at the bottom,
//     the stands far away and below, a giant screen, and a city and mountains behind;
//   • League Stadium: a stone coliseum on a cool day: pale slabs, grey-green paving, a brick wall,
//     stone stands split by pillars, flags, and a scoreboard tower.
// A fourth place, the Tropical Beach, is the owner's own idea (from their reference pictures).
// They are rebuilt here in this app's own look (the same sky dome, fog, lights, tone mapping and
// painted-canvas textures as the meadow): no model, texture or code of that game is used, and
// everything is made in code.

import * as THREE from 'three';

/** Sky, fog and light for each stadium (display colours, like the meadow's palette). */
export const STADIUM_LOOK = {
  night: {
    sky: { horizon: [0.10, 0.12, 0.22], zenith: [0.015, 0.02, 0.06], glow: [0.55, 0.62, 0.85], sunCol: [0.9, 0.93, 1.0], cloudShade: [0.05, 0.06, 0.12], cloudLit: [0.20, 0.22, 0.34], deep: [0.02, 0.03, 0.06] },
    skyDir: [-0.35, 0.62, -0.7], // the moon
    lightDir: [0.25, 1, 0.45], // the floodlights
    sun: [0xeaf2ff, 0.95],
    hemi: [0x6f7fc8, 0x1c2228, 0.36],
    fog: 0.0016,
    stars: true,
  },
  floating: {
    sky: { horizon: [0.07, 0.08, 0.17], zenith: [0.008, 0.01, 0.04], glow: [0.5, 0.55, 0.8], sunCol: [0.9, 0.93, 1.0], cloudShade: [0.03, 0.04, 0.09], cloudLit: [0.15, 0.17, 0.28], deep: [0.01, 0.02, 0.05] },
    skyDir: [0.5, 0.55, -0.67],
    lightDir: [-0.2, 1, 0.35],
    sun: [0xf2f6ff, 1.15],
    hemi: [0x6470b8, 0x0c1016, 0.32],
    fog: 0.0011,
    stars: true,
  },
  league: {
    sky: { horizon: [0.72, 0.77, 0.80], zenith: [0.36, 0.48, 0.66], glow: [0.95, 0.93, 0.86], sunCol: [1.0, 0.97, 0.92], cloudShade: [0.50, 0.55, 0.62], cloudLit: [0.93, 0.94, 0.95], deep: [0.10, 0.14, 0.16] },
    skyDir: [0.42, 0.62, -0.66],
    lightDir: [0.42, 0.62, -0.66],
    sun: [0xe8eef5, 1.25],
    hemi: [0xbfd0e6, 0x5a6258, 0.75],
    fog: 0.0026,
    stars: false,
  },
};

// The beach is no stadium, but it is built the same way: see beach() below.
STADIUM_LOOK.beach = {
  sky: { horizon: [0.80, 0.87, 0.93], zenith: [0.16, 0.42, 0.80], glow: [1.0, 0.93, 0.78], sunCol: [1.0, 0.97, 0.90], cloudShade: [0.66, 0.72, 0.80], cloudLit: [1.0, 1.0, 0.98], deep: [0.03, 0.20, 0.36] },
  skyDir: [0.55, 0.62, -0.42],
  lightDir: [0.55, 0.62, -0.42],
  sun: [0xfff4e0, 1.6],
  hemi: [0xcfe4ff, 0xd9c79c, 0.7],
  fog: 0.0016,
  stars: false,
  // In dark mode: sunset over the sea, the sun low ahead.
  dusk: {
    sky: { horizon: [0.98, 0.62, 0.30], zenith: [0.24, 0.26, 0.46], glow: [1.0, 0.70, 0.36], sunCol: [1.0, 0.80, 0.55], cloudShade: [0.46, 0.34, 0.42], cloudLit: [1.0, 0.72, 0.52], deep: [0.10, 0.10, 0.20] },
    skyDir: [0.42, 0.09, -0.90],
    lightDir: [0.42, 0.30, -0.86],
    sun: [0xffb070, 1.35],
    hemi: [0xb9a6c8, 0x8a6a4a, 0.5],
  },
};

/** The look of a place: the beach has a sunset in dark mode. */
export function lookFor(environment, dark = false) {
  const base = STADIUM_LOOK[environment];
  if (!base) return null;
  return dark && base.dusk ? { ...base, ...base.dusk } : base;
}

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

/** A painted canvas as a (repeating) texture. */
function canvasTexture(w, h, draw, { repeat = [1, 1] } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

/** Grain: small darker and lighter specks over what is painted already. */
function speckle(g, w, h, r, count, strength = 0.12) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${r() * strength})` : `rgba(255,255,255,${r() * strength})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3);
  }
}

/** Courses of blocks (bricks, slabs, paving): `cols` × `rows` to a tile, every other course shifted. */
function blockTexture({ base, joint, cols, rows, tones, moss = 0, seed = 1, size = 512, repeat = [1, 1] }) {
  return canvasTexture(size, size, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = joint;
    g.fillRect(0, 0, w, h);
    const bw = w / cols;
    const bh = h / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = -1; x < cols; x++) {
        const ox = (y % 2) * bw * 0.5;
        g.fillStyle = r() < 0.72 ? base : tones[Math.floor(r() * tones.length)];
        for (const dx of [0, w]) g.fillRect(x * bw + ox + 1.5 + dx - (x < 0 ? 0 : 0), y * bh + 1.5, bw - 3, bh - 3);
      }
    }
    for (let i = 0; i < moss; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = 8 + r() * 34;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(74,104,60,${0.2 + r() * 0.25})`);
      grad.addColorStop(1, 'rgba(74,104,60,0)');
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    speckle(g, w, h, r, 5000);
  }, { repeat });
}

/** A soft round glow, for the lamps. */
function glowTexture() {
  return canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
}

/** A shape turned round the middle of the field from its outline: [[radius, height], …]. */
function lathe(profile, material, { segments = 96, shadow = false } = {}) {
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments), material);
  mesh.receiveShadow = shadow;
  return mesh;
}

function ring(inner, outer, y, material, { segments = 96, shadow = false } = {}) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, segments, 1), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = shadow;
  return mesh;
}

function disc(radius, y, material, { segments = 96, shadow = true } = {}) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, segments), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = shadow;
  return mesh;
}

/** Rows of seats as steps: returns the outline for lathe() and where each row's seats are. */
function steps(r0, y0, rows, depth, rise) {
  const profile = [[r0, y0]];
  const seats = [];
  for (let i = 0; i < rows; i++) {
    profile.push([r0 + i * depth, y0 + (i + 1) * rise], [r0 + (i + 1) * depth, y0 + (i + 1) * rise]);
    seats.push({ r: r0 + (i + 0.55) * depth, y: y0 + (i + 1) * rise });
  }
  return { profile, seats, endR: r0 + rows * depth, endY: y0 + rows * rise };
}

const SHIRTS = [0xd84a4a, 0x3f7fd8, 0xe8c64a, 0x58b368, 0xf0f0f0, 0x2c2f3a, 0xe58a3c, 0x9a62c8, 0x4ac0c8, 0xd86a9a];

/**
 * The crowd: one small box per spectator on the rows, in shirt colours, bobbing a little (each on
 * its own beat, in the vertex shader). `gap(angle)` leaves the aisles, tunnels and pillars free.
 */
function crowd(seats, { seed = 7, spacing = 0.62, size = 0.36, fill = 0.86, gap = null, time, dim = 1 }) {
  const r = rng(seed);
  const spots = [];
  for (const row of seats) {
    const n = Math.floor((Math.PI * 2 * row.r) / spacing);
    for (let i = 0; i < n; i++) {
      const a = ((i + r() * 0.3) / n) * Math.PI * 2;
      if (r() > fill || gap?.(a)) continue;
      spots.push([a, row.r, row.y]);
    }
  }
  // Shuffled, so showing only the first part of them (lower graphics settings) thins the crowd evenly.
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  const geo = new THREE.BoxGeometry(size, size * 1.7, size * 0.8);
  geo.translate(0, size * 0.85, 0);
  const mat = new THREE.MeshLambertMaterial();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
      `#include <begin_vertex>
       transformed.y += abs(sin(uTime * 2.6 + instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3)) * ${(size * 0.35).toFixed(3)};`);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  spots.forEach(([a, rad, y], i) => {
    q.setFromAxisAngle(up, -a + Math.PI / 2);
    const s = 0.85 + r() * 0.35;
    m.compose(new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad), q, new THREE.Vector3(s, s, s));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.setHex(SHIRTS[Math.floor(r() * SHIRTS.length)]).multiplyScalar(dim));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.userData.max = spots.length;
  return mesh;
}

/** Lamps: a bright box each, with a soft glow in front. */
function lamps(points, { glow, color = 0xffffff, size = 0.5, halo = 3.2 }) {
  const group = new THREE.Group();
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(size, size * 0.6, size), new THREE.MeshBasicMaterial({ color, fog: false }), points.length);
  const m = new THREE.Matrix4();
  points.forEach((p, i) => {
    boxes.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85, fog: false }));
    sprite.position.copy(p);
    sprite.scale.setScalar(halo);
    group.add(sprite);
  });
  boxes.instanceMatrix.needsUpdate = true;
  boxes.frustumCulled = false;
  group.add(boxes);
  return group;
}

const around = (count, radius, y, offset = 0) => Array.from({ length: count }, (_, i) => {
  const a = offset + (i / count) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);
});

/** A screen picture: the two sides' colours with "VS" between them. */
function screenTexture() {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#0c1220';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c23a32';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(w * 0.56, 0); g.lineTo(w * 0.44, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#2f5fb0';
    g.beginPath(); g.moveTo(w, 0); g.lineTo(w * 0.56, 0); g.lineTo(w * 0.44, h); g.lineTo(w, h); g.fill();
    g.strokeStyle = '#f4f6fa';
    g.lineWidth = 10;
    g.beginPath(); g.moveTo(w * 0.56, 0); g.lineTo(w * 0.44, h); g.stroke();
    g.fillStyle = '#f4f6fa';
    g.font = 'bold 110px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('VS', w / 2, h / 2 + 6);
  });
}

// ---------------------------------------------------------------------------

function nightStadium({ fieldR, time, glow, add, keep }) {
  const WALL = 21;
  const std = (opts) => keep(new THREE.MeshStandardMaterial({ roughness: 0.9, ...opts }));
  // The pitch: mown stripes, with a cyan line the Pokémon stay inside.
  const grass = keep(canvasTexture(512, 512, (g, w, h) => {
    const r = rng(31);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#468a2c' : '#55a034';
      g.fillRect(0, (i * h) / 8, w, h / 8);
    }
    speckle(g, w, h, r, 14000, 0.1);
  }, { repeat: [5, 5] }));
  add(disc(WALL - 4, 0, std({ map: grass, roughness: 0.96 })));
  add(ring(fieldR + 1.38, fieldR + 1.5, 0.014, new THREE.MeshBasicMaterial({ color: 0x7cf2f2 })));
  add(ring(WALL - 4, WALL, 0.004, std({ color: 0x2e3236 }), { shadow: true }));
  // The wall with its lit boards, then two tiers of stands with a walkway between them.
  const boards = keep(canvasTexture(1024, 64, (g, w, h) => {
    const cols = ['#e0609e', '#4a8cf0', '#7cf2f2', '#f4f6fa', '#e8c64a'];
    for (let i = 0; i < 16; i++) {
      g.fillStyle = '#141a22';
      g.fillRect((i * w) / 16, 0, w / 16, h);
      g.fillStyle = cols[i % cols.length];
      g.fillRect((i * w) / 16 + 6, 14, w / 16 - 12, h - 28);
    }
  }, { repeat: [6, 1] }));
  add(lathe([[WALL, 0], [WALL, 2.2], [WALL + 0.5, 2.2]], std({ color: 0x2b5a66, side: THREE.DoubleSide })));
  add(lathe([[WALL - 0.02, 0.5], [WALL - 0.02, 1.7]], new THREE.MeshBasicMaterial({ map: boards, side: THREE.DoubleSide })));
  const concrete = std({ color: 0x39434a, side: THREE.DoubleSide });
  const lower = steps(WALL + 0.5, 2.2, 12, 0.82, 0.55);
  add(lathe(lower.profile, concrete));
  add(lathe([[lower.endR, lower.endY], [lower.endR + 4, lower.endY], [lower.endR + 4, lower.endY + 1.6]], std({ color: 0x3a444a, side: THREE.DoubleSide })));
  const upper = steps(lower.endR + 4, lower.endY + 1.6, 8, 0.82, 0.6);
  add(lathe(upper.profile, concrete));
  const aisle = (a) => Math.abs(((a * 12) / (Math.PI * 2)) % 1 - 0.5) > 0.46;
  const people = crowd([...lower.seats, ...upper.seats], { seed: 11, time, gap: aisle, dim: 0.7 });
  add(people);
  // A strip of pink light over the stands, then the roof ring with the floodlights at its edge.
  const strip = keep(canvasTexture(64, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#5a2a52');
    grad.addColorStop(0.5, '#e0609e');
    grad.addColorStop(1, '#6a2f5c');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(20,10,30,0.55)';
    g.fillRect(0, 0, 5, h);
  }, { repeat: [72, 1] }));
  add(lathe([[upper.endR + 0.4, upper.endY], [upper.endR + 0.4, upper.endY + 5]], new THREE.MeshBasicMaterial({ map: strip, side: THREE.DoubleSide })));
  const roofY = upper.endY + 5;
  add(lathe([[upper.endR + 0.4, roofY], [upper.endR + 1.5, roofY + 2.6], [WALL + 7.5, roofY - 0.4], [WALL + 7.9, roofY - 1.1], [upper.endR + 0.4, roofY]], std({ color: 0x1c2a30, side: THREE.DoubleSide, roughness: 0.7 })));
  add(lamps(around(36, WALL + 7.6, roofY - 1.3), { glow, color: 0xf2f6ff, size: 0.55, halo: 4.2 }));
  return { crowd: people };
}

function floatingStadium({ fieldR, time, glow, add, keep }) {
  const PLAT = Math.max(11.5, fieldR + 4.6);
  const PIT = 40;
  const WATER = -31;
  const std = (opts) => keep(new THREE.MeshStandardMaterial({ roughness: 0.85, ...opts }));
  // The deck: plating in panels, on stacked layers of white and grey with a red band.
  const plating = keep(canvasTexture(512, 512, (g, w, h) => {
    const r = rng(41);
    g.fillStyle = '#8f97a1';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        g.fillStyle = r() < 0.3 ? '#98a0aa' : '#aab1ba';
        g.fillRect(x * 128 + 2, y * 128 + 2, 124, 124);
      }
    }
    speckle(g, w, h, r, 6000, 0.08);
  }, { repeat: [4, 4] }));
  const octagon = (radius, height, y, material) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 8, 1), material);
    mesh.rotation.y = Math.PI / 8;
    mesh.position.y = y - height / 2;
    mesh.receiveShadow = true;
    return mesh;
  };
  const deck = octagon(PLAT, 0.5, 0, [std({ color: 0xe6e9ed }), std({ map: plating, roughness: 0.7 }), std({ color: 0x70767e })]);
  add(deck);
  const edge = new THREE.Mesh(new THREE.RingGeometry(PLAT * 0.955, PLAT * 0.97, 8, 1), new THREE.MeshBasicMaterial({ color: 0x7cf2f2 }));
  edge.rotation.set(-Math.PI / 2, 0, Math.PI / 8);
  edge.position.y = 0.012;
  add(edge);
  add(octagon(PLAT - 0.5, 0.4, -0.5, std({ color: 0xc23a32 })));
  add(octagon(PLAT - 1.3, 0.9, -0.9, std({ color: 0xdfe3e8 })));
  add(octagon(PLAT - 2.6, 1.1, -1.8, std({ color: 0x8a9098 })));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(PLAT - 3.4, 5.5, 3.2, 24, 1), std({ color: 0x5a6068 }));
  neck.position.y = -2.9 - 1.6;
  add(neck);
  // The pillar, down to the water at the bottom of the pit, with rings of light.
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, -WATER - 6.1, 32, 1), std({ color: 0x343a44, roughness: 0.6 }));
  pillar.position.y = (WATER - 6.1) / 2;
  add(pillar);
  for (let y = -9; y > WATER + 2; y -= 5.5) add(lathe([[5.56, y], [5.56, y + 0.22]], new THREE.MeshBasicMaterial({ color: 0x4a8cf0, side: THREE.DoubleSide }), { segments: 48 }));
  add(disc(PIT, WATER, std({ color: 0x0a1826, roughness: 0.2, metalness: 0.6 }), { shadow: false }));
  add(lathe([[PIT, WATER], [PIT, -18]], std({ color: 0x161c26, side: THREE.DoubleSide })));
  // The stands start far away and below the deck; between them and it, the void.
  const bowl = steps(PIT, -18, 22, 0.9, 0.85);
  add(lathe(bowl.profile, std({ color: 0x2c3440, side: THREE.DoubleSide })));
  add(lathe([[bowl.endR, bowl.endY], [bowl.endR, bowl.endY + 3.4], [bowl.endR + 1.2, bowl.endY + 3.4], [bowl.endR + 1.2, -22]], std({ color: 0x1c222c, side: THREE.DoubleSide })));
  const aisle = (a) => Math.abs(((a * 16) / (Math.PI * 2)) % 1 - 0.5) > 0.45;
  const people = crowd(bowl.seats, { seed: 23, spacing: 0.95, size: 0.55, time, gap: aisle, dim: 0.55 });
  add(people);
  add(ring(bowl.endR + 1.2, 420, -22, std({ color: 0x0c1016 }), { segments: 48 }));
  // Floodlights on masts round the pit, at the deck's height.
  const masts = around(8, PIT - 5, 9.5, Math.PI / 8);
  const mastMat = std({ color: 0x20262e });
  for (const p of masts) {
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9.5 - WATER, 0.7), mastMat);
    mast.position.set(p.x, (9.5 + WATER) / 2, p.z);
    add(mast);
  }
  add(lamps(masts.flatMap((p) => [-1, 0, 1].map((k) => new THREE.Vector3(p.x - p.z * 0.035 * k, p.y + 0.3, p.z + p.x * 0.035 * k))), { glow, color: 0xf2f6ff, size: 0.7, halo: 6 }));
  // Behind (where the battle camera looks): the giant screen, then a city and mountains.
  const screenAt = new THREE.Vector3(9, 8, -66);
  const block = new THREE.Mesh(new THREE.BoxGeometry(36, 20, 3), std({ color: 0x10141c }));
  block.position.copy(screenAt);
  block.lookAt(0, 8, 0);
  add(block);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(32, 16), new THREE.MeshBasicMaterial({ map: keep(screenTexture()), fog: false }));
  screen.position.copy(screenAt).addScaledVector(new THREE.Vector3(-screenAt.x, 0, -screenAt.z).normalize(), 1.6);
  screen.lookAt(0, 8, 0);
  add(screen);
  const windows = keep(canvasTexture(64, 128, (g, w, h) => {
    const r = rng(53);
    g.fillStyle = '#0a0e16';
    g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 8) for (let x = 4; x < w; x += 8) {
      if (r() < 0.45) continue;
      g.fillStyle = r() < 0.8 ? '#f2d98a' : '#9fd0ff';
      g.fillRect(x, y, 4, 4);
    }
  }));
  const cr = rng(61);
  const towerGeo = new THREE.BoxGeometry(1, 1, 1);
  const city = new THREE.InstancedMesh(towerGeo, new THREE.MeshBasicMaterial({ map: windows }), 90);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 90; i++) {
    const a = cr() * Math.PI * 2;
    const d = 95 + cr() * 60;
    const hgt = 10 + cr() * 34;
    const wid = 6 + cr() * 8;
    m.compose(new THREE.Vector3(Math.cos(a) * d, -22 + hgt / 2, Math.sin(a) * d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), cr() * Math.PI), new THREE.Vector3(wid, hgt, wid));
    city.setMatrixAt(i, m);
  }
  city.instanceMatrix.needsUpdate = true;
  city.frustumCulled = false;
  add(city);
  const peaks = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6, 1), new THREE.MeshBasicMaterial({ color: 0x0b0f1c }), 40);
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2 + cr() * 0.1;
    const d = 230 + cr() * 60;
    const hgt = 30 + cr() * 45;
    m.compose(new THREE.Vector3(Math.cos(a) * d, -22 + hgt / 2, Math.sin(a) * d), new THREE.Quaternion(), new THREE.Vector3(60 + cr() * 50, hgt, 60 + cr() * 50));
    peaks.setMatrixAt(i, m);
  }
  peaks.instanceMatrix.needsUpdate = true;
  peaks.frustumCulled = false;
  add(peaks);
  return { crowd: people };
}

function leagueStadium({ fieldR, time, add, keep }) {
  const WALL = 20;
  const SECTIONS = 14;
  const std = (opts) => keep(new THREE.MeshStandardMaterial({ roughness: 0.92, ...opts }));
  // The field: big slabs of pale stone; round it, grey-green paving to the wall.
  const slabs = keep(blockTexture({ base: '#c9ac86', joint: '#a88a68', cols: 3, rows: 4, tones: ['#b39572', '#d2b792', '#bfa27c'], seed: 71, repeat: [3, 3] }));
  const paving = keep(blockTexture({ base: '#727d72', joint: '#59625a', cols: 6, rows: 8, tones: ['#8a958a', '#677267', '#7b877a'], moss: 26, seed: 73, repeat: [9, 9] }));
  add(disc(WALL, 0, std({ map: paving })));
  add(disc(fieldR + 0.45, 0.001, std({ map: slabs, roughness: 0.95 })));
  // The wall of grey bricks, with a banner in each side's colour and the tunnels people come in through.
  const bricks = keep(blockTexture({ base: '#8f948d', joint: '#636861', cols: 4, rows: 6, tones: ['#6f756d', '#9a9f97', '#858b82'], moss: 14, seed: 77, repeat: [44, 1.6] }));
  const stone = std({ color: 0x8f948d, side: THREE.DoubleSide });
  add(lathe([[WALL, 0], [WALL, 3.2]], std({ map: bricks, side: THREE.DoubleSide })));
  add(lathe([[WALL, 3.2], [WALL + 0.6, 3.2]], std({ color: 0x6f756d, side: THREE.DoubleSide })));
  const stands = steps(WALL + 0.6, 3.2, 11, 0.85, 0.5);
  add(lathe(stands.profile, stone));
  // Sections split by pillars: one at the wall and a taller one at the back, a low wall between them.
  const pillarMat = std({ color: 0x7c827a });
  const capMat = std({ color: 0x4f6a5c, roughness: 0.6, metalness: 0.3 });
  const run = stands.endR - WALL;
  const rise = stands.endY - 3.2;
  for (let i = 0; i < SECTIONS; i++) {
    const a = ((i + 0.5) / SECTIONS) * Math.PI * 2;
    const spoke = new THREE.Group();
    spoke.rotation.y = -a;
    const front = new THREE.Mesh(new THREE.BoxGeometry(1.1, 5.2, 1.1), pillarMat);
    front.position.set(WALL + 0.3, 2.6, 0);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 1.4), capMat);
    cap.position.set(WALL + 0.3, 5.35, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.3, stands.endY + 4.6, 1.3), pillarMat);
    back.position.set(stands.endR + 0.5, (stands.endY + 4.6) / 2, 0);
    const backCap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.35, 1.6), capMat);
    backCap.position.set(stands.endR + 0.5, stands.endY + 4.78, 0);
    const divider = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(run, rise), 0.9, 0.5), pillarMat);
    divider.position.set(WALL + run / 2 + 0.3, 3.2 + rise / 2 + 0.55, 0);
    divider.rotation.z = Math.atan2(rise, run);
    // A flag on each back pillar, red and blue in turn.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), capMat);
    pole.position.set(stands.endR + 0.5, stands.endY + 6.5, 0);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.05), new THREE.MeshLambertMaterial({ color: i % 2 ? 0x2f5fb0 : 0xc23a32, side: THREE.DoubleSide }));
    flag.position.set(stands.endR + 0.5, stands.endY + 7.5, 0.9);
    flag.rotation.y = Math.PI / 2;
    spoke.add(front, cap, back, backCap, divider, pole, flag);
    add(spoke);
    // Between pillars: a banner on the wall, or (every other section) a dark tunnel mouth.
    const mid = (i / SECTIONS) * Math.PI * 2;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(i % 2 ? 1.5 : 2.2, i % 2 ? 2.2 : 2.5),
      i % 2 ? new THREE.MeshLambertMaterial({ color: i % 4 === 1 ? 0xc23a32 : 0x2f5fb0 }) : new THREE.MeshBasicMaterial({ color: 0x14171a }));
    face.position.set(Math.cos(mid) * (WALL - 0.04), i % 2 ? 1.85 : 1.25, Math.sin(mid) * (WALL - 0.04));
    face.lookAt(0, face.position.y, 0);
    add(face);
  }
  const pillarGap = (a) => Math.abs(((a * SECTIONS) / (Math.PI * 2)) % 1 - 0.5) < 0.06;
  const people = crowd(stands.seats, { seed: 83, time, gap: pillarGap });
  add(people);
  // The wall behind the stands, the ground outside, and the scoreboard on its own tower.
  add(lathe([[stands.endR, stands.endY], [stands.endR, stands.endY + 3.6], [stands.endR + 1, stands.endY + 3.6], [stands.endR + 1, 0]], std({ map: bricks, side: THREE.DoubleSide })));
  add(ring(stands.endR + 1, 420, -0.02, std({ color: 0x6f7a62 }), { segments: 48 }));
  const towerAt = new THREE.Vector3(11, 0, -37);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(6, 24, 4.5), std({ map: keep(blockTexture({ base: '#8f948d', joint: '#636861', cols: 4, rows: 6, tones: ['#6f756d', '#9a9f97'], moss: 10, seed: 79, repeat: [2, 8] })) }));
  tower.position.copy(towerAt).setY(12);
  tower.lookAt(0, 12, 0);
  const board = new THREE.Mesh(new THREE.BoxGeometry(15, 8, 1.6), std({ color: 0x2a3030 }));
  board.position.copy(towerAt).setY(21);
  board.lookAt(0, 21, 0);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 6.8), new THREE.MeshBasicMaterial({ map: keep(screenTexture()) }));
  screen.position.copy(towerAt).setY(21).addScaledVector(new THREE.Vector3(-towerAt.x, 0, -towerAt.z).normalize(), 0.85);
  screen.lookAt(0, 21, 0);
  add(tower);
  add(board);
  add(screen);
  return { crowd: people };
}

// ---------------------------------------------------------------------------
// Tropical Beach: an island of pale sand in a turquoise sea, palms swaying over the field and
// throwing their shadows on it, a rowing boat, driftwood, rocks, a pier with a lamp, and buoys.

const hash2 = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v) + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
}
const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const WATER_LEVEL = -0.45;
/** Where the sea meets the sand, by direction (the same formula is in the water's shader). */
export const shoreRadius = (angle) => 15.5 + Math.sin(angle * 3 + 0.6) * 1.6 + Math.sin(angle * 5 + 2.1) * 0.7;
/** Height of the sand at (x, z): flat on the field, low dunes round it, sloping into the sea. */
export function beachHeight(x, z, fieldR) {
  const r = Math.hypot(x, z);
  const shore = shoreRadius(Math.atan2(z, x));
  const dunes = (fbm(x * 0.22 + 7, z * 0.22 + 3) - 0.35) * 0.9 * smooth(fieldR + 1, fieldR + 4.5, r) * (1 - smooth(shore - 4, shore - 1, r));
  const slope = r > shore - 4 ? -(r - (shore - 4)) * (-WATER_LEVEL / 4) : 0;
  return Math.max(-6, Math.max(0, dunes) + slope);
}

/** A palm: a leaning, tapering trunk and a crown of drooping fronds that sway (uTime). */
function palm({ height, lean, seed, trunkMat, frondMat, frondDepth }) {
  const r = rng(seed);
  const group = new THREE.Group();
  const bend = new THREE.Vector3(Math.cos(lean) * height * 0.32, 0, Math.sin(lean) * height * 0.32);
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(bend.x * 0.2, height * 0.55, bend.z * 0.2), new THREE.Vector3(bend.x, height, bend.z));
  const trunkGeo = new THREE.TubeGeometry(curve, 14, 0.2, 7, false);
  // Taper: thinner towards the top (the tube's rings follow the curve).
  const tp = trunkGeo.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const ring = Math.floor(i / 8);
    const c = curve.getPoint(ring / 14);
    const k = 1 - 0.5 * (ring / 14);
    tp.setXYZ(i, c.x + (tp.getX(i) - c.x) * k, c.y + (tp.getY(i) - c.y) * k, c.z + (tp.getZ(i) - c.z) * k);
  }
  trunkGeo.computeVertexNormals();
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.castShadow = true;
  group.add(trunk);
  const top = curve.getPoint(1);
  const fronds = 9 + Math.floor(r() * 3);
  for (let i = 0; i < fronds; i++) {
    const len = height * (0.62 + r() * 0.16);
    const geo = new THREE.PlaneGeometry(len, len * 0.3, 10, 1);
    geo.translate(len / 2, 0, 0);
    geo.rotateX(Math.PI / 2); // lay it flat: its length along x, its width along z
    const p = geo.attributes.position;
    // It arches up a little, then droops; its edges hang lower than its rib.
    for (let v = 0; v < p.count; v++) {
      const t = p.getX(v) / len;
      p.setY(v, -t * t * len * 0.55 + t * len * 0.16 + Math.abs(p.getZ(v)) * -0.25);
    }
    geo.computeVertexNormals();
    const frond = new THREE.Mesh(geo, frondMat);
    frond.customDepthMaterial = frondDepth;
    frond.castShadow = true;
    frond.position.copy(top);
    frond.rotation.y = (i / fronds) * Math.PI * 2 + r() * 0.5;
    frond.rotation.z = (r() - 0.3) * 0.35;
    group.add(frond);
  }
  return group;
}

function beach({ fieldR, time, glow, add, keep, look }) {
  const std = (opts) => keep(new THREE.MeshStandardMaterial({ roughness: 0.95, ...opts }));
  const r = rng(131);
  // The sand: one mesh from the field out under the sea, paler where dry and darker where wet.
  const sandTex = keep(canvasTexture(512, 512, (g, w, h) => {
    const q = rng(133);
    g.fillStyle = '#efe3c6';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      const x = q() * w;
      const y = q() * h;
      const rad = 10 + q() * 50;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${q() < 0.5 ? '214,196,160' : '250,242,222'},${0.10 + q() * 0.16})`);
      grad.addColorStop(1, 'rgba(230,214,180,0)');
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    speckle(g, w, h, q, 26000, 0.1);
  }, { repeat: [1, 1] }));
  const sandGeo = new THREE.RingGeometry(0.01, 46, 128, 60);
  sandGeo.rotateX(-Math.PI / 2);
  const sp = sandGeo.attributes.position;
  const uv = sandGeo.attributes.uv;
  const colors = new Float32Array(sp.count * 3);
  const dry = new THREE.Color(0xffffff);
  const wet = new THREE.Color(0xa9966f);
  const c = new THREE.Color();
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i);
    const z = sp.getZ(i);
    sp.setY(i, beachHeight(x, z, fieldR));
    uv.setXY(i, x / 7, z / 7);
    const rad = Math.hypot(x, z);
    const shore = shoreRadius(Math.atan2(z, x));
    c.copy(dry).lerp(wet, smooth(shore - 2.2, shore - 0.2, rad));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  sandGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  sandGeo.computeVertexNormals();
  const sand = new THREE.Mesh(sandGeo, std({ map: sandTex, vertexColors: true }));
  sand.receiveShadow = true;
  add(sand);

  // The sea: waves that mirror the sky and glint in the sun, turquoise in the shallows and deep blue
  // further out, with lines of foam washing up the sand.
  const sky = look.sky;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400, 1, 1), new THREE.ShaderMaterial({
    transparent: true,
    toneMapped: false,
    fog: false,
    uniforms: {
      uTime: time,
      uSunDir: { value: new THREE.Vector3(...look.skyDir).normalize() },
      uHorizon: { value: new THREE.Color(...sky.horizon) },
      uZenith: { value: new THREE.Color(...sky.zenith) },
      uSunCol: { value: new THREE.Color(...sky.sunCol) },
      uDeep: { value: new THREE.Color(...sky.deep) },
      uShallow: { value: new THREE.Color(0.20, 0.80, 0.74).lerp(new THREE.Color(...sky.horizon), look === STADIUM_LOOK.beach ? 0 : 0.45) },
      uDetail: { value: 1 },
    },
    vertexShader: `varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime, uDetail; uniform vec3 uSunDir, uHorizon, uZenith, uSunCol, uDeep, uShallow;
      varying vec3 vWorld;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), u.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), u.x), u.y); }
      float waves(vec2 p) {
        float t = uTime;
        float w = vn(p * 0.35 + vec2(t * 0.22, t * 0.13)) * 0.55 + vn(p * 0.9 - vec2(t * 0.3, -t * 0.21)) * 0.3;
        if (uDetail > 0.5) w += vn(p * 2.3 + vec2(-t * 0.5, t * 0.4)) * 0.15;
        return w;
      }
      float shoreR(float a) { return 15.5 + sin(a * 3.0 + 0.6) * 1.6 + sin(a * 5.0 + 2.1) * 0.7; }
      void main() {
        vec2 p = vWorld.xz; float r = length(p); float a = atan(p.y, p.x);
        float depth = clamp((r - shoreR(a)) / 26.0, 0.0, 1.0);
        float e = 0.35;
        float w0 = waves(p);
        vec3 n = normalize(vec3((w0 - waves(p + vec2(e, 0.0))) * 0.9, 1.0, (w0 - waves(p + vec2(0.0, e))) * 0.9));
        vec3 V = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
        n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(12.0, 110.0, dist) * 0.92)); // calm far away (no sparkle noise)
        float fres = 0.03 + 0.72 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 R = reflect(-V, n);
        vec3 skyCol = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.55));
        float s = max(dot(R, uSunDir), 0.0);
        vec3 glint = uSunCol * (pow(s, 260.0) * 2.4 + pow(s, 28.0) * 0.22);
        vec3 body = mix(uShallow, uDeep, smoothstep(0.05, 1.0, depth));
        vec3 col = mix(body, skyCol, fres) + glint;
        // Foam: two lines that wash in and out along the shore, broken up by the waves.
        float wash = sin(uTime * 0.7 + a * 4.0) * 0.012;
        float line1 = smoothstep(0.014, 0.0, abs(depth - 0.008 - wash * 0.6));
        float line2 = smoothstep(0.010, 0.0, abs(depth - 0.045 - wash * 1.2 - 0.012 * sin(uTime * 0.45 + a * 7.0)));
        float foam = clamp(line1 * 1.2 + line2 * 0.55, 0.0, 1.0) * (0.55 + 0.45 * vn(p * 3.0 + uTime * 0.3));
        col = mix(col, vec3(1.0), foam);
        col = mix(col, uHorizon, smoothstep(160.0, 900.0, dist));
        // See-through at the very edge, so the sand shows under the first centimetres.
        float alpha = clamp(0.55 + depth * 14.0 + foam, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }`,
  }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  water.renderOrder = 1;
  add(water);

  // Palms, mostly on the sun's side so their shadows fall across the sand towards the camera.
  const frondTex = keep(canvasTexture(256, 96, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#2f6b2a');
    grad.addColorStop(1, '#7fb04a');
    // A solid leaf with a saw-toothed edge (thin lines would vanish at a distance), darker along the rib.
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, h / 2);
    const teeth = 22;
    for (let i = 0; i <= teeth; i++) {
      const x = (i / teeth) * (w - 4);
      const half = (h / 2 - 2) * Math.sin(Math.PI * Math.min(1, 0.1 + (i / teeth) * 0.9)) ** 0.7;
      g.lineTo(x, h / 2 - half);
      g.lineTo(x + (w / teeth) * 0.55, h / 2 - half * 0.45);
    }
    g.lineTo(w, h / 2);
    for (let i = teeth; i >= 0; i--) {
      const x = (i / teeth) * (w - 4);
      const half = (h / 2 - 2) * Math.sin(Math.PI * Math.min(1, 0.1 + (i / teeth) * 0.9)) ** 0.7;
      g.lineTo(x + (w / teeth) * 0.55, h / 2 + half * 0.45);
      g.lineTo(x, h / 2 + half);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(30,70,28,0.7)';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w - 6, h / 2); g.stroke();
  }));
  frondTex.wrapS = frondTex.wrapT = THREE.ClampToEdgeWrapping;
  const sway = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>',
      `#include <begin_vertex>
       float sw = sin(uTime * 1.3 + position.x * 0.9 + modelMatrix[3].x * 0.7) * 0.05 * position.x;
       transformed.y += sw; transformed.z += sw * 0.6;`);
  };
  const frondMat = keep(new THREE.MeshStandardMaterial({ map: frondTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 }));
  frondMat.onBeforeCompile = sway;
  const frondDepth = keep(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: frondTex, alphaTest: 0.4 }));
  frondDepth.onBeforeCompile = sway;
  const trunkTex = keep(canvasTexture(64, 256, (g, w, h) => {
    const q = rng(137);
    g.fillStyle = '#8a7358';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 10) { g.fillStyle = `rgba(60,46,32,${0.25 + q() * 0.25})`; g.fillRect(0, y, w, 3); }
    speckle(g, w, h, q, 900, 0.14);
  }));
  const trunkMat = std({ map: trunkTex, roughness: 0.9 });
  const sunA = Math.atan2(look.lightDir[2], look.lightDir[0]);
  const spots = [[sunA - 0.25, 8.6, 3.9], [sunA + 0.35, 9.8, 3.3], [sunA + 0.9, 10.6, 4.3], [sunA - 0.85, 10.8, 3.6], [sunA + 1.6, 11.6, 3.4], [sunA + 2.6, 11.2, 4.0], [sunA - 1.7, 12.2, 3.7]];
  spots.forEach(([a, rad, height], i) => {
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    const tree = palm({ height, lean: a + Math.PI + (r() - 0.5) * 1.2, seed: 141 + i, trunkMat, frondMat, frondDepth });
    tree.position.set(x, beachHeight(x, z, fieldR), z);
    add(tree);
  });

  // Rocks, driftwood and a rowing boat pulled up on the sand.
  const rockMat = std({ color: 0x8a7f72, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const rad = fieldR + 2 + r() * 9;
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + r() * 0.5, 0), rockMat);
    rock.scale.set(1 + r() * 0.6, 0.6 + r() * 0.3, 1 + r() * 0.4);
    rock.position.set(x, beachHeight(x, z, fieldR) + 0.08, z);
    rock.rotation.y = r() * Math.PI;
    rock.castShadow = rock.receiveShadow = true;
    add(rock);
  }
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 3.4, 7), std({ color: 0xb9ab95 }));
  wood.rotation.set(Math.PI / 2, 0, 0.4);
  wood.position.set(5.2, beachHeight(5.2, -9.4, fieldR) + 0.14, -9.4);
  wood.castShadow = true;
  add(wood);
  const boat = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), std({ color: 0x2c4a6e, side: THREE.DoubleSide, roughness: 0.7 }));
  hull.scale.set(2.3, 0.7, 0.75);
  hull.castShadow = true;
  boat.add(hull);
  for (const x of [-0.9, 0.2, 1.2]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 1.25 - Math.abs(x) * 0.3), std({ color: 0xc9b48c }));
    seat.position.set(x, -0.12, 0);
    boat.add(seat);
  }
  boat.position.set(-3.2, beachHeight(-3.2, -11.6, fieldR) + 0.62, -11.6);
  boat.rotation.set(0.12, 0.5, 0.06);
  add(boat);

  // A wooden pier out over the water, with a lamp at its end, and two buoys bobbing.
  const plank = std({ color: 0x9a7a55, roughness: 0.9 });
  const pierA = sunA + 0.55;
  const pier = new THREE.Group();
  pier.rotation.y = -pierA;
  for (let d = 13.2; d < 27; d += 0.42) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.07, 1.9), plank);
    board.position.set(d, 0.32, 0);
    board.castShadow = board.receiveShadow = true;
    pier.add(board);
  }
  for (let d = 14; d < 27.5; d += 2.6) {
    for (const z of [-0.95, 0.95]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 7), plank);
      post.position.set(d, -0.4, z);
      pier.add(post);
    }
  }
  const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), std({ color: 0x2a2a2e }));
  lampPost.position.set(26.6, 1.5, 0.8);
  pier.add(lampPost);
  add(pier);
  const lampAt = new THREE.Vector3(Math.cos(pierA) * 26.6 - Math.sin(pierA) * 0.8, 2.75, Math.sin(pierA) * 26.6 + Math.cos(pierA) * 0.8);
  add(lamps([lampAt], { glow, color: 0xffe2a8, size: 0.22, halo: look === STADIUM_LOOK.beach ? 0.9 : 2.6 }));
  const buoys = [];
  for (const [a, rad] of [[pierA - 0.5, 24], [pierA + 0.65, 30]]) {
    const buoy = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 0.5, 12), std({ color: 0xd8442e, roughness: 0.6 }));
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 1.1, 8), std({ color: 0xe86a4a, roughness: 0.6 }));
    mast.position.y = 0.75;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff1c2 }));
    cap.position.y = 1.35;
    buoy.add(body, mast, cap);
    buoy.position.set(Math.cos(a) * rad, WATER_LEVEL + 0.12, Math.sin(a) * rad);
    buoy.userData.phase = a * 3;
    add(buoy);
    buoys.push(buoy);
  }
  return {
    water,
    update(seconds) {
      for (const b of buoys) {
        b.position.y = WATER_LEVEL + 0.12 + Math.sin(seconds * 1.1 + b.userData.phase) * 0.07;
        b.rotation.z = Math.sin(seconds * 0.8 + b.userData.phase) * 0.09;
      }
    },
  };
}

/** Stars for the night stadiums: points on a far sphere above the horizon (they follow the camera). */
export function starField(count = 900) {
  const r = rng(97);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const y = 0.06 + r() * 0.94;
    const k = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * k * 1100, y * 1100, Math.sin(a) * k * 1100], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdfe6ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  points.frustumCulled = false;
  points.renderOrder = -1;
  return points;
}

/**
 * Build a stadium ("night", "floating" or "league") round a field of radius `fieldR`.
 * Returns { group, update(seconds), setQuality(q), dispose() }.
 */
export function buildStadium(kind, { fieldR, look = STADIUM_LOOK[kind] }) {
  const group = new THREE.Group();
  const kept = [];
  const keep = (o) => { kept.push(o); return o; };
  const time = { value: 0 };
  const glow = keep(glowTexture());
  const add = (o) => { group.add(o); return o; };
  const make = { night: nightStadium, floating: floatingStadium, league: leagueStadium, beach }[kind];
  if (!make) throw new Error(`Unknown stadium: ${kind}`);
  const parts = make({ fieldR, time, glow, add, keep, look });
  let lively = true;
  return {
    group,
    update(seconds) {
      if (lively || parts.water) time.value = seconds; // the sea always moves
      parts.update?.(seconds);
    },
    setQuality(q) {
      // Fewer spectators on lower settings; on Basic they stand still.
      lively = q !== 'basic';
      if (parts.water) parts.water.material.uniforms.uDetail.value = q === 'basic' ? 0 : 1;
      if (parts.crowd) parts.crowd.count = Math.round(parts.crowd.userData.max * (q === 'high' ? 1 : q === 'basic' ? 0.3 : 0.6));
    },
    dispose() {
      for (const o of kept) o.dispose?.();
      group.traverse((o) => {
        o.geometry?.dispose?.();
        for (const m of [].concat(o.material ?? [])) m.dispose?.();
      });
    },
  };
}
