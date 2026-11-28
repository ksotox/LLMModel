// The game's settings (the ⚙ menu): key bindings, the mouse, graphics and the performance readout.
// Kept in this browser (localStorage), so each device keeps its own. Pure apart from load/save (tested).

const KEY = 'pokedex.gameSettings';

/** What each action does, in the order the menu lists them, and its default keys (event.code). */
export const ACTIONS = [
  { id: 'forward', label: 'Move forward', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', label: 'Move back', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', label: 'Move left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'Move right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'jump', label: 'Jump · glide · climb (flying) · rise (Reef)', keys: ['Space'] },
  { id: 'sprint', label: 'Sprint · boost', keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'dive', label: 'Dive (flying) · sink (Reef)', keys: ['ControlLeft', 'KeyC'] },
  { id: 'interact', label: 'Interact · ride · get off', keys: ['KeyE'] },
  { id: 'meet', label: 'Meet a Pokémon (Reef)', keys: ['KeyF'] },
  { id: 'skyDrop', label: 'Sky drop', keys: ['KeyG'] },
  { id: 'mute', label: 'Sound on/off', keys: ['KeyM'] },
  { id: 'overlay', label: 'Performance readout', keys: ['F3'] },
  { id: 'settings', label: 'Settings menu', keys: ['KeyP'] },
];

export const QUALITIES = ['high', 'standard', 'basic'];

export const DEFAULTS = {
  bindings: Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]])),
  mouse: {
    look: 'lock', // 'lock': the camera follows the mouse once you press a key or click; 'drag': left-click + drag
    sensitivity: 1, // ×
    invertY: false,
  },
  video: {
    renderScale: 'auto', // 'auto' (dynamic resolution) or a fraction of the screen's own: 1, 0.85, 0.7, 0.5
    grass: 'high', // low · medium · high · ultra
    shadows: true,
    effects: true, // High's extra passes: ambient occlusion, bloom, mirror water
    frameLimit: 0, // 0: the screen's own rate; otherwise frames a second
    viewDistance: 'far', // near · medium · far
  },
  overlay: { fps: false, cpu: false, gpu: false },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Settings `raw` (possibly old, partial or broken) filled in from the defaults. Pure. */
export function normalizeSettings(raw) {
  const s = clone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return s;
  for (const a of ACTIONS) {
    const keys = raw.bindings?.[a.id];
    if (Array.isArray(keys)) s.bindings[a.id] = keys.filter((k) => typeof k === 'string' && k).slice(0, 2);
  }
  if (['lock', 'drag'].includes(raw.mouse?.look)) s.mouse.look = raw.mouse.look;
  const sens = Number(raw.mouse?.sensitivity);
  if (Number.isFinite(sens)) s.mouse.sensitivity = Math.min(3, Math.max(0.2, sens));
  s.mouse.invertY = Boolean(raw.mouse?.invertY);
  const v = raw.video ?? {};
  if (v.renderScale === 'auto' || [1, 0.85, 0.7, 0.5].includes(Number(v.renderScale))) s.video.renderScale = v.renderScale === 'auto' ? 'auto' : Number(v.renderScale);
  if (['low', 'medium', 'high', 'ultra'].includes(v.grass)) s.video.grass = v.grass;
  if (typeof v.shadows === 'boolean') s.video.shadows = v.shadows;
  if (typeof v.effects === 'boolean') s.video.effects = v.effects;
  if ([0, 30, 60, 120, 144].includes(Number(v.frameLimit))) s.video.frameLimit = Number(v.frameLimit);
  if (['near', 'medium', 'far'].includes(v.viewDistance)) s.video.viewDistance = v.viewDistance;
  for (const k of ['fps', 'cpu', 'gpu']) s.overlay[k] = Boolean(raw.overlay?.[k]);
  return s;
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    return normalizeSettings(JSON.parse(storage?.getItem(KEY) ?? 'null'));
  } catch {
    return clone(DEFAULTS);
  }
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

/** Which action a key (event.code) does, or null. Pure. */
export function actionFor(code, bindings) {
  for (const a of ACTIONS) if (bindings[a.id]?.includes(code)) return a.id;
  return null;
}

/** Whether `action` is held, given the held key codes. Pure. */
export const held = (action, keys, bindings) => (bindings[action] ?? []).some((k) => keys.has(k));

/**
 * Bind `code` to `action` in `slot` (0 main key, 1 second key); the key is taken off any other action
 * that had it (one key, one action). Returns new bindings. Pure.
 */
export function bindKey(bindings, action, code, slot = 0) {
  const next = Object.fromEntries(Object.entries(bindings).map(([a, keys]) => [a, keys.filter((k) => k !== code)]));
  const keys = [...(next[action] ?? [])];
  keys[Math.min(slot, keys.length)] = code;
  next[action] = keys.filter(Boolean).slice(0, 2);
  return next;
}

/** A key's name for people: "W", "Space", "Left Shift", "↑", "F3". Pure. */
export function keyLabel(code) {
  if (!code) return '—';
  const named = {
    Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps Lock', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** The look turn for a mouse movement (dx, dy pixels): { yaw, pitch } radians, by the settings. Pure. */
export function mouseTurn(dx, dy, mouse, scale = 1) {
  const k = mouse.sensitivity * scale;
  return { yaw: -dx * 0.0025 * k, pitch: dy * 0.002 * k * (mouse.invertY ? -1 : 1) };
}

/** The grass density for a setting, as a share of the level's own blade count. Pure. */
export const GRASS_DENSITY = { low: 0.35, medium: 0.65, high: 1, ultra: 1.5 };
/** How far the scenery is drawn (the camera's far plane and the fog), by the setting. Pure. */
export const VIEW_DISTANCE = { near: { far: 700, fog: 1.6 }, medium: { far: 1600, fog: 1.2 }, far: { far: 4000, fog: 1 } };
