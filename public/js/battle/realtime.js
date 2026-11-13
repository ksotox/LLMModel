// Real-time PokéBattles: both Pokémon move, dodge, jump and use their card's attacks at the same
// time, against the computer or a friend on the same device. The idea follows the fan game PokeBrawl
// (github.com/xjoje6/PokeBrawl, MIT): free movement on the field, energy that refills, moves with
// cooldowns, a dodge with a moment of invulnerability, stun that shortens through a combo, a
// computer rival that plays with a delay and mistakes, ring-outs on the Floating Stadium and a field
// that closes in at the League Stadium. Written from scratch for card data; no code of it is used.
//
// Pure and deterministic (no DOM, no three.js): the page feeds each side's intent into step() at a
// fixed 60 steps a second and draws what the state says; the tests run whole battles in Node.

import { createRng, matchups, sandProof, SAND_DAMAGE, weatherBoost } from './engine.js';

export const STEP = 1 / 60;
export const TIME_LIMIT = 180; // seconds; then the side with more HP left (by share) wins

const SPEED = 3.2; // units a second (the field is about 12 across)
const JUMP_SPEED = 5.2;
const GRAVITY = 15;
const ENERGY_MAX = 100;
const ENERGY_REGEN = 12; // a second
const ENERGY_PER_SYMBOL = 20;
const DODGE_CHARGES = 2;
const DODGE_TIME = 0.26; // the dash
const DODGE_SPEED = 8;
const DODGE_INVULNERABLE = 0.2;
const DODGE_RECOVERY = 0.18; // a moment you can be punished in
const DODGE_REFILL = 1.4; // seconds per charge, starting a while after the last dodge
const STUN = 0.36;
const COMBO_WINDOW = 1.3;
const COMBO_MAX = 5; // the fifth hit in a row knocks down (then a moment of invulnerability)
const DOWN_TIME = 0.9;
const GETUP_INVULNERABLE = 0.6;
const DAMAGE_SCALE = 0.12; // printed damage → real-time damage per hit (battles of about a minute)
const PROJECTILE_SPEED = 9;
const PROJECTILE_RADIUS = 0.5;
const MELEE_RANGE = 1.7;
const LUNGE_RANGE = 2.8; // a close-up attack lunges at a rival this near
const LUNGE_SPEED = 7;
const BODY_RADIUS = 0.45;
const SAND_EVERY = 6;
const BOOST_TIME = 10;

/** Card types whose attacks fly (the rest strike up close). */
const RANGED = new Set(['Fire', 'Water', 'Lightning', 'Psychic', 'Grass', 'Dragon', 'Fairy']);

/** The field: its radius, whether a wall holds you in, and how it closes in (League). */
export const ARENA_RULES = {
  meadow: { radius: 5.8, wall: true },
  night: { radius: 5.8, wall: true },
  league: { radius: 5.8, wall: true, shrink: [[30, 5.0], [55, 4.2], [80, 3.5]] },
  floating: { radius: 10.3, wall: false }, // the deck's edge: off it is a ring-out
};

export const DIFFICULTY = {
  easy: { reaction: 0.45, error: 0.35, aggression: 0.35, dodge: 0.2, think: 0.35 },
  normal: { reaction: 0.28, error: 0.18, aggression: 0.6, dodge: 0.5, think: 0.22 },
  hard: { reaction: 0.17, error: 0.07, aggression: 0.85, dodge: 0.8, think: 0.12 },
};

const costOf = (attack) => (Array.isArray(attack?.cost) ? attack.cost.length : 0);

/**
 * The (up to) four moves of a fighter: its printed attacks, then its first ability as a power-up,
 * and a free quick strike so there is always something to do.
 */
export function moveSpecs(data) {
  const types = data?.types?.length ? data.types : ['Colorless'];
  const ranged = RANGED.has(types[0]);
  const moves = (data?.attacks ?? []).slice(0, 3).map((a) => {
    const symbols = costOf(a);
    const base = a.damage?.base ?? 0;
    const kind = base > 0 ? (ranged ? 'projectile' : 'melee') : /heal/i.test(a.effect ?? '') ? 'heal' : 'charge';
    return {
      name: a.name,
      kind,
      type: types[0],
      damage: base,
      shots: a.damage?.mod === 'x' ? 3 : 1, // "20×": three shots in a fan
      bonus: a.damage?.mod === '+' ? 1.5 : 1, // "30+": half again on average
      energy: Math.min(ENERGY_MAX, symbols * ENERGY_PER_SYMBOL),
      cooldown: 0.6 + symbols * 0.5,
      startup: 0.12 + symbols * 0.05,
      recovery: 0.22,
    };
  });
  const ability = data?.abilities?.[0];
  if (ability && moves.length < 4) moves.push({ name: ability.name, kind: 'boost', type: types[0], damage: 0, shots: 0, bonus: 1, energy: 0, cooldown: 999, startup: 0.2, recovery: 0.2, once: true });
  if (moves.length < 4) moves.push({ name: 'Quick Strike', kind: 'melee', type: types[0], damage: 20, shots: 1, bonus: 1, energy: 0, cooldown: 0.7, startup: 0.1, recovery: 0.2, basic: true });
  return moves;
}

function makeSide(data, side, start) {
  const hp = Math.max(10, Number(data?.battle?.hp) || 60);
  const battle = data?.battle ?? {};
  return {
    side,
    name: data?.name ?? 'Pokémon',
    cardId: data?.cardId ?? null,
    types: battle.types?.length ? battle.types : ['Colorless'],
    weaknesses: battle.weaknesses ?? [],
    resistances: battle.resistances ?? [],
    maxHp: hp,
    hp,
    x: start.x,
    z: start.z,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    facing: 0,
    energy: 40,
    moves: moveSpecs(battle),
    cooldowns: [0, 0, 0, 0],
    usedOnce: [],
    action: null, // { index, t, fired }
    dodges: DODGE_CHARGES,
    dodgeT: 0,
    dodgeDir: [0, 0],
    sinceDodge: 99,
    refill: 0,
    invulnerable: 0,
    stun: 0,
    down: 0,
    combo: 0,
    comboT: 0,
    boost: 0,
    out: false, // fell off the deck
    stats: { dealt: 0, hits: 0, dodged: 0 },
  };
}

/** A new battle. `a` and `b`: { battle, name, cardId } as for the turn-based engine. */
export function createRealtime(a, b, { rng = Math.random, seed = null, weather = 'clear', arena = 'meadow', mode = 'cpu', difficulty = 'normal' } = {}) {
  const rules = ARENA_RULES[arena] ?? ARENA_RULES.meadow;
  const random = seed != null ? createRng(seed) : rng;
  const d = Math.min(3.2, rules.radius * 0.55);
  const state = {
    t: 0,
    arena,
    rules,
    zone: rules.radius,
    weather,
    mode,
    difficulty: DIFFICULTY[difficulty] ? difficulty : 'normal',
    rng: random,
    fighters: [makeSide(a, 0, { x: -d * 0.55, z: d * 0.55 }), makeSide(b, 1, { x: d * 0.55, z: -d * 0.55 })],
    projectiles: [],
    nextId: 1,
    sandT: 0,
    over: false,
    winner: null,
    ai: [null, null],
    history: [], // recent positions, so the computer sees the past ("reaction")
  };
  for (const f of state.fighters) f.facing = Math.atan2(-f.x, -f.z);
  return state;
}

/** An intent: what a side wants this step. move: { x, z } in the world (length up to 1). */
export const idle = () => ({ move: { x: 0, z: 0 }, jump: false, dodge: false, use: null });

const len = (x, z) => Math.hypot(x, z);
const canAct = (f) => !f.out && f.hp > 0 && f.stun <= 0 && f.down <= 0 && f.dodgeT <= 0 && !f.action;

/**
 * Damage of one hit: the printed damage scaled for real time, with the power-up, the weather and the
 * card's weakness (×2, or +N scaled) and resistance (−N scaled); snow guards Water types a little.
 */
export function hitAmount(attacker, target, move, { weather = 'clear', boost = 1 } = {}) {
  let amount = move.damage * move.bonus * DAMAGE_SCALE * boost * weatherBoost(weather, attacker);
  const { weakness, resistance } = matchups(attacker, target);
  if (weakness) amount = weakness.mult ? amount * weakness.mult : amount + (weakness.add ?? 0) * DAMAGE_SCALE;
  if (resistance) amount -= (resistance.sub ?? 30) * DAMAGE_SCALE;
  if (weather === 'snow' && target.types.includes('Water')) amount -= 10 * DAMAGE_SCALE;
  return { amount: Math.max(1, Math.round(amount)), weakness: Boolean(weakness), resisted: Boolean(resistance) };
}

function damage(state, attacker, target, move, x, z, events) {
  if (target.invulnerable > 0 || target.out || target.hp <= 0) {
    if (target.dodgeT > 0 || target.invulnerable > 0) {
      target.stats.dodged++;
      events.push({ type: 'evade', side: target.side });
    }
    return false;
  }
  const hit = hitAmount(attacker, target, move, { weather: state.weather, boost: attacker.boost > 0 ? 1.5 : 1 });
  const { weakness, resisted } = hit;
  const amount = Math.min(target.hp, hit.amount);
  target.hp -= amount;
  attacker.stats.dealt += amount;
  attacker.stats.hits++;
  // Stun that gets shorter through a combo; the fifth hit in a row knocks down.
  target.combo = target.comboT > 0 ? target.combo + 1 : 1;
  target.comboT = COMBO_WINDOW;
  const away = len(target.x - x, target.z - z) || 1;
  const push = 2.6 + (weakness ? 1 : 0);
  target.vx = ((target.x - x) / away) * push;
  target.vz = ((target.z - z) / away) * push;
  target.action = null;
  if (target.combo >= COMBO_MAX) {
    target.down = DOWN_TIME;
    target.combo = 0;
    target.comboT = 0;
  } else {
    target.stun = STUN * 0.78 ** (target.combo - 1);
  }
  events.push({ type: 'hit', side: target.side, by: attacker.side, amount, weakness, resisted, moveType: move.type, x: target.x, z: target.z, down: target.down > 0 });
  if (target.hp <= 0) events.push({ type: 'ko', side: target.side });
  return true;
}

function fire(state, f, foe, move, index, events) {
  if (move.kind === 'boost') {
    f.boost = BOOST_TIME;
    f.usedOnce.push(index);
    events.push({ type: 'boost', side: f.side, name: move.name });
    return;
  }
  if (move.kind === 'heal') {
    const amount = Math.min(f.maxHp - f.hp, Math.max(5, Math.round(f.maxHp * 0.12)));
    f.hp += amount;
    events.push({ type: 'heal', side: f.side, amount });
    return;
  }
  if (move.kind === 'charge') {
    f.energy = ENERGY_MAX;
    events.push({ type: 'charge', side: f.side });
    return;
  }
  events.push({ type: 'move', side: f.side, index, name: move.name, kind: move.kind, moveType: move.type });
  if (move.kind === 'melee') {
    const dx = foe.x - f.x;
    const dz = foe.z - f.z;
    const d = len(dx, dz);
    const ahead = Math.cos(Math.atan2(dx, dz) - f.facing);
    if (d <= MELEE_RANGE && ahead > 0.2 && Math.abs(foe.y - f.y) < 1.2) damage(state, f, foe, move, f.x, f.z, events);
    else events.push({ type: 'miss', side: f.side });
    return;
  }
  // Projectiles fly straight at where the rival is now (no homing): stepping aside dodges them.
  for (let i = 0; i < move.shots; i++) {
    const spread = move.shots > 1 ? (i - (move.shots - 1) / 2) * 0.22 : 0;
    const a = Math.atan2(foe.x - f.x, foe.z - f.z) + spread;
    state.projectiles.push({
      id: state.nextId++,
      side: f.side,
      x: f.x + Math.sin(a) * 0.6,
      z: f.z + Math.cos(a) * 0.6,
      y: f.y + 0.7,
      vx: Math.sin(a) * PROJECTILE_SPEED,
      vz: Math.cos(a) * PROJECTILE_SPEED,
      life: 1.6,
      move: move.shots > 1 ? { ...move, damage: move.damage / 1.5 } : move,
    });
  }
}

function stepFighter(state, f, foe, intent, dt, events) {
  // Timers.
  for (let i = 0; i < f.cooldowns.length; i++) f.cooldowns[i] = Math.max(0, f.cooldowns[i] - dt);
  f.energy = Math.min(ENERGY_MAX, f.energy + ENERGY_REGEN * dt);
  f.invulnerable = Math.max(0, f.invulnerable - dt);
  f.comboT = Math.max(0, f.comboT - dt);
  if (f.comboT === 0) f.combo = 0;
  f.boost = Math.max(0, f.boost - dt);
  f.sinceDodge += dt;
  if (f.dodges < DODGE_CHARGES && f.sinceDodge > DODGE_REFILL) {
    f.refill += dt;
    if (f.refill >= DODGE_REFILL) { f.dodges++; f.refill = 0; }
  }
  if (f.stun > 0) f.stun = Math.max(0, f.stun - dt);
  if (f.down > 0) {
    f.down = Math.max(0, f.down - dt);
    if (f.down === 0) f.invulnerable = GETUP_INVULNERABLE;
  }
  if (f.out || f.hp <= 0) return;

  // Face the rival (lock-on, as with a gamepad's lock-on).
  const target = Math.atan2(foe.x - f.x, foe.z - f.z);
  let turn = ((target - f.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  f.facing += turn * Math.min(1, dt * 12);

  // Start something new.
  if (canAct(f) && intent) {
    if (intent.dodge && f.dodges > 0 && f.y <= 0.001) {
      const m = len(intent.move.x, intent.move.z);
      // A dodge goes where you're steering, or sideways if you're not.
      f.dodgeDir = m > 0.2 ? [intent.move.x / m, intent.move.z / m] : [Math.cos(target), -Math.sin(target)];
      f.dodgeT = DODGE_TIME + DODGE_RECOVERY;
      f.invulnerable = DODGE_INVULNERABLE;
      f.dodges--;
      f.sinceDodge = 0;
      f.refill = 0;
      events.push({ type: 'dodge', side: f.side });
    } else if (intent.use != null) {
      const move = f.moves[intent.use];
      if (move && f.cooldowns[intent.use] <= 0 && f.energy >= move.energy && !(move.once && f.usedOnce.includes(intent.use))) {
        f.energy -= move.energy;
        f.cooldowns[intent.use] = move.cooldown;
        f.action = { index: intent.use, t: 0, fired: false };
      }
    } else if (intent.jump && f.y <= 0.001) {
      f.vy = JUMP_SPEED;
      events.push({ type: 'jump', side: f.side });
    }
  }

  // Move.
  let ax = 0;
  let az = 0;
  if (f.dodgeT > 0) {
    const dashing = f.dodgeT > DODGE_RECOVERY;
    f.dodgeT = Math.max(0, f.dodgeT - dt);
    if (dashing) { ax = f.dodgeDir[0] * DODGE_SPEED; az = f.dodgeDir[1] * DODGE_SPEED; }
    f.vx = ax;
    f.vz = az;
  } else if (f.stun > 0 || f.down > 0) {
    f.vx *= 0.88; // knocked back, sliding to a stop
    f.vz *= 0.88;
  } else {
    const m = Math.min(1, len(intent?.move.x ?? 0, intent?.move.z ?? 0));
    const k = m > 0 ? m / len(intent.move.x, intent.move.z) : 0;
    const slow = f.action ? 0.35 : 1; // moving while attacking is slow
    const tx = (intent?.move.x ?? 0) * k * SPEED * slow;
    const tz = (intent?.move.z ?? 0) * k * SPEED * slow;
    const grip = f.y > 0.001 ? 4 : 14; // little control in the air
    f.vx += (tx - f.vx) * Math.min(1, grip * dt);
    f.vz += (tz - f.vz) * Math.min(1, grip * dt);
  }
  f.x += f.vx * dt;
  f.z += f.vz * dt;
  if (f.y > 0 || f.vy > 0) {
    f.vy -= GRAVITY * dt;
    f.y = Math.max(0, f.y + f.vy * dt);
    if (f.y === 0) f.vy = 0;
  }

  // An action: wind up, then the move goes off, then a short recovery.
  if (f.action) {
    const move = f.moves[f.action.index];
    f.action.t += dt;
    // A close-up attack lunges at the rival during its wind-up.
    if (move.kind === 'melee' && !f.action.fired) {
      const dx = foe.x - f.x;
      const dz = foe.z - f.z;
      const d = len(dx, dz);
      if (d > 1.1 && d < LUNGE_RANGE + 0.5) {
        const k = Math.min(LUNGE_SPEED * dt, d - 1.1) / d;
        f.x += dx * k;
        f.z += dz * k;
      }
    }
    if (!f.action.fired && f.action.t >= move.startup) {
      f.action.fired = true;
      fire(state, f, foe, move, f.action.index, events);
    }
    if (f.action.t >= move.startup + move.recovery) f.action = null;
  }

  // The field's edge: a wall, or (Floating Stadium) a fall.
  const r = len(f.x, f.z);
  const limit = state.zone - BODY_RADIUS;
  if (r > limit) {
    if (state.rules.wall || state.zone < state.rules.radius) {
      f.x *= limit / r;
      f.z *= limit / r;
    } else if (r > state.rules.radius + 0.3) {
      f.out = true;
      f.hp = 0;
      events.push({ type: 'ringout', side: f.side }, { type: 'ko', side: f.side });
    }
  }
}

function stepProjectiles(state, dt, events) {
  const keep = [];
  for (const p of state.projectiles) {
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.life -= dt;
    const target = state.fighters[1 - p.side];
    const hitBody = len(target.x - p.x, target.z - p.z) < PROJECTILE_RADIUS + BODY_RADIUS && Math.abs(target.y + 0.6 - p.y) < 1.1;
    if (hitBody && damage(state, state.fighters[p.side], target, p.move, p.x - p.vx * 0.05, p.z - p.vz * 0.05, events)) {
      events.push({ type: 'burst', id: p.id, x: p.x, z: p.z, moveType: p.move.type });
      continue;
    }
    const outside = len(p.x, p.z) > (state.rules.wall ? state.zone + 0.2 : state.rules.radius + 4);
    if (p.life <= 0 || outside) {
      events.push({ type: 'burst', id: p.id, x: p.x, z: p.z, moveType: p.move.type, fizzle: true });
      continue;
    }
    keep.push(p);
  }
  state.projectiles = keep;
}

/**
 * Advance the battle by one fixed step. `intents`: [side 0, side 1] (null = no input; in a
 * battle against the computer pass null for side 1 and the computer plays it). Returns the events.
 */
export function step(state, intents = [null, null], dt = STEP) {
  if (state.over) return [];
  const events = [];
  state.t += dt;
  state.history.push(state.fighters.map((f) => ({ x: f.x, z: f.z, y: f.y, dodgeT: f.dodgeT, action: f.action ? f.action.index : null })));
  if (state.history.length > 60) state.history.shift();
  const want = [0, 1].map((side) => intents[side] ?? (state.mode === 'cpu' && side === 1 ? aiIntent(state, side) : null));

  // The League's field closes in by phases.
  for (const [at, radius] of state.rules.shrink ?? []) {
    if (state.t >= at && state.zone > radius) {
      state.zone = Math.max(radius, state.zone - dt * 0.8);
      if (state.zone === radius) events.push({ type: 'zone', radius });
    }
  }
  const [a, b] = state.fighters;
  stepFighter(state, a, b, want[0], dt, events);
  stepFighter(state, b, a, want[1], dt, events);
  // Bodies don't overlap.
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = len(dx, dz);
  if (d > 0 && d < BODY_RADIUS * 2 && Math.abs(a.y - b.y) < 0.8) {
    const push = (BODY_RADIUS * 2 - d) / 2;
    a.x -= (dx / d) * push; a.z -= (dz / d) * push;
    b.x += (dx / d) * push; b.z += (dz / d) * push;
  }
  stepProjectiles(state, dt, events);

  // The sandstorm wears down everyone but Fighting and Metal types, never to 0.
  if (state.weather === 'sand') {
    state.sandT += dt;
    if (state.sandT >= SAND_EVERY) {
      state.sandT = 0;
      for (const f of state.fighters) {
        if (!sandProof(f) && f.hp > SAND_DAMAGE && !f.out) {
          f.hp -= SAND_DAMAGE;
          events.push({ type: 'weather', kind: 'sand', side: f.side, amount: SAND_DAMAGE });
        }
      }
    }
  }

  const down = state.fighters.filter((f) => f.hp <= 0);
  if (down.length) {
    state.over = true;
    state.winner = down.length === 2 ? null : 1 - down[0].side;
    events.push({ type: 'end', winner: state.winner });
  } else if (state.t >= TIME_LIMIT) {
    state.over = true;
    const share = state.fighters.map((f) => f.hp / f.maxHp);
    state.winner = Math.abs(share[0] - share[1]) < 1e-9 ? null : share[0] > share[1] ? 0 : 1;
    events.push({ type: 'end', winner: state.winner, timeUp: true });
  }
  return events;
}

// ---------------------------------------------------------------------------
// The computer: it fills in an intent as a player would, seeing the rival as it was a moment ago
// ("reaction"), with mistakes and a liking for attacking set by the difficulty.

export function aiIntent(state, side) {
  const level = DIFFICULTY[state.difficulty];
  const me = state.fighters[side];
  const foe = state.fighters[1 - side];
  const r = state.rng;
  const brain = (state.ai[side] ??= { next: 0, plan: idle(), strafe: r() < 0.5 ? 1 : -1, seen: new Set() });
  const intent = { ...brain.plan, move: { ...brain.plan.move }, jump: false, dodge: false, use: null };

  // 1. An incoming projectile: dodge it (once per projectile, by chance).
  for (const p of state.projectiles) {
    if (p.side === side || brain.seen.has(p.id)) continue;
    const dx = me.x - p.x;
    const dz = me.z - p.z;
    const closing = (dx * p.vx + dz * p.vz) / PROJECTILE_SPEED;
    if (closing > 0 && len(dx, dz) < 2.6) {
      brain.seen.add(p.id);
      if (r() < level.dodge && me.dodges > 0) {
        intent.dodge = true;
        intent.move = { x: -p.vz / PROJECTILE_SPEED * brain.strafe, z: p.vx / PROJECTILE_SPEED * brain.strafe };
        return intent;
      }
    }
  }

  if (state.t < brain.next) return intent;
  brain.next = state.t + level.think * (0.7 + r() * 0.6);

  // Where the rival was "reaction" seconds ago, give or take an error.
  const back = Math.min(state.history.length - 1, Math.round(level.reaction / STEP));
  const seen = state.history[state.history.length - 1 - back]?.[1 - side] ?? foe;
  const fx = seen.x + (r() - 0.5) * level.error * 2;
  const fz = seen.z + (r() - 0.5) * level.error * 2;
  const dx = fx - me.x;
  const dz = fz - me.z;
  const d = len(dx, dz) || 1;

  // 2. Punish: the rival is recovering from a dodge or an attack, or lying down.
  const open = seen.dodgeT > 0 && seen.dodgeT < DODGE_RECOVERY + 0.02;
  // 3. Pick a move it can use now, if it feels like attacking.
  const usable = me.moves.map((m, i) => ({ m, i })).filter(({ m, i }) => me.cooldowns[i] <= 0 && me.energy >= m.energy && !(m.once && me.usedOnce.includes(i)));
  const inRange = usable.filter(({ m }) => (m.kind === 'melee' ? d < LUNGE_RANGE : m.kind === 'projectile' ? d < 7.5 : true));
  const hurtSelf = me.hp < me.maxHp * 0.5;
  const pick = inRange.find(({ m }) => m.kind === 'boost' && foe.hp > foe.maxHp * 0.4)
    ?? inRange.find(({ m }) => m.kind === 'heal' && hurtSelf)
    ?? inRange.filter(({ m }) => m.damage > 0).sort((p, q) => q.m.damage * q.m.bonus * q.m.shots - p.m.damage * p.m.bonus * p.m.shots)[0];
  if (pick && (open || r() < level.aggression)) intent.use = pick.i;

  // 4. Hold the distance that suits it, circling; keep away from the edge.
  const ranged = me.moves.some((m) => m.kind === 'projectile' && !m.basic);
  const want = ranged ? 4.2 : 2.2;
  const toward = d > want + 0.6 ? 1 : d < want - 0.6 ? -1 : 0;
  let mx = (dx / d) * toward + (-dz / d) * brain.strafe * 0.7;
  let mz = (dz / d) * toward + (dx / d) * brain.strafe * 0.7;
  const rr = len(me.x, me.z);
  if (rr > state.zone - 1.2) { mx -= me.x / rr * 1.5; mz -= me.z / rr * 1.5; brain.strafe *= -1; }
  if (r() < 0.08) brain.strafe *= -1;
  intent.move = { x: mx, z: mz };
  intent.jump = r() < 0.03;
  brain.plan = { ...intent, use: null, dodge: false, jump: false };
  return intent;
}
