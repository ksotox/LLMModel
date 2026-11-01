// Set completion: your sets with progress, any set to browse, and one set's full checklist with
// owned cards in colour and missing ones muted.

import { api } from './api.js';
import { openCatalogCard } from './search.js';
import { clear, formatPrice, h, rarityBadge, toast } from './ui.js';
import { openCard } from './views.js';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
const bar = (v) => h('div.progress', h('span', { style: { width: `${Math.round((v ?? 0) * 100)}%` } }));

export async function renderSets(root, meta, navigate) {
  const { sets } = await api.sets();
  const lang = h('select', { 'aria-label': 'Language' }, h('option', { value: 'en' }, 'English sets'), h('option', { value: 'ja' }, 'Japanese sets'));
  const pick = h('select', { 'aria-label': 'Set' }, h('option', { value: '' }, 'Loading sets…'));
  const loadAll = async () => {
    clear(pick, h('option', { value: '' }, 'Loading sets…'));
    try {
      const all = (await api.allSets(lang.value)).sets.slice().reverse(); // newest first
      clear(pick, h('option', { value: '' }, 'Choose a set…'), all.map((s) => h('option', { value: s.setId }, `${s.name}${s.code ? ` (${s.code})` : ''}${s.total ? ` · ${s.total}` : ''}`)));
    } catch (err) {
      clear(pick, h('option', { value: '' }, err.message));
    }
  };
  lang.addEventListener('change', loadAll);
  pick.addEventListener('change', () => { if (pick.value) navigate(`#/sets/${lang.value}/${encodeURIComponent(pick.value)}`); });

  clear(root,
    h('div.page-head', h('h1', 'Sets'), h('p.muted', 'How complete is each expansion? Open a set to see every card: the ones you own, and the ones still missing.')),
    sets.length
      ? h('div.set-grid', sets.map((s) => h('a.set-tile', { href: s.setId ? `#/sets/${s.lang}/${encodeURIComponent(s.setId)}` : undefined },
        h('div.set-tile-head', h('strong', s.name || s.code), s.lang === 'ja' && h('span.lang-tag', 'JP')),
        h('span.muted.small', `${s.code} · ${s.copies} card${s.copies === 1 ? '' : 's'}`),
        bar(s.completion),
        h('span.set-tile-foot', h('strong', s.total ? `${s.owned} / ${s.total}` : `${s.owned} owned`), h('span', pct(s.completion))))))
      : h('div.empty', h('p', 'Add some cards and your sets appear here.')),
    h('section.panel', h('h2', 'Browse any set'), h('div.field-row', lang, pick)));
  loadAll();
}

export async function renderSet(root, meta, navigate, lang, setId, params) {
  clear(root, h('p.muted', 'Loading the checklist…'));
  let data = await api.set(lang, setId);
  let goal = params.get('goal') ?? 'main';
  let show = params.get('show') ?? 'all';
  const grid = h('div');
  const summary = h('div');

  const inGoal = (c) => (goal === 'main' ? !c.secret : goal === 'reverse' ? c.reverseEligible : true);
  const owns = (c) => (goal === 'reverse' ? c.ownedReverse > 0 : c.owned > 0);
  const FILTERS = {
    all: () => true,
    missing: (c) => !owns(c),
    owned: (c) => owns(c),
    duplicates: (c) => c.owned > 1,
    'missing-ir': (c) => !c.owned && /illustration rare/i.test(c.rarity ?? ''),
  };

  const render = () => {
    const g = data.goals[goal];
    clear(summary,
      h('div.set-metrics',
        metric('Cards owned', g.owned), metric('Total cards', g.total), metric('Completion', pct(g.completion)),
        metric('Missing', g.total - g.owned),
        metric('Est. value of missing', data.missingValue != null ? formatPrice(data.missingValue, 'USD') : h('button.btn.small', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = 'Looking up prices…';
            try {
              data = await api.set(lang, setId, { values: 1 });
              render();
            } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
          },
        }, 'Estimate')),
        metric('Duplicate copies', data.duplicates)),
      bar(g.completion));
    const cards = data.cards.filter((c) => inGoal(c) && FILTERS[show](c));
    clear(grid, cards.length ? h('div.card-grid.checklist', cards.map((c) => h('button.card-tile.check-tile', {
      type: 'button',
      class: owns(c) ? 'owned' : 'missing',
      onclick: () => (c.ids.length ? openCard(c.ids[0]) : openCatalogCard({ tcgId: c.tcgId, name: c.name, number: c.number, image: c.imageLarge, setCode: data.code, setName: data.name, language: lang }, meta, async () => { data = await api.set(lang, setId); render(); })),
    },
    h('div.card-img', c.image ? h('img', { src: c.image, alt: '', loading: 'lazy', onerror: (e) => { if (c.imageLarge && e.target.src !== c.imageLarge) e.target.src = c.imageLarge; } }) : h('div.card-noimg', c.name),
      c.owned > 1 && h('span.badge.qty', `×${c.owned}`),
      !owns(c) && h('span.badge.missing-badge', 'Missing')),
    h('div.card-info',
      h('strong.card-name', { title: c.name }, c.name),
      h('span.card-set', h('span', `#${c.number}`), c.secret && h('span.chip', 'secret')),
      c.rarity && h('div.card-meta', h('div.card-market', rarityBadge(c.rarity), c.value != null && h('span.price', formatPrice(c.value, 'USD'))))))))
      : h('div.empty', h('p', 'Nothing to show with this filter.')));
    history.replaceState(null, '', `#/sets/${lang}/${encodeURIComponent(setId)}?goal=${goal}&show=${show}`);
  };

  const goalSel = h('select', { 'aria-label': 'Goal' }, Object.entries(data.goals).map(([k, g]) => h('option', { value: k }, `${g.label} — ${pct(g.completion)}`)));
  goalSel.value = goal;
  goalSel.addEventListener('change', () => { goal = goalSel.value; render(); });
  const chips = h('div.chips', [['all', 'All'], ['missing', 'Missing'], ['owned', 'Owned'], ['duplicates', 'Duplicates'], ...(data.hasRarities ? [['missing-ir', 'Missing illustration rares']] : [])]
    .map(([k, label]) => h('button.chip-button', { type: 'button', class: k === show ? 'active' : '', onclick: (e) => { show = k; for (const b of chips.children) b.classList.toggle('active', b === e.target); render(); } }, label)));

  clear(root,
    h('a.back', { href: '#/sets' }, '← All sets'),
    h('div.page-head', h('h1', data.name, ' ', lang === 'ja' && h('span.lang-tag', 'JP')), h('p.muted', `${data.code} · ${data.official ?? '?'} numbered cards${data.cards.length > (data.official ?? 0) ? ` + ${data.cards.length - data.official} secret rares` : ''}`)),
    h('section.panel', summary),
    h('div.toolbar', goalSel, chips),
    grid);
  render();
}

function metric(label, value) {
  return h('div.metric', h('span.metric-label', label), h('strong.metric-value', value));
}
