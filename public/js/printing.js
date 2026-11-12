// Printing details are independent of rarity and the catalog's card identity.
export const PRINTING_OPTIONS = {
  foil_pattern: ['unknown', 'standard', 'cosmos', 'cracked-ice', 'crosshatch', 'starlight', 'tinsel', 'sheen', 'water-web', 'vertical-line', 'sequin', 'confetti', 'glitter', 'rainbow', 'mirror', 'gold', 'poke-ball', 'great-ball', 'ultra-ball', 'master-ball', 'dusk-ball', 'love-ball', 'friend-ball', 'quick-ball', 'energy', 'team-rocket', 'other'],
  texture: ['unknown', 'smooth', 'textured'],
  stamp: ['none', 'prerelease', 'staff', 'pokemon-center', 'set-logo', 'play-pokemon', 'league', 'winner', 'gamestop', 'trick-or-trade', '25th-anniversary', '30th-anniversary', 'other'],
  edition: ['standard', 'first-edition', 'other', 'unknown'],
};
export const PRINTING_DEFAULTS = { foil_pattern: 'unknown', texture: 'unknown', stamp: 'none', edition: 'standard' };
export const printingLabel = (s) => s === 'unknown' ? 'Unknown / unverified' : s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
export function normalizeStamp(value) {
  if (typeof value !== 'string') return null;
  const stamps = [...new Set(value.split('+'))].filter((s) => s && s !== 'none').sort();
  return stamps.every((s) => PRINTING_OPTIONS.stamp.includes(s)) ? stamps.join('+') || 'none' : null;
}
export function printingFields(card, h, onChange = () => {}) {
  return h('div.field-row.printing-fields', Object.entries(PRINTING_OPTIONS).map(([key, values]) => {
    if (key === 'stamp') {
      const summary = h('summary', printingLabel(card.stamp ?? 'none'));
      const inputs = [];
      const stamps = new Set((card.stamp ?? 'none').split('+'));
      const choices = values.map((value) => {
        const input = h('input', { type: 'checkbox', checked: stamps.has(value), value, onchange: () => {
          if (value === 'none' && input.checked) inputs.forEach((i) => { if (i !== input) i.checked = false; });
          if (value !== 'none' && input.checked) inputs[0].checked = false;
          card.stamp = normalizeStamp(inputs.filter((i) => i.checked).map((i) => i.value).join('+'));
          inputs[0].checked = card.stamp === 'none';
          summary.textContent = printingLabel(card.stamp); onChange();
        } });
        inputs.push(input); return h('label.stamp-choice', input, printingLabel(value));
      });
      return h('div.field', h('span', 'Special stamps'), h('details.stamp-options', summary, choices));
    }
    const select = h('select', { 'aria-label': printingLabel(key.replace('_', '-')), onchange: () => { card[key] = select.value; onChange(); } }, values.map((v) => h('option', { value: v }, printingLabel(v))));
    select.value = card[key] ?? PRINTING_DEFAULTS[key];
    return h('label.field', h('span', printingLabel(key.replace('_', '-'))), select);
  }));
}
export function printingSummary(card) {
  return Object.keys(PRINTING_DEFAULTS).filter((k) => card[k] && card[k] !== PRINTING_DEFAULTS[k]).map((k) => printingLabel(card[k])).join(' · ');
}
