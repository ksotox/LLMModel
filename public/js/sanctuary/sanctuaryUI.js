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
const MODEL_KEY = 'pokedex.trainerModel'; // the id of the trainer model in use (server/trainers.js), or 'none'
export const DEFAULT_TRAINER_MODEL = 'builtin-ash';

/**
 * The id of the trainer model in use: Ash until another is chosen; null when the simple figure
 * (a preset) was chosen instead.
 */
export function savedTrainerModel(storage = globalThis.localStorage) {
  let id = null;
  try { id = storage?.getItem(MODEL_KEY) ?? null; } catch { /* storage unavailable */ }
  if (id === 'none') return null;
  return id || DEFAULT_TRAINER_MODEL;
}
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
  let lastStamina = null;
  const title = h('div.radial-center');
  const button = (pos, action, label) => h('button.radial-btn', {
    type: 'button', class: pos, role: 'menuitem', 'data-action': action,
    onclick: () => { const c = active; closeRadial(); if (c) onRadialAction(action, c); },
  }, label);
  const follow = button('pos-top', 'follow', 'Follow');
  const ride = button('pos-ride', 'ride', '🪽 Ride'); // flying Pokémon only
  const radial = h('div.radial-menu', { role: 'menu', hidden: true }, title, follow, button('pos-right', 'pet', 'Pet'), button('pos-bottom', 'inspect', 'Card'), button('pos-left', 'battle', 'Battle'), ride);

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
      try { storage?.setItem(KEY, preset.id); storage?.setItem(MODEL_KEY, 'none'); } catch { /* storage unavailable */ }
      for (const b of [...swatches, ...modelList.querySelectorAll('button.trainer-swatch')]) { b.classList.toggle('active', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }
      onSelectTrainer(preset, null);
    },
  }, h('span.trainer-dots', [preset.hat, preset.shirt, preset.skin].map((c) => h('i', { style: { background: hex(c) } }))), preset.name));
  // Your own trainer models (.glb), kept in your data folder: pick one, add one, or remove one.
  const modelList = h('div.trainer-grid.trainer-models');
  const note = h('p.trainer-note', { role: 'status' });
  const fileInput = h('input', { type: 'file', accept: '.glb,model/gltf-binary', hidden: true, 'aria-label': 'Trainer model file' });
  const credit = (m) => [m.author && `by ${m.author.replace(/\s*\(https?:[^)]*\)/, '')}`, m.licence && m.licence.replace(/\s*\(https?:[^)]*\)/, '')].filter(Boolean).join(' · ');
  const showModels = (models, activeId) => {
    modelList.replaceChildren(...models.map((m) => h('div.trainer-model',
      h('button.trainer-swatch', {
        type: 'button', class: m.id === activeId ? 'active' : '', 'aria-pressed': String(m.id === activeId), 'data-model': m.id,
        onclick: (e) => {
          try { storage?.setItem(MODEL_KEY, m.id); } catch { /* storage unavailable */ }
          for (const b of [...swatches, ...modelList.querySelectorAll('button.trainer-swatch')]) { b.classList.toggle('active', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }
          note.textContent = m.rigged || m.clips ? '' : 'This model has no skeleton, so it moves without arm and leg animation. Rig it (for example with Mixamo) and add it again to animate it.';
          onSelectTrainer(savedTrainer(storage), m);
        },
      }, h('span.trainer-name', m.name), h('small', credit(m) || 'Your model')),
      !m.builtin && h('button.trainer-remove', {
        type: 'button', 'aria-label': `Remove ${m.name}`, title: 'Remove',
        onclick: async () => {
          await fetch(`/api/trainers/${m.id}`, { method: 'DELETE' });
          if (savedTrainerModel(storage) === m.id) { try { storage?.setItem(MODEL_KEY, 'none'); } catch { /* */ } onSelectTrainer(savedTrainer(storage), null); }
          refresh();
        },
      }, '×'))));
  };
  const refresh = async () => {
    try {
      const { trainers } = await (await fetch('/api/trainers')).json();
      showModels(trainers ?? [], savedTrainerModel(storage));
    } catch { modelList.replaceChildren(); }
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    note.textContent = `Adding ${file.name}…`;
    const form = new FormData();
    form.append('model', file);
    try {
      const res = await fetch('/api/trainers', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not add it');
      note.textContent = `Added ${body.name}.`;
      await refresh();
      modelList.querySelector(`[data-model="${body.id}"]`)?.click();
    } catch (err) { note.textContent = err.message; }
  });
  const modal = h('div.sanctuary-modal', { hidden: true, role: 'dialog', 'aria-label': 'Choose trainer' },
    h('div.modal-card', h('h3', 'Choose trainer'), h('div.trainer-grid', swatches),
      h('h4', 'Trainer models'), modelList,
      h('button.btn.small', { type: 'button', onclick: () => fileInput.click() }, '＋ Add a trainer model (.glb)'), fileInput,
      h('p.trainer-hint', 'Ash, Iris and May come with the app. Models you add stay on this computer, for your own use. Every model walks, runs and swims with you.'), note,
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
      ride.hidden = !creature.rideable?.();
      radial.hidden = false;
      follow.focus();
    },
    closeRadial,
    isOpen: () => !radial.hidden || !modal.hidden,
    openTrainerModal: () => { modal.hidden = false; refresh(); },
    updateStamina(stamina, exhausted) {
      // Touched only on a change (this runs every frame).
      const shown = `${Math.round(stamina * 2) / 2}|${exhausted}`;
      if (shown === lastStamina) return;
      lastStamina = shown;
      ring.toggleAttribute('hidden', stamina >= 99.5);
      const circumference = 113.1;
      fill.style.strokeDashoffset = String(circumference * (1 - stamina / 100));
      fill.style.stroke = exhausted ? '#f87171' : '#6ee7b7';
    },
  };
}
