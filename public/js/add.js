// Adding to the collection: upload one or many card photos (optionally splitting a photo with several
// cards in it) and, optionally, the pack / tin / kit / bundle they were pulled from.

import { api } from './api.js';
import { editBoxes } from './cropper.js';
import { cropToBlob, detectCards, loadImage } from './images.js';
import { describeBrief, lookupPanel } from './lookup.js';
import { clear, debounce, dropZone, h, KIND_LABELS, toast, VARIANT_LABELS } from './ui.js';

const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function select(options, value, props = {}) {
  const el = h('select', props, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}

function field(label, control, extra) {
  return h('label.field', h('span', label), control, extra);
}

export function setCodeList(meta) {
  const id = 'set-code-options';
  if (!document.getElementById(id)) {
    document.body.append(h('datalist', { id },
      Object.entries(meta.setCodes).map(([code, s]) => h('option', { value: code }, s.name))));
  }
  return id;
}

/** Split "066/193" into number + set total for storage. */
function splitNumber(raw) {
  const [number, total] = String(raw ?? '').split('/').map((s) => s.trim());
  return { number: number || null, set_total: total || null };
}

// ---------------------------------------------------------------------------
// Pack uploader (used on its own for "Add packs", and inside the card flow)

export function packUploader(meta, { onChange = () => {} } = {}) {
  const items = [];
  const list = h('div.pack-items');

  const kinds = meta.packKinds.map((k) => [k, KIND_LABELS[k] ?? k]);

  const addItem = ({ blob = null, preview = null, img = null } = {}) => {
    const item = { key: nextKey(), blob, preview, img, name: '', kind: 'booster-pack', set_name: '' };
    const name = h('input', { type: 'text', placeholder: 'e.g. Phantasmal Flames booster pack', required: true, oninput: () => { item.name = name.value; onChange(); } });
    const kind = select(kinds, item.kind, { onchange: () => { item.kind = kind.value; onChange(); } });
    const set = h('input', { type: 'text', placeholder: 'Set / product (optional)', list: setCodeList(meta), oninput: () => { item.set_name = set.value; } });
    item.el = h('div.pack-item',
      h('div.pack-thumb', preview ? h('img', { src: preview, alt: 'Pack photo' }) : h('span.placeholder', { 'aria-hidden': 'true' }, '📦')),
      h('div.pack-fields',
        field('Name', name),
        h('div.field-row', field('Type', kind), field('Set', set))),
      h('div.item-actions',
        img && h('button.btn.small', { type: 'button', title: 'Crop, or split one photo of several packs', onclick: () => splitItem(item) }, 'Crop / split'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => removeItem(item) }, 'Remove')));
    item.focus = () => name.focus();
    items.push(item);
    list.append(item.el);
    onChange();
    return item;
  };

  const removeItem = (item) => {
    items.splice(items.indexOf(item), 1);
    item.el.remove();
    onChange();
  };

  const splitItem = async (item) => {
    const boxes = await editBoxes(item.img, [item.box ?? WHOLE], { title: 'Mark each pack in the photo' });
    if (!boxes?.length) return;
    const [first, ...rest] = boxes;
    const update = async (target, box) => {
      target.box = box;
      target.blob = await cropToBlob(target.img, box, 'pack.jpg');
      const url = URL.createObjectURL(target.blob);
      target.el.querySelector('.pack-thumb').replaceChildren(h('img', { src: url, alt: 'Pack photo' }));
    };
    await update(item, first);
    for (const box of rest) {
      const extra = addItem({ img: item.img, preview: null });
      await update(extra, box);
    }
  };

  const addFiles = async (files) => {
    for (const file of files) {
      try {
        const img = await loadImage(file);
        const blob = await cropToBlob(img, WHOLE, 'pack.jpg');
        addItem({ blob, preview: URL.createObjectURL(blob), img });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  };

  const el = h('div.pack-uploader',
    dropZone({ label: 'Add photos of packs, tins, kits or bundles', hint: 'One photo per pack — or one photo of several, then use “Crop / split”.', onFiles: addFiles }),
    h('button.btn.link', { type: 'button', onclick: () => addItem().focus() }, '+ Add a pack without a photo'),
    list);

  return {
    el,
    items,
    validate() {
      const missing = items.find((i) => !i.name.trim());
      if (missing) {
        missing.focus();
        throw new Error('Give every pack a name');
      }
    },
    payload: () => items.map((i) => ({ name: i.name.trim(), kind: i.kind, set_name: i.set_name.trim() || null, photo: i.blob })),
  };
}

export function renderAddPacks(root, meta, navigate) {
  const save = h('button.btn.primary', { type: 'button', disabled: true }, 'Save packs');
  const uploader = packUploader(meta, {
    onChange: () => {
      const n = uploader.items.length;
      save.disabled = !n;
      save.textContent = n ? `Save ${n} pack${n === 1 ? '' : 's'}` : 'Save packs';
    },
  });
  save.addEventListener('click', async () => {
    try {
      uploader.validate();
      save.disabled = true;
      save.textContent = 'Saving…';
      const packs = await api.createPacks(uploader.payload());
      toast(`Added ${packs.length} pack${packs.length === 1 ? '' : 's'}`, 'success');
      navigate(packs.length === 1 ? `#/packs/${packs[0].id}` : '#/packs');
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
      save.textContent = 'Save packs';
    }
  });
  clear(root,
    h('div.page-head', h('h1', 'Add packs'), h('p.muted', 'Record the packs, tins, kits and bundles you open. The date added is saved automatically.')),
    h('section.panel', uploader.el),
    h('div.save-bar', save));
}

// ---------------------------------------------------------------------------
// Card flow

export async function renderAddCards(root, meta, navigate, { packId } = {}) {
  const existingPacks = await api.packs();
  const codeList = setCodeList(meta);
  const sources = []; // uploaded photos: { key, img, boxes, cards[], el }
  const NONE = '';

  // Step 1 — where were these pulled from?
  const packChoice = select([
    [NONE, 'Not from a pack / not sure'],
    ...existingPacks.map((p) => [`p:${p.id}`, `${p.name} · ${KIND_LABELS[p.kind] ?? p.kind}`]),
    ['new', '+ New pack, tin, kit or bundle…'],
  ], packId ? `p:${packId}` : NONE, { 'aria-label': 'Pulled from' });
  const newPacks = packUploader(meta, { onChange: () => refreshPackOptions() });
  const newPackWrap = h('div.new-packs', { hidden: true }, newPacks.el);

  const packOptions = () => [
    [NONE, 'No pack'],
    ...existingPacks.map((p) => [`p:${p.id}`, p.name]),
    ...newPacks.items.map((i, n) => [`n:${i.key}`, i.name.trim() || `New pack ${n + 1}`]),
  ];
  const defaultPack = () => {
    if (packChoice.value !== 'new') return packChoice.value;
    return newPacks.items[0] ? `n:${newPacks.items[0].key}` : NONE;
  };

  const allCards = () => sources.flatMap((s) => s.cards);

  function refreshPackOptions() {
    const opts = packOptions();
    for (const card of allCards()) {
      if (!card.packTouched) card.packRef = defaultPack();
      if (!opts.some(([v]) => v === card.packRef)) card.packRef = defaultPack();
      clear(card.packSelect, opts.map(([v, label]) => h('option', { value: v }, label)));
      card.packSelect.value = card.packRef;
    }
    updateSave();
  }

  packChoice.addEventListener('change', () => {
    newPackWrap.hidden = packChoice.value !== 'new';
    if (packChoice.value === 'new' && !newPacks.items.length) newPackWrap.querySelector('.dropzone')?.scrollIntoView({ block: 'nearest' });
    refreshPackOptions();
  });

  // Step 2 — card photos
  const sourceList = h('div.sources');

  function makeCard(source, blob, previous = {}) {
    const card = {
      key: nextKey(),
      blob,
      preview: URL.createObjectURL(blob),
      name: previous.name ?? '',
      set_code: previous.set_code ?? '',
      number: previous.number ?? '',
      variant: previous.variant ?? 'normal',
      packRef: previous.packTouched ? previous.packRef : defaultPack(),
      packTouched: previous.packTouched ?? false,
      match: previous.match ?? null,
    };
    const nameIn = h('input', { type: 'text', value: card.name, placeholder: 'e.g. Voltorb', autocomplete: 'off' });
    const codeIn = h('input.code', { type: 'text', value: card.set_code, placeholder: 'PAL', list: codeList, maxLength: 6, autocomplete: 'off' });
    const numIn = h('input.num', { type: 'text', value: card.number, placeholder: '066/193', autocomplete: 'off', inputMode: 'text' });
    const variant = select(meta.variants.map((v) => [v, VARIANT_LABELS[v] ?? v]), card.variant, { onchange: () => { card.variant = variant.value; } });
    card.packSelect = select(packOptions(), card.packRef, {
      onchange: () => { card.packRef = card.packSelect.value; card.packTouched = true; updateSave(); },
    });
    const matchNote = h('span.match-note');
    const showMatch = () => {
      matchNote.textContent = card.match ? `✓ Official card: ${card.match.name} · ${describeBrief(card.match)}` : '';
      card.el?.classList.toggle('matched', !!card.match);
    };
    const panel = lookupPanel({
      selectedId: card.match?.tcgId,
      onSelect: (brief) => {
        card.match = brief;
        if (brief) {
          nameIn.value = card.name = brief.name;
          if (brief.setCode) codeIn.value = card.set_code = brief.setCode;
          if (brief.number) numIn.value = card.number = brief.setTotal ? `${brief.number}/${brief.setTotal}` : brief.number;
        }
        showMatch();
        updateSave();
      },
    });
    const runSearch = debounce(() => panel.search({ name: card.name, setCode: card.set_code, number: card.number }), 500);
    const onField = () => {
      card.name = nameIn.value;
      card.set_code = codeIn.value.toUpperCase();
      card.number = numIn.value;
      if (card.match) {
        card.match = null;
        showMatch();
      }
      updateSave();
      runSearch();
    };
    for (const input of [nameIn, codeIn, numIn]) input.addEventListener('input', onField);

    card.el = h('div.card-item',
      h('div.card-item-photo', h('img', { src: card.preview, alt: 'Your card photo' })),
      h('div.card-item-body',
        h('div.field-row.card-fields',
          field('Name', nameIn),
          field('Set code', codeIn),
          field('Number', numIn)),
        h('div.field-row',
          field('Variant', variant),
          field('Pulled from', card.packSelect)),
        matchNote,
        panel.el),
      h('div.item-actions',
        h('button.btn.small.ghost', { type: 'button', onclick: () => removeCard(source, card) }, 'Remove')));
    card.nameInput = nameIn;
    showMatch();
    if (card.name || (card.set_code && card.number)) panel.search({ name: card.name, setCode: card.set_code, number: card.number });
    return card;
  }

  function removeCard(source, card) {
    source.cards.splice(source.cards.indexOf(card), 1);
    card.el.remove();
    if (!source.cards.length) removeSource(source);
    renderSourceHead(source);
    updateSave();
  }

  function removeSource(source) {
    sources.splice(sources.indexOf(source), 1);
    source.el.remove();
    updateSave();
  }

  function renderSourceHead(source) {
    const n = source.cards.length;
    clear(source.head,
      h('img.source-thumb', { src: source.img.src, alt: 'Original photo' }),
      h('div.source-info',
        h('strong', source.name),
        h('span.muted', n === 1 ? '1 card in this photo' : `${n} cards found in this photo`)),
      h('div.item-actions',
        h('button.btn.small', { type: 'button', onclick: () => adjustSource(source) }, n > 1 ? 'Adjust cards' : 'Crop / split'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => removeSource(source) }, 'Remove photo')));
  }

  async function buildSourceCards(source, boxes) {
    const previous = source.cards;
    const cards = [];
    for (const [i, box] of boxes.entries()) {
      const blob = await cropToBlob(source.img, box, `card-${i + 1}.jpg`);
      cards.push(makeCard(source, blob, previous[i]));
    }
    source.boxes = boxes;
    source.cards = cards;
    clear(source.body, cards.map((c) => c.el));
    renderSourceHead(source);
    updateSave();
  }

  async function adjustSource(source) {
    const boxes = await editBoxes(source.img, source.boxes);
    if (!boxes) return;
    if (!boxes.length) return removeSource(source);
    await buildSourceCards(source, boxes);
  }

  async function addPhotos(files) {
    for (const file of files) {
      try {
        const img = await loadImage(file);
        const detected = detectCards(img);
        const source = { key: nextKey(), img, name: file.name || 'Photo', cards: [], boxes: [] };
        source.head = h('div.source-head');
        source.body = h('div.source-cards');
        source.el = h('div.source', source.head, source.body);
        sources.push(source);
        sourceList.append(source.el);
        await buildSourceCards(source, detected.length ? detected : [WHOLE]);
        source.cards[0]?.nameInput.focus({ preventScroll: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  // Save
  const save = h('button.btn.primary', { type: 'button', disabled: true }, 'Save cards');
  const summary = h('span.muted');
  function updateSave() {
    const cards = allCards();
    const matched = cards.filter((c) => c.match).length;
    save.disabled = !cards.length;
    save.textContent = cards.length ? `Save ${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Save cards';
    summary.textContent = cards.length ? `${matched} of ${cards.length} matched to an official card` : 'Upload card photos to get started';
  }

  save.addEventListener('click', async () => {
    const cards = allCards();
    try {
      const unnamed = cards.find((c) => !c.name.trim() && !c.match);
      if (unnamed) {
        unnamed.nameInput.focus();
        throw new Error('Give every card a name (or pick its official match)');
      }
      const usedNew = new Set(cards.filter((c) => c.packRef.startsWith('n:')).map((c) => c.packRef.slice(2)));
      if (packChoice.value === 'new') newPacks.validate();
      save.disabled = true;
      save.textContent = 'Saving…';

      // Create any new packs first so the cards can point at them.
      const packIds = new Map();
      const toCreate = packChoice.value === 'new' ? newPacks.items : newPacks.items.filter((i) => usedNew.has(i.key));
      if (toCreate.length) {
        const payload = newPacks.payload().filter((_, i) => toCreate.includes(newPacks.items[i]));
        const created = await api.createPacks(payload);
        toCreate.forEach((item, i) => packIds.set(item.key, created[i].id));
      }
      const resolvePack = (ref) => {
        if (ref.startsWith('p:')) return Number(ref.slice(2));
        if (ref.startsWith('n:')) return packIds.get(ref.slice(2)) ?? null;
        return null;
      };

      const payload = cards.map((c) => {
        const m = c.match;
        return {
          photo: c.blob,
          name: c.name.trim() || m?.name,
          set_code: c.set_code.trim() || m?.setCode || null,
          ...splitNumber(c.number),
          variant: c.variant,
          pack_id: resolvePack(c.packRef),
          ...(m ? { tcg_id: m.tcgId, set_id: m.setId, set_name: m.setName, official_image_url: m.image } : {}),
        };
      });
      const saved = await api.createCards(payload);
      toast(`Added ${saved.length} card${saved.length === 1 ? '' : 's'} to your Pokédex`, 'success');
      const packs = new Set(saved.map((c) => c.pack_id));
      navigate(packs.size === 1 && saved[0].pack_id ? `#/packs/${saved[0].pack_id}` : '#/');
    } catch (err) {
      toast(err.message, 'error');
      updateSave();
    }
  });

  clear(root,
    h('div.page-head',
      h('h1', 'Add cards'),
      h('p.muted', 'Upload one card per photo, or one photo of several cards — they are found automatically and you can adjust them. The date added is recorded for you.')),
    h('section.panel',
      h('h2.step', h('span.step-num', '1'), 'Pulled from ', h('span.muted.optional', '(optional)')),
      field('Pack, tin, kit or bundle', packChoice),
      newPackWrap),
    h('section.panel',
      h('h2.step', h('span.step-num', '2'), 'Card photos'),
      dropZone({ label: 'Drop card photos here', hint: 'Single cards or several cards per photo. JPEG or PNG.', onFiles: addPhotos }),
      sourceList),
    h('div.save-bar', summary, save));

  if (packChoice.value === 'new') newPackWrap.hidden = false;
  updateSave();
}
