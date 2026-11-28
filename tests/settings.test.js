// The game's settings (game/settings.js): key bindings, the mouse, graphics, the performance readout.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACTIONS, actionFor, bindKey, DEFAULTS, GRASS_DENSITY, held, keyLabel, loadSettings, mouseTurn,
  normalizeSettings, saveSettings, VIEW_DISTANCE,
} from '../public/js/game/settings.js';

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};

describe('settings', () => {
  test('the defaults: the camera follows the mouse, W A S D moves, P opens the menu', () => {
    const s = normalizeSettings(null);
    assert.equal(s.mouse.look, 'lock');
    assert.deepEqual(s.bindings.forward, ['KeyW', 'ArrowUp']);
    assert.deepEqual(s.bindings.settings, ['KeyP']);
    assert.equal(s.video.renderScale, 'auto');
    assert.deepEqual(s.overlay, { fps: false, cpu: false, gpu: false });
  });

  test('no default key belongs to two actions', () => {
    const all = ACTIONS.flatMap((a) => a.keys);
    assert.equal(new Set(all).size, all.length);
  });

  test('junk, partial and out-of-range settings fall back to the defaults', () => {
    assert.deepEqual(normalizeSettings('nonsense'), DEFAULTS);
    const s = normalizeSettings({
      mouse: { look: 'teleport', sensitivity: 99, invertY: 1 },
      video: { renderScale: 0.3, grass: 'ultra', shadows: 'yes', frameLimit: 60, viewDistance: 'medium' },
      bindings: { jump: ['KeyJ', 7, 'KeyK', 'KeyL'], forward: 'KeyW' },
      overlay: { gpu: true },
    });
    assert.equal(s.mouse.look, 'lock');
    assert.equal(s.mouse.sensitivity, 3);
    assert.equal(s.mouse.invertY, true);
    assert.equal(s.video.renderScale, 'auto');
    assert.equal(s.video.grass, 'ultra');
    assert.equal(s.video.shadows, true);
    assert.equal(s.video.frameLimit, 60);
    assert.equal(s.video.viewDistance, 'medium');
    assert.deepEqual(s.bindings.jump, ['KeyJ', 'KeyK']);
    assert.deepEqual(s.bindings.forward, ['KeyW', 'ArrowUp']);
    assert.deepEqual(s.overlay, { fps: false, cpu: false, gpu: true });
    assert.equal(normalizeSettings({ video: { renderScale: '0.7' } }).video.renderScale, 0.7);
  });

  test('settings are saved and loaded back; broken storage gives the defaults', () => {
    const store = memory();
    const s = normalizeSettings({ mouse: { look: 'drag', sensitivity: 1.5 } });
    saveSettings(s, store);
    assert.deepEqual(loadSettings(store), s);
    assert.deepEqual(loadSettings({ getItem: () => '{not json' }), DEFAULTS);
    assert.deepEqual(loadSettings({ getItem: () => { throw new Error('blocked'); } }), DEFAULTS);
    assert.doesNotThrow(() => saveSettings(s, { setItem: () => { throw new Error('full'); } }));
  });

  test('binding a key takes it off the action that had it', () => {
    const b = bindKey(DEFAULTS.bindings, 'jump', 'KeyE');
    assert.deepEqual(b.jump, ['KeyE']);
    assert.deepEqual(b.interact, []);
    assert.deepEqual(DEFAULTS.bindings.interact, ['KeyE'], 'the defaults are untouched');
    const second = bindKey(b, 'jump', 'Space', 1);
    assert.deepEqual(second.jump, ['KeyE', 'Space']);
    const replaced = bindKey(second, 'jump', 'KeyJ', 0);
    assert.deepEqual(replaced.jump, ['KeyJ', 'Space']);
    assert.deepEqual(bindKey(replaced, 'jump', 'KeyK', 5).jump, ['KeyJ', 'Space', 'KeyK'].slice(0, 2), 'two keys at most');
    assert.deepEqual(bindKey(DEFAULTS.bindings, 'sprint', 'KeyW', 0).forward, ['ArrowUp']);
  });

  test('a key maps to its action, and an action is held when any of its keys is', () => {
    const b = DEFAULTS.bindings;
    assert.equal(actionFor('KeyW', b), 'forward');
    assert.equal(actionFor('ArrowLeft', b), 'left');
    assert.equal(actionFor('KeyZ', b), null);
    assert.equal(held('sprint', new Set(['ShiftRight']), b), true);
    assert.equal(held('sprint', new Set(['KeyW']), b), false);
    assert.equal(held('nothing', new Set(['KeyW']), b), false);
  });

  test('key names read like the keyboard', () => {
    assert.equal(keyLabel('KeyW'), 'W');
    assert.equal(keyLabel('Space'), 'Space');
    assert.equal(keyLabel('ShiftLeft'), 'Left Shift');
    assert.equal(keyLabel('ArrowUp'), '↑');
    assert.equal(keyLabel('Digit3'), '3');
    assert.equal(keyLabel('Numpad5'), 'Num 5');
    assert.equal(keyLabel('F3'), 'F3');
    assert.equal(keyLabel(undefined), '—');
  });

  test('the mouse turns the camera by the sensitivity, and up and down can be inverted', () => {
    const base = mouseTurn(100, 50, { sensitivity: 1, invertY: false });
    assert.ok(base.yaw < 0, 'moving right turns right');
    assert.ok(base.pitch > 0);
    const fast = mouseTurn(100, 50, { sensitivity: 2, invertY: false });
    assert.ok(Math.abs(fast.yaw - base.yaw * 2) < 1e-12);
    const inverted = mouseTurn(100, 50, { sensitivity: 1, invertY: true });
    assert.equal(inverted.pitch, -base.pitch);
    assert.ok(Math.abs(mouseTurn(100, 50, { sensitivity: 1, invertY: false }, 2).yaw - base.yaw * 2) < 1e-12);
  });

  test('every grass and view-distance setting has its numbers', () => {
    for (const g of ['low', 'medium', 'high', 'ultra']) assert.ok(GRASS_DENSITY[g] > 0);
    assert.ok(GRASS_DENSITY.low < GRASS_DENSITY.high && GRASS_DENSITY.high < GRASS_DENSITY.ultra);
    for (const v of ['near', 'medium', 'far']) assert.ok(VIEW_DISTANCE[v].far > 0 && VIEW_DISTANCE[v].fog > 0);
  });
});
