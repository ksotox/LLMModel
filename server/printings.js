// Which printings (the app's "variants") a card exists in, so the variant suggestion can rule out
// impossible ones. A common Voltorb exists as normal or reverse holo; an ex is always holo; an
// Illustration Rare or a secret rare (number above the set total) is always full art.
//
// Sources, best first: TCGdex's variant list (`variants_detailed`, or the older `variants` yes/no
// object), then which TCGplayer price lines exist, then the rarity rules alone.

const TYPE_TO_VARIANT = { normal: 'normal', reverse: 'reverse-holo', holo: 'holo' };
const PRICE_LINE_TO_VARIANT = { normal: 'normal', holofoil: 'holo', 'reverse-holofoil': 'reverse-holo', reverseHolofoil: 'reverse-holo' };

const FULL_ART = /illustration rare|ultra rare|hyper rare|secret rare|shiny ultra|rare rainbow|full art|trainer gallery|amazing rare|mega hyper/i;
const ALWAYS_HOLO = /double rare|rare holo (v|vmax|vstar|ex|gx)\b|ace spec|radiant/i;

const FOIL_NAMES = {
  pokeball: 'Poké Ball pattern', masterball: 'Master Ball pattern', greatball: 'Great Ball pattern', ultraball: 'Ultra Ball pattern',
  loveball: 'Love Ball pattern', friendball: 'Friend Ball pattern', quickball: 'Quick Ball pattern', duskball: 'Dusk Ball pattern',
  'team-rocket': 'Team Rocket pattern', energy: 'Energy symbol pattern', cosmos: 'cosmos foil', 'cracked-ice': 'cracked ice foil',
};
const TYPE_NAMES = { normal: 'normal', reverse: 'reverse holo', holo: 'holo' };

const numberIsSecret = (number, total) => {
  const n = Number(String(number ?? '').match(/^\d+$/)?.[0]);
  return Boolean(total) && Number.isFinite(n) && n > Number(total);
};

/**
 * @returns {{ allowed: string[], fixed: string|null, reason: string|null, notes: string[], source: string|null }}
 *   allowed: variants this card exists in (empty = unknown, anything goes)
 *   fixed:   the only possible variant, when there's just one
 *   notes:   special printings worth checking by eye (pattern foils, stamps)
 */
export function printingsFor({ variantsDetailed, variants, priceLines = [], rarity, number, setTotal, setName, setId } = {}) {
  const notes = [];
  let found = [];
  let source = null;

  if (Array.isArray(variantsDetailed) && variantsDetailed.length) {
    found = variantsDetailed.map((v) => TYPE_TO_VARIANT[v?.type]).filter(Boolean);
    source = 'TCGdex';
    for (const v of variantsDetailed) {
      const foil = v?.foil && (FOIL_NAMES[v.foil] ?? `${v.foil} foil`);
      if (foil) notes.push(`Also printed as a ${foil} ${TYPE_NAMES[v.type] ?? v.type}: look for the pattern in the foil.`);
      for (const stamp of v?.stamp ?? []) notes.push(`Also printed with a "${String(stamp).replace(/-/g, ' ')}" stamp.`);
    }
  } else if (variants && typeof variants === 'object' && Object.keys(variants).length) {
    found = Object.entries(variants).filter(([, yes]) => yes === true).map(([k]) => TYPE_TO_VARIANT[k]).filter(Boolean);
    source = 'TCGdex';
    if (variants.firstEdition) notes.push('Also printed as 1st Edition (stamp at the bottom left of the art).');
  }
  if (!found.length && priceLines.length) {
    found = priceLines.map((k) => PRICE_LINE_TO_VARIANT[k]).filter(Boolean);
    source = found.length ? 'TCGplayer prices' : null;
  }
  const allowed = [...new Set(found)];

  const promo = !setTotal && (/promo/i.test(setName ?? '') || /p$/.test(setId ?? ''));
  if (promo) return { allowed: ['promo'], fixed: 'promo', reason: 'Promo cards are recorded as Promo.', notes, source: source ?? 'set' };
  if (numberIsSecret(number, setTotal)) {
    return { allowed: ['full-art'], fixed: 'full-art', reason: `Its number is above the set total (${number}/${setTotal}): a secret rare, always full art.`, notes, source: 'number' };
  }
  if (FULL_ART.test(rarity ?? '')) {
    return { allowed: ['full-art'], fixed: 'full-art', reason: `${rarity} cards are always full art.`, notes, source: 'rarity' };
  }
  if (ALWAYS_HOLO.test(rarity ?? '') && !allowed.includes('reverse-holo')) {
    return { allowed: ['holo'], fixed: 'holo', reason: `${rarity} cards are always holo.`, notes, source: 'rarity' };
  }
  if (allowed.length === 1) {
    const name = { normal: 'normal', holo: 'holo', 'reverse-holo': 'reverse holo' }[allowed[0]];
    return { allowed, fixed: allowed[0], reason: `This card was only printed as ${name}.`, notes, source };
  }
  return { allowed, fixed: null, reason: null, notes, source };
}
