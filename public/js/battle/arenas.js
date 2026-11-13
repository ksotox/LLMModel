// The places a PokéBattle can happen in, and the weather over it. Plain data (no 3D code), so the
// setup screen and the tests can use it without loading three.js.
//
// The three stadiums and the four kinds of weather follow the open-source fan game PokeBrawl
// (github.com/xjoje6/PokeBrawl, MIT): its Night, Floating and League stadiums and its sun, rain,
// sandstorm and snow. They are rebuilt here in this app's own graphics (public/js/battle/stadiums.js
// and weatherFx.js): no model, texture or code of that game is used.

export const ENVIRONMENTS = [
  { id: 'meadow', name: 'Meadow', about: 'The grass field by the lake, with woods and mountains.' },
  { id: 'night', name: 'Night Stadium', about: 'A packed stadium at night, under a ring of floodlights.' },
  { id: 'floating', name: 'Floating Stadium', about: 'A platform on a pillar over a deep pit, the crowd far below.' },
  { id: 'league', name: 'League Stadium', about: 'A stone coliseum on a cool, cloudy day.' },
];

export const WEATHERS = [
  { id: 'clear', name: 'Clear', about: 'No effect.' },
  { id: 'sun', name: 'Sunny', about: 'Fire attacks deal 50% more damage, Water attacks half.' },
  { id: 'rain', name: 'Rain', about: 'Water attacks deal 50% more damage, Fire attacks half.' },
  { id: 'sand', name: 'Sandstorm', about: 'At the start of its turn, a Pokémon that isn’t Fighting or Metal type loses 10 HP (never its last 10).' },
  { id: 'snow', name: 'Snow', about: 'Water-type Pokémon take 10 less damage from attacks.' },
];

const KEY = 'pokedex.battleArena';
const known = (list, id, fallback) => (list.some((x) => x.id === id) ? id : fallback);

/** The arena chosen last time: { environment, weather }. */
export function savedArena(storage = globalThis.localStorage) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}; } catch { /* nothing saved, or storage unavailable */ }
  return { environment: known(ENVIRONMENTS, saved.environment, 'meadow'), weather: known(WEATHERS, saved.weather, 'clear') };
}

export function saveArena(arena, storage = globalThis.localStorage) {
  const clean = { environment: known(ENVIRONMENTS, arena?.environment, 'meadow'), weather: known(WEATHERS, arena?.weather, 'clear') };
  try { storage?.setItem(KEY, JSON.stringify(clean)); } catch { /* storage unavailable */ }
  return clean;
}

export const environmentName = (id) => ENVIRONMENTS.find((e) => e.id === id)?.name ?? 'Meadow';
export const weatherName = (id) => WEATHERS.find((w) => w.id === id)?.name ?? 'Clear';
