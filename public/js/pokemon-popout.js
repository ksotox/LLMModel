// "3D Pop-out" for the card gallery (from the owner's artwork pop-out package). With the switch on,
// each tile shows its card standing on a glowing pedestal with an aura and sparkles, and the
// Pokémon coming out of it:
//   1. a copy with its own diorama (delivered, or made on this device: dioramas.js) shows it; cards
//      with prepared scene art (registerArtwork; four ship with the app) show that scene;
//   2. other Pokémon cards get their 3D model drawn standing in front of the card (popoutRender.js);
//   3. anything else (Trainers, Energy, no model, no WebGL) keeps the tilted card with its glow.
// Pure helpers at the top (no DOM), so tests can import them.

export const POPOUT_STORAGE_KEY = 'pokedex.artworkPopout';

// Prepared scenes, cropped from the owner's mockup. Keys are SET:NUMBER (number without zeros).
const ART = {
  'DRI:190': { scene: '/popout-art/scenes/DRI-190.webp', effect: 'fire' },
  'CRI:104': { scene: '/popout-art/scenes/CRI-104.webp', effect: 'poison' },
  'PBL:31': { scene: '/popout-art/scenes/PBL-031.webp', effect: 'water' },
  'DRI:20': { scene: '/popout-art/scenes/DRI-020.webp', effect: 'grass' },
};

/** SET:NUMBER for a card, whether its number is stored as "190", "190/182" or "020". */
export function cardArtworkKey(card) {
  const set = String(card.set_code ?? card.setCode ?? '').trim().toUpperCase();
  const raw = String(card.number ?? card.card_number ?? '').trim().split('/')[0].trim();
  const match = raw.match(/^0*(\d+)$/);
  return `${set}:${match ? Number(match[1]) : raw.toUpperCase()}`;
}

/** The card's types as a list ("Fire, Water", ["Fire"] or a single `type`). */
function typeList(card) {
  if (Array.isArray(card.types)) return card.types;
  if (typeof card.types === 'string' && card.types.trim()) return card.types.split(',');
  return [card.type ?? ''];
}

/** The glow colour for a card: its prepared art's, else from its type. */
export function artworkForCard(card) {
  const asset = ART[cardArtworkKey(card)];
  const type = String(typeList(card)[0] ?? '').trim().toLowerCase(); // a dual-type card glows in its first type
  const effect = asset?.effect ?? (
    /fire/.test(type) ? 'fire'
      : /water/.test(type) ? 'water'
        : /lightning|electric/.test(type) ? 'electric'
          : /psychic|poison/.test(type) ? 'poison'
            : /grass|bug/.test(type) ? 'grass'
              : /dark/.test(type) ? 'dark'
                : /fighting/.test(type) ? 'fighting'
                  : /metal|steel/.test(type) ? 'metal'
                    : /dragon/.test(type) ? 'dragon'
                      : 'holo');
  return { effect, ...(asset ?? {}) };
}

/**
 * Add prepared art for one printing: { scene } (a finished picture, card and Pokémon together) or
 * { background, foreground } (a clean card picture plus the Pokémon cut out on transparency).
 */
export function registerArtwork(key, spec) {
  if (!/^[A-Z0-9-]+:\w+$/i.test(key)) throw new Error('Use SET:NUMBER, e.g. DRI:190');
  if (!(spec?.scene || (spec?.background && spec?.foreground))) throw new Error('Supply a scene, or a background and a foreground');
  const [set, number] = key.toUpperCase().split(':');
  ART[`${set}:${/^\d+$/.test(number) ? Number(number) : number}`] = { ...spec };
}

/** Trainer and Energy cards have no Pokémon to pop out. */
export const hasPokemon = (card) => !/trainer|energy|トレーナー|エネルギー/i.test(String(card.category ?? ''));

export function isPopoutOn() {
  try { return localStorage.getItem(POPOUT_STORAGE_KEY) === '1'; } catch { return false; }
}

export function setPopoutOn(on) {
  try { localStorage.setItem(POPOUT_STORAGE_KEY, on ? '1' : '0'); } catch { /* storage blocked: still works for this visit */ }
}

/** The switch, built with the app's h() helper. */
export function popoutToggle(h, on, onChange) {
  return h('label.pfx-toggle',
    h('span.pfx-cube', { 'aria-hidden': 'true' }, '◇'),
    h('span', '3D Pop-out'),
    h('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked), 'aria-label': '3D Pop-out artwork' }),
    h('span.pfx-track', { 'aria-hidden': 'true' }));
}

/**
 * The picture part of a tile with the pop-out on (the rest of the tile is unchanged).
 * `onModelSlot(img, card)` is called with the empty image that the 3D picture will fill.
 */
export function popoutImageNodes(h, card, cardImage, secondaryImage, { compact = false, onModelSlot, diorama = null } = {}) {
  // A copy's own diorama (server/cardDioramas.js) is a finished scene, like the prepared ones.
  const art = diorama ? { ...artworkForCard(card), scene: diorama } : artworkForCard(card);
  const scene = Boolean(art.scene);
  let modelSlot = null;
  if (!scene && !art.foreground && hasPokemon(card) && onModelSlot) {
    modelSlot = h('img.pfx-model', { alt: '', 'aria-hidden': 'true', decoding: 'async' });
    onModelSlot(modelSlot, card);
  }
  return [
    h('span.pfx-aura', { 'aria-hidden': 'true' }),
    h('span.pfx-pedestal', { 'aria-hidden': 'true' }),
    h('span.pfx-particles', { 'aria-hidden': 'true' }),
    h('img', { src: scene ? art.scene : (art.background || cardImage), alt: '', loading: 'lazy', class: scene ? 'pfx-scene' : 'pfx-face' }),
    !scene && art.foreground && h('img.pfx-foreground', { src: art.foreground, alt: '', loading: 'lazy', 'aria-hidden': 'true' }),
    modelSlot,
    !scene && !compact && secondaryImage && h('img.card-inset', { src: secondaryImage, alt: '', loading: 'lazy' }),
  ];
}
