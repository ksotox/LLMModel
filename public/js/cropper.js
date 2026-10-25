// Modal editor for marking where each card is in a photo. Boxes can be drawn, moved, resized and deleted.

import { detectCards, gridBoxes } from './images.js';
import { h, modal } from './ui.js';

const MIN = 0.03;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Opens the editor for `img` starting from `boxes` (normalised). Resolves with the new boxes,
 * or null if the user cancelled.
 */
export function editBoxes(img, boxes, { title = 'Mark each card in the photo' } = {}) {
  return new Promise((resolve) => {
    let state = boxes.map((b) => ({ ...b }));
    let result = null;

    const stage = h('div.crop-stage');
    const photo = h('img', { src: img.src, alt: 'Uploaded photo', draggable: false });
    const layer = h('div.crop-layer');
    stage.append(photo, layer);
    const count = h('span.crop-count');
    const cols = h('input', { type: 'number', min: 1, max: 10, value: Math.max(1, state.length || 1), 'aria-label': 'Columns' });
    const rows = h('input', { type: 'number', min: 1, max: 10, value: 1, 'aria-label': 'Rows' });

    const render = () => {
      layer.replaceChildren(...state.map((b, i) => h('div.crop-box', {
        dataset: { index: i },
        style: { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` },
      },
      h('span.crop-label', String(i + 1)),
      h('button.crop-delete', { type: 'button', 'aria-label': `Remove card ${i + 1}`, dataset: { action: 'delete' } }, '×'),
      ...['nw', 'ne', 'sw', 'se'].map((corner) => h('span.crop-handle', { class: corner, dataset: { corner } })))));
      count.textContent = state.length === 1 ? '1 card' : `${state.length} cards`;
      done.disabled = state.length === 0;
      done.textContent = state.length > 1 ? `Use these ${state.length} cards` : 'Use this card';
    };

    // Pointer interactions: draw on empty space, move a box by dragging it, resize from a corner.
    let drag = null;
    const point = (e) => {
      const r = layer.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    };
    layer.addEventListener('pointerdown', (e) => {
      if (e.target.dataset.action === 'delete') return;
      e.preventDefault();
      const p = point(e);
      const boxEl = e.target.closest('.crop-box');
      if (boxEl) {
        const index = Number(boxEl.dataset.index);
        drag = { index, start: p, orig: { ...state[index] }, corner: e.target.dataset.corner ?? null };
      } else {
        state.push({ x: p.x, y: p.y, w: 0, h: 0 });
        drag = { index: state.length - 1, start: p, orig: { x: p.x, y: p.y, w: 0, h: 0 }, corner: 'se', fresh: true };
      }
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = point(e);
      const { orig, start } = drag;
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      let { x, y, w, h: ht } = orig;
      if (!drag.corner) {
        x = clamp(orig.x + dx, 0, 1 - orig.w);
        y = clamp(orig.y + dy, 0, 1 - orig.h);
      } else if (drag.fresh) {
        x = Math.min(start.x, p.x);
        y = Math.min(start.y, p.y);
        w = Math.abs(p.x - start.x);
        ht = Math.abs(p.y - start.y);
      } else {
        const right = orig.x + orig.w;
        const bottom = orig.y + orig.h;
        if (drag.corner.includes('w')) { x = clamp(orig.x + dx, 0, right - MIN); w = right - x; }
        if (drag.corner.includes('e')) { w = clamp(orig.w + dx, MIN, 1 - orig.x); }
        if (drag.corner.includes('n')) { y = clamp(orig.y + dy, 0, bottom - MIN); ht = bottom - y; }
        if (drag.corner.includes('s')) { ht = clamp(orig.h + dy, MIN, 1 - orig.y); }
      }
      state[drag.index] = { x, y, w, h: ht };
      render();
    });
    const endDrag = () => {
      if (!drag) return;
      const b = state[drag.index];
      if (drag.fresh && (b.w < MIN || b.h < MIN)) state.splice(drag.index, 1);
      drag = null;
      render();
    };
    layer.addEventListener('pointerup', endDrag);
    layer.addEventListener('pointercancel', endDrag);
    layer.addEventListener('click', (e) => {
      const del = e.target.closest('[data-action="delete"]');
      if (!del) return;
      state.splice(Number(del.closest('.crop-box').dataset.index), 1);
      render();
    });

    const done = h('button.btn.primary', { type: 'button' }, 'Use these cards');
    modal((closeModal) => {
      done.addEventListener('click', () => { result = state; closeModal(); });
      return h('div.crop-editor',
        h('h2', title),
        h('p.muted', 'Drag on the photo to draw a box around each card. Drag a box to move it, or a corner to resize it.'),
        h('div.crop-toolbar',
          h('button.btn', { type: 'button', onclick: () => { state = detectCards(img); render(); } }, 'Auto-detect cards'),
          h('span.crop-grid', 'Split evenly:', cols, '×', rows,
            h('button.btn', { type: 'button', onclick: () => { state = gridBoxes(Number(cols.value) || 1, Number(rows.value) || 1); render(); } }, 'Apply')),
          h('button.btn', { type: 'button', onclick: () => { state = [{ x: 0, y: 0, w: 1, h: 1 }]; render(); } }, 'Whole photo'),
          h('button.btn.ghost', { type: 'button', onclick: () => { state = []; render(); } }, 'Clear')),
        stage,
        h('div.actions', count, h('button.btn', { type: 'button', onclick: closeModal }, 'Cancel'), done));
    }, { wide: true, onClose: () => resolve(result) });
    render();
  });
}
