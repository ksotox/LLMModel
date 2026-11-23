// Builds server/speciesData.json: every Pokémon's real height and weight (as the games' Pokédex
// gives them), body shape, game types and whether it has the Levitate ability, plus the forms whose
// size or types differ (Mega, Gigantamax, regional forms…). Taken from PokéAPI's data files on GitHub
// (github.com/PokeAPI/pokeapi, data/v2/csv). Run it again to pick up new Pokémon:
//   node scripts/species-build.mjs
// The app never fetches these files itself: the JSON it writes is part of the repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.POKEAPI_CSV_URL || 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'speciesData.json');

async function csv(name) {
  const res = await fetch(`${BASE}/${name}.csv`);
  if (!res.ok) throw new Error(`${name}.csv: HTTP ${res.status}`);
  const [head, ...rows] = (await res.text()).trim().split(/\r?\n/).map((l) => l.split(','));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const [pokemon, species, pokemonTypes, types, pokemonAbilities, abilities] = await Promise.all(
  ['pokemon', 'pokemon_species', 'pokemon_types', 'types', 'pokemon_abilities', 'abilities'].map(csv));

const typeName = new Map(types.map((t) => [t.id, t.identifier]));
const typesOf = new Map();
for (const t of pokemonTypes.sort((a, b) => a.slot - b.slot)) {
  if (!typesOf.has(t.pokemon_id)) typesOf.set(t.pokemon_id, []);
  typesOf.get(t.pokemon_id).push(typeName.get(t.type_id));
}
const levitate = abilities.find((a) => a.identifier === 'levitate')?.id;
const levitates = new Set(pokemonAbilities.filter((a) => a.ability_id === levitate).map((a) => a.pokemon_id));
const shapeOf = new Map(species.map((s) => [s.id, Number(s.shape_id) || 0]));
const nameOf = new Map(species.map((s) => [s.id, s.identifier]));

const out = { source: 'PokéAPI data/v2/csv (github.com/PokeAPI/pokeapi)', units: 'height m, weight kg', species: {}, names: {} };
// Names (PokéAPI's identifiers, e.g. "mr-mime") → National Pokédex number, to find a card's Pokémon by name.
for (const s of species) out.names[s.identifier] = Number(s.id);
// One entry per National Pokédex number: [height m, weight kg, shape id, "type,type", levitates (0/1), forms?]
for (const p of pokemon.filter((x) => x.is_default === '1')) {
  out.species[p.species_id] = [Number(p.height) / 10, Number(p.weight) / 10, shapeOf.get(p.species_id) ?? 0, (typesOf.get(p.id) ?? []).join(','), levitates.has(p.id) ? 1 : 0];
}
for (const p of pokemon.filter((x) => x.is_default !== '1')) {
  const base = out.species[p.species_id];
  const prefix = `${nameOf.get(p.species_id)}-`;
  if (!base || !p.identifier.startsWith(prefix)) continue;
  const h = Number(p.height) / 10;
  const w = Number(p.weight) / 10 || base[1]; // Gigantamax weights are unknown (0)
  const t = (typesOf.get(p.id) ?? []).join(',');
  if (!(h > 0) || (h === base[0] && w === base[1] && t === base[3])) continue; // a costume, same size
  (base[5] ??= {})[p.identifier.slice(prefix.length)] = [h, w, t, levitates.has(p.id) ? 1 : 0];
}
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`${Object.keys(out.species).length} species → ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
