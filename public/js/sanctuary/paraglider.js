// The paraglider's wing: an arched canopy of ribbed cells in two colours, its lines running down to the
// trainer's harness. It opens (inflates from a bundle), banks into turns, breathes in the wind and
// collapses on landing. The group's origin is the harness: put it at the trainer.

const SPAN = 7.2; // tip to tip along the arc
const CHORD = 2.1; // leading to trailing edge
const RISE = 5.4; // harness to wing
const CELLS = 22;

/** The canopy's surface: an arc of cells with an airfoil's camber, coloured cell by cell. */
function canopyGeometry(THREE, colours) {
  const across = CELLS * 2;
  const along = 6;
  const radius = 4.6;
  const sweep = SPAN / radius; // the arc's angle
  const pos = [];
  const col = [];
  const idx = [];
  const a = new THREE.Color(colours[0]);
  const b = new THREE.Color(colours[1]);
  for (let i = 0; i <= across; i++) {
    const u = i / across;
    const angle = (u - 0.5) * sweep;
    const cell = Math.min(CELLS - 1, Math.floor(u * CELLS));
    const c = cell % 2 ? a : b;
    // Each cell billows a little between its ribs.
    const billow = Math.sin((u * CELLS) % 1 * Math.PI) * 0.05;
    for (let j = 0; j <= along; j++) {
      const v = j / along;
      const chord = CHORD * (1 - Math.abs(u - 0.5) * 0.6); // tapering to the tips
      const camber = Math.sin(v * Math.PI) * 0.22 * (1 - v * 0.4) + billow;
      const r = radius + camber;
      pos.push(Math.sin(angle) * r, Math.cos(angle) * r - radius, (0.4 - v) * chord);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < across; i++) {
    for (let j = 0; j < along; j++) {
      const p = i * (along + 1) + j;
      idx.push(p, p + along + 1, p + 1, p + 1, p + along + 1, p + along + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A paraglider wing (`colours`: the two fabric colours). Returns { group, update(dt, { open, bank, t,
 * speed }), dispose() }: `open` true while flying (it inflates, or collapses when false), `bank` −1…1.
 */
export function buildParaglider(THREE, { colours = [0xf97316, 0xfde047] } = {}) {
  const group = new THREE.Group();
  group.name = 'paraglider';
  group.visible = false;
  const wingGeo = canopyGeometry(THREE, colours);
  const fabric = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, side: THREE.DoubleSide });
  const wing = new THREE.Mesh(wingGeo, fabric);
  wing.castShadow = true;
  const wingHolder = new THREE.Group();
  wingHolder.position.y = RISE;
  wingHolder.add(wing);
  group.add(wingHolder);

  // The lines: from points along the leading and trailing edges down to the two risers at the harness.
  const pos = wingGeo.attributes.position;
  const along = 7;
  const linePts = [];
  for (let i = 1; i < CELLS * 2; i += 4) {
    for (const j of [1, 5]) {
      const k = i * along + j;
      const side = i < CELLS ? -0.25 : 0.25;
      linePts.push(pos.getX(k), pos.getY(k) + RISE, pos.getZ(k), side, 0.9, 0);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.55 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  group.add(lines);

  let inflate = 0;
  let roll = 0;
  return {
    group,
    update(dt, { open = false, bank = 0, t = 0, speed = 0 } = {}) {
      inflate += ((open ? 1 : 0) - inflate) * Math.min(1, dt * (open ? 2.2 : 4));
      group.visible = inflate > 0.02;
      if (!group.visible) return;
      // Inflating: the bundle spreads out and rises over the harness.
      wing.scale.set(0.25 + inflate * 0.75, 0.4 + inflate * 0.6, 1);
      wingHolder.position.y = RISE * (0.35 + inflate * 0.65);
      lines.scale.set(0.25 + inflate * 0.75, 0.35 + inflate * 0.65, 1);
      // Banking into turns (the wing swings out over the turn), pitching a touch with speed, breathing.
      roll += (bank * 0.5 - roll) * Math.min(1, dt * 3);
      group.rotation.z = -roll;
      wingHolder.rotation.x = -0.06 - (speed - 9) * 0.01 + Math.sin(t * 1.3) * 0.015;
      wing.position.y = Math.sin(t * 2.1) * 0.04;
    },
    dispose() {
      group.parent?.remove(group);
      wingGeo.dispose();
      fabric.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    },
  };
}
