// Tiny DOM helpers shared by every view.

/**
 * h('div.card', { onclick }, child, ...) — create an element.
 * The tag may carry classes ("button.btn.primary"); props starting with "on" become listeners,
 * `dataset`/`style` objects are merged, everything else is set as a property or attribute.
 */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.classList.add(...classes);
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset' || key === 'style') Object.assign(el[key], value);
    else if (key === 'class') el.classList.add(...String(value).split(/\s+/).filter(Boolean));
    else if (key in el && !key.startsWith('aria') && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function formatDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const KIND_LABELS = {
  'booster-pack': 'Booster pack',
  tin: 'Tin',
  kit: 'Kit',
  bundle: 'Bundle',
  'elite-trainer-box': 'Elite Trainer Box',
  'collection-box': 'Collection box',
  blister: 'Blister',
  'booster-box': 'Booster box',
  other: 'Other',
};

export const VARIANT_LABELS = {
  normal: 'Normal',
  'reverse-holo': 'Reverse holo',
  holo: 'Holo',
  'full-art': 'Full art',
  promo: 'Promo',
  other: 'Other',
};

export function cardNumber(card) {
  if (!card.number) return '';
  return card.set_total ? `${card.number}/${card.set_total}` : card.number;
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const el = h('div.toast', { class: kind, role: 'status' }, message);
  host.append(el);
  setTimeout(() => el.classList.add('leaving'), 3200);
  setTimeout(() => el.remove(), 3600);
}

/** Open a modal dialog; returns { dialog, close }. Content may be a node or a function(close) => node. */
export function modal(content, { wide = false, onClose } = {}) {
  const dialog = h('dialog.modal', { class: wide ? 'wide' : '' });
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.append(h('button.modal-close', { type: 'button', 'aria-label': 'Close', onclick: close }, '×'));
  dialog.append(typeof content === 'function' ? content(close) : content);
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog(message, { okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    modal((close) => h('div.confirm',
      h('p', message),
      h('div.actions',
        h('button.btn', { type: 'button', onclick: close }, 'Cancel'),
        h('button.btn', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => { answer = true; close(); } }, okLabel))),
    { onClose: () => resolve(answer) });
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** A drop zone + file input that hands back image Files. */
export function dropZone({ label, hint, multiple = true, onFiles, camera = true }) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple, hidden: true });
  const cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const take = (list) => {
    const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (files.length) onFiles(files);
  };
  input.addEventListener('change', () => { take(input.files); input.value = ''; });
  cameraInput.addEventListener('change', () => { take(cameraInput.files); cameraInput.value = ''; });
  const zone = h('div.dropzone',
    h('div.dropzone-icon', { 'aria-hidden': 'true' }, '⇪'),
    h('strong', label),
    hint && h('span.muted', hint),
    h('div.dropzone-actions',
      h('button.btn.primary', { type: 'button', onclick: () => input.click() }, multiple ? 'Choose photos' : 'Choose photo'),
      camera && h('button.btn', { type: 'button', onclick: () => cameraInput.click() }, 'Take photo')),
    input, cameraInput);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    take(e.dataTransfer.files);
  });
  return zone;
}
