// PokéBattles rules: simple, original rules built on each card's own data (not the official card
// game or video game rules). Pure functions, no DOM: the page animates the events this returns,
// and the tests run it in Node with a seeded random generator.
//
//   • HP is the card's HP. A battle ends when one side reaches 0.
//   • Energy: each side gains 1 at the start of its turn (max 6). An attack needs as much energy
//     as its printed cost has symbols, and spends it. Resting skips the turn for +1 more energy.
//   • Damage is the printed number. "30+" flips a coin: heads doubles it. "20×" flips 3 coins:
//     20 for each heads. An attack with no damage heals 20 if its text mentions healing,
//     otherwise it charges +2 energy.
//   • Weakness (×2 or +N) and resistance (−N) apply as printed when the attacker's type matches.
//   • Each ability can be used once per battle: it takes the turn and powers up the next attack by +50%.
//   • Weather (optional, after the fan game PokeBrawl's, adapted to card types): sun strengthens Fire
//     and weakens Water attacks, rain the reverse, a sandstorm wears down everyone but Fighting and
//     Metal types, and snow protects Water types (the card game's Ice Pokémon).

export const MAX_ENERGY = 6;
export const MAX_ROUNDS = 100;

/** A small seeded random generator (mulberry32), so battles can be replayed in tests. */
export function createRng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WEATHER_KINDS = ['clear', 'sun', 'rain', 'sand', 'snow'];
export const SAND_DAMAGE = 10;
const SNOW_GUARD = 10;

/** How the weather changes an attack's damage before weakness and resistance: ×1.5, ×0.5 or ×1. */
export function weatherBoost(weather, attacker) {
  const fire = attacker.types.includes('Fire');
  const water = attacker.types.includes('Water');
  if (weather === 'sun') return fire ? 1.5 : water ? 0.5 : 1;
  if (weather === 'rain') return water ? 1.5 : fire ? 0.5 : 1;
  return 1;
}

/** A sandstorm doesn't hurt Fighting (the card game's Rock and Ground) or Metal Pokémon. */
export const sandProof = (fighter) => fighter.types.some((t) => t === 'Fighting' || t === 'Metal');

export const attackCost = (attack) => (Array.isArray(attack?.cost) ? attack.cost.length : 0);
const roundTen = (n) => Math.max(0, Math.round(n / 10) * 10);

export function makeFighter(data, { name, cardId = null, label = '' } = {}) {
  const hp = Math.max(10, Number(data?.hp) || 60);
  return {
    name: name ?? 'Pokémon',
    cardId,
    label,
    maxHp: hp,
    hp,
    types: data?.types?.length ? data.types : ['Colorless'],
    attacks: (data?.attacks?.length ? data.attacks : [{ name: 'Tackle', cost: ['Colorless'], damage: { base: 20, mod: null }, effect: '' }]),
    abilities: data?.abilities ?? [],
    weaknesses: data?.weaknesses ?? [],
    resistances: data?.resistances ?? [],
    energy: 0,
    boost: 0,
    usedAbilities: [],
    stats: { dealt: 0, moves: 0 },
  };
}

/** Weakness / resistance of `defender` against `attacker`'s types. */
export function matchups(attacker, defender) {
  const types = new Set(attacker.types);
  return {
    weakness: defender.weaknesses.find((w) => types.has(w.type)) ?? null,
    resistance: defender.resistances.find((r) => types.has(r.type)) ?? null,
  };
}

export function applyMatchups(amount, attacker, defender, weather = 'clear') {
  if (amount <= 0) return { amount: 0, weakness: false, resisted: false };
  const { weakness, resistance } = matchups(attacker, defender);
  let out = amount;
  if (weakness) out = weakness.mult ? out * weakness.mult : out + (weakness.add ?? 0);
  if (resistance) out -= resistance.sub ?? 30;
  if (weather === 'snow' && defender.types.includes('Water')) out -= SNOW_GUARD;
  return { amount: Math.max(0, out), weakness: Boolean(weakness), resisted: Boolean(resistance) };
}

/** What an attack deals right now, flipping coins with `rng` when it says to. */
export function damageFor(attacker, defender, attack, rng = Math.random, weather = 'clear') {
  const { base = 0, mod = null } = attack?.damage ?? {};
  let coins = [];
  let raw = base;
  if (mod === '+') {
    coins = [rng() < 0.5];
    raw = coins[0] ? base * 2 : base;
  } else if (mod === 'x') {
    coins = [rng() < 0.5, rng() < 0.5, rng() < 0.5];
    raw = base * coins.filter(Boolean).length;
  }
  if (attacker.boost) raw *= 1 + attacker.boost;
  raw *= weatherBoost(weather, attacker);
  const result = applyMatchups(roundTen(raw), attacker, defender, weather);
  return { ...result, coins, raw: roundTen(raw) };
}

/** Average damage (for the computer's choice and the move buttons). */
export function expectedDamage(attacker, defender, attack, weather = 'clear') {
  const { base = 0, mod = null } = attack?.damage ?? {};
  let raw = mod === '+' || mod === 'x' ? base * 1.5 : base;
  if (attacker.boost) raw *= 1 + attacker.boost;
  raw *= weatherBoost(weather, attacker);
  return applyMatchups(roundTen(raw), attacker, defender, weather).amount;
}

export function createBattle(dataA, dataB, { rng = Math.random, mode = 'cpu', weather = 'clear' } = {}) {
  const fighters = [makeFighter(dataA.battle, { name: dataA.name, cardId: dataA.cardId, label: 'Player 1' }),
    makeFighter(dataB.battle, { name: dataB.name, cardId: dataB.cardId, label: mode === 'cpu' ? 'Computer' : 'Player 2' })];
  const battle = { fighters, turn: rng() < 0.5 ? 0 : 1, round: 1, mode, rng, weather: WEATHER_KINDS.includes(weather) ? weather : 'clear', winner: null, over: false, log: [] };
  battle.opening = [{ type: 'start', first: battle.turn, coin: battle.turn === 0 ? 'heads' : 'tails' }, ...startTurn(battle)];
  return battle;
}

function startTurn(battle) {
  const f = battle.fighters[battle.turn];
  const gained = Math.min(1, MAX_ENERGY - f.energy);
  f.energy += gained;
  const events = [{ type: 'turn', who: battle.turn, energy: f.energy, round: battle.round }];
  // The sandstorm wears the Pokémon down as its turn starts, but never takes its last 10 HP.
  if (battle.weather === 'sand' && !sandProof(f) && f.hp > SAND_DAMAGE) {
    f.hp -= SAND_DAMAGE;
    events.push({ type: 'weather', kind: 'sand', who: battle.turn, amount: SAND_DAMAGE, hp: f.hp, maxHp: f.maxHp });
  }
  return events;
}

/** Everything the side whose turn it is can do now. */
export function legalActions(battle) {
  if (battle.over) return [];
  const f = battle.fighters[battle.turn];
  const actions = f.attacks.map((a, index) => ({ type: 'attack', index, ok: f.energy >= attackCost(a) }));
  f.abilities.forEach((a, index) => actions.push({ type: 'ability', index, ok: !f.usedAbilities.includes(index) }));
  actions.push({ type: 'rest', ok: f.energy < MAX_ENERGY });
  return actions;
}

/**
 * Play one action for the side whose turn it is. Returns the events to animate, in order:
 * use, coins, hit, heal, energy, boost, ko, end, turn, weather (sandstorm damage at the start of a turn).
 */
export function act(battle, action) {
  if (battle.over) throw new Error('The battle is over');
  const me = battle.turn;
  const f = battle.fighters[me];
  const foe = battle.fighters[1 - me];
  const events = [];
  if (action.type === 'attack') {
    const attack = f.attacks[action.index];
    if (!attack) throw new Error('No such attack');
    const cost = attackCost(attack);
    if (f.energy < cost) throw new Error(`${attack.name} needs ${cost} energy`);
    f.energy -= cost;
    f.stats.moves++;
    events.push({ type: 'use', who: me, kind: 'attack', name: attack.name, text: attack.effect, attackType: f.types[0], damageText: attack.damage?.text ?? '' });
    if ((attack.damage?.base ?? 0) > 0) {
      const hit = damageFor(f, foe, attack, battle.rng, battle.weather);
      if (hit.coins.length) events.push({ type: 'coins', who: me, coins: hit.coins });
      f.boost = 0;
      foe.hp = Math.max(0, foe.hp - hit.amount);
      f.stats.dealt += hit.amount;
      events.push({ type: 'hit', who: 1 - me, amount: hit.amount, weakness: hit.weakness, resisted: hit.resisted, hp: foe.hp, maxHp: foe.maxHp });
    } else if (/heal/i.test(attack.effect ?? '')) {
      const amount = Math.min(20, f.maxHp - f.hp);
      f.hp += amount;
      events.push({ type: 'heal', who: me, amount, hp: f.hp, maxHp: f.maxHp });
    } else {
      const gained = Math.min(2, MAX_ENERGY - f.energy);
      f.energy += gained;
      events.push({ type: 'energy', who: me, amount: gained, energy: f.energy });
    }
  } else if (action.type === 'ability') {
    const ability = f.abilities[action.index];
    if (!ability) throw new Error('No such ability');
    if (f.usedAbilities.includes(action.index)) throw new Error(`${ability.name} was already used`);
    f.usedAbilities.push(action.index);
    f.boost = 0.5;
    f.stats.moves++;
    events.push({ type: 'use', who: me, kind: 'ability', name: ability.name, text: ability.effect, attackType: f.types[0] });
    events.push({ type: 'boost', who: me, amount: 0.5 });
  } else if (action.type === 'rest') {
    const gained = Math.min(1, MAX_ENERGY - f.energy);
    f.energy += gained;
    events.push({ type: 'use', who: me, kind: 'rest', name: 'Rest' });
    events.push({ type: 'energy', who: me, amount: gained, energy: f.energy });
  } else {
    throw new Error('Unknown action');
  }
  battle.log.push({ who: me, action, events });

  if (foe.hp <= 0) {
    battle.over = true;
    battle.winner = me;
    events.push({ type: 'ko', who: 1 - me }, { type: 'end', winner: me });
    return events;
  }
  battle.turn = 1 - me;
  if (battle.turn === 0) battle.round++;
  if (battle.round > MAX_ROUNDS) {
    battle.over = true;
    const [a, b] = battle.fighters;
    battle.winner = a.hp / a.maxHp === b.hp / b.maxHp ? null : a.hp / a.maxHp > b.hp / b.maxHp ? 0 : 1;
    events.push({ type: 'end', winner: battle.winner, timeUp: true });
    return events;
  }
  events.push(...startTurn(battle));
  return events;
}

/** The computer's move: a knockout if it can, else the best damage it can afford, else an ability, else rest. */
export function cpuChoice(battle) {
  const f = battle.fighters[battle.turn];
  const foe = battle.fighters[1 - battle.turn];
  const options = f.attacks.map((a, index) => ({ a, index, cost: attackCost(a), dmg: expectedDamage(f, foe, a, battle.weather) }))
    .filter((o) => o.cost <= f.energy);
  const ko = options.filter((o) => o.dmg >= foe.hp).sort((x, y) => x.cost - y.cost)[0];
  if (ko) return { type: 'attack', index: ko.index };
  const best = options.filter((o) => o.dmg > 0).sort((x, y) => y.dmg - x.dmg)[0];
  const ability = f.abilities.findIndex((_, i) => !f.usedAbilities.includes(i));
  // Power up first when the boost would matter and nothing better is ready.
  if (ability >= 0 && !f.boost && (!best || best.dmg < foe.hp / 3)) return { type: 'ability', index: ability };
  if (best) return { type: 'attack', index: best.index };
  const heal = options.find((o) => (o.a.damage?.base ?? 0) === 0 && /heal/i.test(o.a.effect ?? '') && f.hp < f.maxHp * 0.6);
  if (heal) return { type: 'attack', index: heal.index };
  return { type: 'rest' };
}
