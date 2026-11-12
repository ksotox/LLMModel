// Adding to the collection: upload one or many card photos (optionally splitting a photo with several
// cards in it) and, optionally, the pack / tin / kit / bundle they were pulled from.

import { api } from './api.js';
import { editQuads } from './cropper.js';
import { suggestVariant, VARIANT_NAMES } from './foil.js';
import { analyseCardAsync, compareAnglesAsync } from './foilAsync.js';
import { biggestCardCanvas, canvasToBlob, cardQuads, cropToBlob, cutCard, cutRegion, loadImage, wholeQuad } from './images.js';
import { describeBrief, lookupPanel } from './lookup.js';
import { readCardText } from './ocr.js';
import { warmUpCardFinder, warpCard } from './vision.js';
import { retakeAdvice } from './vision/quality.js';
import { clear, debounce, dropZone, h, KIND_LABELS, modal, toast, VARIANT_LABELS } from './ui.js';

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
    const quads = await editQuads(item.img, [item.quad ?? wholeQuad(item.img)], { title: 'Mark each pack in the photo', detect: false });
    if (!quads?.length) return;
    const [first, ...rest] = quads;
    const update = async (target, quad) => {
      target.quad = quad;
      target.blob = await cutRegion(target.img, quad, 'pack.jpg');
      const url = URL.createObjectURL(target.blob);
      target.el.querySelector('.pack-thumb').replaceChildren(h('img', { src: url, alt: 'Pack photo' }));
    };
    await update(item, first);
    for (const quad of rest) {
      const extra = addItem({ img: item.img, preview: null });
      await update(extra, quad);
    }
  };

  const addFiles = async (files) => {
    for (const file of files) {
      try {
        const img = await loadImage(file);
        const blob = await cropToBlob(img, 'pack.jpg');
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

// Which printings each official card exists in (asked once per card id).
const printingsCache = new Map();
function printingsOf(tcgId) {
  if (!printingsCache.has(tcgId)) {
    printingsCache.set(tcgId, api.printings(tcgId).catch(() => {
      printingsCache.delete(tcgId);
      return null;
    }));
  }
  return printingsCache.get(tcgId);
}

const pixels = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

/** The same canvas turned upside down (for a card photographed the wrong way round). */
function rotated180(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width, out.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// How good a reading is, to compare a second attempt with the first.
const readScore = (r) => (r.match ? { high: 3, medium: 2, low: 1 }[r.confidence] ?? 1 : (r.read?.name ? 0.5 : 0) + (r.read?.number ? 0.4 : 0));

// The three outcomes of reading a card, plus the states around them.
const STATUS = {
  queued: ['Waiting', 'Waiting to be read'],
  reading: ['Reading…', 'Reading the card'],
  recognized: ['Recognized', 'Matched to its official card'],
  review: ['Review needed', 'Probably right: check it is the right card'],
  unrecognized: ['Unrecognized', 'Couldn’t be read: type its details or read it again'],
  confirmed: ['Checked', 'Checked or filled in by you'],
};

// Same grouping as the server's: the official card (or name + set + number) and the printing.
const dupKey = (c) => `${c.tcg_id ?? `${String(c.name ?? '').trim().toLowerCase()}|${String(c.set_code ?? '').toUpperCase()}|${String(c.number ?? '').replace(/^0+/, '')}`}#${c.variant ?? 'normal'}`;

export async function renderAddCards(root, meta, navigate, { packId } = {}) {
  warmUpCardFinder(); // load the card finder in the background before the first photo
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

  // Cards are read one at a time: OCR is heavy and shares one worker.
  let readQueue = Promise.resolve();
  const progress = { total: 0, done: 0 };
  const progressBar = h('progress', { max: 1, value: 0 });
  const progressText = h('span');
  const progressEl = h('div.read-progress', { hidden: true, role: 'status', 'aria-live': 'polite' }, progressText, progressBar);
  const batchSummary = h('div.batch-summary', { hidden: true });
  let reviewOnly = false;

  function drawProgress() {
    const busy = progress.done < progress.total;
    progressEl.hidden = !busy;
    if (busy) {
      progressText.textContent = `Reading card ${progress.done + 1} of ${progress.total}…`;
      progressBar.max = progress.total;
      progressBar.value = progress.done;
    } else {
      progress.total = progress.done = 0;
    }
  }

  function queueRead(card, job) {
    progress.total++;
    drawProgress();
    readQueue = readQueue.then(async () => {
      if (allCards().includes(card)) await job().catch((err) => console.warn('Reading failed:', err));
      progress.done++;
      drawProgress();
      drawSummary();
    });
  }

  // After a batch: how many were recognized, need a look, or couldn't be read.
  function drawSummary() {
    const cards = allCards();
    const busy = progress.done < progress.total;
    const count = (...st) => cards.filter((c) => st.includes(c.status)).length;
    const ok = count('recognized', 'confirmed');
    const review = count('review');
    const failed = count('unrecognized');
    batchSummary.hidden = !cards.length || busy;
    if (batchSummary.hidden) return;
    if (!review && !failed && reviewOnly) setReviewOnly(false);
    clear(batchSummary,
      h('div.summary-counts',
        h('span.read-status.recognized', `${ok} recognized`),
        review > 0 && h('span.read-status.review', `${review} need${review === 1 ? 's' : ''} review`),
        failed > 0 && h('span.read-status.unrecognized', `${failed} unrecognized`)),
      h('div.actions.left',
        (review || failed) > 0 && h('button.btn.small', { type: 'button', class: reviewOnly ? 'active' : '', onclick: () => setReviewOnly(!reviewOnly) },
          reviewOnly ? 'Show all cards' : `Review ${review + failed} uncertain card${review + failed === 1 ? '' : 's'}`),
        failed > 0 && h('button.btn.small.ghost', { type: 'button', onclick: () => { for (const c of cards.filter((x) => x.status === 'unrecognized')) c.retry(); } },
          `Read ${failed === 1 ? 'it' : `all ${failed}`} again`)));
  }

  function setReviewOnly(on) {
    reviewOnly = on;
    sourceList.classList.toggle('review-only', on);
    drawSummary();
    if (on) sourceList.querySelector('.card-item.status-review, .card-item.status-unrecognized')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  const onStatusChange = debounce(() => { drawSummary(); updateSave(); }, 50);

  function makeCard(source, blob, previous = {}, canvas = null, quality = null, recut = null) {
    // After re-cropping, keep what the user typed; anything read automatically is read again.
    const typed = previous.touched ? previous : {};
    const card = {
      key: nextKey(),
      blob,
      preview: URL.createObjectURL(blob),
      touched: typed.touched ?? false,
      name: typed.name ?? '',
      set_code: typed.set_code ?? '',
      number: typed.number ?? '',
      variant: previous.variant ?? 'normal',
      variantTouched: previous.variantTouched ?? false,
      packRef: previous.packTouched ? previous.packRef : defaultPack(),
      packTouched: previous.packTouched ?? false,
      match: typed.match ?? null,
      status: typed.touched ? 'confirmed' : 'queued',
    };
    const statusBadge = h('span.read-status', { role: 'status' });
    const retryButton = h('button.btn.small.ghost', { type: 'button', hidden: true, onclick: () => card.retry() }, 'Read again');
    card.setStatus = (status) => {
      card.status = status;
      const [label, title] = STATUS[status];
      statusBadge.className = `read-status ${status}`;
      statusBadge.textContent = label;
      statusBadge.title = title;
      card.el?.classList.remove(...Object.keys(STATUS).map((k) => `status-${k}`));
      card.el?.classList.add(`status-${status}`);
      retryButton.hidden = !canvas || !['review', 'unrecognized'].includes(status);
      onStatusChange();
    };
    const nameIn = h('input', { type: 'text', value: card.name, placeholder: 'e.g. Voltorb', autocomplete: 'off' });
    const codeIn = h('input.code', { type: 'text', value: card.set_code, placeholder: 'PAL', list: codeList, maxLength: 6, autocomplete: 'off' });
    const numIn = h('input.num', { type: 'text', value: card.number, placeholder: '066/193', autocomplete: 'off', inputMode: 'text' });
    const variant = select(meta.variants.map((v) => [v, VARIANT_LABELS[v] ?? v]), card.variant, {
      onchange: () => {
        card.variant = variant.value;
        card.variantTouched = true;
        card.updateVariantHint();
      },
    });

    // Variant suggestion: which printings exist (TCGdex), the foil texture in this photo, and an
    // optional tilt scan. A certain answer is filled in; anything else waits for "Use".
    const variantHint = h('div.variant-hint', { 'aria-live': 'polite' });
    const tiltFrames = [];
    let photoFoil = null;
    let hintSeq = 0;
    const setVariant = (value, byUser) => {
      if (!meta.variants.includes(value)) return;
      variant.value = card.variant = value;
      if (byUser) card.variantTouched = true;
    };
    const tiltInput = h('input', { type: 'file', accept: 'image/*', multiple: true, capture: 'environment', hidden: true });
    tiltInput.addEventListener('change', async () => {
      const files = [...tiltInput.files];
      tiltInput.value = '';
      for (const file of files) {
        try {
          const img = await loadImage(file);
          tiltFrames.push(await biggestCardCanvas(img, canvas.width));
          URL.revokeObjectURL(img.objectUrl);
        } catch (err) {
          toast(err.message, 'error');
        }
      }
      tiltFrames.splice(0, Math.max(0, tiltFrames.length - 3)); // the latest three angles
      card.updateVariantHint();
    });
    card.updateVariantHint = async () => {
      if (!canvas) return;
      const seq = ++hintSeq;
      try {
        photoFoil ??= await analyseCardAsync(pixels(canvas));
        const printings = card.match?.tcgId ? await printingsOf(card.match.tcgId) : null;
        let angles = null;
        if (tiltFrames.length) {
          try {
            angles = await compareAnglesAsync([canvas, ...tiltFrames].map(pixels));
          } catch (err) {
            toast(err.message, 'error');
          }
        }
        if (seq !== hintSeq) return;
        const tip = suggestVariant({ printings, photo: photoFoil, angles });
        if (!tip) return clear(variantHint);
        if (tip.method === 'printings' && !card.variantTouched) setVariant(tip.variant, false);
        const certain = tip.method === 'printings';
        clear(variantHint,
          h('div.variant-suggestion',
            h('span', '✨ Suggested: ', h('strong', VARIANT_NAMES[tip.variant] ?? tip.variant),
              certain ? ' · certain' : ` · ${Math.round(tip.confidence * 100)}% sure${tip.method === 'tilt' ? ' (tilt scan)' : ''}`),
            tip.variant !== card.variant && h('button.btn.small', { type: 'button', onclick: () => { setVariant(tip.variant, true); card.updateVariantHint(); } }, 'Use'),
            !certain && h('button.btn.small.ghost', { type: 'button', onclick: () => tiltInput.click() },
              tiltFrames.length ? `Add another angle (${tiltFrames.length + 1} photos)` : 'Tilt scan')),
          h('ul.variant-reasons', tip.reasons.map((r) => h('li', r)), (printings?.notes ?? []).map((n) => h('li', n))),
          !certain && !tiltFrames.length && tip.needsTilt && h('p.small.muted',
            'For a surer answer, use Tilt scan: take 1–2 more photos of this card in the same light, tilted a little left or right each time.'),
          tiltInput);
      } catch (err) {
        console.warn('Variant suggestion unavailable:', err);
        clear(variantHint);
      }
    };
    card.packSelect = select(packOptions(), card.packRef, {
      onchange: () => { card.packRef = card.packSelect.value; card.packTouched = true; updateSave(); },
    });
    const matchNote = h('span.match-note');
    const readNote = h('span.read-note');
    const showMatch = () => {
      matchNote.textContent = card.match ? `✓ Official card: ${card.match.name} · ${describeBrief(card.match)}` : '';
      card.el?.classList.toggle('matched', !!card.match);
    };
    const panel = lookupPanel({
      selectedId: card.match?.tcgId,
      onSelect: (brief) => {
        card.touched = true;
        card.match = brief;
        card.setStatus(brief ? 'confirmed' : card.status);
        card.el.classList.remove('duplicate');
        if (brief) {
          nameIn.value = card.name = brief.name;
          if (brief.setCode) codeIn.value = card.set_code = brief.setCode;
          if (brief.number) numIn.value = card.number = brief.setTotal ? `${brief.number}/${brief.setTotal}` : brief.number;
        }
        showMatch();
        updateSave();
        card.updateVariantHint();
      },
    });
    const runSearch = debounce(() => panel.search({ name: card.name, setCode: card.set_code, number: card.number }), 500);
    const onField = () => {
      card.touched = true;
      if (card.status !== 'reading') card.setStatus('confirmed');
      card.el.classList.remove('duplicate');
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

    // Read the name, set code and number off the photo and fill them in, then suggest the variant.
    // Automatic reading never overwrites what the user typed: a field they filled stays as it is,
    // and a match found after they started typing is offered in the list rather than picked.
    card.autoRead = async () => {
      if (card.touched || card.match) {
        if (card.status === 'queued') card.setStatus('confirmed');
      } else {
        await readCard();
      }
      await card.updateVariantHint();
    };
    card.retry = () => {
      card.setStatus('queued');
      queueRead(card, () => readCard({ retry: true }));
    };
    // The card was cut out upside down: keep the turned picture (saved and shown) from now on.
    let turnedRound = false;
    const useTurned = async (turned) => {
      canvas = turned;
      turnedRound = !turnedRound;
      photoFoil = null;
      card.blob = await canvasToBlob(turned, 'card', { transparent: true });
      URL.revokeObjectURL(card.preview);
      card.preview = URL.createObjectURL(card.blob);
      card.el.querySelector('.card-item-photo img').src = card.preview;
    };
    const cutAgain = async (grow) => {
      const c = await recut(grow);
      return turnedRound ? rotated180(c) : c;
    };
    const readCard = async ({ retry = false } = {}) => {
      if (!canvas) return;
      card.setStatus('reading');
      readNote.className = 'read-note busy';
      readNote.textContent = retry ? 'Reading the card again…' : 'Reading the card…';
      try {
        let result = await api.identify(await readCardText(canvas));
        // Small print is sensitive to exactly where the card was cut: when the reading isn't sure,
        // read cuts with slightly wider and tighter margins too (only the reading; the saved picture stays).
        for (const grow of [0.008, 0]) {
          if (readScore(result) >= 3 || !recut) break;
          const other = await api.identify(await readCardText(await cutAgain(grow))).catch(() => null);
          if (other && readScore(other) > readScore(result)) result = other;
        }
        // Upside down? When nothing at all was matched (or on "Read again", when unsure), the card
        // is also read turned round, and the better reading wins (the picture is turned with it).
        if (readScore(result) < (retry ? 3 : 1)) {
          const flipped = rotated180(canvas);
          const other = await api.identify(await readCardText(flipped)).catch(() => null);
          if (other && readScore(other) > readScore(result)) {
            result = other;
            await useTurned(flipped);
          }
        }
        const typed = card.touched;
        const fill = (name, code, number) => {
          // Only empty fields are filled once the user has typed something.
          if (name && (!typed || !nameIn.value.trim())) nameIn.value = card.name = name;
          if (code && (!typed || !codeIn.value.trim())) codeIn.value = card.set_code = code;
          if (number && (!typed || !numIn.value.trim())) numIn.value = card.number = number;
        };
        if (result.match && !card.match) {
          const m = result.match;
          if (typed) {
            panel.show(result.candidates, null);
            readNote.className = 'read-note medium';
            readNote.textContent = `Read from the photo: ${m.name} · ${describeBrief(m)}. Pick it below if it’s right (your details were kept).`;
            card.setStatus('review');
          } else {
            fill(m.name, m.setCode, m.setTotal ? `${m.number}/${m.setTotal}` : m.number);
            card.match = m;
            panel.show(result.candidates, m.tcgId);
            readNote.className = `read-note ${result.confidence}`;
            readNote.textContent = result.confidence === 'high' ? '✓ Read from the photo' : 'Read from the photo — please check it’s the right card';
            card.setStatus(result.confidence === 'high' ? 'recognized' : 'review');
          }
        } else if (!card.match) {
          const r = result.read;
          fill(r.name, r.setCode, r.number && (r.total ? `${r.number}/${r.total}` : r.number));
          if (result.candidates.length) panel.show(result.candidates, null);
          else if (card.name || card.number) panel.search({ name: card.name, setCode: card.set_code, number: card.number });
          const partly = card.name || card.number;
          readNote.className = 'read-note low';
          readNote.textContent = partly
            ? 'Partly read from the photo — pick the right card below or fix the details'
            : 'Couldn’t read this card — type its name, or the set code and number, or read it again';
          card.setStatus(typed ? 'confirmed' : partly ? 'review' : 'unrecognized');
        } else {
          readNote.textContent = '';
          card.setStatus('confirmed');
        }
        showMatch();
        updateSave();
      } catch (err) {
        readNote.className = 'read-note low';
        readNote.textContent = `Couldn’t read this card automatically (${err.message}). Type its details or read it again.`;
        card.setStatus(card.touched ? 'confirmed' : 'unrecognized');
      }
    };

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
        variantHint,
        retakeAdvice(quality) && h('p.retake-note', { role: 'note' }, retakeAdvice(quality)),
        readNote,
        matchNote,
        panel.el),
      h('div.item-actions',
        statusBadge,
        retryButton,
        h('button.btn.small.ghost', { type: 'button', onclick: () => removeCard(source, card) }, 'Remove')));
    card.setStatus(card.status);
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
    drawSummary();
  }

  function removeSource(source) {
    sources.splice(sources.indexOf(source), 1);
    source.el.remove();
    updateSave();
    drawSummary();
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

  async function buildSourceCards(source, quads) {
    const previous = source.cards;
    const cards = [];
    for (const [i, quad] of quads.entries()) {
      const { canvas, blob, quality } = await cutCard(source.img, quad, `card-${i + 1}`);
      const recut = (grow) => warpCard(source.img, quad, { width: canvas.width, grow });
      cards.push(makeCard(source, blob, previous[i], canvas, quality, recut));
    }
    source.quads = quads;
    source.cards = cards;
    clear(source.body, cards.map((c) => c.el));
    renderSourceHead(source);
    updateSave();
    for (const card of cards) queueRead(card, () => card.autoRead());
  }

  async function adjustSource(source) {
    const quads = await editQuads(source.img, source.quads);
    if (!quads) return;
    if (!quads.length) return removeSource(source);
    await buildSourceCards(source, quads);
  }

  async function addPhotos(files) {
    for (const file of files) {
      try {
        if (/\.(heic|heif)$/i.test(file.name ?? '') || /hei[cf]/i.test(file.type ?? '')) toast(`Opening the iPhone photo “${file.name}”…`, 'info');
        const img = await loadImage(file);
        const { quads } = await cardQuads(img);
        const source = { key: nextKey(), img, name: file.name || 'Photo', cards: [], quads: [] };
        source.head = h('div.source-head');
        source.body = h('div.source-cards');
        source.el = h('div.source', source.head, source.body);
        sources.push(source);
        sourceList.append(source.el);
        await buildSourceCards(source, quads);
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
    const review = cards.filter((c) => c.status === 'review' || c.status === 'unrecognized').length;
    summary.textContent = cards.length
      ? `${matched} of ${cards.length} matched to an official card${review ? ` · ${review} to review` : ''}`
      : 'Upload card photos to get started';
  }

  const describe = (c) => {
    const d = details(c);
    return [d.name, [d.set_code, d.number && (d.set_total ? `${d.number}/${d.set_total}` : d.number)].filter(Boolean).join(' '), d.variant !== 'normal' && (VARIANT_LABELS[d.variant] ?? d.variant)].filter(Boolean).join(' · ');
  };
  const details = (c) => ({
    name: c.name.trim() || c.match?.name, set_code: c.set_code.trim() || c.match?.setCode || null, ...splitNumber(c.number),
    variant: c.variant, tcg_id: c.match?.tcgId ?? null,
  });

  /**
   * Before saving: warn about cards already in the collection (or twice in this batch) and ask
   * whether to add them anyway. Returns true to go ahead.
   */
  async function duplicateCheck(cards) {
    let owned = [];
    try {
      ({ owned } = await api.duplicates(cards.map(details)));
    } catch {
      return true; // the check is a convenience: never block saving on it
    }
    const seen = new Map();
    const hits = [];
    cards.forEach((c, i) => {
      const key = dupKey(details(c));
      const before = seen.get(key) ?? 0;
      seen.set(key, before + 1);
      if (owned[i] > 0 || before > 0) hits.push({ card: c, owned: owned[i] ?? 0, earlier: before });
    });
    for (const c of cards) c.el.classList.remove('duplicate');
    if (!hits.length) return true;
    const yes = await new Promise((resolve) => {
      let answer = false;
      modal((close) => h('div.confirm.duplicate-check',
        h('h2', hits.length === 1 ? 'You already have this card' : `You already have ${hits.length} of these cards`),
        h('ul.duplicate-list', hits.map(({ card, owned: n, earlier }) => h('li',
          h('img', { src: card.preview, alt: '' }),
          h('span', h('strong', describe(card)), h('br'),
            h('span.muted', [n > 0 && `${n} already in your collection`, earlier > 0 && 'also earlier in this batch'].filter(Boolean).join(' · ')))))),
        h('p', `Would you like to add ${hits.length === 1 ? 'it' : 'them'} anyway?`),
        h('div.actions',
          h('button.btn', { type: 'button', onclick: close }, 'No'),
          h('button.btn.primary', { type: 'button', onclick: () => { answer = true; close(); } }, 'Yes, add anyway'))),
      { onClose: () => resolve(answer) });
    });
    if (!yes) {
      for (const { card } of hits) card.el.classList.add('duplicate');
      hits[0].card.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('Nothing saved. Duplicates are marked — remove the ones you don’t want, then save.', 'info');
    }
    return yes;
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
      if (!(await duplicateCheck(cards))) return;
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
      dropZone({ label: 'Drop card photos here', hint: 'Single cards or several cards per photo. JPEG, PNG or iPhone HEIC.', onFiles: addPhotos }),
      progressEl,
      batchSummary,
      sourceList),
    h('div.save-bar', summary, save));

  if (packChoice.value === 'new') newPackWrap.hidden = false;
  updateSave();
}
