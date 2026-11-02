// Experimental pre-grading: front + back photos of one card copy go to the local Viridian
// computer-vision service (through this app's server, never directly), and the reports are kept
// with that card. Based on the Viridian Pre-Grading Integration Kit v0.1, adapted to this app.
//
// Honesty rules for this screen: every result is labelled as an experimental CV estimate, no
// probabilities or accuracy claims, no "worth grading" advice.

import { cardNumber, clear, confirmDialog, formatDate, h, modal, toast, VARIANT_LABELS } from './ui.js';

export const CV_LABEL = 'Experimental CV estimate — not professional grading.';
const MAX_BYTES = 8 * 1024 * 1024;

async function call(url, options) {
  const res = await fetch(url, { ...options, credentials: 'same-origin' });
  if (res.status === 204) return null;
  let data = {};
  try { data = await res.json(); } catch { throw new Error('Unexpected server response'); }
  if (res.status === 401 && data.signIn) window.dispatchEvent(new Event('signin-needed'));
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data;
}

const muted = (text) => h('p.gr-muted', text);
const describeCopy = (card) => [card.set_code, cardNumber(card), card.variant && card.variant !== 'normal' ? VARIANT_LABELS[card.variant] ?? card.variant : null,
  card.condition, card.storage_location].filter(Boolean).join(' · ');

function metric(label, item, extra = '') {
  const unavailable = item?.grade == null;
  return h('div.gr-metric', { class: unavailable ? 'unavailable' : '' },
    h('span.gr-metric-title', label),
    h('strong', unavailable ? '—' : `${item.grade}/10`),
    h('small', unavailable
      ? item?.note || 'Couldn’t be measured from this photo'
      : [`${item.confidence || 'unknown'} confidence`, item.method === 'reference' || item.method === 'reference-back' ? 'aligned to the official picture' : null, extra].filter(Boolean).join(' · ')));
}

function qualitySummary(side, name) {
  const ok = side?.ok;
  return h('div.gr-quality', { class: ok ? 'ok' : 'warn' },
    h('strong', `${name} photo: ${ok ? '✓ quality checks passed' : '⚠ retake recommended'}`),
    muted(side?.warnings?.length ? side.warnings.join(' ') : 'No sharpness, glare or size problems found.'));
}

export function reportView(report) {
  const retake = report.status === 'retake';
  const wrap = h('section.gr-report',
    h('div.gr-report-head',
      h('div',
        h('div.gr-eyebrow', 'Pre-grading report'),
        h('h3', retake ? 'Retake recommended' : 'Condition screening complete'),
        muted(formatDate(report.created_at, true))),
      h('div.gr-estimate',
        h('span', 'Experimental estimate'),
        h('strong', !retake && report.experimental_overall != null ? `~${report.experimental_overall}/10` : 'Not shown'))),
    h('p.gr-notice', h('strong', CV_LABEL), ' This is computer-vision screening with provisional rules, not a trained or calibrated grade predictor, and not a PSA, BGS or CGC grade.'),
    h('div.gr-quality-grid', qualitySummary(report.capture?.front, 'Front'), qualitySummary(report.capture?.back, 'Back')));
  if (retake) wrap.append(h('p.gr-retry', '⚠ At least one photo didn’t pass the quality checks, so no overall estimate is shown. Take sharper, glare-free photos of the whole card and try again.'));
  else wrap.append(muted('The overall estimate comes from centering and surface only (the lower of front and back). The corner and edge readings are shown for information: on ordinary photos they aren’t reliable enough to count.'));

  for (const [side, title] of [['front', 'Front'], ['back', 'Back']]) {
    const d = report[side] ?? {};
    const c = d.centering;
    const ratios = [c?.left_right && `L/R ${c.left_right}`, c?.top_bottom && `T/B ${c.top_bottom}`].filter(Boolean).join(' · ');
    wrap.append(h('section.gr-side',
      h('h4', `${title}`),
      h('div.gr-scores', metric('Centering', c, ratios), metric('Corners', d.corners), metric('Edges', d.edges), metric('Surface', d.surface)),
      c?.axis_note && muted(c.axis_note),
      h('div.gr-photos',
        report.media?.[side] && h('figure', h('a', { href: report.media[side], target: '_blank', rel: 'noopener' }, h('img', { src: report.media[side], alt: `${title} original photo`, loading: 'lazy' })), h('figcaption', 'Your original photo')),
        report.media?.[`${side}_overlay`] && h('figure', h('a', { href: report.media[`${side}_overlay`], target: '_blank', rel: 'noopener' }, h('img', { src: report.media[`${side}_overlay`], alt: `${title} inspection overlay`, loading: 'lazy' })), h('figcaption', 'Inspection overlay (centering lines, corners, edges)')))));
  }
  if (report.warnings?.length) wrap.append(h('section.gr-warnings', h('h4', 'Inspection notes'), h('ul', report.warnings.map((m) => h('li', m)))));
  return wrap;
}

/** The pre-grading dialog for one card copy: photos in, report out, earlier reports below. */
export function openGradingDialog(card) {
  const files = { front: null, back: null };
  const urls = [];
  const stage = h('div.gr-stage');
  const history = h('div.gr-history');
  const status = h('p.gr-status', { role: 'status' });
  const health = h('div.gr-connection', 'Checking the local grading service…');

  const picker = (role, label, tip) => {
    const preview = h('div.gr-photo-preview', h('span.gr-muted', 'No photo yet'));
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': `${label} photo` });
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      files[role] = file;
      if (!file) return clear(preview, h('span.gr-muted', 'No photo yet'));
      const url = URL.createObjectURL(file);
      urls.push(url);
      clear(preview, h('img', { src: url, alt: `${label} preview` }), muted(`${file.name} · ${(file.size / 1048576).toFixed(1)} MB`));
      if (file.size > MAX_BYTES) toast(`${label} photo is over 8 MB: use a smaller one.`, 'error');
    });
    return h('label.gr-upload', h('span.gr-upload-title', label), preview, muted(tip), input);
  };

  const submit = h('button.btn.primary', { type: 'submit', disabled: true }, 'Analyze both photos');
  const form = h('form.gr-form',
    h('div.gr-upload-grid',
      picker('front', 'Front', 'The whole card, straight on, on a plain contrasting surface. Out of its sleeve.'),
      picker('back', 'Back', 'The whole back of the same card, with no glare.')),
    h('div.gr-actions', submit, status));

  const { close } = modal(h('div.gr-dialog',
    h('div.gr-eyebrow', 'Pre-grade card'),
    h('h2', card.name),
    muted(describeCopy(card)),
    health,
    h('p.gr-tip', 'Take fresh, sharp photos for this — not the cut-out picture in your collection, which is resized and has rounded corners. JPEG, PNG or WebP, up to 8 MB each. JPEG straight from the camera works best.'),
    form,
    stage,
    h('h3', 'Earlier inspections of this card'),
    history), { wide: true, onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)) });

  const show = (report) => {
    clear(stage, reportView(report));
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function refreshHistory() {
    try {
      const { reports } = await call(`/api/grading/cards/${card.id}`);
      clear(history, reports.length ? reports.map((report) => h('div.gr-history-item',
        h('div',
          h('strong', report.status === 'retake' ? 'Retake recommended' : `Screening${report.experimental_overall != null ? ` · ~${report.experimental_overall}/10 (experimental)` : ''}`),
          muted(formatDate(report.created_at, true))),
        h('div.gr-history-actions',
          h('button.btn.small', { type: 'button', onclick: () => show(report) }, 'View'),
          h('button.btn.small.ghost.danger-text', {
            type: 'button',
            onclick: async () => {
              if (!(await confirmDialog('Delete this inspection and its saved photos? The card itself stays in your collection.'))) return;
              try {
                await call(`/api/grading/cards/${card.id}/reports/${report.id}`, { method: 'DELETE' });
                clear(stage);
                await refreshHistory();
                toast('Inspection deleted', 'success');
              } catch (err) { toast(err.message, 'error'); }
            },
          }, 'Delete')))) : muted('No inspections saved for this card yet.'));
    } catch (err) {
      clear(history, muted(err.message));
    }
  }

  (async () => {
    try {
      const r = await call('/api/grading/health');
      health.classList.toggle('gr-ready', r.ready);
      health.textContent = r.ready
        ? '● Local Viridian grading service is ready'
        : `● Grading service offline: ${r.detail} Start it to analyse photos (see the user guide). Earlier reports still open below.`;
      submit.disabled = !r.ready;
    } catch (err) {
      health.textContent = `● Grading service status unavailable: ${err.message}`;
    }
  })();
  refreshHistory();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!files.front || !files.back) { status.textContent = 'Choose both a front and a back photo.'; return; }
    if ([files.front, files.back].some((f) => f.size > MAX_BYTES)) { status.textContent = 'Each photo must be 8 MB or smaller.'; return; }
    const data = new FormData();
    data.set('front', files.front);
    data.set('back', files.back);
    submit.disabled = true;
    submit.textContent = 'Inspecting…';
    status.textContent = 'Checking photo quality and inspecting the card…';
    try {
      const { report } = await call(`/api/grading/cards/${card.id}`, { method: 'POST', body: data });
      status.textContent = report.status === 'retake' ? 'Saved. Retake recommended.' : 'Saved with this card.';
      show(report);
      await refreshHistory();
    } catch (err) {
      status.textContent = err.message;
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Analyze both photos';
    }
  });
  return close;
}

/** The Pre-grade page: pick a card copy from the collection. */
export async function renderGradingLab(root) {
  const filter = h('input.search', { type: 'search', placeholder: 'Search your cards by name, set or number…', 'aria-label': 'Search cards to pre-grade' });
  const list = h('div.gr-card-picker', muted('Loading your collection…'));
  clear(root,
    h('div.page-head',
      h('h1', 'Pre-grade'),
      h('p.muted', 'Check a card’s condition from a front and back photo: centering, corners, edges and surface. Each inspection is saved with that card.')),
    h('p.gr-notice', h('strong', CV_LABEL), ' Computer-vision screening only: no trained model, no accuracy guarantee, no professional grading.'),
    h('div.toolbar', filter),
    list);
  let cards;
  try {
    cards = (await call('/api/cards?sort=name')).cards ?? [];
  } catch (err) {
    clear(list, muted(`Couldn’t load your collection: ${err.message}`));
    return;
  }
  const draw = () => {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = cards.filter((c) => {
      const text = [c.name, c.set_code, c.set_name, cardNumber(c)].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    }).slice(0, 150);
    clear(list, shown.length ? shown.map((card) => h('div.gr-card-option',
      h('div.gr-card-option-main',
        card.official_url || card.photo_url ? h('img', { src: card.official_url || card.photo_url, alt: '', loading: 'lazy' }) : h('span.gr-placeholder', '◈'),
        h('div', h('strong', card.name), muted(describeCopy(card) || card.set_name || ''))),
      h('button.btn.primary.small', { type: 'button', onclick: () => openGradingDialog(card) }, 'Pre-grade'))) : muted(cards.length ? 'No cards match.' : 'Add cards to your collection first.'));
  };
  filter.addEventListener('input', draw);
  draw();
}
