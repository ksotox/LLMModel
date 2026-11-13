// The three stadiums a PokéBattle can happen in besides the meadow. Their idea and layout follow
// the open-source fan game PokeBrawl (github.com/xjoje6/PokeBrawl, MIT):
//   • Night Stadium: a packed, walled stadium at night under a roof ring of floodlights, with a
//     strip of pink light over the stands and a cyan line round the field;
//   • Floating Stadium: a platform on a pillar over a deep, dark pit with water at the bottom,
//     the stands far away and below, a giant screen, and a city and mountains behind;
//   • League Stadium: a stone coliseum on a cool day: pale slabs, grey-green paving, a brick wall,
//     stone stands split by pillars, flags, and a scoreboard tower.
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
export function buildStadium(kind, { fieldR }) {
  const group = new THREE.Group();
  const kept = [];
  const keep = (o) => { kept.push(o); return o; };
  const time = { value: 0 };
  const glow = keep(glowTexture());
  const add = (o) => { group.add(o); return o; };
  const make = { night: nightStadium, floating: floatingStadium, league: leagueStadium }[kind];
  if (!make) throw new Error(`Unknown stadium: ${kind}`);
  const parts = make({ fieldR, time, glow, add, keep });
  let lively = true;
  return {
    group,
    update(seconds) {
      if (lively) time.value = seconds;
    },
    setQuality(q) {
      // Fewer spectators on lower settings; on Basic they stand still.
      lively = q !== 'basic';
      parts.crowd.count = Math.round(parts.crowd.userData.max * (q === 'high' ? 1 : q === 'basic' ? 0.3 : 0.6));
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
