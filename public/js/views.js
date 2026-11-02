// Browsing views: the card collection, packs, a single pack, and the card detail dialog.

import { api } from './api.js';
import { ebaySection } from './ebay.js';
import { historySection } from './history.js';
import { cardQuads, cropToBlob, cutCard, loadImage } from './images.js';
import { lookupPanel } from './lookup.js';
import {
  cardNumber, clear, confirmDialog, debounce, formatChance, formatDate, formatPrice, h, KIND_LABELS, modal, oneIn, rarityBadge, toast, VARIANT_LABELS,
} from './ui.js';

const DAY = 24 * 60 * 60 * 1000;

const MODE_KEY = 'pokedex.imageMode';

function getMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'photo' ? 'photo' : 'official';
  } catch {
    return 'official';
  }
}

function setMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // storage unavailable: the toggle still works for this visit
  }
}

function pickFile(onFile) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

/** A new photo of a card: cut the card out of it (the biggest one, if several are in the photo). */
async function cardPhotoBlob(file) {
  const img = await loadImage(file);
  const { quads } = await cardQuads(img);
  const area = (q) => Math.abs((q[2].x - q[0].x) * (q[2].y - q[0].y));
  const biggest = [...quads].sort((a, b) => area(b) - area(a))[0];
  return (await cutCard(img, biggest, file.name)).blob;
}

/** A new photo of a pack: saved as taken (scaled down). */
async function packPhotoBlob(file) {
  return cropToBlob(await loadImage(file), file.name);
}

// ---------------------------------------------------------------------------
// Card grid

const STATUS_LABELS = { trade: 'For trade', sell: 'For sale' };
const CONDITION_NAMES = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' };
const gradeLabel = (c) => (c.grade_company ? `${c.grade_company}${c.grade ? ` ${c.grade}` : ''}` : null);

/**
 * One card in a gallery. `compact` shows just the picture, name, set number, rarity and price;
 * the detailed tile adds pull chance, date added, pack, condition and plans. In selection mode the
 * tile toggles a tick instead of opening the card.
 */
function cardTile(card, mode, onOpen, { compact = false, selecting = false, selected = false, onToggle } = {}) {
  const official = card.official_url;
  const photo = card.photo_url;
  const primary = mode === 'photo' ? photo || official : official || photo;
  const secondary = primary === official ? photo : official;
  const qty = card.quantity > 1 ? card.quantity : card.owned > 1 && !card.ids ? card.owned : 0;
  return h('button.card-tile', {
    type: 'button',
    class: [compact ? 'compact' : '', selected ? 'selected' : ''].join(' '),
    'aria-pressed': selecting ? String(selected) : undefined,
    onclick: () => (selecting ? onToggle(card) : onOpen(card)),
    'aria-label': `${card.name} ${cardNumber(card)}`,
  },
  h('div.card-img',
    primary ? h('img', { src: primary, alt: '', loading: 'lazy' }) : h('div.card-noimg', card.name),
    !compact && secondary && h('img.card-inset', { src: secondary, alt: '', loading: 'lazy', title: secondary === photo ? 'Your photo' : 'Official card' }),
    card.variant && card.variant !== 'normal' && h('span.badge.variant', VARIANT_LABELS[card.variant] ?? card.variant),
    qty > 0 && h('span.badge.qty', { title: `${qty} copies` }, `×${qty}`),
    selecting && h('span.tick', { 'aria-hidden': 'true' }, selected ? '✓' : '')),
  h('div.card-info',
    h('strong.card-name', { title: card.name }, card.name),
    h('span.card-set', { title: card.set_name ?? '' },
      card.set_code && h('span.set-tag', card.set_code),
      card.language === 'ja' && h('span.lang-tag', { title: 'Japanese card' }, 'JP'),
      h('span', cardNumber(card) || card.set_name || '')),
    h('div.card-meta',
      h('div.card-market',
        card.rarity ? rarityBadge(card.rarity) : h('span.card-unmatched', { title: 'Open the card to link it to its official card' }, card.tcg_id ? 'No rarity yet' : 'Not matched yet'),
        card.market_price != null && h('span.price', { title: card.market_source ?? 'Estimated market price' }, formatPrice(card.market_price, card.market_currency))),
      !compact && (gradeLabel(card) || card.condition || STATUS_LABELS[card.status]) && h('div.card-chips',
        gradeLabel(card) && h('span.chip.grade', gradeLabel(card)),
        card.condition && h('span.chip', { title: CONDITION_NAMES[card.condition] }, card.condition),
        STATUS_LABELS[card.status] && h('span.chip.status', STATUS_LABELS[card.status])),
      !compact && h('div.card-foot',
        card.pull_chance != null
          ? h('span', { title: `${formatChance(card.pull_chance)} per booster pack${card.pull_source ? ` · ${card.pull_source}` : ''}` }, `1 in ${oneIn(card.pull_chance).toLocaleString()} packs`)
          : h('span'),
        h('span', { title: `Added ${formatDate(card.created_at, true)}` }, shortDate(card.created_at))),
      !compact && card.pack_name && h('span.chip', `📦 ${card.pack_name}`))));
}

/** "Oct 28", or "Oct 28, 2025" for another year. */
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function cardGrid(cards, mode, onOpen, emptyState, opts = {}) {
  if (!cards.length) return emptyState;
  return h('div.card-grid', { class: opts.density ? `density-${opts.density}` : '' }, cards.map((c) => cardTile(c, mode, onOpen, { ...opts, selected: opts.isSelected?.(c) })));
}

function modeToggle(mode, onChange) {
  const btn = (value, label) => h('button', {
    type: 'button',
    class: value === mode ? 'active' : '',
    'aria-pressed': String(value === mode),
    onclick: () => { setMode(value); onChange(value); },
  }, label);
  return h('div.segmented', { role: 'group', 'aria-label': 'Card image' }, btn('official', 'Official'), btn('photo', 'My photos'));
}

function segmented(label, options, value, onChange) {
  return h('div.segmented', { role: 'group', 'aria-label': label }, options.map(([v, text]) => h('button', {
    type: 'button', class: v === value ? 'active' : '', 'aria-pressed': String(v === value), onclick: () => onChange(v),
  }, text)));
}

/** Table view: sortable columns for managing the collection. */
function cardTable(cards, { sort, onSort, onOpen, selecting, isSelected, onToggle }) {
  const cols = [['name', 'Card'], ['set', 'Set'], [null, 'No.'], ['rarity', 'Rarity'], [null, 'Variant'], ['quantity', 'Qty'], ['condition', 'Condition'], ['value', 'Value']];
  return h('div.table-wrap', h('table.collection-table',
    h('thead', h('tr', selecting && h('th', ''), cols.map(([key, label]) => h('th', { class: key === 'value' || key === 'quantity' ? 'num' : '' },
      key ? h('button.sort-button', { type: 'button', class: sort === key ? 'active' : '', onclick: () => onSort(key) }, label, sort === key ? ' ▾' : '') : label)))),
    h('tbody', cards.map((c) => h('tr', { class: isSelected(c) ? 'selected' : '', onclick: () => (selecting ? onToggle(c) : onOpen(c)) },
      selecting && h('td', h('input', { type: 'checkbox', checked: isSelected(c), tabIndex: -1, 'aria-label': `Select ${c.name}` })),
      h('td.name-cell', h('img.table-thumb', { src: c.official_url || c.photo_url || '', alt: '', loading: 'lazy' }), h('span', c.name), c.language === 'ja' && h('span.lang-tag', 'JP')),
      h('td', c.set_code ?? c.set_name ?? ''),
      h('td', cardNumber(c)),
      h('td', c.rarity ? rarityBadge(c.rarity) : h('span.muted', '—')),
      h('td', VARIANT_LABELS[c.variant] ?? c.variant ?? ''),
      h('td.num', c.quantity > 1 ? c.quantity : c.owned ?? 1),
      h('td', gradeLabel(c) ?? c.condition ?? h('span.muted', '—')),
      h('td.num', c.market_price != null ? formatPrice(c.market_price, c.market_currency) : h('span.muted', '—')))))));
}

// ---------------------------------------------------------------------------
// Collection

const PREFS_KEY = 'pokedex.gallery';
const loadPrefs = () => {
  try {
    return { view: 'detailed', density: 'comfortable', group: true, ...(window.currentUser?.settings?.gallery ?? JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')) };
  } catch {
    return { view: 'detailed', density: 'comfortable', group: true };
  }
};
const savePrefs = debounce((prefs) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  if (window.currentUser) api.updateMe({ settings: { gallery: prefs } }).then((u) => { window.currentUser = u; }).catch(() => {});
}, 600);

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const PRESETS = [
  ['valuable', 'Most valuable', { sort: 'value' }],
  ['recent', 'Recently added', { addedFrom: daysAgo(30) }],
  ['missingPrice', 'Missing prices', { missingPrice: '1' }],
  ['unmatched', 'Unmatched cards', { unmatched: '1' }],
  ['duplicates', 'Duplicates', { duplicates: '1' }],
  ['grading', 'Grading candidates', { gradingCandidates: '1', sort: 'value' }],
  ['trade', 'For trade or sale', { status: 'trade' }],
];
const FILTER_KEYS = ['rarity', 'type', 'variant', 'language', 'condition', 'status', 'minValue', 'maxValue', 'addedFrom', 'addedTo', 'graded', 'duplicates', 'unmatched', 'missingPrice', 'gradingCandidates'];

export async function renderCollection(root, meta, navigate, params) {
  const packs = await api.packs();
  let mode = getMode();
  const prefs = loadPrefs();
  const state = { q: params.get('q') ?? '', pack: params.get('pack') ?? '', set: params.get('set') ?? '', sort: params.get('sort') ?? '', trash: params.get('trash') === '1' };
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? '']).filter(([, v]) => v));
  let preset = params.get('preset') ?? '';
  let page = 1;
  let total = 0;
  let loaded = [];
  let loading = false;
  let selecting = false;
  const selected = new Map(); // card id → card (a grouped row selects all its copies)
  const PAGE = 60;

  const search = h('input.search', { type: 'search', placeholder: 'Search name, set, number, rarity, pack, storage…', value: state.q, 'aria-label': 'Search cards' });
  const select = (label, options, value) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v }, t)));
    el.value = value;
    return el;
  };
  const packSel = select('Filter by pack', [['', 'All packs & bundles'], ['none', 'Not from a pack'], ...packs.map((p) => [String(p.id), `${p.name} (${p.card_count})`])], state.pack);
  const setSel = select('Filter by set', [['', 'All sets'], ...meta.collectionSets.map((s) => [s.code, `${s.code}${s.name ? ` — ${s.name}` : ''} (${s.count})`])], state.set);
  const sortSel = select('Sort', [['', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'], ['set', 'Set & number'], ['value', 'Highest value'], ['rarity', 'Hardest to pull'], ['quantity', 'Most copies'], ['condition', 'Condition']], state.sort);

  // Filter panel: every field combines with the others.
  const f = {
    rarity: select('Rarity', [['', 'Any rarity'], ...(meta.facets?.rarities ?? []).map((r) => [r, r])], filters.rarity ?? ''),
    type: select('Type', [['', 'Any type'], ...(meta.facets?.types ?? []).map((t) => [t, t])], filters.type ?? ''),
    variant: select('Variant', [['', 'Any variant'], ...meta.variants.map((v) => [v, VARIANT_LABELS[v] ?? v])], filters.variant ?? ''),
    language: select('Language', [['', 'Any language'], ['en', 'English'], ['ja', 'Japanese']], filters.language ?? ''),
    condition: select('Condition', [['', 'Any condition'], ...meta.conditions.map((c) => [c, `${c} — ${CONDITION_NAMES[c]}`])], filters.condition ?? ''),
    status: select('Plans', [['', 'Any plans'], ['keep', 'Keeping'], ['trade', 'For trade'], ['sell', 'For sale']], filters.status ?? ''),
    graded: select('Graded', [['', 'Graded or not'], ['yes', 'Graded'], ['no', 'Raw (ungraded)']], filters.graded ?? ''),
    minValue: h('input', { type: 'number', min: 0, step: '0.01', placeholder: 'Min $', value: filters.minValue ?? '', 'aria-label': 'Minimum value' }),
    maxValue: h('input', { type: 'number', min: 0, step: '0.01', placeholder: 'Max $', value: filters.maxValue ?? '', 'aria-label': 'Maximum value' }),
    addedFrom: h('input', { type: 'date', value: filters.addedFrom ?? '', 'aria-label': 'Added from' }),
    addedTo: h('input', { type: 'date', value: filters.addedTo ?? '', 'aria-label': 'Added until' }),
    duplicates: h('input', { type: 'checkbox', checked: filters.duplicates === '1' }),
    unmatched: h('input', { type: 'checkbox', checked: filters.unmatched === '1' }),
    missingPrice: h('input', { type: 'checkbox', checked: filters.missingPrice === '1' }),
  };
  const filterValues = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value]).filter(([, v]) => v));
  const activeCount = () => Object.keys(filterValues()).length;
  const filterToggle = h('button.btn', { type: 'button', 'aria-expanded': 'false' });
  const filterPanel = h('div.filter-panel', { hidden: true },
    h('div.filter-grid',
      ...['rarity', 'type', 'variant', 'language', 'condition', 'status', 'graded'].map((k) => f[k]),
      h('div.range', f.minValue, h('span', '–'), f.maxValue),
      h('div.range', f.addedFrom, h('span', '–'), f.addedTo)),
    h('div.filter-checks',
      h('label.check', f.duplicates, ' Owned twice or more'),
      h('label.check', f.unmatched, ' Not matched yet'),
      h('label.check', f.missingPrice, ' No price yet'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { for (const el of Object.values(f)) { if (el.type === 'checkbox') el.checked = false; else el.value = ''; } preset = ''; update(); } }, 'Clear filters')));
  const syncFilterButton = () => {
    const n = activeCount();
    filterToggle.textContent = n ? `Filters (${n})` : 'Filters';
    filterToggle.classList.toggle('active', n > 0);
  };
  filterToggle.addEventListener('click', () => {
    filterPanel.hidden = !filterPanel.hidden;
    filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden));
  });
  if (activeCount()) filterPanel.hidden = false;

  const presets = h('div.chips', PRESETS.map(([key, label, values]) => h('button.chip-button', {
    type: 'button',
    class: key === preset ? 'active' : '',
    onclick: () => {
      const on = preset !== key;
      preset = on ? key : '';
      for (const el of Object.values(f)) { if (el.type === 'checkbox') el.checked = false; else el.value = ''; }
      sortSel.value = '';
      if (on) {
        for (const [k, v] of Object.entries(values)) {
          if (k === 'sort') sortSel.value = v;
          else if (f[k]) { if (f[k].type === 'checkbox') f[k].checked = v === '1'; else f[k].value = v; }
        }
      }
      for (const b of presets.children) b.classList.toggle('active', b.textContent === label && on);
      update();
    },
  }, label)));

  // View controls.
  const viewHost = h('div.view-controls');
  const renderViewControls = () => clear(viewHost,
    segmented('View', [['compact', 'Compact'], ['detailed', 'Detailed'], ['table', 'Table']], prefs.view, (v) => { prefs.view = v; savePrefs({ ...prefs }); renderViewControls(); draw(); }),
    prefs.view !== 'table' && segmented('Density', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['large', 'Large']], prefs.density, (v) => { prefs.density = v; savePrefs({ ...prefs }); renderViewControls(); draw(); }),
    prefs.view !== 'table' && modeToggle(mode, (m) => { mode = m; draw(); }),
    h('label.check', h('input', { type: 'checkbox', checked: prefs.group, onchange: (e) => { prefs.group = e.target.checked; savePrefs({ ...prefs }); load(); } }), ' Group copies'),
    h('button.btn.small', { type: 'button', class: selecting ? 'active' : '', onclick: () => { selecting = !selecting; if (!selecting) selected.clear(); renderViewControls(); draw(); } }, selecting ? 'Done selecting' : 'Select'));

  const results = h('div.results');
  const count = h('span.result-count.muted');
  const more = h('div.load-more');
  const bulkBar = h('div.bulk-bar', { hidden: true });

  const query = (p) => ({
    q: state.q, packId: state.pack, setCode: state.set, sort: state.sort, ...filterValues(), trash: state.trash ? '1' : '',
    page: p, pageSize: PAGE, group: prefs.group && !state.trash ? '1' : '',
  });

  const syncUrl = () => {
    if (!results.isConnected) return; // the user has left the collection page
    const qs = new URLSearchParams(Object.entries({ ...state, trash: state.trash ? '1' : '', preset, ...filterValues() }).filter(([, v]) => v)).toString();
    history.replaceState(null, '', `#/${qs ? `?${qs}` : ''}`);
  };

  const idsOf = (c) => c.ids ?? [c.id];
  const isSelected = (c) => idsOf(c).every((id) => selected.has(id));
  const toggle = (c) => {
    const on = !isSelected(c);
    for (const id of idsOf(c)) { if (on) selected.set(id, c); else selected.delete(id); }
    draw();
  };

  const open = (c) => openCard(c.id, { onChange: load });

  const draw = () => {
    const filtered = state.q || state.pack || state.set || activeCount() || state.trash;
    count.textContent = total ? `${total} ${prefs.group && !state.trash ? 'different card' : 'card'}${total === 1 ? '' : 's'}${filtered ? ' match' : ''}${total === 1 && filtered ? 'es' : ''}` : '';
    const empty = filtered
      ? h('div.empty', h('p', state.trash ? 'The trash is empty.' : 'No cards match your search.'))
      : h('div.empty',
        h('div.empty-art', { 'aria-hidden': 'true' }, h('span.pokeball')),
        h('h2', 'Your Pokédex is empty'),
        h('p.muted', 'Snap a photo of your cards — one at a time or a whole row — and they’ll be catalogued with their official artwork.'),
        h('a.btn.primary', { href: '#/add' }, 'Add your first cards'));
    const opts = { compact: prefs.view === 'compact', density: prefs.density, selecting, isSelected, onToggle: toggle };
    clear(results, !loaded.length ? empty : prefs.view === 'table'
      ? cardTable(loaded, { sort: state.sort, onSort: (k) => { state.sort = sortSel.value = state.sort === k ? '' : k; update(); }, onOpen: open, ...opts })
      : cardGrid(loaded, mode, open, empty, opts));
    clear(more, loaded.length < total && h('button.btn', { type: 'button', onclick: () => loadMore() }, `Show more (${total - loaded.length} left)`));
    drawBulkBar();
  };

  const load = async () => {
    page = 1;
    loading = true;
    try {
      const res = await api.cardsPage(query(1));
      loaded = res.cards;
      total = res.total;
    } finally {
      loading = false;
    }
    draw();
  };
  const loadMore = async () => {
    if (loading || loaded.length >= total) return;
    loading = true;
    try {
      const res = await api.cardsPage(query(++page));
      loaded = loaded.concat(res.cards);
      total = res.total;
    } finally {
      loading = false;
    }
    draw();
  };
  // Load the next page as the end of the list comes into view.
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px' }).observe(more);

  // Bulk actions for the selected cards.
  const drawBulkBar = () => {
    bulkBar.hidden = !selecting;
    if (!selecting) return clear(bulkBar);
    const ids = [...selected.keys()];
    const n = ids.length;
    const act = async (body, message) => {
      try {
        await api.bulk({ ids, ...body });
        toast(message, 'success');
        selected.clear();
        load();
      } catch (err) { toast(err.message, 'error'); }
    };
    const setter = (label, options, key) => select(label, [['', label], ...options], '');
    const packPick = setter('Move to pack…', [['none', 'No pack'], ...packs.map((p) => [String(p.id), p.name])]);
    packPick.addEventListener('change', () => packPick.value && act({ action: 'set', set: { pack_id: packPick.value === 'none' ? null : Number(packPick.value) } }, `Moved ${n} card${n === 1 ? '' : 's'}`));
    const condPick = setter('Set condition…', meta.conditions.map((c) => [c, `${c} — ${CONDITION_NAMES[c]}`]));
    condPick.addEventListener('change', () => condPick.value && act({ action: 'set', set: { condition: condPick.value } }, 'Condition updated'));
    const statusPick = setter('Mark as…', [['keep', 'Keeping'], ['trade', 'For trade'], ['sell', 'For sale']]);
    statusPick.addEventListener('change', () => statusPick.value && act({ action: 'set', set: { status: statusPick.value } }, 'Updated'));
    clear(bulkBar,
      h('strong', `${n} selected`),
      h('button.btn.small.ghost', { type: 'button', onclick: () => { for (const c of loaded) for (const id of idsOf(c)) selected.set(id, c); draw(); } }, 'Select all shown'),
      n > 0 && h('button.btn.small.ghost', { type: 'button', onclick: () => { selected.clear(); draw(); } }, 'Clear'),
      n > 0 && !state.trash && [packPick, condPick, statusPick,
        h('button.btn.small', {
          type: 'button',
          onclick: async () => {
            const where = prompt(`Storage location for ${n} card${n === 1 ? '' : 's'} (e.g. "Binder 2, page 5"):`);
            if (where !== null) act({ action: 'set', set: { storage_location: where.trim() || null } }, 'Storage location updated');
          },
        }, 'Storage…'),
        h('a.btn.small', { href: `/api/cards/export?ids=${ids.join(',')}`, download: '' }, 'Export CSV'),
        h('button.btn.small.danger', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog(`Move ${n} card${n === 1 ? '' : 's'} to the trash? You can restore them for 30 days.`, { okLabel: 'Move to trash' }))) return;
            await api.bulk({ ids, action: 'trash' });
            selected.clear();
            undoToast(`${n} card${n === 1 ? '' : 's'} moved to the trash`, async () => { await api.bulk({ ids, action: 'restore' }); load(); });
            load();
          },
        }, 'Delete')],
      n > 0 && state.trash && [
        h('button.btn.small.primary', { type: 'button', onclick: () => act({ action: 'restore' }, `Restored ${n} card${n === 1 ? '' : 's'}`) }, 'Restore'),
        h('button.btn.small.danger', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog(`Delete ${n} card${n === 1 ? '' : 's'} for good, with their photos? This can't be undone.`))) return;
            for (const id of ids) await api.deleteCard(id, { permanent: true });
            selected.clear();
            load();
          },
        }, 'Delete for good')]);
  };

  const update = () => {
    Object.assign(state, { q: search.value.trim(), pack: packSel.value, set: setSel.value, sort: sortSel.value });
    syncFilterButton();
    selected.clear();
    syncUrl();
    load();
  };
  search.addEventListener('input', debounce(update, 250));
  for (const el of [packSel, setSel, sortSel]) el.addEventListener('change', update);
  for (const el of Object.values(f)) el.addEventListener(el.type === 'number' ? 'input' : 'change', debounce(() => { preset = ''; update(); }, 300));
  syncFilterButton();

  const s = meta.stats;
  const refreshAll = h('button.btn', {
    type: 'button',
    title: 'Look up current prices and pull chances for every card, and link cards that are missing their official image',
    onclick: async () => {
      refreshAll.disabled = true;
      refreshAll.textContent = 'Updating prices…';
      try {
        const { updated, linked } = await api.refreshAllMarket();
        toast([`Updated ${updated} card${updated === 1 ? '' : 's'}`, linked && `found ${linked} official image${linked === 1 ? '' : 's'}`].filter(Boolean).join(', '), 'success');
        navigate(location.hash || '#/');
      } catch (err) {
        toast(err.message, 'error');
        refreshAll.disabled = false;
        refreshAll.textContent = 'Update prices';
      }
    },
  }, 'Update prices');
  const value = [s.value_usd > 0 && formatPrice(s.value_usd, 'USD'), s.value_eur > 0 && formatPrice(s.value_eur, 'EUR')].filter(Boolean).join(' + ');
  clear(root,
    h('div.page-head.row',
      h('div', h('h1', state.trash ? 'Trash' : 'My collection'),
        state.trash
          ? h('p.muted', 'Deleted cards stay here for 30 days. Select cards to restore them or delete them for good.')
          : h('div.stats',
            h('span', h('strong', s.cards), ' cards'),
            h('span', h('strong', s.unique_cards), ' unique'),
            h('span', h('strong', s.packs), ' packs & bundles'),
            value && h('span', { title: `Estimated market value of the ${s.priced} priced cards` }, 'Est. value ', h('strong', value)))),
      h('div.actions',
        state.trash ? h('a.btn', { href: '#/' }, '← Back to collection') : s.in_trash > 0 && h('a.btn.ghost', { href: '#/?trash=1' }, `Trash (${s.in_trash})`),
        !state.trash && s.cards > 0 && refreshAll,
        !state.trash && h('a.btn.primary', { href: '#/add' }, '+ Add cards'))),
    !state.trash && presets,
    h('div.toolbar', search, packSel, setSel, sortSel, !state.trash && filterToggle),
    !state.trash && filterPanel,
    h('div.toolbar.view-bar', count, viewHost),
    bulkBar,
    results,
    more);
  renderViewControls();
  await load();
}

/** A toast with an Undo button (for moving cards to the trash). */
function undoToast(message, onUndo) {
  const host = document.getElementById('toasts');
  const el = h('div.toast.info', { role: 'status' }, message, ' ',
    h('button.toast-action', { type: 'button', onclick: async () => { el.remove(); await onUndo(); toast('Restored', 'success'); } }, 'Undo'));
  host.append(el);
  setTimeout(() => el.classList.add('leaving'), 9000);
  setTimeout(() => el.remove(), 9400);
}

// ---------------------------------------------------------------------------
// Packs

function packTile(pack) {
  return h('a.pack-tile', { href: `#/packs/${pack.id}` },
    h('div.pack-img', pack.photo_url ? h('img', { src: pack.photo_url, alt: '', loading: 'lazy' }) : h('span.placeholder', { 'aria-hidden': 'true' }, '📦')),
    h('div.pack-info',
      h('strong', pack.name),
      h('span.muted', [KIND_LABELS[pack.kind] ?? pack.kind, pack.set_name].filter(Boolean).join(' · ')),
      h('span.pack-meta', h('span.chip', `${pack.card_count} card${pack.card_count === 1 ? '' : 's'}`), h('span.muted', formatDate(pack.created_at)))));
}

export async function renderPacks(root) {
  const search = h('input.search', { type: 'search', placeholder: 'Search packs, tins, kits, bundles…', 'aria-label': 'Search packs' });
  const grid = h('div');
  const load = async () => {
    const packs = await api.packs({ q: search.value });
    clear(grid, packs.length
      ? h('div.pack-grid', packs.map(packTile))
      : h('div.empty',
        h('h2', search.value ? 'No packs match your search' : 'No packs yet'),
        !search.value && h('p.muted', 'Add the packs, tins, kits and bundles you open, then link the cards you pulled.'),
        !search.value && h('a.btn.primary', { href: '#/add-packs' }, 'Add packs')));
  };
  search.addEventListener('input', debounce(load, 250));
  clear(root,
    h('div.page-head.row',
      h('div', h('h1', 'Packs & bundles'), h('p.muted', 'Everything you’ve opened, and what came out of it.')),
      h('a.btn.primary', { href: '#/add-packs' }, '+ Add packs')),
    h('div.toolbar', search),
    grid);
  await load();
}

function editPackDialog(pack, meta, onSaved) {
  modal((close) => {
    const name = h('input', { type: 'text', value: pack.name, required: true });
    const kind = h('select', meta.packKinds.map((k) => h('option', { value: k }, KIND_LABELS[k] ?? k)));
    kind.value = pack.kind;
    const set = h('input', { type: 'text', value: pack.set_name ?? '' });
    const notes = h('textarea', { rows: 3 }, pack.notes ?? '');
    const form = h('form.form',
      h('h2', 'Edit pack'),
      h('label.field', h('span', 'Name'), name),
      h('div.field-row', h('label.field', h('span', 'Type'), kind), h('label.field', h('span', 'Set'), set)),
      h('label.field', h('span', 'Notes'), notes),
      h('div.actions', h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.updatePack(pack.id, { name: name.value, kind: kind.value, set_name: set.value, notes: notes.value });
        close();
        onSaved();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return form;
  });
}

export async function renderPack(root, meta, navigate, id) {
  const pack = await api.pack(id);
  let mode = getMode();
  const search = h('input.search', { type: 'search', placeholder: `Search cards from this ${KIND_LABELS[pack.kind]?.toLowerCase() ?? 'pack'}…`, 'aria-label': 'Search cards in this pack' });
  const results = h('div.results');
  const toggleHost = h('div');
  const reload = () => renderPack(root, meta, navigate, id);

  const load = async () => {
    const cards = await api.cards({ packId: pack.id, q: search.value });
    clear(results, cardGrid(cards, mode, (c) => openCard(c.id, { onChange: reload }),
      h('div.empty', h('p', search.value ? 'No cards match your search.' : 'No cards linked to this pack yet.'),
        !search.value && h('a.btn.primary', { href: `#/add?pack=${pack.id}` }, 'Add cards from this pack'))));
    clear(toggleHost, modeToggle(mode, (m) => { mode = m; load(); }));
  };
  search.addEventListener('input', debounce(load, 250));

  const remove = async () => {
    let withCards = false;
    const ok = await new Promise((resolve) => {
      let answer = false;
      modal((close) => h('div.confirm',
        h('p', `Delete “${pack.name}”?`),
        pack.card_count > 0 && h('label.check', h('input', { type: 'checkbox', onchange: (e) => { withCards = e.target.checked; } }),
          ` Also delete the ${pack.card_count} card${pack.card_count === 1 ? '' : 's'} pulled from it (otherwise they stay in your collection)`),
        h('div.actions',
          h('button.btn', { type: 'button', onclick: close }, 'Cancel'),
          h('button.btn.danger', { type: 'button', onclick: () => { answer = true; close(); } }, 'Delete'))),
      { onClose: () => resolve(answer) });
    });
    if (!ok) return;
    await api.deletePack(pack.id, withCards);
    toast('Pack deleted', 'success');
    navigate('#/packs');
  };

  clear(root,
    h('a.back', { href: '#/packs' }, '← All packs'),
    h('div.pack-hero',
      h('div.pack-hero-img', pack.photo_url ? h('img', { src: pack.photo_url, alt: pack.name }) : h('span.placeholder', { 'aria-hidden': 'true' }, '📦')),
      h('div.pack-hero-info',
        h('span.eyebrow', KIND_LABELS[pack.kind] ?? pack.kind),
        h('h1', pack.name),
        pack.set_name && h('p', pack.set_name),
        h('p.muted', `Added ${formatDate(pack.created_at, true)} · ${pack.card_count} card${pack.card_count === 1 ? '' : 's'}`),
        pack.notes && h('p.notes', pack.notes),
        h('div.actions.left',
          h('a.btn.primary', { href: `#/add?pack=${pack.id}` }, '+ Add cards from this'),
          h('button.btn', { type: 'button', onclick: () => editPackDialog(pack, meta, reload) }, 'Edit'),
          h('button.btn', {
            type: 'button',
            onclick: () => pickFile(async (file) => {
              try {
                await api.replacePackPhoto(pack.id, await packPhotoBlob(file));
                reload();
              } catch (err) {
                toast(err.message, 'error');
              }
            }),
          }, pack.photo_url ? 'Replace photo' : 'Add photo'),
          h('button.btn.ghost.danger-text', { type: 'button', onclick: remove }, 'Delete')))),
    h('div.toolbar', search, toggleHost),
    results);
  await load();
}

// ---------------------------------------------------------------------------
// Card detail

export async function openCard(id, { onChange = () => {} } = {}) {
  let card = await api.card(id);
  const packs = await api.packs();
  const meta = await api.meta();
  let changed = false;
  const body = h('div.card-detail');

  const safe = (src) => (/^(\/|https?:\/\/)/i.test(src ?? '') ? src : null); // only this app's files or web addresses
  const figure = (label, src, empty) => h('figure.detail-img',
    safe(src) ? h('a', { href: safe(src), target: '_blank', rel: 'noopener' }, h('img', { src: safe(src), alt: `${label}: ${card.name}` })) : h('div.detail-noimg', empty),
    h('figcaption', label));

  let currentView = 'info';
  const refresh = async (next) => {
    card = next ?? await api.card(id);
    changed = true;
    render();
  };

  const findOfficial = (host) => {
    const panel = lookupPanel({
      selectedId: card.tcg_id,
      autoSelectSingle: false,
      onSelect: async (brief) => {
        try {
          await refresh(await api.updateCard(card.id, { tcg_id: brief?.tcgId ?? null, official_image_url: brief?.image ?? null, set_name: brief?.setName ?? card.set_name }));
          toast(brief ? 'Linked to the official card' : 'Official card unlinked', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    });
    const name = h('input', { type: 'text', value: card.name, 'aria-label': 'Name' });
    const code = h('input.code', { type: 'text', value: card.set_code ?? '', placeholder: 'PAL', 'aria-label': 'Set code' });
    const num = h('input.num', { type: 'text', value: cardNumber(card), placeholder: '066/193', 'aria-label': 'Number' });
    const go = () => panel.search({ name: name.value, setCode: code.value, number: num.value });
    for (const i of [name, code, num]) i.addEventListener('input', debounce(go, 500));
    clear(host, h('div.find-official', h('h3', 'Find the official card'), h('div.field-row.card-fields', name, code, num), panel.el));
    go();
  };

  const editForm = () => {
    const name = h('input', { type: 'text', value: card.name, required: true });
    const code = h('input', { type: 'text', value: card.set_code ?? '', placeholder: 'PAL' });
    const num = h('input', { type: 'text', value: cardNumber(card), placeholder: '066/193' });
    const setName = h('input', { type: 'text', value: card.set_name ?? '' });
    const variant = h('select', meta.variants.map((v) => h('option', { value: v }, VARIANT_LABELS[v] ?? v)));
    variant.value = card.variant ?? 'normal';
    const pack = h('select', h('option', { value: '' }, 'No pack'), packs.map((p) => h('option', { value: String(p.id) }, p.name)));
    pack.value = card.pack_id ? String(card.pack_id) : '';
    const notes = h('textarea', { rows: 3 }, card.notes ?? '');
    const condition = h('select', h('option', { value: '' }, 'Not set'), meta.conditions.map((c) => h('option', { value: c }, `${c} — ${CONDITION_NAMES[c]}`)));
    condition.value = card.condition ?? '';
    const gradeCompany = h('select', ['', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG', 'ACE', 'OTHER'].map((g) => h('option', { value: g }, g === 'OTHER' ? 'Other' : g || 'Not graded')));
    gradeCompany.value = card.grade_company ?? '';
    const grade = h('input', { type: 'text', value: card.grade ?? '', placeholder: '10', inputMode: 'decimal' });
    const cost = h('input', { type: 'number', min: 0, step: '0.01', value: card.purchase_price ?? '', placeholder: '0.00' });
    const storage = h('input', { type: 'text', value: card.storage_location ?? '', placeholder: 'Binder 2, page 5', list: 'storage-places' });
    const places = h('datalist', { id: 'storage-places' }, (meta.facets?.storage ?? []).map((p) => h('option', { value: p })));
    const status = h('select', [['keep', 'Keeping'], ['trade', 'For trade'], ['sell', 'For sale']].map(([v, t]) => h('option', { value: v }, t)));
    status.value = card.status ?? 'keep';
    const form = h('form.form',
      h('label.field', h('span', 'Name'), name),
      h('div.field-row', h('label.field', h('span', 'Set code'), code), h('label.field', h('span', 'Number'), num)),
      h('label.field', h('span', 'Set name'), setName),
      h('div.field-row', h('label.field', h('span', 'Variant'), variant), h('label.field', h('span', 'Pulled from'), pack)),
      h('fieldset.inventory', h('legend', 'This copy'),
        h('div.field-row', h('label.field', h('span', 'Condition'), condition), h('label.field', h('span', 'Plans'), status)),
        h('div.field-row', h('label.field', h('span', 'Graded by'), gradeCompany), h('label.field', h('span', 'Grade'), grade)),
        h('div.field-row', h('label.field', h('span', 'Paid (USD)'), cost), h('label.field', h('span', 'Stored in'), storage, places))),
      h('label.field', h('span', 'Notes'), notes),
      h('div.actions.left', h('button.btn.primary', { type: 'submit' }, 'Save changes'), h('button.btn', { type: 'button', onclick: () => render() }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const [number, total] = num.value.split('/').map((s) => s.trim());
      try {
        await refresh(await api.updateCard(card.id, {
          name: name.value, set_code: code.value, number: number || null, set_total: total || null,
          set_name: setName.value, variant: variant.value, pack_id: pack.value || null, notes: notes.value,
          condition: condition.value || null, status: status.value, grade_company: gradeCompany.value || null,
          grade: gradeCompany.value ? grade.value.trim() || null : null, purchase_price: cost.value === '' ? null : Number(cost.value),
          storage_location: storage.value.trim() || null,
        }));
        toast('Card updated', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return form;
  };

  const refreshMarket = async (quiet = false) => {
    try {
      const wasLinked = card.tcg_id;
      card = await api.refreshMarket(card.id);
      changed = true;
      if (!wasLinked && card.tcg_id) toast('Found the official card', 'success');
      // A background refresh must not wipe what the user is typing in the edit form.
      if (currentView !== 'edit') render(currentView);
      if (!quiet) toast(card.market_price != null ? 'Price updated' : 'No price found for this card right now', card.market_price != null ? 'success' : 'info');
    } catch (err) {
      if (!quiet) toast(err.message, 'error');
    }
  };

  function marketSection() {
    const updated = card.market_updated ? formatDate(card.market_updated) : null;
    return h('div.market',
      h('div.market-row',
        h('span.market-label', 'Rarity'),
        card.rarity ? rarityBadge(card.rarity) : h('span.muted', 'Unknown — link the official card to see it')),
      h('div.market-row',
        h('span.market-label', 'Pull chance'),
        card.pull_chance != null
          ? h('span', h('strong', formatChance(card.pull_chance)), ` per booster pack (about 1 in ${oneIn(card.pull_chance).toLocaleString()} packs)`,
            h('small.muted.block', `Estimate from ${card.pull_source}. Real odds vary by set and product.`))
          : h('span.muted', 'Not available for this set or rarity')),
      h('div.market-row',
        h('span.market-label', 'Market price'),
        card.market_price != null
          ? h('span', h('strong.price-big', formatPrice(card.market_price, card.market_currency)),
            card.market_low != null && h('span.muted', ` · low ${formatPrice(card.market_low, card.market_currency)}`),
            card.market_high != null && h('span.muted', ` · high ${formatPrice(card.market_high, card.market_currency)}`),
            h('small.muted.block', [card.market_source, updated && `updated ${updated}`].filter(Boolean).join(', ')))
          : h('span.muted', 'No price found yet')),
      h('button.btn.small', { type: 'button', onclick: () => refreshMarket() }, 'Refresh price'));
  }

  // Every copy of this card (same official card and printing): condition, cost and plans per copy.
  function copiesSection() {
    const copies = card.copies ?? [];
    if (copies.length < 2) return null;
    const paid = copies.reduce((s, c) => s + (c.purchase_price ?? 0), 0);
    return h('section.copies',
      h('h3', `Your copies (${copies.length})`),
      h('div.table-wrap', h('table.simple-table',
        h('thead', h('tr', h('th', 'Added'), h('th', 'Condition'), h('th', 'Stored in'), h('th', 'Plans'), h('th.num', 'Paid'), h('th.num', 'Value'))),
        h('tbody', copies.map((c) => h('tr', { class: c.id === card.id ? 'current' : '', onclick: c.id === card.id ? null : async () => { card = await api.card(c.id); render(); } },
          h('td', shortDate(c.created_at), c.id === card.id && h('span.muted', ' (this one)')),
          h('td', gradeLabel(c) ?? c.condition ?? '—'),
          h('td', c.storage_location ?? '—'),
          h('td', STATUS_LABELS[c.status] ?? 'Keeping'),
          h('td.num', c.purchase_price != null ? formatPrice(c.purchase_price, 'USD') : '—'),
          h('td.num', c.market_price != null ? formatPrice(c.market_price, c.market_currency) : '—')))))),
      paid > 0 && h('p.muted', `Paid ${formatPrice(paid, 'USD')} in total.`));
  }

  async function addCopy() {
    const keep = ['name', 'set_code', 'set_name', 'number', 'set_total', 'variant', 'rarity', 'category', 'hp', 'types', 'tcg_id', 'official_image_url', 'language', 'pack_id'];
    try {
      const [copy] = await api.createCards([Object.fromEntries(keep.map((k) => [k, card[k] ?? null]))]);
      changed = true;
      card = await api.card(copy.id);
      toast('Added another copy — set its condition below', 'success');
      render('edit');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function render(view = 'info') {
    currentView = view;
    const extra = h('div.detail-extra');
    const row = (label, value) => value ? [h('dt', label), h('dd', value)] : null;
    const info = view === 'edit' ? editForm() : h('div',
      h('dl.details',
        row('Set', [card.set_name, card.set_code && `(${card.set_code})`].filter(Boolean).join(' ')),
        row('Number', cardNumber(card)),
        row('Language', card.language === 'ja' ? 'Japanese' : null),
        row('Variant', VARIANT_LABELS[card.variant] ?? card.variant),
        row('Category', card.category),
        row('HP', card.hp),
        row('Type', card.types),
        row('Pulled from', card.pack_id ? h('a', { href: `#/packs/${card.pack_id}`, onclick: () => dialog.close() }, card.pack_name) : 'Not from a pack'),
        row('Condition', card.condition && `${card.condition} — ${CONDITION_NAMES[card.condition]}`),
        row('Graded', gradeLabel(card)),
        row('Paid', card.purchase_price != null && [formatPrice(card.purchase_price, 'USD'),
          card.market_price != null && card.market_currency === 'USD' && h('span.muted', ` (${card.market_price >= card.purchase_price ? '+' : '−'}${formatPrice(Math.abs(card.market_price - card.purchase_price), 'USD')} now)`)]),
        row('Stored in', card.storage_location),
        row('Plans', STATUS_LABELS[card.status]),
        row('Date added', formatDate(card.created_at, true)),
        row('Notes', card.notes)),
      copiesSection(),
      h('div.actions.left',
        h('button.btn', { type: 'button', onclick: () => render('edit') }, 'Edit'),
        h('button.btn', { type: 'button', onclick: () => findOfficial(extra) }, card.tcg_id ? 'Change official card' : 'Find official card'),
        card.tcg_id && !card.official_image_path && h('button.btn', {
          type: 'button',
          onclick: async () => {
            try {
              await refresh(await api.refreshOfficial(card.id));
              toast(card.official_image_path ? 'Official image saved' : 'Still unavailable — try again later', card.official_image_path ? 'success' : 'info');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Retry official image'),
        h('button.btn', {
          type: 'button',
          onclick: () => pickFile(async (file) => {
            try {
              await refresh(await api.replaceCardPhoto(card.id, await cardPhotoBlob(file)));
            } catch (err) {
              toast(err.message, 'error');
            }
          }),
        }, card.photo_url ? 'Replace my photo' : 'Add my photo'),
        h('button.btn', { type: 'button', title: 'Add one more copy of this card (same printing) to your collection', onclick: addCopy }, '+ Add a copy'),
        h('button.btn.ghost.danger-text', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog(`Move ${card.name} to the trash? You can restore it for 30 days.`, { okLabel: 'Move to trash' }))) return;
            await api.deleteCard(card.id);
            changed = true;
            const removed = card.id;
            undoToast(`${card.name} moved to the trash`, async () => { await api.bulk({ ids: [removed], action: 'restore' }); onChange(); });
            dialog.close();
          },
        }, 'Delete')));

    clear(body,
      h('div.detail-images',
        figure('Your photo', card.photo_url, 'No photo'),
        figure('Official card', card.official_url, card.tcg_id ? 'Official image unavailable right now' : 'Not linked to an official card yet')),
      h('div.detail-info',
        h('h2', card.name),
        h('p.muted', [card.set_code, cardNumber(card)].filter(Boolean).join(' · ')),
        view === 'edit' ? null : marketSection(),
        info,
        extra),
      priceHistory,
      ebay);
  }

  // Created once, so it keeps its state (filters, chart view) when the rest of the dialog redraws.
  const priceHistory = historySection(card);
  const ebay = ebaySection(card);
  render();
  // Prices move: refresh in the background when the stored one is missing or more than a day old.
  // The same request links a card that isn't linked yet and fetches a missing official image.
  const age = card.market_updated ? Date.now() - Date.parse(card.market_updated) : Infinity;
  const missingOfficial = card.number && (!card.tcg_id || !card.official_image_path);
  if (missingOfficial || ((card.tcg_id || (card.set_code && card.number)) && age > DAY)) refreshMarket(true);
  const { dialog } = modal(body, { wide: true, onClose: () => changed && onChange() });
}
