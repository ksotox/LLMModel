// The ⚙ settings menu for the 3D pages (Sanctuary, Reef): Controls (key bindings), Mouse, Graphics and
// Performance (the FPS · CPU · GPU readout). Every change is saved at once (game/settings.js) and handed
// to the page through onChange(settings), so it takes effect while you play.

import { clear, h } from '../ui.js';
import { ACTIONS, bindKey, DEFAULTS, keyLabel, loadSettings, normalizeSettings, saveSettings } from './settings.js';

/**
 * Build the menu into `host`. `quality`: { get(), set(q) } the graphics level (High · Standard · Basic),
 * which the page already keeps. Returns { button (the ⚙ to place in the page's top bar), open(), close(),
 * isOpen(), settings (the current ones), dispose() }.
 */
export function createSettingsMenu(host, { onChange = () => {}, quality = null } = {}) {
  let settings = loadSettings();
  let tab = 'controls';
  let capturing = null; // { action, slot } waiting for a key
  const change = (next) => {
    settings = normalizeSettings(next);
    saveSettings(settings);
    onChange(settings);
    render();
  };

  const panel = h('div.settings-body');
  const tabs = h('div.settings-tabs', { role: 'tablist' });
  const modal = h('div.sanctuary-modal.settings-modal', { hidden: true, role: 'dialog', 'aria-label': 'Settings' },
    h('div.modal-card.settings-card',
      h('div.settings-head', h('h3', '⚙ Settings'), h('button.btn.small', { type: 'button', onclick: () => close() }, 'Done')),
      tabs, panel));
  host.append(modal);

  const row = (label, control, hint = '') => h('label.settings-row', h('span.settings-label', label, hint ? h('small', hint) : ''), control);
  const select = (value, options, set) => {
    const el = h('select', options.map(([v, text]) => h('option', { value: String(v) }, text)));
    el.value = String(value);
    el.addEventListener('change', () => set(el.value));
    return el;
  };
  const toggle = (value, set) => {
    const el = h('input', { type: 'checkbox' });
    el.checked = Boolean(value);
    el.addEventListener('change', () => set(el.checked));
    return el;
  };

  const panels = {
    controls: () => [
      h('p.settings-note', 'Click a key, then press the new one (Esc cancels). A key belongs to one action at a time. Keys 1–8 travel to the habitats.'),
      h('div.settings-binds', ACTIONS.map((a) => h('div.settings-bind',
        h('span', a.label),
        [0, 1].map((slot) => h('button.btn.small.keycap', {
          type: 'button',
          class: capturing?.action === a.id && capturing.slot === slot ? 'capturing' : '',
          'aria-label': `${a.label}: ${slot ? 'second' : 'main'} key`,
          onclick: () => { capturing = { action: a.id, slot }; render(); },
        }, capturing?.action === a.id && capturing.slot === slot ? 'Press a key…' : keyLabel(settings.bindings[a.id]?.[slot])))))),
      h('div.btn-row', h('button.btn.small', { type: 'button', onclick: () => change({ ...settings, bindings: structuredClone(DEFAULTS.bindings) }) }, 'Reset keys')),
    ],
    mouse: () => [
      row('Looking around', select(settings.mouse.look, [['lock', 'Follow the mouse'], ['drag', 'Left-click and drag']], (v) => change({ ...settings, mouse: { ...settings.mouse, look: v } })), 'Follow: starts with your first key or click; Esc frees the cursor'),
      row('Mouse sensitivity', (() => {
        const el = h('input', { type: 'range', min: '0.2', max: '3', step: '0.1', value: String(settings.mouse.sensitivity) });
        const out = h('output', `${settings.mouse.sensitivity.toFixed(1)}×`);
        el.addEventListener('input', () => { out.textContent = `${Number(el.value).toFixed(1)}×`; });
        el.addEventListener('change', () => change({ ...settings, mouse: { ...settings.mouse, sensitivity: Number(el.value) } }));
        return h('span.settings-range', el, out);
      })()),
      row('Invert up and down', toggle(settings.mouse.invertY, (v) => change({ ...settings, mouse: { ...settings.mouse, invertY: v } }))),
    ],
    graphics: () => [
      quality ? row('Quality', select(quality.get(), [['high', 'High'], ['standard', 'Standard'], ['basic', 'Basic (no graphics card)']], (v) => { quality.set(v); render(); })) : '',
      row('Resolution', select(settings.video.renderScale, [['auto', 'Auto'], [1, '100%'], [0.85, '85%'], [0.7, '70%'], [0.5, '50%']], (v) => change({ ...settings, video: { ...settings.video, renderScale: v === 'auto' ? 'auto' : Number(v) } })), 'Auto lowers it a little to keep the game smooth'),
      row('Grass', select(settings.video.grass, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], (v) => change({ ...settings, video: { ...settings.video, grass: v } }))),
      row('View distance', select(settings.video.viewDistance, [['near', 'Near'], ['medium', 'Medium'], ['far', 'Far']], (v) => change({ ...settings, video: { ...settings.video, viewDistance: v } }))),
      row('Shadows', toggle(settings.video.shadows, (v) => change({ ...settings, video: { ...settings.video, shadows: v } }))),
      row('Extra effects', toggle(settings.video.effects, (v) => change({ ...settings, video: { ...settings.video, effects: v } })), 'High only: soft shading, glow, mirror water'),
      row('Frame limit', select(settings.video.frameLimit, [[0, 'Screen rate'], [144, '144'], [120, '120'], [60, '60'], [30, '30']], (v) => change({ ...settings, video: { ...settings.video, frameLimit: Number(v) } })), 'A steady lower rate can feel smoother than an uneven high one'),
    ],
    performance: () => [
      h('p.settings-note', 'A readout in the bottom-left corner. F3 shows or hides it all.'),
      row('Frames a second', toggle(settings.overlay.fps, (v) => change({ ...settings, overlay: { ...settings.overlay, fps: v } }))),
      row('CPU time per frame', toggle(settings.overlay.cpu, (v) => change({ ...settings, overlay: { ...settings.overlay, cpu: v } }))),
      row('GPU time per frame', toggle(settings.overlay.gpu, (v) => change({ ...settings, overlay: { ...settings.overlay, gpu: v } }))),
    ],
  };
  const NAMES = { controls: 'Controls', mouse: 'Mouse', graphics: 'Graphics', performance: 'Performance' };
  function render() {
    if (modal.hidden) return;
    clear(tabs, Object.entries(NAMES).map(([id, name]) => h('button.btn.small', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), class: tab === id ? 'primary' : '',
      onclick: () => { tab = id; capturing = null; render(); },
    }, name)));
    clear(panel, panels[tab]());
  }

  // Binding a key: the next key pressed (Esc cancels).
  const onKey = (e) => {
    if (modal.hidden) return;
    if (!capturing) { if (e.code === 'Escape') { e.preventDefault(); close(); } return; }
    e.preventDefault();
    e.stopPropagation();
    const { action, slot } = capturing;
    capturing = null;
    if (e.code === 'Escape') return render();
    change({ ...settings, bindings: bindKey(settings.bindings, action, e.code, slot) });
  };
  window.addEventListener('keydown', onKey, true);

  const button = h('button.btn.small.settings-gear', { type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => open() }, '⚙');
  function open() {
    if (document.pointerLockElement) document.exitPointerLock?.();
    modal.hidden = false;
    render();
  }
  function close() { capturing = null; modal.hidden = true; }
  return {
    button,
    open,
    close,
    isOpen: () => !modal.hidden,
    get settings() { return settings; },
    dispose() { window.removeEventListener('keydown', onKey, true); modal.remove(); button.remove(); },
  };
}
