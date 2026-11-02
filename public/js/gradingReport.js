// The detailed pre-grading report: a virtual slab of the card (flip, tilt, flattened or original
// photo, save as image), a breakdown per category with front / back sub-grades and what the
// measurements found, the precision scan (each corner and edge up close, with Viridian's
// screening map), the surface map, and graded sale prices already saved for the card.
//
// Everything shown comes from the measurements in the report. Rules for this screen: the
// "Experimental CV estimate — not professional grading." label stays on every view, including the
// saved slab image; no probabilities, accuracy claims or "worth grading" advice.

import { cardNumber, clear, formatDate, formatPrice, h } from './ui.js';

export const CV_LABEL = 'Experimental CV estimate — not professional grading.';
const SIDES = [['front', 'Front'], ['back', 'Back']];
const DESCRIPTORS = { 10: 'Gem Mint', 9: 'Mint', 8: 'Near Mint–Mint', 7: 'Near Mint', 6: 'Excellent–Mint', 5: 'Excellent', 4: 'Very Good–Excellent', 3: 'Very Good', 2: 'Good', 1: 'Poor' };
const SEVERITY_LABELS = { none: 'Clean', minor: 'Minor', moderate: 'Moderate', heavy: 'Heavy', unknown: '—' };
const descriptor = (g) => (g == null ? '' : DESCRIPTORS[Math.max(1, Math.min(10, Math.round(g)))]);
const muted = (text) => h('p.gr-muted', text);
const pct = (f) => (f == null ? '—' : `${(f * 100).toFixed(1)}%`);
const lowest = (...grades) => {
  const g = grades.filter((x) => x != null);
  return g.length ? Math.min(...g) : null;
};
const severityOf = (g) => (g == null ? 'unknown' : g >= 9 ? 'none' : g >= 8 ? 'minor' : g >= 6 ? 'moderate' : 'heavy');
const chip = (severity, text = SEVERITY_LABELS[severity]) => h('span.gr-sev', { class: `sev-${severity}` }, text);
const reportCode = (report) => String(report.id ?? '').replace(/-/g, '').slice(0, 8).toUpperCase();
const isReference = (m) => String(m?.method ?? '').startsWith('reference');

// ---------------------------------------------------------------------------
// The virtual slab

function slabFace(card, report, side, { photo }) {
  const d = report[side] ?? {};
  const grade = side === 'front' ? report.experimental_overall : d.experimental_overall;
  const retake = report.status === 'retake';
  const flat = report.media?.[`${side}_flat`];
  const src = photo === 'original' || !flat ? report.media?.[side] : flat;
  return h('div.slab-face', { class: side },
    h('div.slab-sheen', { 'aria-hidden': 'true' }),
    h('div.slab-label',
      h('span.slab-logo', { 'aria-hidden': 'true' }),
      h('div.slab-title',
        h('strong', side === 'front' ? card.name : 'Card back'),
        h('span', side === 'front' ? [card.set_name || card.set_code, cardNumber(card) && `#${cardNumber(card)}`].filter(Boolean).join(' · ') : `${card.name} · reverse side`)),
      h('div.slab-grade', { title: 'Experimental estimate' },
        h('small', 'EST.'),
        h('strong', retake || grade == null ? '—' : `~${grade}`))),
    h('div.slab-window', src ? h('img', { src, alt: `${side === 'front' ? 'Front' : 'Back'} of ${card.name}`, draggable: false }) : h('div.slab-empty', 'No photo')),
    h('div.slab-foot',
      h('div',
        h('small', side === 'front' ? 'Condition estimate' : 'Back estimate'),
        h('strong', retake ? 'Retake recommended' : descriptor(grade) || 'Not measured'),
        h('span.slab-code', `MY POKÉDEX · REPORT ${reportCode(report)}`)),
      h('div.slab-stamp', 'EXPERIMENTAL', h('br'), 'NOT A', h('br'), 'PRO GRADE')));
}

/** A clear "slab" holding the card, flippable and tilting with the pointer, like a graded case. */
export function slabView(card, report) {
  let side = 'front';
  let photo = 'flat';
  const inner = h('div.slab-inner');
  const scene = h('div.slab-scene', { role: 'img', 'aria-label': `Virtual slab of ${card.name}` }, inner);
  const sideNote = h('span.gr-muted');
  const draw = () => {
    clear(inner, slabFace(card, report, 'front', { photo }), slabFace(card, report, 'back', { photo }), h('div.slab-edge.left'), h('div.slab-edge.right'));
    inner.classList.toggle('flipped', side === 'back');
    sideNote.textContent = side === 'front' ? 'Front' : 'Back';
  };
  // Tilt with the pointer (desktop) for a feel of the real case; the flip button turns it over.
  scene.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = scene.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    scene.style.setProperty('--tilt-x', `${(-y * 14).toFixed(2)}deg`);
    scene.style.setProperty('--tilt-y', `${(x * 18).toFixed(2)}deg`);
    scene.style.setProperty('--sheen', `${Math.round((x + 0.5) * 100)}%`);
  });
  scene.addEventListener('pointerleave', () => {
    scene.style.setProperty('--tilt-x', '0deg');
    scene.style.setProperty('--tilt-y', '0deg');
  });
  const photoToggle = h('div.segmented', { role: 'group', 'aria-label': 'Photo in the slab' },
    ...[['flat', 'Flattened'], ['original', 'Original photo']].map(([v, label]) => h('button', {
      type: 'button',
      class: v === photo ? 'active' : '',
      disabled: v === 'flat' && !report.media?.front_flat,
      onclick: (e) => {
        photo = v;
        for (const b of e.target.parentNode.children) b.classList.toggle('active', b === e.target);
        draw();
      },
    }, label)));
  draw();
  return h('div.slab-wrap',
    scene,
    h('div.slab-controls',
      h('button.btn.small', { type: 'button', onclick: () => { side = side === 'front' ? 'back' : 'front'; draw(); } }, '↻ Flip'),
      photoToggle,
      h('button.btn.small.ghost', { type: 'button', onclick: () => saveSlabImage(card, report, side, photo).catch(() => {}) }, 'Save as image')),
    h('p.gr-muted.center', sideNote, ' · move the pointer over the case to tilt it'));
}

/** Draw the slab on a canvas and download it as a PNG (the label says it's an experimental estimate). */
async function saveSlabImage(card, report, side, photo) {
  const flat = report.media?.[`${side}_flat`];
  const src = photo === 'original' || !flat ? report.media?.[side] : flat;
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = 700;
  const H = 1150;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const round = (x, y, w, hh, r) => { g.beginPath(); g.roundRect(x, y, w, hh, r); };
  // case
  const caseGrad = g.createLinearGradient(0, 0, W, H);
  caseGrad.addColorStop(0, '#eef1f5');
  caseGrad.addColorStop(0.5, '#ffffff');
  caseGrad.addColorStop(1, '#e3e7ee');
  g.fillStyle = caseGrad;
  round(0, 0, W, H, 28);
  g.fill();
  g.strokeStyle = '#c8ced8';
  g.lineWidth = 3;
  g.stroke();
  // label
  const lab = g.createLinearGradient(0, 0, W, 0);
  lab.addColorStop(0, '#1e293b');
  lab.addColorStop(0.5, '#334155');
  lab.addColorStop(1, '#1e293b');
  g.fillStyle = lab;
  round(24, 24, W - 48, 120, 14);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '700 30px system-ui, sans-serif';
  g.fillText(side === 'front' ? card.name : 'Card back', 48, 74, W - 240);
  g.fillStyle = '#cbd5e1';
  g.font = '20px system-ui, sans-serif';
  g.fillText([card.set_name || card.set_code, cardNumber(card) && `#${cardNumber(card)}`].filter(Boolean).join(' · '), 48, 106, W - 240);
  g.fillStyle = '#94a3b8';
  g.font = '15px ui-monospace, monospace';
  g.fillText(`MY POKÉDEX · REPORT ${reportCode(report)} · ${formatDate(report.created_at)}`, 48, 132, W - 240);
  const grade = side === 'front' ? report.experimental_overall : report[side]?.experimental_overall;
  const badge = g.createLinearGradient(W - 190, 40, W - 48, 128);
  badge.addColorStop(0, '#fb923c');
  badge.addColorStop(1, '#ea580c');
  g.fillStyle = badge;
  round(W - 180, 40, 132, 88, 12);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = '700 14px system-ui, sans-serif';
  g.fillText('EST.', W - 114, 62);
  g.font = '900 46px system-ui, sans-serif';
  g.fillText(report.status === 'retake' || grade == null ? '—' : `~${grade}`, W - 114, 112);
  g.textAlign = 'left';
  // card window
  g.fillStyle = '#1f2937';
  round(48, 168, W - 96, H - 168 - 150, 12);
  g.fill();
  const box = { x: 64, y: 184, w: W - 128, h: H - 184 - 166 };
  const scale = Math.min(box.w / img.naturalWidth, box.h / img.naturalHeight);
  const iw = img.naturalWidth * scale;
  const ih = img.naturalHeight * scale;
  g.drawImage(img, box.x + (box.w - iw) / 2, box.y + (box.h - ih) / 2, iw, ih);
  // footer
  g.fillStyle = lab;
  round(24, H - 126, W - 48, 102, 14);
  g.fill();
  g.fillStyle = '#94a3b8';
  g.font = '700 14px system-ui, sans-serif';
  g.fillText('CONDITION ESTIMATE', 48, H - 92);
  g.fillStyle = '#fff';
  g.font = '700 26px system-ui, sans-serif';
  g.fillText(report.status === 'retake' ? 'Retake recommended' : descriptor(grade) || 'Not measured', 48, H - 60);
  g.fillStyle = '#fbbf24';
  g.font = '700 15px system-ui, sans-serif';
  g.fillText(CV_LABEL, 48, H - 36, W - 96);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${card.name.replace(/[^\w-]+/g, '_')}-pre-grade-${side}.png`;
  a.click();
}

// ---------------------------------------------------------------------------
// Grade breakdown

function categoryText(report, key) {
  const f = report.front ?? {};
  const b = report.back ?? {};
  const pre = report.precision ?? {};
  const worstOf = (side, group) => {
    const list = pre[side]?.[group] ?? [];
    return list.reduce((w, r) => (r.fraction != null && (!w || r.fraction > w.fraction) ? r : w), null);
  };
  if (key === 'centering') {
    const line = (label, c) => (c?.grade != null
      ? `${label}: L/R ${c.left_right ?? '?'}, T/B ${c.top_bottom ?? '?'}${isReference(c) ? ' (aligned to a reference picture)' : ''}.`
      : `${label}: couldn’t be measured${c?.note ? ` (${c.note.replace(/\.$/, '')})` : ''}.`);
    return [line('Front', f.centering), line('Back', b.centering),
      'For a top grade, graders usually look for about 55/45 or better on the front and 75/25 on the back. Left/right is the more reliable reading.'];
  }
  if (key === 'surface') {
    const line = (label, s) => (s?.scuff != null ? `${label}: ${pct(s.scuff)} of the inner card area shows small scratch- or scuff-like features.` : `${label}: not measured.`);
    return [line('Front', f.surface), line('Back', b.surface),
      'Holo, reverse-holo and textured printing also show up as features here: compare with the surface map below before reading it as wear.'];
  }
  const group = key; // corners | edges
  const noun = key === 'corners' ? 'corner' : 'edge';
  const line = (label, side, m) => {
    const w = worstOf(side, group);
    if (!w) return m?.grade != null ? `${label}: ${m.grade}/10.` : `${label}: not measured.`;
    return `${label}: most flagged at the ${w.label.toLowerCase()} (${pct(w.fraction)} of the measured ${noun} area).`;
  };
  const reference = isReference(f[group]);
  return [line('Front', 'front', f[group]), line('Back', 'back', b[group]),
    reference
      ? 'The front was compared with the aligned official picture, so printing cancels out: this reading counts toward the estimate.'
      : `This is a blind screening: bright or dark printing inside the measured box (text, symbols, holo) gets flagged too, so check the close-ups. On ordinary photos it isn’t reliable enough to count toward the estimate.`];
}

function breakdown(report) {
  const counts = {
    centering: true,
    surface: true,
    corners: isReference(report.front?.corners),
    edges: isReference(report.front?.edges),
  };
  const findings = report.findings ?? [];
  const forCategory = {
    centering: (f) => f.area === 'Centering',
    surface: (f) => f.area === 'Surface',
    corners: (f) => /corner/i.test(f.area),
    edges: (f) => /edge/i.test(f.area),
  };
  return h('section.gr-breakdown',
    h('h4', 'Grade breakdown'),
    h('div.gr-cats', ['centering', 'corners', 'edges', 'surface'].map((key) => {
      const fg = report.front?.[key]?.grade ?? null;
      const bg = report.back?.[key]?.grade ?? null;
      const worst = lowest(fg, bg);
      const issues = findings.filter(forCategory[key]);
      return h('article.gr-cat',
        h('header',
          h('h5', key[0].toUpperCase() + key.slice(1)),
          h('strong.gr-cat-grade', worst == null ? '—' : worst),
          counts[key] ? h('span.gr-tag.ok', 'Counts toward estimate') : h('span.gr-tag', 'Screening only')),
        h('div.gr-sides',
          ...[['Front', fg], ['Back', bg]].map(([label, g]) => h('div',
            h('span', label),
            h('strong', g == null ? '—' : `${g}/10`),
            h('small', g == null ? 'Not measured' : descriptor(g)),
            h('div.gr-bar', h('span', { style: { width: `${(g ?? 0) * 10}%` }, class: `sev-${severityOf(g)}` }))))),
        h('div.gr-analysis', categoryText(report, key).map((t) => h('p', t))),
        issues.length > 0 && h('details.gr-issues',
          h('summary', `Flagged (${issues.length})`),
          h('ul', issues.map((f) => h('li', chip(f.severity), h('span.gr-side-tag', f.side), h('strong', ` ${f.area}`), ` — ${f.kind}. `, h('span.gr-muted-inline', f.detail))))));
    })));
}

// ---------------------------------------------------------------------------
// Precision scan

const VARIANTS = [['original', 'Original'], ['contrast', 'Contrast'], ['inverted', 'Inverted'], ['detail', 'Detail'], ['map', 'Map']];

function closeUp(region, media, base, { wide = false, method }) {
  const img = media[base];
  if (!img) return null;
  const map = media[`${base}_map`];
  const frame = h('div.gr-zoom', { class: `${wide ? 'wide' : ''} v-original` },
    h('img', { src: img, alt: region.label, loading: 'lazy' }),
    map && h('img.gr-map', { src: map, alt: '', loading: 'lazy' }));
  const buttons = h('div.gr-variants', VARIANTS.filter(([v]) => v !== 'map' || map).map(([v, label]) => h('button', {
    type: 'button',
    class: v === 'original' ? 'active' : '',
    onclick: (e) => {
      frame.className = `gr-zoom ${wide ? 'wide' : ''} v-${v}`;
      for (const b of buttons.children) b.classList.toggle('active', b === e.target);
    },
  }, label)));
  const measured = isReference({ method })
    ? `${pct(region.fraction)} differs from the aligned official picture`
    : [region.white ? `${pct(region.white)} bright & colourless` : null, region.dark ? `${pct(region.dark)} dark` : null].filter(Boolean).join(' · ') || 'nothing flagged';
  return h('figure.gr-closeup', { class: wide ? 'wide' : '' },
    h('figcaption',
      h('strong', region.label),
      h('span.gr-closeup-grade', region.grade == null ? '—' : `${region.grade}/10`),
      chip(region.severity)),
    frame,
    buttons,
    h('p.gr-muted', measured));
}

function precisionScan(report) {
  const pre = report.precision;
  const media = report.media ?? {};
  if (!pre) return null;
  let side = 'front';
  const body = h('div');
  const tabs = h('div.segmented', { role: 'tablist', 'aria-label': 'Side' });
  const draw = () => {
    const p = pre[side] ?? { corners: [], edges: [] };
    const m = report[side] ?? {};
    const surfaceMap = media[`${side}_surface_map`];
    clear(body,
      h('div.gr-photos',
        media[side] && h('figure', h('a', { href: media[side], target: '_blank', rel: 'noopener' }, h('img', { src: media[side], alt: `${side} original photo`, loading: 'lazy' })), h('figcaption', 'Your photo')),
        media[`${side}_flat`] && h('figure', h('a', { href: media[`${side}_flat`], target: '_blank', rel: 'noopener' }, h('img', { src: media[`${side}_flat`], alt: `${side} flattened`, loading: 'lazy' })), h('figcaption', 'Flattened for inspection'))),
      h('h5.gr-sub', `${side === 'front' ? 'Front' : 'Back'} corners`),
      h('div.gr-corner-grid', p.corners.map((r) => closeUp(r, media, `${side}_corner_${r.key}`, { method: m.corners?.method }))),
      h('h5.gr-sub', `${side === 'front' ? 'Front' : 'Back'} edges`),
      muted('Each edge is shown flat, with the card’s outer edge at the top.'),
      h('div.gr-edge-list', p.edges.map((r) => closeUp(r, media, `${side}_edge_${r.key}`, { wide: true, method: m.edges?.method }))),
      h('h5.gr-sub', `${side === 'front' ? 'Front' : 'Back'} surface`),
      h('div.gr-photos',
        surfaceMap && media[`${side}_flat`] && h('figure',
          (() => {
            const frame = h('div.gr-zoom.v-map.tall', h('img', { src: media[`${side}_flat`], alt: '', loading: 'lazy' }), h('img.gr-map', { src: surfaceMap, alt: '', loading: 'lazy' }));
            return [frame, h('label.check.small', h('input', { type: 'checkbox', checked: true, onchange: (e) => frame.classList.toggle('v-map', e.target.checked) }), ' Show surface map')];
          })(),
          h('figcaption', `Amber: small scratch- or scuff-like features (${pct(m.surface?.scuff)} of the inner area)`)),
        media[`${side}_overlay`] && h('figure', h('a', { href: media[`${side}_overlay`], target: '_blank', rel: 'noopener' }, h('img', { src: media[`${side}_overlay`], alt: `${side} centering overlay`, loading: 'lazy' })), h('figcaption', 'Centering lines and measured borders'))),
      side === 'front' && media.reference_overlay && h('figure.gr-ref',
        h('img', { src: media.reference_overlay, alt: 'Difference from the official picture', loading: 'lazy' }),
        h('figcaption', 'Difference from the aligned official picture (printing cancels out; what remains may be wear)')));
  };
  for (const [key, label] of SIDES) {
    tabs.append(h('button', {
      type: 'button',
      role: 'tab',
      class: key === side ? 'active' : '',
      onclick: (e) => { side = key; for (const b of tabs.children) b.classList.toggle('active', b === e.target); draw(); },
    }, label));
  }
  draw();
  return h('section.gr-precision',
    h('div.gr-section-head', h('h4', 'Precision scan'), tabs),
    muted('Close-ups of what was measured. Map: pink = bright, colourless pixels (possible whitening), cyan = dark spots (dirt or damage), white box = the area measured. If the marked pixels are printing, that’s a false alarm.'),
    body);
}

// ---------------------------------------------------------------------------
// Sold prices by grade (saved PokemonPriceTracker data: no credits are used)

function gradedPrices(card) {
  const host = h('div');
  fetch(`/api/cards/${card.id}/pricetracker`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((t) => {
      const sales = (t?.gradedSales ?? []).filter((g) => g.average != null || g.median != null);
      const raw = card.market_currency === 'USD' ? card.market_price : null;
      if (!sales.length) return;
      clear(host, h('section.gr-prices',
        h('h4', 'Sold prices by grade'),
        muted('Recent eBay sales for this card saved from PokemonPriceTracker. Shown for reference only: this report doesn’t predict what grade a grading company would give.'),
        h('div.table-wrap', h('table.simple-table',
          h('thead', h('tr', h('th', 'Grade'), h('th.num', 'Sales'), h('th.num', 'Average'), raw != null && h('th.num', 'vs. raw'))),
          h('tbody',
            sales.map((g) => h('tr',
              h('td', h('span.chip.grade', g.grade)),
              h('td.num', g.count || '—'),
              h('td.num', formatPrice(g.average ?? g.median, 'USD')),
              raw != null && h('td.num', raw > 0 ? `${((g.average ?? g.median) / raw).toFixed(1)}×` : '—'))),
            raw != null && h('tr', h('td', 'Raw (ungraded)'), h('td.num', '—'), h('td.num', formatPrice(raw, 'USD')), h('td.num', '1×')))))));
    })
    .catch(() => {});
  return host;
}

// ---------------------------------------------------------------------------

function qualitySummary(side, name) {
  const ok = side?.ok;
  return h('div.gr-quality', { class: ok ? 'ok' : 'warn' },
    h('strong', `${name} photo: ${ok ? '✓ quality checks passed' : '⚠ retake recommended'}`),
    muted(side?.warnings?.length ? side.warnings.join(' ') : 'Sharp, no glare, enough detail.'));
}

/** The whole report for one inspection of one card. */
export function reportView(report, card) {
  const retake = report.status === 'retake';
  const overall = retake ? null : report.experimental_overall;
  const findings = report.findings ?? [];
  const wrap = h('section.gr-report',
    h('div.gr-hero',
      slabView(card, report),
      h('div.gr-summary',
        h('div.gr-eyebrow', `Pre-grading report · ${formatDate(report.created_at, true)}`),
        h('h3', retake ? 'Retake recommended' : 'Condition screening complete'),
        h('div.gr-big',
          h('strong', overall == null ? '—' : `~${overall}`),
          h('div', h('span', 'Experimental estimate'), h('b', overall == null ? 'Not shown' : descriptor(overall)))),
        h('p.gr-notice', h('strong', CV_LABEL), ' Computer-vision screening with provisional rules: not a trained or calibrated grade predictor, and not a PSA, BGS or CGC grade.'),
        h('ul.gr-facts',
          h('li', 'Estimate from: ', h('b', 'centering and surface'), isReference(report.front?.corners) ? ' (+ corners and edges aligned to the official picture)' : ', the lower of front and back'),
          h('li', 'Official picture used for alignment: ', h('b', report.reference_used ? 'yes' : 'no')),
          h('li', 'Flagged areas: ', h('b', findings.length ? `${findings.length} (${['heavy', 'moderate', 'minor'].map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ')})` : 'none'))),
        h('div.gr-quality-grid', qualitySummary(report.capture?.front, 'Front'), qualitySummary(report.capture?.back, 'Back')))),
    retake && h('p.gr-retry', '⚠ At least one photo didn’t pass the quality checks, so no overall estimate is shown. Take sharper, glare-free photos of the whole card and try again.'));
  if (report.front || report.back) wrap.append(breakdown(report));
  const scan = precisionScan(report);
  if (scan) wrap.append(scan);
  else {
    // Reports saved before the precision scan: the original photos and overlays.
    wrap.append(h('div.gr-photos', SIDES.flatMap(([side, title]) => [
      report.media?.[side] && h('figure', h('img', { src: report.media[side], alt: `${title} original photo`, loading: 'lazy' }), h('figcaption', `${title}: your photo`)),
      report.media?.[`${side}_overlay`] && h('figure', h('img', { src: report.media[`${side}_overlay`], alt: `${title} overlay`, loading: 'lazy' }), h('figcaption', `${title}: inspection overlay`)),
    ])));
  }
  if (findings.length) {
    wrap.append(h('section.gr-findings',
      h('h4', `Everything flagged (${findings.length})`),
      h('div.table-wrap', h('table.simple-table',
        h('thead', h('tr', h('th', 'Severity'), h('th', 'Side'), h('th', 'Where'), h('th', 'What'), h('th', 'Measured'))),
        h('tbody', findings.map((f) => h('tr', h('td', chip(f.severity)), h('td', f.side), h('td', f.area), h('td', f.kind), h('td.gr-muted-inline', f.detail))))))));
  }
  if (card?.id) wrap.append(gradedPrices(card));
  if (report.warnings?.length) wrap.append(h('section.gr-warnings', h('h4', 'Inspection notes'), h('ul', report.warnings.map((m) => h('li', m)))));
  return wrap;
}
