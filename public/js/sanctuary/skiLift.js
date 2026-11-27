// The Sanctuary's ski lift: a chairlift from the plaza's east edge up to a summit (world.js LIFT). Two
// wooden stations, steel towers, a sagging haul rope and chairs going round it. The trainer rides a chair
// up or down; from a chair high above the ground, Space drops off into the paraglider.
//
// Pure parts (tested): liftLine() places the towers so the rope clears the ground; ropeAt() and
// chairAt() say where a point of the rope, or a chair going round, is at any moment.

/** The seat's drop below the rope, and the rope's height above a station's deck (the seat at knee height). */
export const SEAT_DROP = 2.4;
export const ROPE_HEIGHT = SEAT_DROP + 0.55;
/** The two sides of the loop: up on one side of the towers, down on the other (metres from the middle). */
export const SIDE = 1.5;
/** The chairs' speed along the rope (m/s). */
export const LIFT_SPEED = 5;

/**
 * Where the rope runs from `base` to `top` ({ x, y, z } stations): its heads (the stations' bullwheels
 * and the towers' tops), placed so that the rope, sagging between them, keeps `clearance` metres of air
 * under the chairs everywhere but near the stations (high enough to jump off into the paraglider). `heightAt(x, z)`: the land. Returns { heads: [{ x, y, z, s }], length }
 * (s: distance along the line in plan). Pure.
 */
export function liftLine(base, top, heightAt, { clearance = 8, spacing = 30 } = {}) {
  const length = Math.hypot(top.x - base.x, top.z - base.z);
  const spans = Math.max(2, Math.ceil(length / spacing));
  const at = (s) => ({ x: base.x + ((top.x - base.x) * s) / length, z: base.z + ((top.z - base.z) * s) / length });
  const heads = [];
  for (let i = 0; i <= spans; i++) {
    const s = (length * i) / spans;
    const p = at(s);
    const ground = i === 0 ? base.y : i === spans ? top.y : heightAt(p.x, p.z);
    heads.push({ ...p, s, ground, y: ground + (i === 0 || i === spans ? ROPE_HEIGHT : clearance + SEAT_DROP + 2) });
  }
  // Raise the towers until the rope clears the land by `clearance` under the chairs (a few rounds: a
  // raised tower lifts the spans on both of its sides).
  for (let round = 0; round < 12; round++) {
    let raised = false;
    for (let i = 0; i < spans; i++) {
      const a = heads[i];
      const b = heads[i + 1];
      let need = 0;
      for (let k = 1; k < 16; k++) {
        const u = k / 16;
        const s = a.s + (b.s - a.s) * u;
        const p = at(s);
        const rope = a.y + (b.y - a.y) * u - sagAt(b.s - a.s, u);
        // (Near a station the chairs come down to the deck: the clearance needed grows with distance.)
        const room = Math.min(clearance, 0.5 + Math.min(s, length - s) * 0.4);
        need = Math.max(need, heightAt(p.x, p.z) + room + SEAT_DROP - rope);
      }
      if (need > 0.01) {
        // Lift whichever end is a tower (stations stay put).
        if (i > 0) { a.y += need; raised = true; }
        if (i + 1 < spans) { b.y += need; raised = true; }
      }
    }
    if (!raised) break;
  }
  return { heads, length };
}

/** How far the rope sags below the straight line, `u` (0…1) of the way along a span `span` long. */
function sagAt(span, u) {
  return span * 0.025 * 4 * u * (1 - u);
}

/** The rope's middle at distance `s` along the line (in plan): { x, y, z, heading }. Pure. */
export function ropeAt(line, s) {
  const { heads } = line;
  const t = Math.max(0, Math.min(line.length, s));
  let i = 0;
  while (i < heads.length - 2 && heads[i + 1].s < t) i++;
  const a = heads[i];
  const b = heads[i + 1];
  const u = (t - a.s) / (b.s - a.s || 1);
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u - sagAt(b.s - a.s, u),
    z: a.z + (b.z - a.z) * u,
    heading: Math.atan2(b.x - a.x, b.z - a.z), // up the line
  };
}

/**
 * Where a seat is on the rope: `s` along the line, going up (`up` true) or down. Seats going up hang on
 * one side of the towers, seats coming down on the other. { x, y, z, heading } (heading: the way the
 * seat faces, which is the way it travels). Pure.
 */
export function seatAt(line, s, up = true) {
  const r = ropeAt(line, s);
  const side = up ? SIDE : -SIDE;
  // (cos h, −sin h): across the line, level.
  return {
    x: r.x + Math.cos(r.heading) * side,
    y: r.y - SEAT_DROP,
    z: r.z - Math.sin(r.heading) * side,
    heading: up ? r.heading : r.heading + Math.PI,
  };
}

/** A chair going round the loop: `u` 0…1 (up the first half, down the second). Pure. */
export function chairAt(line, u) {
  const k = ((u % 1) + 1) % 1;
  return k < 0.5 ? seatAt(line, k * 2 * line.length, true) : seatAt(line, (1 - (k - 0.5) * 2) * line.length, false);
}

/**
 * Build the lift into `scene`. `lift`: world.js LIFT; `heightAt(x, z)`: the land; `planks`, `bark`:
 * wood.js textures ({ color, normal }). Returns { line, group, solids, update(t), dispose() } (solids:
 * [{ x, z, r }] the stations' posts and the towers' feet, to walk round).
 */
export function buildSkiLift(THREE, lift, { heightAt, planks, dark = false } = {}) {
  const line = liftLine(lift.base, lift.top, heightAt);
  const group = new THREE.Group();
  group.name = 'ski-lift';
  const owned = [];
  const keep = (x) => { owned.push(x); return x; };
  const wood = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, map: planks?.color ?? null, normalMap: planks?.normal ?? null, roughness: 0.85 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: dark ? 0x6b2b26 : 0x9b3b2e, roughness: 0.7 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.7, roughness: 0.4 }));
  const ropeMat = keep(new THREE.MeshStandardMaterial({ color: 0x2b2b2b, metalness: 0.5, roughness: 0.5 }));
  const seatMat = keep(new THREE.MeshStandardMaterial({ color: 0x1f6feb, roughness: 0.6 }));
  const solids = [];

  // The stations: a plank deck, four posts, a pitched roof and the bullwheel the rope turns round.
  const station = (s, flip) => {
    const g = new THREE.Group();
    const head = ropeAt(line, s);
    const y = heightAt(head.x, head.z);
    g.position.set(head.x, y, head.z);
    g.rotation.y = head.heading + (flip ? Math.PI : 0);
    const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(7, 0.3, 9)), wood);
    deck.position.y = 0.05;
    deck.receiveShadow = deck.castShadow = true;
    g.add(deck);
    const postGeo = keep(new THREE.CylinderGeometry(0.16, 0.2, ROPE_HEIGHT + 1.6, 8));
    for (const [px, pz] of [[-3.1, -4], [3.1, -4], [-3.1, 2.2], [3.1, 2.2]]) {
      const post = new THREE.Mesh(postGeo, wood);
      post.position.set(px, (ROPE_HEIGHT + 1.6) / 2, pz);
      post.castShadow = true;
      g.add(post);
      const w = new THREE.Vector3(px, 0, pz).applyEuler(g.rotation).add(g.position);
      solids.push({ x: w.x, z: w.z, r: 0.35 });
    }
    const roof = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.01, 6.2, 2, 4, 1)), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 1.2);
    roof.position.set(0, ROPE_HEIGHT + 2.5, -0.9);
    roof.castShadow = true;
    g.add(roof);
    const wheel = new THREE.Mesh(keep(new THREE.TorusGeometry(SIDE, 0.12, 8, 32)), steel);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(0, ROPE_HEIGHT, flip ? 1.4 : -1.4);
    g.add(wheel);
    group.add(g);
    return { group: g, wheel };
  };
  const bottom = station(0, false);
  const summit = station(line.length, true);

  // The towers: a steel mast, a crossarm and a pair of sheaves on each side.
  const mastGeo = keep(new THREE.CylinderGeometry(0.28, 0.42, 1, 10));
  const armGeo = keep(new THREE.BoxGeometry(SIDE * 2 + 1, 0.3, 0.4));
  const sheaveGeo = keep(new THREE.CylinderGeometry(0.32, 0.32, 0.18, 14));
  for (const h of line.heads.slice(1, -1)) {
    const mast = new THREE.Mesh(mastGeo, steel);
    const height = h.y - h.ground + 0.4;
    mast.scale.y = height;
    mast.position.set(h.x, h.ground + height / 2 - 0.2, h.z);
    mast.castShadow = true;
    group.add(mast);
    const arm = new THREE.Mesh(armGeo, steel);
    arm.position.set(h.x, h.y + 0.25, h.z);
    arm.rotation.y = ropeAt(line, h.s).heading + Math.PI / 2;
    group.add(arm);
    for (const side of [-1, 1]) {
      const sh = new THREE.Mesh(sheaveGeo, steel);
      const a = arm.rotation.y;
      sh.position.set(h.x + Math.sin(a) * SIDE * side, h.y + 0.05, h.z + Math.cos(a) * SIDE * side);
      sh.rotation.set(0, a, Math.PI / 2);
      group.add(sh);
    }
    solids.push({ x: h.x, z: h.z, r: 0.6 });
  }

  // The haul rope: up on one side, down on the other.
  for (const up of [true, false]) {
    const pts = [];
    for (let s = 0; s <= line.length + 0.01; s += 2) {
      const p = seatAt(line, s, up);
      pts.push(new THREE.Vector3(p.x, p.y + SEAT_DROP, p.z));
    }
    const rope = new THREE.Mesh(keep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.04, 5)), ropeMat);
    group.add(rope);
  }

  // The chairs: a hanger bar from the rope, a seat, a back and a safety bar (one shape, instanced).
  const chairGeo = (() => {
    const parts = [];
    const box = (w, hh, d, x, y, z) => { const b = new THREE.BoxGeometry(w, hh, d); b.translate(x, y, z); parts.push(b); };
    box(0.08, SEAT_DROP - 0.1, 0.08, 0, SEAT_DROP / 2 + 0.05, -0.35); // hanger
    box(1.1, 0.08, 0.55, 0, 0, 0); // seat
    box(1.1, 0.7, 0.08, 0, 0.36, -0.3); // back
    box(1.1, 0.05, 0.05, 0, 0.55, 0.35); // safety bar
    const merged = new THREE.BufferGeometry();
    // (merge by hand: positions, normals and an index)
    let count = 0;
    for (const p of parts) count += p.attributes.position.count;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const idx = [];
    let o = 0;
    for (const p of parts) {
      pos.set(p.attributes.position.array, o * 3);
      nor.set(p.attributes.normal.array, o * 3);
      for (const i of p.index.array) idx.push(i + o);
      o += p.attributes.position.count;
      p.dispose();
    }
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    merged.setIndex(idx);
    return keep(merged);
  })();
  const loop = line.length * 2;
  const count = Math.max(8, Math.round(loop / 16));
  const chairs = new THREE.InstancedMesh(chairGeo, seatMat, count);
  chairs.castShadow = true;
  chairs.frustumCulled = false;
  group.add(chairs);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();

  /** A chair of the trainer's own (the one being ridden), drawn separately so it goes with them. */
  const ridden = new THREE.Mesh(chairGeo, seatMat);
  ridden.castShadow = true;
  ridden.visible = false;
  group.add(ridden);

  return {
    line,
    group,
    solids,
    bottom: bottom.group,
    summit: summit.group,
    /** Move the chairs round to time `t` (seconds); `rider`: { s, up } of the ridden chair, or null. */
    update(t, rider = null) {
      for (let i = 0; i < count; i++) {
        const c = chairAt(line, i / count + (t * LIFT_SPEED) / loop);
        q.setFromAxisAngle(up, c.heading);
        m.compose(p.set(c.x, c.y, c.z), q, one);
        chairs.setMatrixAt(i, m);
      }
      chairs.instanceMatrix.needsUpdate = true;
      bottom.wheel.rotation.z = summit.wheel.rotation.z = (t * LIFT_SPEED) / SIDE;
      ridden.visible = Boolean(rider);
      if (rider) {
        const c = seatAt(line, rider.s, rider.up);
        ridden.position.set(c.x, c.y, c.z);
        ridden.rotation.y = c.heading;
      }
    },
    dispose() {
      group.parent?.remove(group);
      for (const x of owned) x.dispose?.();
    },
  };
}
