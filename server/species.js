// Each Pokémon's real size and build, for drawing its model to scale and choosing how it moves:
// height (m), weight (kg), body shape, game types and Levitate, per National Pokédex number, with the
// forms that differ (Mega, Gigantamax, Alolan…). From server/speciesData.json, built from PokéAPI's
// data files by scripts/species-build.mjs.

import fs from 'node:fs';

const DATA = JSON.parse(fs.readFileSync(new URL('./speciesData.json', import.meta.url), 'utf8'));

/** PokéAPI's body shapes, by id. */
export const SHAPES = ['', 'ball', 'squiggle', 'fish', 'arms', 'blob', 'upright', 'legs', 'quadruped', 'wings', 'tentacles', 'heads', 'humanoid', 'bug-wings', 'armor'];

/**
 * The PokéAPI form a 3D model shows, from the model's folder in the Pokémon 3D API ('x' → 'mega-x',
 * 'gmax' → 'gmax', 'alolan' → 'alola'). Null: the species' usual form (regular, shiny, costumes).
 */
export function formKey(folder) {
  const f = String(folder ?? '').toLowerCase().replace(/shiny/g, '');
  if (/^s?x$/.test(f)) return 'mega-x';
  if (/^s?y$/.test(f)) return 'mega-y';
  if (/mega/.test(f)) return 'mega';
  return { gmax: 'gmax', alolan: 'alola', galar: 'galar', hisuian: 'hisui', primal: 'primal', origin: 'origin' }[f] ?? null;
}

/**
 * One Pokémon's size and build: { dexId, heightM, weightKg, shape, types: ['fire', 'flying'],
 * levitates }, or null when the number is unknown. `form`: a key from formKey().
 */
export function speciesInfo(dexId, form = null) {
  const row = DATA.species[Number(dexId)];
  if (!row) return null;
  const [heightM, weightKg, shape, types, levitates, forms] = row;
  const f = form ? forms?.[form] : null;
  return {
    dexId: Number(dexId),
    heightM: f?.[0] ?? heightM,
    weightKg: f?.[1] ?? weightKg,
    shape: SHAPES[shape] ?? '',
    types: String(f?.[2] ?? types).split(',').filter(Boolean),
    levitates: Boolean(f ? f[3] : levitates),
    ...(f ? { form } : {}),
  };
}

const letters = (s) => String(s).toLowerCase().normalize('NFKD').replace(/♀/g, 'f').replace(/♂/g, 'm').replace(/[^a-z0-9]/g, '');
const BY_LETTERS = new Map(Object.entries(DATA.names).map(([name, id]) => [letters(name), id]));
const PREFIXES = /^(dark|light|shining|radiant|shadow|alolan|galarian|hisuian|paldean|mega|m|primal|origin forme|single strike|rapid strike)\s+/i;
const SUFFIXES = /[\s-]+(ex|gx|v|vmax|vstar|v-union|break|lv\.?\s?x|prime|legend|star|δ|☆|◇|x|y|\d+)$/i;

/**
 * Which Pokémon (and form) a card shows, from its name alone: "Alolan Vulpix" → Vulpix, Alolan form;
 * "Team Rocket's Moltres ex" → Moltres; "Mega Charizard X ex" → Charizard, Mega X; "Charizard VMAX"
 * → its Gigantamax size. speciesInfo() or null.
 */
export function speciesForCardName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  let rest = raw.replace(/^.*?['’]s\s+/, ''); // Team Rocket's, Misty's, Erika's…
  const prefixes = [];
  for (let m; (m = rest.match(PREFIXES));) { prefixes.push(m[1].toLowerCase()); rest = rest.slice(m[0].length); }
  const suffixes = [];
  for (let m; (m = rest.match(SUFFIXES));) { suffixes.push(m[1].toLowerCase()); rest = rest.slice(0, -m[0].length); }
  let dexId = BY_LETTERS.get(letters(rest));
  // "Pikachu & Zekrom-GX", "Lillie's Clefairy": the first word that is a Pokémon.
  if (!dexId) for (const word of rest.split(/[\s&-]+/)) if ((dexId = BY_LETTERS.get(letters(word)))) break;
  if (!dexId) return null;
  const has = (key) => Boolean(DATA.species[dexId]?.[5]?.[key]);
  const isMega = prefixes.includes('mega') || prefixes.includes('m');
  const wanted = [
    prefixes.includes('alolan') && 'alola', prefixes.includes('galarian') && 'galar', prefixes.includes('hisuian') && 'hisui',
    prefixes.includes('primal') && 'primal', prefixes.includes('origin forme') && 'origin',
    isMega && suffixes.includes('x') && 'mega-x', isMega && suffixes.includes('y') && 'mega-y', isMega && 'mega',
    isMega && 'mega-x', suffixes.includes('vmax') && 'gmax',
  ].filter(Boolean);
  return speciesInfo(dexId, wanted.find(has) ?? null);
}
