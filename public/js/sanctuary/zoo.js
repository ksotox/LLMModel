// The Sanctuary's zoo: where each of your Pokémon lives, and how it behaves. Pure (no DOM, no
// three.js): the page draws what these functions decide, and the tests run them in Node.
//
// One creature per different Pokémon in your collection, in the habitat of its card's type.

/** Habitats on the meadow: a centre, a radius, and what the page calls it. */
export const HABITATS = [
  { id: 'shore', name: 'Lake shore', types: ['Water'], x: 27, z: -21, r: 17, ring: 12.5 },
  { id: 'woods', name: 'Woods', types: ['Grass'], x: -34, z: -8, r: 13 },
  { id: 'rocks', name: 'Warm rocks', types: ['Fire'], x: 30, z: 24, r: 11 },
  { id: 'plain', name: 'Open plain', types: ['Lightning'], x: 2, z: 34, r: 13 },
  { id: 'ruins', name: 'Old ruins', types: ['Psychic'], x: -13, z: -22, r: 10 },
  { id: 'ridge', name: 'Stony ridge', types: ['Fighting', 'Metal'], x: -4, z: -44, r: 11 },
  { id: 'dusk', name: 'Shady hollow', types: ['Darkness', 'Dragon', 'Fairy'], x: -32, z: 26, r: 11 },
  { id: 'meadow', name: 'Meadow', types: ['Colorless'], x: 0, z: 0, r: 20, ring: 9.5 },
];

const typesOf = (card) => (Array.isArray(card.types) ? card.types : String(card.types ?? '').split(/[,/]/)).map((t) => t.trim()).filter(Boolean);

export function habitatFor(card) {
  const types = typesOf(card);
  return HABITATS.find((h) => h.types.includes(types[0])) ?? HABITATS.at(-1);
}

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

/**
 * Where every creature starts: [{ card, habitat, x, z, home: {x, z} }], one per different Pokémon
 * (by name), never in water and never on the plaza. The same collection gives the same layout.
 */
export function layoutHabitats(cards, { blocked = () => false, plaza = 8, seed = 7 } = {}) {
  const r = rngFrom(seed);
  const seen = new Set();
  const out = [];
  for (const card of cards) {
    const key = String(card.name ?? '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const habitat = habitatFor(card);
    let spot = null;
    for (let tries = 0; tries < 60 && !spot; tries++) {
      const a = r() * Math.PI * 2;
      const d = habitat.ring ? habitat.ring + r() * (habitat.r - habitat.ring) : Math.sqrt(r()) * habitat.r;
      const x = habitat.x + Math.cos(a) * d;
      const z = habitat.z + Math.sin(a) * d;
      if (Math.hypot(x, z) < plaza || blocked(x, z)) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 2.2)) continue;
      spot = { x, z };
    }
    spot ??= { x: habitat.x, z: habitat.z + habitat.r + 2 + out.length * 0.5 };
    out.push({ card, habitat, x: spot.x, z: spot.z, home: { ...spot } });
  }
  return out;
}

export const CREATURE = { walk: 1.3, follow: 4.6, roam: 6, keep: 2.4, catchUp: 14 };

/** A creature's state for stepCreature(). */
export function createCreature(spot, id) {
  return { id, card: spot.card, habitat: spot.habitat, home: spot.home, x: spot.x, z: spot.z, y: 0, facing: 0, state: 'idle', timer: 1 + (id % 5) * 0.7, target: null, hop: 0, speed: 0 };
}

/**
 * Advance one creature: it idles, wanders near its home, or follows the trainer (keeping a little
 * distance, hurrying when left behind). `world`: { heightAt, blocked(x, z) }.
 */
export function stepCreature(c, dt, player, rand, world) {
  let goal = null;
  let pace = CREATURE.walk;
  if (c.state === 'follow') {
    const d = Math.hypot(player.x - c.x, player.z - c.z);
    if (d > CREATURE.keep) { goal = { x: player.x, z: player.z }; pace = d > CREATURE.catchUp ? CREATURE.follow * 1.6 : CREATURE.follow; }
  } else {
    c.timer -= dt;
    if (c.state === 'idle' && c.timer <= 0) {
      const a = rand() * Math.PI * 2;
      const d = 1 + rand() * CREATURE.roam;
      c.target = { x: c.home.x + Math.cos(a) * d, z: c.home.z + Math.sin(a) * d };
      c.state = 'wander';
      c.timer = 8;
    } else if (c.state === 'wander') {
      goal = c.target;
      if (!goal || Math.hypot(goal.x - c.x, goal.z - c.z) < 0.3 || c.timer <= 0) { c.state = 'idle'; c.timer = 1.5 + rand() * 4; goal = null; }
    }
  }
  c.speed = 0;
  if (goal) {
    const dx = goal.x - c.x;
    const dz = goal.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    const step = Math.min(d, pace * dt);
    const nx = c.x + (dx / d) * step;
    const nz = c.z + (dz / d) * step;
    if (world.blocked?.(nx, nz)) {
      if (c.state === 'wander') { c.state = 'idle'; c.timer = 1; } // turn back from the water
    } else {
      c.x = nx; c.z = nz; c.speed = step / dt;
      const want = Math.atan2(dx, dz);
      const turn = ((want - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      c.facing += turn * Math.min(1, dt * 8);
    }
  } else if (c.state === 'follow') {
    const want = Math.atan2(player.x - c.x, player.z - c.z);
    const turn = ((want - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    c.facing += turn * Math.min(1, dt * 6);
  }
  // It hops along while moving.
  c.hop = c.speed > 0.1 ? (c.hop + dt * (5 + c.speed)) % Math.PI : 0;
  c.y = world.heightAt(c.x, c.z) + Math.sin(c.hop) * 0.22;
  return c;
}

/** The creature nearest the trainer within `reach`, or null. */
export function nearest(creatures, player, reach = 3.2) {
  let best = null;
  let bestD = reach;
  for (const c of creatures) {
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}
