// Browsing views: the card collection, packs, a single pack, and the card detail dialog.

import { api } from './api.js';
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

function cardTile(card, mode, onOpen) {
  const official = card.official_url;
  const photo = card.photo_url;
  const primary = mode === 'photo' ? photo || official : official || photo;
  const secondary = primary === official ? photo : official;
  return h('button.card-tile', { type: 'button', onclick: () => onOpen(card), 'aria-label': `${card.name} ${cardNumber(card)}` },
    h('div.card-img',
      primary ? h('img', { src: primary, alt: '', loading: 'lazy' }) : h('div.card-noimg', card.name),
      secondary && h('img.card-inset', { src: secondary, alt: '', loading: 'lazy', title: secondary === photo ? 'Your photo' : 'Official card' }),
      card.variant && card.variant !== 'normal' && h('span.badge.variant', VARIANT_LABELS[card.variant] ?? card.variant)),
    h('div.card-info',
      h('strong.card-name', card.name),
      h('span.card-set', [card.set_code, cardNumber(card)].filter(Boolean).join(' · ') || card.set_name || '—'),
      (card.rarity || card.market_price != null) && h('div.card-market',
        rarityBadge(card.rarity),
        card.market_price != null && h('span.price', { title: card.market_source ?? 'Estimated market price' }, formatPrice(card.market_price, card.market_currency))),
      card.pull_chance != null && h('span.card-pull', { title: card.pull_source ?? '' }, `${formatChance(card.pull_chance)} per pack · 1 in ${oneIn(card.pull_chance).toLocaleString()}`),
      h('span.card-date', `Added ${formatDate(card.created_at)}`),
      card.pack_name && h('span.chip', `📦 ${card.pack_name}`)));
}

function cardGrid(cards, mode, onOpen, emptyState) {
  if (!cards.length) return emptyState;
  return h('div.card-grid', cards.map((c) => cardTile(c, mode, onOpen)));
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

// ---------------------------------------------------------------------------
// Collection

export async function renderCollection(root, meta, navigate, params) {
  const packs = await api.packs();
  let mode = getMode();
  const state = { q: params.get('q') ?? '', pack: params.get('pack') ?? '', set: params.get('set') ?? '', sort: params.get('sort') ?? '' };

  const search = h('input.search', { type: 'search', placeholder: 'Search name, set, number, rarity, pack…', value: state.q, 'aria-label': 'Search cards' });
  const packSel = h('select', { 'aria-label': 'Filter by pack' },
    h('option', { value: '' }, 'All packs & bundles'),
    h('option', { value: 'none' }, 'Not from a pack'),
    packs.map((p) => h('option', { value: String(p.id) }, `${p.name} (${p.card_count})`)));
  packSel.value = state.pack;
  const setSel = h('select', { 'aria-label': 'Filter by set' },
    h('option', { value: '' }, 'All sets'),
    meta.collectionSets.map((s) => h('option', { value: s.code }, `${s.code}${s.name ? ` — ${s.name}` : ''} (${s.count})`)));
  setSel.value = state.set;
  const sortSel = h('select', { 'aria-label': 'Sort' },
    h('option', { value: '' }, 'Newest first'),
    h('option', { value: 'oldest' }, 'Oldest first'),
    h('option', { value: 'name' }, 'Name A–Z'),
    h('option', { value: 'set' }, 'Set & number'),
    h('option', { value: 'value' }, 'Highest value'),
    h('option', { value: 'rarity' }, 'Hardest to pull'));
  sortSel.value = state.sort;

  const toggleHost = h('div');
  const results = h('div.results');
  const count = h('span.result-count.muted');

  const syncUrl = () => {
    if (!results.isConnected) return; // the user has left the collection page
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString();
    history.replaceState(null, '', `#/${qs ? `?${qs}` : ''}`);
  };

  const load = async () => {
    const cards = await api.cards({ q: state.q, packId: state.pack, setCode: state.set, sort: state.sort });
    const filtered = state.q || state.pack || state.set;
    count.textContent = filtered ? `${cards.length} matching card${cards.length === 1 ? '' : 's'}` : '';
    clear(results, cardGrid(cards, mode, (c) => openCard(c.id, { onChange: load }),
      filtered
        ? h('div.empty', h('p', 'No cards match your search.'))
        : h('div.empty',
          h('div.empty-art', { 'aria-hidden': 'true' }, h('span.pokeball')),
          h('h2', 'Your Pokédex is empty'),
          h('p.muted', 'Snap a photo of your cards — one at a time or a whole row — and they’ll be catalogued with their official artwork.'),
          h('a.btn.primary', { href: '#/add' }, 'Add your first cards'))));
    clear(toggleHost, modeToggle(mode, (m) => { mode = m; load(); }));
  };

  const update = () => {
    Object.assign(state, { q: search.value.trim(), pack: packSel.value, set: setSel.value, sort: sortSel.value });
    syncUrl();
    load();
  };
  search.addEventListener('input', debounce(update, 250));
  for (const el of [packSel, setSel, sortSel]) el.addEventListener('change', update);

  const s = meta.stats;
  const refreshAll = h('button.btn', {
    type: 'button',
    title: 'Look up current prices and pull chances for every card',
    onclick: async () => {
      refreshAll.disabled = true;
      refreshAll.textContent = 'Updating prices…';
      try {
        const { updated } = await api.refreshAllMarket();
        toast(`Updated ${updated} card${updated === 1 ? '' : 's'}`, 'success');
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
      h('div', h('h1', 'My collection'),
        h('div.stats',
          h('span', h('strong', s.cards), ' cards'),
          h('span', h('strong', s.unique_cards), ' unique'),
          h('span', h('strong', s.packs), ' packs & bundles'),
          value && h('span', { title: `Estimated market value of the ${s.priced} priced cards` }, 'Est. value ', h('strong', value)))),
      h('div.actions', s.cards > 0 && refreshAll, h('a.btn.primary', { href: '#/add' }, '+ Add cards'))),
    h('div.toolbar', search, packSel, setSel, sortSel, toggleHost),
    count,
    results);
  await load();
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

  const figure = (label, src, empty) => h('figure.detail-img',
    src ? h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: `${label}: ${card.name}` })) : h('div.detail-noimg', empty),
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
    const form = h('form.form',
      h('label.field', h('span', 'Name'), name),
      h('div.field-row', h('label.field', h('span', 'Set code'), code), h('label.field', h('span', 'Number'), num)),
      h('label.field', h('span', 'Set name'), setName),
      h('div.field-row', h('label.field', h('span', 'Variant'), variant), h('label.field', h('span', 'Pulled from'), pack)),
      h('label.field', h('span', 'Notes'), notes),
      h('div.actions.left', h('button.btn.primary', { type: 'submit' }, 'Save changes'), h('button.btn', { type: 'button', onclick: () => render() }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const [number, total] = num.value.split('/').map((s) => s.trim());
      try {
        await refresh(await api.updateCard(card.id, {
          name: name.value, set_code: code.value, number: number || null, set_total: total || null,
          set_name: setName.value, variant: variant.value, pack_id: pack.value || null, notes: notes.value,
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
      card = await api.refreshMarket(card.id);
      changed = true;
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

  function render(view = 'info') {
    currentView = view;
    const extra = h('div.detail-extra');
    const row = (label, value) => value ? [h('dt', label), h('dd', value)] : null;
    const info = view === 'edit' ? editForm() : h('div',
      h('dl.details',
        row('Set', [card.set_name, card.set_code && `(${card.set_code})`].filter(Boolean).join(' ')),
        row('Number', cardNumber(card)),
        row('Variant', VARIANT_LABELS[card.variant] ?? card.variant),
        row('Category', card.category),
        row('HP', card.hp),
        row('Type', card.types),
        row('Pulled from', card.pack_id ? h('a', { href: `#/packs/${card.pack_id}`, onclick: () => dialog.close() }, card.pack_name) : 'Not from a pack'),
        row('Date added', formatDate(card.created_at, true)),
        row('Notes', card.notes)),
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
        h('button.btn.ghost.danger-text', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog(`Remove ${card.name} from your collection?`))) return;
            await api.deleteCard(card.id);
            changed = true;
            toast('Card removed', 'success');
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
        extra));
  }

  render();
  // Prices move: refresh in the background when the stored one is missing or more than a day old.
  if (card.tcg_id || (card.set_code && card.number)) {
    const age = card.market_updated ? Date.now() - Date.parse(card.market_updated) : Infinity;
    if (age > DAY) refreshMarket(true);
  }
  const { dialog } = modal(body, { wide: true, onClose: () => changed && onChange() });
}
