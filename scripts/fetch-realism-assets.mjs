// Downloads the High-graphics scenery set from Poly Haven (polyhaven.com, every asset CC0) into
// public/assets/realism/, and writes a manifest of what came from where. Run by the
// "Realism assets" workflow (GitHub's runners can reach Poly Haven; the dev sandbox cannot), or by
// hand: `node scripts/fetch-realism-assets.mjs`.
//
// Each slot lists Poly Haven asset ids in order of preference; the first one that exists is used.
// Textures come at 1K (colour, normal, roughness), skies as 1K HDR, models as 1K glTF.
// The whole set is capped (MAX_TOTAL) so the repository stays small.

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.polyhaven.com';
const OUT = path.resolve('public/assets/realism');
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_MODEL = 6 * 1024 * 1024;

const SLOTS = [
  { slot: 'sky-day', type: 'hdris', ids: ['kloofendal_48d_partly_cloudy_puresky', 'kloofendal_43d_clear_puresky', 'rolling_hills', 'meadow_2', 'spruit_sunrise'] },
  { slot: 'sky-sunset', type: 'hdris', ids: ['venice_sunset', 'kloofendal_misty_morning_puresky', 'the_sky_is_on_fire', 'sunflowers_puresky'] },
  // (A full, leafy grass first: the sparse one showed bare soil between the blades.)
  { slot: 'grass', type: 'textures', ids: ['leafy_grass', 'grass_meadow', 'sparse_grass', 'aerial_grass_rock'] },
  { slot: 'soil', type: 'textures', ids: ['forest_ground_04', 'forrest_ground_01', 'brown_mud_leaves_01', 'forest_leaves_02'] },
  { slot: 'rock', type: 'textures', ids: ['rock_face', 'aerial_rocks_02', 'rocky_terrain_02', 'rock_wall_08'] },
  { slot: 'cliff', type: 'textures', ids: ['rock_06', 'aerial_rocks_04', 'cliff_side', 'rock_boulder_dry'] },
  { slot: 'sand', type: 'textures', ids: ['coast_sand_01', 'aerial_beach_01', 'sand_01', 'coast_sand_02'] },
  { slot: 'snow', type: 'textures', ids: ['snow_02', 'snow_03', 'snow_field_aerial'] },
  { slot: 'bark', type: 'textures', ids: ['pine_bark', 'bark_willow', 'bark_brown_02'] },
  { slot: 'planks', type: 'textures', ids: ['weathered_planks', 'wood_planks', 'old_planks_02', 'brown_planks_03', 'wood_planks_grey'] },
  { slot: 'tree-broad', type: 'models', ids: ['island_tree_01', 'island_tree_02', 'tree_small_02', 'jacaranda_tree'] },
  { slot: 'tree-pine', type: 'models', ids: ['fir_sapling', 'pine_sapling_small', 'pine_tree_01', 'fir_tree_01'] },
  { slot: 'rocks', type: 'models', ids: ['rock_moss_set_01', 'rock_moss_set_02', 'boulder_01', 'namaqualand_boulder_02'] },
  { slot: 'shrub', type: 'models', ids: ['shrub_01', 'shrub_04', 'fern_02'] },
];

const getJson = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'pokedex-realism-assets' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': 'pokedex-realism-assets' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** The files to fetch for an asset: [{ url, size, name }] (name relative to the slot folder). */
function filesFor(type, files) {
  if (type === 'hdris') {
    const f = files.hdri?.['1k']?.hdr;
    return f ? [{ url: f.url, size: f.size, name: 'sky.hdr' }] : [];
  }
  if (type === 'textures') {
    const pick = (key, name) => { const f = files[key]?.['1k']?.jpg; return f ? [{ url: f.url, size: f.size, name }] : []; };
    return [...pick('Diffuse', 'color.jpg'), ...pick('nor_gl', 'normal.jpg'), ...pick('Rough', 'rough.jpg')];
  }
  const g = files.gltf?.['1k']?.gltf;
  if (!g) return [];
  const main = { url: g.url, size: g.size, name: 'model.gltf' };
  const inc = Object.entries(g.include ?? {}).map(([rel, f]) => ({ url: f.url, size: f.size, name: rel, include: true }));
  return [main, ...inc];
}

const lists = {};
const manifest = { source: 'Poly Haven (polyhaven.com)', licence: 'CC0 1.0', fetched: new Date().toISOString(), assets: {} };
let total = 0;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const { slot, type, ids } of SLOTS) {
  lists[type] ??= await getJson(`${API}/assets?t=${type}`);
  const id = ids.find((x) => lists[type][x]);
  if (!id) { console.log(`- ${slot}: none of ${ids.join(', ')} exist; skipped`); continue; }
  const files = filesFor(type, await getJson(`${API}/files/${id}`));
  const size = files.reduce((s, f) => s + (f.size ?? 0), 0);
  if (!files.length) { console.log(`- ${slot}: ${id} has no 1K files; skipped`); continue; }
  if (type === 'models' && size > MAX_MODEL) { console.log(`- ${slot}: ${id} is ${(size / 1e6).toFixed(1)} MB; skipped`); continue; }
  if (total + size > MAX_TOTAL) { console.log(`- ${slot}: ${id} would pass the size cap; skipped`); continue; }
  const dir = path.join(OUT, slot);
  let got = 0;
  for (const f of files) got += await download(f.url, path.join(dir, f.name));
  total += got;
  manifest.assets[slot] = { id, type, name: lists[type][id].name, page: `https://polyhaven.com/a/${id}`, files: files.map((f) => f.name), bytes: got };
  console.log(`✓ ${slot}: ${id} (${(got / 1e6).toFixed(2)} MB)`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Total ${(total / 1e6).toFixed(1)} MB in ${Object.keys(manifest.assets).length} assets.`);
