// A skeleton for models that come without one (Snorlax, Ponyta, Magmar, Onix in the Pokémon 3D API; a
// trainer exported as a plain mesh), so they can walk, swing their arms, flap or slither like the rest.
// The bones are placed from the model's own shape and every vertex is tied to the bones nearest its
// part of the body, blending softly where parts meet. Bone names follow the game rigs ("LThigh",
// "RArm", "Spine1", "Tail1"…), so creature/animate.js and sanctuary/rig.js drive them as usual.
//
// rigLayout() and its assign() are pure (tested in Node); autoRig() does the three.js part.

import * as THREE from 'three';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Where the bones go, and how a point is tied to them. `box` is the model's bounds { minX, maxX, minY,
 * maxY, minZ, maxZ } in its own frame (standing on y = minY, facing +Z, its left at +X); `mode` is its
 * body plan's movement ('walk', 'quad', 'slither', 'swim', 'fly', 'hover', 'hop'); `torso` is the
 * half-width of its chest and `span` how far its arms reach out (from the vertices, see measure()).
 * Returns { bones: [{ name, parent, at: [x, y, z] }], assign(x, y, z) → [[bone, weight], …] (weights sum 1) }.
 */
export function rigLayout(box, mode, { torso = null, span = null } = {}) {
  const h = box.maxY - box.minY;
  const y0 = box.minY;
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  const halfW = (box.maxX - box.minX) / 2;
  const bones = [];
  const add = (name, parent, at) => { bones.push({ name, parent, at }); return bones.length - 1; };
  const idx = (name) => bones.findIndex((b) => b.name === name);

  if (mode === 'slither' || mode === 'swim') {
    // A chain along the body's long side, from the head (front) to the tail.
    const alongZ = box.maxZ - box.minZ >= box.maxX - box.minX;
    const lo = alongZ ? box.minZ : box.minX;
    const hi = alongZ ? box.maxZ : box.maxX;
    const names = ['Head', 'Spine1', 'Spine2', 'Spine3', 'Tail1', 'Tail2', 'Tail3'];
    const yMid = y0 + h * 0.45;
    names.forEach((name, i) => {
      const u = hi - ((i + 0.5) / names.length) * (hi - lo);
      add(name, i === 0 ? -1 : i - 1, alongZ ? [cx, yMid, u] : [u, yMid, cz]);
    });
    // The chain is rooted at the head; turn it so the middle carries the rest (Spine1 as root).
    return {
      bones,
      assign(x, y, z) {
        const u = alongZ ? z : x;
        const f = ((hi - u) / Math.max(1e-6, hi - lo)) * names.length - 0.5; // 0 at the head … n-1 at the tail
        const i = Math.max(0, Math.min(names.length - 1, Math.floor(f)));
        const j = Math.min(names.length - 1, i + 1);
        const t = Math.max(0, Math.min(1, f - i));
        return i === j ? [[i, 1]] : [[i, 1 - t], [j, t]];
      },
    };
  }

  if (mode === 'quad') {
    const L = box.maxZ - box.minZ;
    const legTop = y0 + h * 0.42;
    const knee = y0 + h * 0.2;
    const sideX = Math.max(halfW * 0.5, 1e-3);
    const front = box.maxZ - L * 0.28;
    const back = box.minZ + L * 0.28;
    const hips = add('Hips', -1, [cx, y0 + h * 0.55, back]);
    const spine = add('Spine1', hips, [cx, y0 + h * 0.58, cz]);
    add('Head', spine, [cx, y0 + h * 0.75, box.maxZ - L * 0.15]);
    add('Tail1', hips, [cx, y0 + h * 0.55, box.minZ + L * 0.08]);
    for (const [s, side] of [['L', 1], ['R', -1]]) {
      const arm = add(`${s}Arm`, spine, [cx + side * sideX, legTop, front]);
      add(`${s}ForeArm`, arm, [cx + side * sideX, knee, front]);
      const thigh = add(`${s}Thigh`, hips, [cx + side * sideX, legTop, back]);
      add(`${s}Leg`, thigh, [cx + side * sideX, knee, back]);
    }
    return {
      bones,
      assign(x, y, z) {
        const side = x >= cx ? 'L' : 'R';
        const isFront = z >= cz;
        const legW = 1 - smooth(legTop - h * 0.04, legTop + h * 0.06, y); // 1 down in the legs
        const upper = isFront ? idx(`${side}Arm`) : idx(`${side}Thigh`);
        const lower = isFront ? idx(`${side}ForeArm`) : idx(`${side}Leg`);
        const kneeW = 1 - smooth(knee - h * 0.04, knee + h * 0.04, y);
        let body;
        if (z > box.maxZ - L * 0.3 && y > y0 + h * 0.5) body = [[idx('Head'), smooth(box.maxZ - L * 0.36, box.maxZ - L * 0.26, z)], [spine, 0]];
        else if (z < box.minZ + L * 0.16) body = [[idx('Tail1'), smooth(box.minZ + L * 0.2, box.minZ + L * 0.1, z)], [hips, 0]];
        else body = [[isFront ? spine : hips, 1]];
        if (body.length === 2) body[1][1] = 1 - body[0][1];
        const leg = [[lower, kneeW], [upper, 1 - kneeW]];
        return normalise([...leg.map(([b, w]) => [b, w * legW]), ...body.map(([b, w]) => [b, w * (1 - legW)])]);
      },
    };
  }

  // Upright bodies (and anything else): hips, spine, head, two legs, two arms; flyers get wings too.
  const tw = Math.max(torso ?? halfW * 0.45, 1e-3);
  const reachX = Math.max(span ?? halfW, tw * 1.2);
  const hip = y0 + h * 0.45;
  const knee = y0 + h * 0.22;
  const shoulder = y0 + h * 0.74;
  const neck = y0 + h * 0.83;
  const hips = add('Hips', -1, [cx, hip, cz]);
  const spine = add('Spine1', hips, [cx, y0 + h * 0.62, cz]);
  add('Head', spine, [cx, neck, cz]);
  for (const [s, side] of [['L', 1], ['R', -1]]) {
    const thigh = add(`${s}Thigh`, hips, [cx + side * tw * 0.5, hip, cz]);
    add(`${s}Leg`, thigh, [cx + side * tw * 0.5, knee, cz]);
    const arm = add(mode === 'fly' ? `${s}Wing1` : `${s}Arm`, spine, [cx + side * tw, shoulder, cz]);
    add(mode === 'fly' ? `${s}Wing2` : `${s}ForeArm`, arm, [cx + side * lerp(tw, reachX, 0.5), shoulder, cz]);
  }
  const armName = (s) => (mode === 'fly' ? `${s}Wing1` : `${s}Arm`);
  const foreName = (s) => (mode === 'fly' ? `${s}Wing2` : `${s}ForeArm`);
  return {
    bones,
    assign(x, y, z) {
      const side = x >= cx ? 'L' : 'R';
      const ax = Math.abs(x - cx);
      // Arms: out beyond the chest, above the hips.
      const out = smooth(tw * 1.05, tw * 1.3, ax) * smooth(hip + h * 0.08, hip + h * 0.16, y);
      if (out > 0) {
        const elbow = lerp(tw, reachX, 0.5);
        const fore = smooth(elbow - (reachX - tw) * 0.1, elbow + (reachX - tw) * 0.1, ax);
        const torsoBone = y > neck ? idx('Head') : spine;
        return normalise([[idx(foreName(side)), out * fore], [idx(armName(side)), out * (1 - fore)], [torsoBone, 1 - out]]);
      }
      // Legs: below the hips.
      const legW = 1 - smooth(hip - h * 0.03, hip + h * 0.05, y);
      const kneeW = 1 - smooth(knee - h * 0.04, knee + h * 0.04, y);
      const headW = smooth(neck - h * 0.03, neck + h * 0.03, y);
      const spineW = smooth(hip + h * 0.02, hip + h * 0.12, y);
      const body = [[idx('Head'), headW], [spine, spineW * (1 - headW)], [hips, (1 - spineW) * (1 - headW)]];
      return normalise([
        [idx(`${side}Leg`), legW * kneeW], [idx(`${side}Thigh`), legW * (1 - kneeW)],
        ...body.map(([b, w]) => [b, w * (1 - legW)]),
      ]);
    },
  };
}

/** Up to four [bone, weight] pairs, heaviest first, summing to 1. */
function normalise(pairs) {
  const merged = new Map();
  for (const [b, w] of pairs) if (b >= 0 && w > 1e-4) merged.set(b, (merged.get(b) ?? 0) + w);
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  return top.map(([b, w]) => [b, w / sum]);
}

/**
 * The chest's half-width and the arms' reach, from vertex positions (in the model's frame): the body's
 * width at the belly (85% of its points are closer in), and the furthest points at shoulder height. Pure.
 */
export function measure(points, box) {
  const h = box.maxY - box.minY;
  const cx = (box.minX + box.maxX) / 2;
  // The chest's width, measured at the belly (below the shoulders: arms held out in a T-pose aren't there);
  // the arms' reach, at shoulder height.
  const belly = [];
  const shoulders = [];
  for (const [x, y] of points) {
    if (y > box.minY + h * 0.45 && y < box.minY + h * 0.62) belly.push(Math.abs(x - cx));
    if (y > box.minY + h * 0.55 && y < box.minY + h * 0.85) shoulders.push(Math.abs(x - cx));
  }
  if (!belly.length) return { torso: null, span: null };
  belly.sort((a, b) => a - b);
  return { torso: belly[Math.floor(belly.length * 0.85)], span: shoulders.length ? Math.max(...shoulders) : null };
}

/**
 * Give a model with no skeleton one (in place). `object` is modelLoader.loadModel's result.object;
 * `mode` its body plan's movement. Returns true when a skeleton was added.
 */
export function autoRig(object, mode) {
  let rigged = false;
  object.traverse((o) => { if (o.isBone || o.isSkinnedMesh) rigged = true; });
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  if (rigged || !meshes.length) return false;
  object.updateMatrixWorld(true);
  const toObject = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const v = new THREE.Vector3();
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const sample = [];
  const local = meshes.map((mesh) => {
    const pos = mesh.geometry.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(toObject, mesh.matrixWorld);
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      out.set([v.x, v.y, v.z], i * 3);
      box.minX = Math.min(box.minX, v.x); box.maxX = Math.max(box.maxX, v.x);
      box.minY = Math.min(box.minY, v.y); box.maxY = Math.max(box.maxY, v.y);
      box.minZ = Math.min(box.minZ, v.z); box.maxZ = Math.max(box.maxZ, v.z);
      if (i % 3 === 0) sample.push([v.x, v.y]);
    }
    return out;
  });
  const layout = rigLayout(box, mode, measure(sample, box));
  // The bones live under the model's root, so whole-body motion carries them along.
  const root = object.children[0] ?? object;
  const bones = layout.bones.map((b) => Object.assign(new THREE.Bone(), { name: b.name }));
  layout.bones.forEach((b, i) => {
    const parent = b.parent >= 0 ? bones[b.parent] : root;
    parent.add(bones[i]);
    parent.updateMatrixWorld(true);
    const world = object.localToWorld(new THREE.Vector3(...b.at));
    bones[i].position.copy(parent.worldToLocal(world));
    bones[i].updateMatrixWorld(true);
  });
  const skeleton = new THREE.Skeleton(bones);
  meshes.forEach((mesh, k) => {
    const geometry = mesh.geometry.clone();
    const count = geometry.attributes.position.count;
    const index = new Uint16Array(count * 4);
    const weight = new Float32Array(count * 4);
    const p = local[k];
    for (let i = 0; i < count; i++) {
      layout.assign(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).forEach(([b, w], n) => { index[i * 4 + n] = b; weight[i * 4 + n] = w; });
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
    Object.assign(skinned, { name: mesh.name, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, frustumCulled: mesh.frustumCulled, renderOrder: mesh.renderOrder });
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    mesh.parent.add(skinned);
    mesh.parent.remove(mesh);
    skinned.updateMatrixWorld(true);
    skinned.bind(skeleton, skinned.matrixWorld);
  });
  object.userData.autoRigged = true;
  return true;
}
