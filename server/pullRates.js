// Estimated chance of pulling one specific card from one booster pack.
//
// chance = (how many cards of that rarity an average pack holds) / (how many cards of that rarity the set has)
//
// Per-pack rates for the special rarities come from TCGplayer's published pack-opening studies:
//   Scarlet & Violet base set (8,000+ packs), 151, Temporal Forces, Phantasmal Flames (5,000+ packs).
// Sets without their own study use the average for their era. Rates vary between sets and products,
// so the result is always presented as an estimate.

const SOURCES = {
  sv: 'TCGplayer study of 8,000+ Scarlet & Violet packs (era average)',
  me: 'TCGplayer study of 5,000+ Phantasmal Flames packs (era average)',
};

const ERA_RATES = {
  sv: {
    'double rare': 1 / 7,
    'ultra rare': 1 / 15,
    'illustration rare': 1 / 13,
    'special illustration rare': 1 / 32,
    'hyper rare': 1 / 54,
    'ace spec rare': 1 / 20,
  },
  me: {
    'double rare': 0.2077,
    'ultra rare': 0.0806,
    'illustration rare': 0.1097,
    'special illustration rare': 0.0125,
    'mega hyper rare': 1 / 1260,
  },
};

const SET_RATES = {
  SVI: { era: 'sv', source: 'TCGplayer study of 8,000+ Scarlet & Violet base set packs', rates: ERA_RATES.sv },
  MEW: {
    era: 'sv',
    source: 'TCGplayer study of Scarlet & Violet—151 packs',
    rates: { 'double rare': 1 / 8, 'ultra rare': 1 / 16, 'illustration rare': 1 / 12, 'special illustration rare': 1 / 32, 'hyper rare': 1 / 51 },
  },
  TEF: {
    era: 'sv',
    source: 'TCGplayer study of 8,000+ Temporal Forces packs',
    rates: { 'double rare': 1 / 6, 'ultra rare': 1 / 15, 'illustration rare': 1 / 13, 'special illustration rare': 1 / 86, 'hyper rare': 1 / 139, 'ace spec rare': 1 / 20 },
  },
  PFL: { era: 'me', source: 'TCGplayer study of 5,000+ Phantasmal Flames packs', rates: ERA_RATES.me },
};

// Special sets with a different pack layout (shiny vaults, all-holo packs, 30th anniversary...): no estimate.
const NON_STANDARD = new Set(['PAF', 'PRE', 'BLK', 'WHT', 'ASC', '30C', 'SVP', 'MEP', 'CRZ', 'CEL', 'SHF', 'CPA', 'PGO']);

const ERA_BY_SERIES = { 'Scarlet & Violet': 'sv', 'Mega Evolution': 'me' };

// Ordinary slots in a 10-card SV / ME era pack.
const COMMONS_PER_PACK = 4;
const UNCOMMONS_PER_PACK = 3;
const REVERSE_SLOTS = 2;
// Hits that take the rare slot, and hits that take a reverse-holo slot.
const RARE_SLOT_HITS = ['double rare', 'ultra rare', 'hyper rare', 'mega hyper rare'];
const REVERSE_SLOT_HITS = ['illustration rare', 'special illustration rare', 'ace spec rare'];

export function normaliseRarity(rarity) {
  return String(rarity ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {object} p
 * @param {string} p.rarity    the card's rarity, e.g. "Double Rare"
 * @param {string} p.variant   our variant ("reverse-holo" changes the maths for commons/uncommons/rares)
 * @param {object} p.profile   from PtcgDataClient.rarityProfile: { setCode, series, counts }
 * @returns {{ chance: number, oneIn: number, source: string } | null}
 */
export function pullChance({ rarity, variant, profile }) {
  const r = normaliseRarity(rarity);
  if (!r || !profile?.counts) return null;
  const code = String(profile.setCode ?? '').toUpperCase();
  if (NON_STANDARD.has(code)) return null;
  const set = SET_RATES[code];
  const era = set?.era ?? ERA_BY_SERIES[profile.series];
  if (!era) return null;
  const rates = { ...ERA_RATES[era], ...(set?.rates ?? {}) };
  const source = set?.source ?? SOURCES[era];
  const count = (name) => profile.counts[name] ?? 0;
  const sum = (names) => names.reduce((total, name) => total + (count(name) ? rates[name] ?? 0 : 0), 0);

  let expected; // how many cards of this kind an average pack holds
  let pool; // how many different cards share that slot
  if (variant === 'reverse-holo' && ['common', 'uncommon', 'rare'].includes(r)) {
    expected = REVERSE_SLOTS - sum(REVERSE_SLOT_HITS);
    pool = count('common') + count('uncommon') + count('rare');
  } else if (r === 'common') {
    [expected, pool] = [COMMONS_PER_PACK, count('common')];
  } else if (r === 'uncommon') {
    [expected, pool] = [UNCOMMONS_PER_PACK, count('uncommon')];
  } else if (r === 'rare') {
    [expected, pool] = [1 - sum(RARE_SLOT_HITS), count('rare')];
  } else if (rates[r] != null) {
    [expected, pool] = [rates[r], count(r)];
  } else {
    return null;
  }
  if (!pool || expected <= 0) return null;
  const chance = Math.min(1, expected / pool);
  return { chance, oneIn: Math.max(1, Math.round(1 / chance)), source };
}
