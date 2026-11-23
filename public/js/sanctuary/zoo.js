// The Sanctuary's zoo: where each of your Pokémon lives, and how it behaves. Pure (no DOM, no
// three.js): the page draws what these functions decide, and the tests run them in Node.
//
// One creature per different Pokémon in your collection, in the habitat of its card's type, at its real
// size and moving as it does (creature/body.js): walkers and four-legged ones roam the ground at a pace
// that suits their legs, swimmers keep to the lake, flyers take off to travel and land to rest, and
// Pokémon that levitate float above the grass.

import { bodyPlan } from '../creature/body.js';

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
 * Where every creature starts: [{ card, habitat, x, z, home: {x, z}, plan }], one per different Pokémon
 * (by name), never on the plaza, and spaced by size. Swimmers start in the water (`water(x, z)`, when
 * given), everyone else on land. The same collection gives the same layout.
 */
export function layoutHabitats(cards, { blocked = () => false, water = null, plaza = 8, seed = 7 } = {}) {
  const r = rngFrom(seed);
  const seen = new Set();
  const out = [];
  const shore = HABITATS.find((h) => h.id === 'shore');
  for (const card of cards) {
    const key = String(card.name ?? '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const plan = bodyPlan(card.species, { fallbackHeight: 1 });
    const swims = plan.mode === 'swim' && water;
    const habitat = swims ? shore : habitatFor(card);
    // A swimmer needs water all round it (as far as its size reaches), easing off if the lake is small.
    const fits = (x, z, reach) => [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]].every(([dx, dz]) => water(x + dx, z + dz));
    let spot = null;
    for (let tries = 0; tries < 90 && !spot; tries++) {
      const a = r() * Math.PI * 2;
      const d = swims ? Math.sqrt(r()) * habitat.r : habitat.ring ? habitat.ring + r() * (habitat.r - habitat.ring) : Math.sqrt(r()) * habitat.r;
      const x = habitat.x + Math.cos(a) * d;
      const z = habitat.z + Math.sin(a) * d;
      if (Math.hypot(x, z) < plaza) continue;
      if (swims ? !fits(x, z, plan.radius * (1 - tries / 90)) : blocked(x, z)) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < Math.max(2.2, o.plan.radius + plan.radius + 1))) continue;
      spot = { x, z };
    }
    spot ??= { x: habitat.x, z: habitat.z + habitat.r + 2 + out.length * 0.5 };
    out.push({ card, habitat, x: spot.x, z: spot.z, home: { ...spot }, plan });
  }
  return out;
}

export const CREATURE = { walk: 1.3, follow: 4.6, roam: 6, keep: 2.4, catchUp: 14, climb: 2.5 };

/** A creature's state for stepCreature(). */
export function createCreature(spot, id) {
  const plan = spot.plan ?? bodyPlan(spot.card?.species, { fallbackHeight: 1 });
  return { id, card: spot.card, habitat: spot.habitat, home: spot.home, x: spot.x, z: spot.z, y: 0, alt: plan.mode === 'hover' ? plan.hoverHeight : 0, facing: 0, state: 'idle', timer: 1 + (id % 5) * 0.7, target: null, hop: 0, speed: 0, plan, air: false };
}

/**
 * Advance one creature: it idles, wanders near its home, or follows the trainer (keeping a little
 * distance, hurrying when left behind), at the pace its size and build allow. `world`: { heightAt,
 * blocked(x, z, mode), waterLevel? }: `blocked` says where a creature that moves this way can't go
 * (the page keeps swimmers in the lake and lets flyers cross it).
 */
export function stepCreature(c, dt, player, rand, world) {
  const plan = c.plan;
  let goal = null;
  // Its own walking pace (a Joltik dawdles, a Gyarados glides), kept within what reads well on screen.
  let pace = Math.min(4, Math.max(0.5, plan.walkSpeed));
  const keep = CREATURE.keep + plan.radius;
  if (c.state === 'follow') {
    const d = Math.hypot(player.x - c.x, player.z - c.z);
    // Keeping up with the trainer, though small legs have to work hard for it.
    const follow = Math.max(CREATURE.follow, Math.min(plan.runSpeed, 9));
    if (d > keep) { goal = { x: player.x, z: player.z }; pace = d > CREATURE.catchUp + plan.radius ? follow * 1.6 : follow; }
  } else {
    c.timer -= dt;
    if (c.state === 'idle' && c.timer <= 0) {
      const a = rand() * Math.PI * 2;
      const d = 1 + rand() * (CREATURE.roam + plan.radius * 2);
      c.target = { x: c.home.x + Math.cos(a) * d, z: c.home.z + Math.sin(a) * d };
      c.state = 'wander';
      c.timer = 8 + plan.radius * 2;
    } else if (c.state === 'wander') {
      goal = c.target;
      if (!goal || Math.hypot(goal.x - c.x, goal.z - c.z) < 0.3 || c.timer <= 0) { c.state = 'idle'; c.timer = 1.5 + rand() * 4; goal = null; }
    }
  }
  c.speed = 0;
  // A flyer takes off before it sets out, and only moves once it's up.
  const grounded = plan.mode === 'fly' && goal && c.alt < 0.4 * plan.cruise;
  if (goal && !grounded) {
    const dx = goal.x - c.x;
    const dz = goal.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    const step = Math.min(d, pace * dt);
    const nx = c.x + (dx / d) * step;
    const nz = c.z + (dz / d) * step;
    if (world.blocked?.(nx, nz, plan.mode)) {
      if (c.state === 'wander') { c.state = 'idle'; c.timer = 1; } // turn back from the water (or the shore)
    } else {
      c.x = nx; c.z = nz; c.speed = step / dt;
      const want = Math.atan2(dx, dz);
      const turn = ((want - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      c.facing += turn * Math.min(1, dt * (8 / (1 + plan.radius))); // big bodies turn slowly
    }
  } else if (c.state === 'follow') {
    const want = Math.atan2(player.x - c.x, player.z - c.z);
    const turn = ((want - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    c.facing += turn * Math.min(1, dt * 6);
  }
  // How high it is: flyers cruise (lower beside the trainer) and land to rest; levitators float.
  let alt = 0;
  if (plan.mode === 'hover') alt = plan.hoverHeight;
  else if (plan.mode === 'fly') {
    const resting = !goal && c.state !== 'follow' && plan.perches;
    alt = resting ? 0 : c.state === 'follow' ? Math.min(plan.cruise, 1.2 + plan.heightM * 0.6) : plan.cruise;
  }
  const climb = CREATURE.climb * (1 + plan.heightM * 0.3) * dt;
  c.alt += Math.max(-climb, Math.min(climb, alt - c.alt));
  c.air = plan.mode === 'fly' && c.alt > 0.05;
  // The card it stands as (until its model loads) hops along while moving.
  c.hop = c.speed > 0.1 ? (c.hop + dt * (5 + c.speed)) % Math.PI : 0;
  const ground = world.heightAt(c.x, c.z);
  // Swimmers float at the surface, mostly under it, as a whale or a fish does: by the model's own
  // height (`c.sink`, set when it loads), else a guess from its size.
  c.y = plan.mode === 'swim' && world.waterLevel != null ? world.waterLevel - (c.sink ?? plan.heightM * (plan.long ? 0.15 : 0.4)) : ground + c.alt;
  return c;
}

/** The creature nearest the trainer within `reach`, or null. */
export function nearest(creatures, player, reach = 3.2) {
  let best = null;
  let bestD = Infinity;
  for (const c of creatures) {
    // Measured to its body, not its middle: a Wailord can be reached from its side.
    const d = Math.hypot(c.x - player.x, c.z - player.z) - (c.plan?.radius ?? 0);
    if (d > reach) continue;
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * A creature in the Reef: it hovers, drifts to nearby spots in open water (up and down too), or
 * follows the trainer. `world`: { heightAt, top, blocked(x, y, z) }.
 */
export function stepDrifter(c, dt, player, rand, world) {
  let goal = null;
  // Everyone swims here, at a pace that suits its size.
  const h = c.plan?.heightM ?? 1;
  let pace = Math.min(4, Math.max(0.6, 0.3 * Math.sqrt(9.81 * h)));
  if (c.state === 'follow') {
    const d = Math.hypot(player.x - c.x, player.y - c.y, player.z - c.z) - (c.plan?.radius ?? 0);
    if (d > CREATURE.keep) { goal = { x: player.x, y: player.y + 0.3, z: player.z }; pace = d > CREATURE.catchUp ? CREATURE.follow * 1.6 : CREATURE.follow; }
  } else {
    c.timer -= dt;
    if (c.state === 'idle' && c.timer <= 0) {
      const a = rand() * Math.PI * 2;
      const d = 1 + rand() * CREATURE.roam;
      const x = c.home.x + Math.cos(a) * d;
      const z = c.home.z + Math.sin(a) * d;
      const floor = world.heightAt(x, z) + 0.8;
      c.target = { x, z, y: Math.min(world.top - 1, floor + rand() * 4) };
      c.state = 'wander';
      c.timer = 9;
    } else if (c.state === 'wander') {
      goal = c.target;
      if (!goal || Math.hypot(goal.x - c.x, goal.y - c.y, goal.z - c.z) < 0.3 || c.timer <= 0) { c.state = 'idle'; c.timer = 1.5 + rand() * 4; goal = null; }
    }
  }
  c.speed = 0;
  if (goal) {
    const dx = goal.x - c.x;
    const dy = goal.y - c.y;
    const dz = goal.z - c.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const step = Math.min(d, pace * dt);
    const nx = c.x + (dx / d) * step;
    const ny = c.y + (dy / d) * step;
    const nz = c.z + (dz / d) * step;
    if (world.blocked?.(nx, ny, nz)) {
      if (c.state === 'wander') { c.state = 'idle'; c.timer = 1; }
    } else {
      c.x = nx; c.y = ny; c.z = nz; c.speed = step / dt;
      if (Math.hypot(dx, dz) > 0.05) {
        const want = Math.atan2(dx, dz);
        const turn = ((want - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        c.facing += turn * Math.min(1, dt * 6);
      }
    }
  }
  // Below the surface (all of it: a big one keeps lower) and above the sea floor.
  c.y = Math.max(world.heightAt(c.x, c.z) + 0.5, Math.min(world.top - 0.6 - h * 0.6, c.y));
  c.hop = (c.hop + dt * 1.6) % (Math.PI * 2); // a gentle bob in the water
  return c;
}

/** Water-type Pokémon live here: one of each. */
export function reefResidents(cards) {
  const seen = new Set();
  return cards.filter((c) => {
    const key = String(c.name ?? '').toLowerCase();
    if (!key || seen.has(key) || habitatFor(c).id !== 'shore') return false;
    seen.add(key);
    return true;
  });
}
