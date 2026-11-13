// The Sanctuary's overlay (the owner's module, fitted to this app): the trainer chooser, the radial
// wheel that opens on a creature (Follow / Stay, Pet, Card, Battle) and the stamina ring. Plain DOM
// over the 3D view; the page pauses the trainer while the wheel or the chooser is open.

import { h } from '../ui.js';

export const TRAINER_PRESETS = [
  { id: 'ranger', name: 'Meadow Ranger', hat: 0xd97706, shirt: 0x2563eb, skin: 0xf1c27d },
  { id: 'ace', name: 'Ace Explorer', hat: 0xdc2626, shirt: 0x1f2937, skin: 0xe0ac69 },
  { id: 'botanist', name: 'Field Botanist', hat: 0x16a34a, shirt: 0xfef3c7, skin: 0x8d5524 },
];

const KEY = 'pokedex.trainer';
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/** The trainer chosen last time (the first one otherwise). */
export function savedTrainer(storage = globalThis.localStorage) {
  let id = null;
  try { id = storage?.getItem(KEY); } catch { /* storage unavailable */ }
  return TRAINER_PRESETS.find((p) => p.id === id) ?? TRAINER_PRESETS[0];
}

/**
 * Build the overlay into `host`. Returns { openRadial(creature), closeRadial(), isOpen(),
 * openTrainerModal(), updateStamina(stamina, exhausted) }.
 */
export function initSanctuaryUI(host, { onSelectTrainer, onRadialAction, storage = globalThis.localStorage }) {
  let active = null;
  const title = h('div.radial-center');
  const button = (pos, action, label) => h('button.radial-btn', {
    type: 'button', class: pos, role: 'menuitem', 'data-action': action,
    onclick: () => { const c = active; closeRadial(); if (c) onRadialAction(action, c); },
  }, label);
  const follow = button('pos-top', 'follow', 'Follow');
  const radial = h('div.radial-menu', { role: 'menu', hidden: true }, title, follow, button('pos-right', 'pet', 'Pet'), button('pos-bottom', 'inspect', 'Card'), button('pos-left', 'battle', 'Battle'));

  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('viewBox', '0 0 44 44');
  ring.setAttribute('class', 'stamina-ring');
  ring.setAttribute('aria-hidden', 'true');
  ring.setAttribute('hidden', ''); // (an SVG element has no `hidden` property)
  const back = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const [el, cls] of [[back, 'ring-bg'], [fill, 'ring-fg']]) {
    el.setAttribute('cx', '22'); el.setAttribute('cy', '22'); el.setAttribute('r', '18'); el.setAttribute('class', cls);
    ring.append(el);
  }

  const current = savedTrainer(storage);
  const swatches = TRAINER_PRESETS.map((preset) => h('button.trainer-swatch', {
    type: 'button', class: preset.id === current.id ? 'active' : '', 'aria-pressed': String(preset.id === current.id),
    onclick: (e) => {
      try { storage?.setItem(KEY, preset.id); } catch { /* storage unavailable */ }
      for (const b of swatches) { b.classList.toggle('active', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }
      onSelectTrainer(preset);
    },
  }, h('span.trainer-dots', [preset.hat, preset.shirt, preset.skin].map((c) => h('i', { style: { background: hex(c) } }))), preset.name));
  const modal = h('div.sanctuary-modal', { hidden: true, role: 'dialog', 'aria-label': 'Choose trainer' },
    h('div.modal-card', h('h3', 'Choose trainer'), h('div.trainer-grid', swatches),
      h('button.btn.primary', { type: 'button', onclick: () => { modal.hidden = true; } }, 'Done')));
  host.append(radial, ring, modal);

  function closeRadial() {
    active = null;
    radial.hidden = true;
  }
  return {
    openRadial(creature) {
      active = creature;
      title.textContent = creature.card.name;
      follow.textContent = creature.state === 'follow' ? 'Stay' : 'Follow';
      radial.hidden = false;
      follow.focus();
    },
    closeRadial,
    isOpen: () => !radial.hidden || !modal.hidden,
    openTrainerModal: () => { modal.hidden = false; },
    updateStamina(stamina, exhausted) {
      ring.toggleAttribute('hidden', stamina >= 99.5);
      const circumference = 113.1;
      fill.style.strokeDashoffset = String(circumference * (1 - stamina / 100));
      fill.style.stroke = exhausted ? '#f87171' : '#6ee7b7';
    },
  };
}
