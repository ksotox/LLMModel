// Modal editor for marking where each card is in a photo. Each card is a 4-corner outline that can be
// drawn, moved, reshaped corner by corner (for tilted cards) and deleted.

import { gridQuads, wholeQuad } from './images.js';
import { h, modal } from './ui.js';
import { findCards } from './vision.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/**
 * Opens the editor for `img` starting from `quads` (image pixels, TL/TR/BR/BL).
 * Resolves with the new quads, or null if the user cancelled.
 */
export function editQuads(img, quads, { title = 'Mark each card in the photo', detect = true } = {}) {
  return new Promise((resolve) => {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    let state = quads.map((q) => q.map((p) => ({ ...p })));
    let result = null;

    const photo = h('img', { src: img.src, alt: 'Uploaded photo', draggable: false });
    const layer = svg('svg', { class: 'crop-layer', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    const stage = h('div.crop-stage', photo, layer);
    const count = h('span.crop-count');
    const status = h('span.muted.crop-status');
    const cols = h('input', { type: 'number', min: 1, max: 10, value: Math.max(1, state.length || 1), 'aria-label': 'Columns' });
    const rows = h('input', { type: 'number', min: 1, max: 10, value: 1, 'aria-label': 'Rows' });
    const done = h('button.btn.primary', { type: 'button' });
    const handle = Math.max(W, H) * 0.012;

    const render = () => {
      layer.replaceChildren();
      state.forEach((q, i) => {
        const g = svg('g', { class: 'crop-quad', 'data-index': i });
        g.append(svg('polygon', { points: q.map((p) => `${p.x},${p.y}`).join(' '), 'data-index': i, class: 'crop-shape' }));
        const label = svg('text', { x: q[0].x + handle * 1.4, y: q[0].y + handle * 2.6, class: 'crop-label', 'font-size': handle * 2.2 });
        label.textContent = String(i + 1);
        g.append(label);
        q.forEach((p, c) => g.append(svg('circle', { cx: p.x, cy: p.y, r: handle, class: 'crop-handle', 'data-index': i, 'data-corner': c })));
        const del = svg('g', { class: 'crop-delete', 'data-index': i, 'data-action': 'delete', role: 'button', 'aria-label': `Remove card ${i + 1}` });
        del.append(svg('circle', { cx: q[1].x - handle * 2, cy: q[1].y + handle * 2, r: handle * 1.3, 'data-action': 'delete', 'data-index': i }));
        const x = svg('text', { x: q[1].x - handle * 2, y: q[1].y + handle * 2.5, 'font-size': handle * 2, 'text-anchor': 'middle', 'data-action': 'delete', 'data-index': i });
        x.textContent = '×';
        del.append(x);
        g.append(del);
        layer.append(g);
      });
      count.textContent = state.length === 1 ? '1 card' : `${state.length} cards`;
      done.disabled = state.length === 0;
      done.textContent = state.length > 1 ? `Use these ${state.length} cards` : 'Use this card';
    };

    // Pointer interactions: draw on empty space, drag a shape to move it, drag a corner to reshape it.
    let drag = null;
    const point = (e) => {
      const r = layer.getBoundingClientRect();
      return { x: Math.min(W, Math.max(0, ((e.clientX - r.left) / r.width) * W)), y: Math.min(H, Math.max(0, ((e.clientY - r.top) / r.height) * H)) };
    };
    layer.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (t.dataset.action === 'delete') {
        state.splice(Number(t.dataset.index), 1);
        render();
        return;
      }
      e.preventDefault();
      const p = point(e);
      if (t.dataset.corner != null) {
        drag = { kind: 'corner', index: Number(t.dataset.index), corner: Number(t.dataset.corner) };
      } else if (t.dataset.index != null) {
        const index = Number(t.dataset.index);
        drag = { kind: 'move', index, start: p, orig: state[index].map((q) => ({ ...q })) };
      } else {
        state.push([p, { ...p }, { ...p }, { ...p }]);
        drag = { kind: 'draw', index: state.length - 1, start: p };
      }
      layer.setPointerCapture(e.pointerId);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = point(e);
      if (drag.kind === 'corner') {
        state[drag.index][drag.corner] = p;
      } else if (drag.kind === 'move') {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        state[drag.index] = drag.orig.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      } else {
        const s = drag.start;
        const [x0, x1] = [Math.min(s.x, p.x), Math.max(s.x, p.x)];
        const [y0, y1] = [Math.min(s.y, p.y), Math.max(s.y, p.y)];
        state[drag.index] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      }
      render();
    });
    const endDrag = () => {
      if (drag?.kind === 'draw') {
        const q = state[drag.index];
        if (q[2].x - q[0].x < W * 0.03 || q[2].y - q[0].y < H * 0.03) state.splice(drag.index, 1);
      }
      drag = null;
      render();
    };
    layer.addEventListener('pointerup', endDrag);
    layer.addEventListener('pointercancel', endDrag);

    const autoDetect = async () => {
      status.textContent = 'Looking for cards…';
      try {
        const found = await findCards(img);
        status.textContent = found.length ? '' : 'No cards found automatically — draw them instead.';
        if (found.length) state = found;
      } catch (err) {
        status.textContent = err.message;
      }
      render();
    };

    modal((closeModal) => {
      done.addEventListener('click', () => { result = state; closeModal(); });
      return h('div.crop-editor',
        h('h2', title),
        h('p.muted', 'Drag on the photo to draw an outline. Drag a corner to fit it exactly to the card’s edge, or drag the inside to move it.'),
        h('div.crop-toolbar',
          detect && h('button.btn', { type: 'button', onclick: autoDetect }, 'Auto-detect cards'),
          h('span.crop-grid', 'Split evenly:', cols, '×', rows,
            h('button.btn', { type: 'button', onclick: () => { state = gridQuads(img, Number(cols.value) || 1, Number(rows.value) || 1); render(); } }, 'Apply')),
          h('button.btn', { type: 'button', onclick: () => { state = [wholeQuad(img)]; render(); } }, 'Whole photo'),
          h('button.btn.ghost', { type: 'button', onclick: () => { state = []; render(); } }, 'Clear'),
          status),
        stage,
        h('div.actions', count, h('button.btn', { type: 'button', onclick: closeModal }, 'Cancel'), done));
    }, { wide: true, onClose: () => resolve(result) });
    render();
  });
}
