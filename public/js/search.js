// Search every Pokémon card in the online sources (not only your collection), see its rarity,
// estimated pull chance and market price, and add it to your collection.

import { setCodeList } from './add.js';
import { api } from './api.js';
import { describeBrief } from './lookup.js';
import { clear, debounce, formatChance, formatPrice, h, modal, oneIn, rarityBadge, toast, VARIANT_LABELS } from './ui.js';

function marketBlock(market) {
  const { rarity, pull, price } = market;
  return h('div.market',
    h('div.market-row', h('span.market-label', 'Rarity'), rarity ? rarityBadge(rarity) : h('span.muted', 'Unknown')),
    h('div.market-row', h('span.market-label', 'Pull chance'),
      pull
        ? h('span', h('strong', formatChance(pull.chance)), ` per booster pack (about 1 in ${pull.oneIn.toLocaleString()} packs)`,
          h('small.muted.block', `Estimate from ${pull.source}. Real odds vary by set and product.`))
        : h('span.muted', 'Not available for this set or rarity')),
    h('div.market-row', h('span.market-label', 'Market price'),
      price
        ? h('span', h('strong.price-big', formatPrice(price.value, price.currency)),
          price.low != null && h('span.muted', ` · low ${formatPrice(price.low, price.currency)}`),
          price.high != null && h('span.muted', ` · high ${formatPrice(price.high, price.currency)}`),
          h('small.muted.block', price.source))
        : h('span.muted', 'No price found right now')));
}

async function openCatalogCard(brief, meta, onAdded) {
  const body = h('div.card-detail', h('p.muted', 'Loading card details…'));
  const { dialog } = modal(body, { wide: true });
  const packs = await api.packs();
  let variant = 'normal';
  let data;

  const variantSel = h('select', meta.variants.map((v) => h('option', { value: v }, VARIANT_LABELS[v] ?? v)));
  const packSel = h('select', h('option', { value: '' }, 'Not from a pack'), packs.map((p) => h('option', { value: String(p.id) }, p.name)));
  const marketHost = h('div');
  const addBtn = h('button.btn.primary', { type: 'button' }, 'Add to my collection');

  const loadMarket = async () => {
    clear(marketHost, h('p.muted', 'Checking rarity and price…'));
    try {
      data = await api.catalogCard(brief.tcgId, variant);
      clear(marketHost, marketBlock(data.market));
    } catch (err) {
      clear(marketHost, h('p.muted', err.message));
    }
  };
  variantSel.addEventListener('change', () => { variant = variantSel.value; loadMarket(); });

  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    try {
      const c = data?.card;
      const [saved] = await api.createCards([{
        tcg_id: brief.tcgId,
        name: c?.name ?? brief.name,
        set_code: c?.set_code ?? brief.setCode,
        set_id: c?.set_id ?? brief.setId,
        set_name: c?.set_name ?? brief.setName,
        number: c?.number ?? brief.number,
        set_total: c?.set_total ?? brief.setTotal,
        official_image_url: c?.official_image_url ?? brief.image,
        variant,
        pack_id: packSel.value || null,
      }]);
      toast(`Added ${saved.name} to your collection`, 'success');
      onAdded(brief);
      dialog.close();
    } catch (err) {
      toast(err.message, 'error');
      addBtn.disabled = false;
    }
  });

  clear(body,
    h('div.detail-images.single',
      h('figure.detail-img',
        brief.image ? h('img', { src: brief.image, alt: brief.name }) : h('div.detail-noimg', 'No image available'),
        h('figcaption', brief.source === 'pokemontcg' ? 'Image: Pokémon TCG data' : 'Image: TCGdex'))),
    h('div.detail-info',
      h('h2', brief.name),
      h('p.muted', [brief.setName, describeBrief(brief)].filter(Boolean).join(' · ')),
      brief.owned > 0 && h('p', h('span.chip.owned', `In your collection ×${brief.owned}`)),
      marketHost,
      h('div.add-to-collection',
        h('h3', 'Add to my collection'),
        h('div.field-row',
          h('label.field', h('span', 'Variant'), variantSel),
          h('label.field', h('span', 'Pulled from'), packSel)),
        h('p.muted.small', 'You can add your own photo of it later from the card in your collection.'),
        addBtn)));
  loadMarket();
}

export function renderSearch(root, meta, navigate, params) {
  const codeList = setCodeList(meta);
  const name = h('input', { type: 'search', placeholder: 'e.g. Charizard', value: params.get('name') ?? '', autocomplete: 'off' });
  const code = h('input.code', { type: 'text', placeholder: 'PAL', list: codeList, value: params.get('code') ?? '', maxLength: 6, autocomplete: 'off' });
  const num = h('input.num', { type: 'text', placeholder: '066/193', value: params.get('number') ?? '', autocomplete: 'off' });
  const status = h('p.muted.search-status');
  const grid = h('div');
  let seq = 0;

  const tile = (b) => h('button.card-tile', { type: 'button', onclick: () => openCatalogCard(b, meta, () => { b.owned = (b.owned ?? 0) + 1; render(results); }) },
    h('div.card-img',
      b.thumb || b.image ? h('img', { src: b.thumb || b.image, alt: '', loading: 'lazy', onerror: (e) => { if (b.image && e.target.src !== b.image) e.target.src = b.image; } }) : h('div.card-noimg', b.name),
      b.owned > 0 && h('span.badge.owned', `Owned ×${b.owned}`)),
    h('div.card-info',
      h('strong.card-name', b.name),
      h('span.card-set', describeBrief(b) || b.setName || ''),
      b.setName && h('span.card-date', b.setName),
      b.rarity && h('div.card-market', rarityBadge(b.rarity))));

  let results = [];
  const render = (list) => clear(grid, list.length ? h('div.card-grid', list.map(tile)) : null);

  const search = async () => {
    const q = { name: name.value.trim(), setCode: code.value.trim().toUpperCase(), number: num.value.trim() };
    history.replaceState(null, '', `#/search?${new URLSearchParams(Object.entries({ name: q.name, code: q.setCode, number: q.number }).filter(([, v]) => v))}`);
    const id = ++seq;
    if (q.name.length < 2 && !q.setCode && !q.number) {
      results = [];
      render(results);
      status.textContent = 'Search by name, or by the set code and number printed at the bottom-left of the card.';
      return;
    }
    status.textContent = 'Searching…';
    try {
      const { results: found } = await api.lookup(q);
      if (id !== seq) return;
      results = found;
      status.textContent = found.length
        ? `${found.length} card${found.length === 1 ? '' : 's'} found${found.length >= 48 ? ' (showing the first 48 — add a set code to narrow it down)' : ''}. Tap one for rarity, pull chance and price.`
        : 'No cards found. Check the spelling, set code or number.';
      render(results);
    } catch (err) {
      if (id !== seq) return;
      status.textContent = err.message;
      render([]);
    }
  };
  const later = debounce(search, 450);
  for (const input of [name, code, num]) input.addEventListener('input', later);
  const form = h('form.search-form', { onsubmit: (e) => { e.preventDefault(); search(); } },
    h('div.field-row.card-fields',
      h('label.field', h('span', 'Card name'), name),
      h('label.field', h('span', 'Set code'), code),
      h('label.field', h('span', 'Number'), num)),
    h('button.btn.primary', { type: 'submit' }, 'Search'));

  clear(root,
    h('div.page-head', h('h1', 'Search cards'),
      h('p.muted', 'Look up any Pokémon card — even ones you don’t own yet — with its rarity, estimated pull chance and current market price.')),
    h('section.panel', form, status),
    grid);
  search();
  name.focus();
}
