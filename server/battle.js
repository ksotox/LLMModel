// Battle data for PokéBattles, taken from the card itself: HP, types, the printed attacks (cost,
// damage, text), abilities, weakness, resistance and the Pokédex number that links to a 3D model.
// TCGdex (English and Japanese) and the Pokémon TCG dataset already send all of this; the rest of
// the app keeps only a few fields, so it's read again here (both clients cache it for a day).

import { PtcgDataClient } from './ptcgData.js';

const num = (v) => {
  const n = Number(String(v ?? '').match(/\d+/)?.[0]);
  return Number.isFinite(n) ? n : null;
};

/** "30" → {base 30}; "30+" → {base 30, mod '+'}; "20×" / "20x" → {base 20, mod 'x'}; none → {base 0}. */
export function parseDamage(value) {
  if (typeof value === 'number') return { base: value, mod: null, text: String(value) };
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d+)\s*([+×x*-])?/i);
  if (!m) return { base: 0, mod: null, text: s };
  const mod = m[2] === '+' ? '+' : m[2] && /[×x*]/i.test(m[2]) ? 'x' : null;
  return { base: Number(m[1]), mod, text: s };
}

/** "×2" → { mult: 2 }; "+20" → { add: 20 }; "-30" → { sub: 30 }. */
export function parseModifier(value) {
  const s = String(value ?? '').trim();
  const n = num(s);
  if (n == null) return {};
  if (/^[×x*]/i.test(s)) return { mult: n };
  if (/^\+/.test(s)) return { add: n };
  if (/^[-−]/.test(s)) return { sub: n };
  return {};
}

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

function fromTcgdex(raw) {
  return {
    dexIds: list(raw.dexId).map(Number).filter(Number.isFinite),
    hp: num(raw.hp),
    types: list(raw.types).map(String),
    stage: raw.stage ?? null,
    category: raw.category ?? null,
    attacks: list(raw.attacks).map((a) => ({
      name: text(a?.name, 60) || 'Attack',
      cost: list(a?.cost).map(String),
      damage: parseDamage(a?.damage),
      effect: text(a?.effect),
    })),
    abilities: list(raw.abilities).map((a) => ({ name: text(a?.name, 60) || 'Ability', kind: text(a?.type, 30), effect: text(a?.effect) })),
    weaknesses: list(raw.weaknesses).map((w) => ({ type: String(w?.type ?? ''), value: String(w?.value ?? '×2'), ...parseModifier(w?.value ?? '×2') })),
    resistances: list(raw.resistances).map((r) => ({ type: String(r?.type ?? ''), value: String(r?.value ?? '-30'), ...parseModifier(r?.value ?? '-30') })),
    retreat: Number.isFinite(Number(raw.retreat)) ? Number(raw.retreat) : null,
  };
}

function fromDataset(raw) {
  return {
    dexIds: list(raw.nationalPokedexNumbers).map(Number).filter(Number.isFinite),
    hp: num(raw.hp),
    types: list(raw.types).map(String),
    stage: list(raw.subtypes).find((s) => /basic|stage/i.test(s)) ?? null,
    category: raw.supertype === 'Pokémon' ? 'Pokemon' : raw.supertype ?? null,
    attacks: list(raw.attacks).map((a) => ({
      name: text(a?.name, 60) || 'Attack',
      cost: list(a?.cost).map(String),
      damage: parseDamage(a?.damage),
      effect: text(a?.text),
    })),
    abilities: list(raw.abilities).map((a) => ({ name: text(a?.name, 60) || 'Ability', kind: text(a?.type, 30), effect: text(a?.text) })),
    weaknesses: list(raw.weaknesses).map((w) => ({ type: String(w?.type ?? ''), value: String(w?.value ?? '×2'), ...parseModifier(w?.value ?? '×2') })),
    resistances: list(raw.resistances).map((r) => ({ type: String(r?.type ?? ''), value: String(r?.value ?? '-30'), ...parseModifier(r?.value ?? '-30') })),
    retreat: list(raw.retreatCost).length || null,
  };
}

/** The card's raw record from whichever source it's linked to (null when unlinked or offline). */
async function rawCard(catalog, tcgId) {
  if (!tcgId) return null;
  try {
    if (String(tcgId).startsWith(PtcgDataClient.PREFIX)) return { source: 'dataset', raw: await catalog.ptcg.rawCard(tcgId) };
    if (String(tcgId).startsWith('ja:')) return { source: 'tcgdex', raw: await catalog.tcgdexJa.card(tcgId) };
    return { source: 'tcgdex', raw: await catalog.tcgdex.card(tcgId) };
  } catch {
    return null;
  }
}

const FALLBACK_ATTACK = { name: 'Tackle', cost: ['Colorless'], damage: { base: 20, mod: null, text: '20' }, effect: '' };

/**
 * Everything a battle needs for one card. `fromCard` is false when the card's own data couldn't
 * be found (not linked yet, or offline): then it gets one basic attack and its stored HP.
 */
export async function battleData(catalog, card) {
  const found = await rawCard(catalog, card.tcg_id);
  const data = found?.raw ? (found.source === 'dataset' ? fromDataset(found.raw) : fromTcgdex(found.raw)) : null;
  const types = data?.types?.length ? data.types : String(card.types ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const attacks = data?.attacks?.length ? data.attacks : [FALLBACK_ATTACK];
  return {
    fromCard: Boolean(data?.attacks?.length),
    category: data?.category ?? card.category ?? null,
    dexIds: data?.dexIds ?? [],
    hp: data?.hp ?? num(card.hp) ?? 60,
    types: types.length ? types : ['Colorless'],
    stage: data?.stage ?? null,
    attacks: attacks.slice(0, 4),
    abilities: (data?.abilities ?? []).slice(0, 2),
    weaknesses: data?.weaknesses ?? [],
    resistances: data?.resistances ?? [],
    retreat: data?.retreat ?? null,
  };
}

/** Pokémon cards only: Trainers and Energy can't battle. */
export const isPokemonCard = (card, battle) => /pok[eé]mon|ポケモン/i.test(String(battle?.category ?? card.category ?? 'Pokemon'));
