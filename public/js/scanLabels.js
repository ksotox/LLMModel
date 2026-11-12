// Scanner tests (owner only): mark the cards in a few of your own photos, so `npm run bench:scan`
// measures how well the scanner finds and reads cards in real photos, not only made-up ones.
// The photo is kept on this PC (the app's data folder), and only when you click Save.

import { api } from './api.js';
import { editQuads } from './cropper.js';
import { canvasToBlob, cardQuads, cutCard, loadImage } from './images.js';
import { readCardText } from './ocr.js';
import { clear, confirmDialog, dropZone, h, toast } from './ui.js';

const field = (label, input) => h('label.field', h('span', label), input);

async function request(method, url, body) {
  const res = await fetch(url, { method, body });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** The whole photo as a JPEG at its full size (so the marked corners match it exactly). */
function fullPhoto(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return canvasToBlob(c, 'scan-test.jpg');
}

export async function renderScanTests(root, { user }) {
  if (!user?.is_owner) {
    clear(root, h('div.empty', h('h2', 'Only the owner can keep scanner tests'), h('a.btn', { href: '#/profile' }, 'Back to your profile')));
    return;
  }
  const saved = h('div.scan-tests');
  const draft = h('div');

  const loadSaved = async () => {
    const { photos } = await request('GET', '/api/scan-labels');
    clear(saved, photos.length
      ? photos.map((p) => h('div.scan-test',
        h('img', { src: `/api/scan-labels/photos/${encodeURIComponent(p.file)}`, alt: 'Your test photo', loading: 'lazy' }),
        h('div', h('strong', p.cards.map((c) => c.name).join(', ')), h('p.small.muted', `${p.cards.length} card${p.cards.length === 1 ? '' : 's'} marked`)),
        h('button.btn.small.ghost.danger-text', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDialog('Delete this test photo? It is removed from your PC too.'))) return;
            await request('DELETE', `/api/scan-labels/${encodeURIComponent(p.file)}`);
            loadSaved();
          },
        }, 'Delete')))
      : h('p.muted', 'No test photos yet.'));
  };

  const addPhoto = async ([file]) => {
    try {
      const img = await loadImage(file);
      const { quads } = await cardQuads(img);
      const marked = await editQuads(img, quads, { title: 'Put each outline exactly on its card’s corners' });
      if (!marked?.length) return;
      const items = [];
      clear(draft, h('p.muted', 'Reading the cards…'));
      for (const quad of marked) {
        const { canvas } = await cutCard(img, quad);
        // Pre-fill each card from the scanner's own reading: you check and correct it.
        const result = await api.identify(await readCardText(canvas)).catch(() => ({ match: null }));
        const name = h('input', { type: 'text', value: result.match?.name ?? '', placeholder: 'e.g. Voltorb', required: true });
        const id = h('input', { type: 'text', value: result.match?.tcgId ?? '', placeholder: 'e.g. sv02-066 (optional)' });
        const thumb = h('img', { alt: 'Card' });
        thumb.src = canvas.toDataURL('image/jpeg', 0.7);
        items.push({ quad, name, id, el: h('div.scan-test-card', thumb, h('div', field('Name', name), field('Official card id', id))) });
      }
      const save = h('button.btn.primary', {
        type: 'button',
        onclick: async () => {
          if (items.some((it) => !it.name.value.trim())) { toast('Give every card its name', 'error'); return; }
          save.disabled = true;
          try {
            const form = new FormData();
            form.append('photo', await fullPhoto(img), 'scan-test.jpg');
            form.append('labels', JSON.stringify({
              width: img.naturalWidth,
              height: img.naturalHeight,
              cards: items.map((it) => ({ name: it.name.value, tcgIds: it.id.value.trim() ? [it.id.value.trim()] : [], corners: it.quad.map((p) => [p.x, p.y]) })),
            }));
            await request('POST', '/api/scan-labels', form);
            toast('Saved to your scanner tests', 'success');
            clear(draft);
            loadSaved();
          } catch (err) {
            toast(err.message, 'error');
            save.disabled = false;
          }
        },
      }, 'Save to my scanner tests');
      clear(draft, h('section.panel',
        h('h2', 'Check each card'),
        h('p.muted', 'The names were read by the scanner: correct any that are wrong. The official id (shown on each card’s page) makes the test stricter but is optional.'),
        h('div.scan-test-cards', items.map((it) => it.el)),
        h('div.item-actions', save, h('button.btn.ghost', { type: 'button', onclick: () => clear(draft) }, 'Cancel'))));
    } catch (err) {
      clear(draft);
      toast(err.message, 'error');
    }
  };

  clear(root,
    h('div.page-head', h('h1', 'Scanner tests'),
      h('p.muted', 'Mark the cards in a few of your own photos. The scanner benchmark (npm run bench:scan) then measures how well cards are found and read in real photos like yours. Each photo is kept on this PC only, in the app’s data folder, when you click Save.')),
    h('section.panel', h('h2', 'Add a test photo'),
      dropZone({ label: 'Drop a photo of your cards', hint: 'Any photo: a table, a binder page, sleeves…', multiple: false, onFiles: addPhoto })),
    draft,
    h('section.panel', h('h2', 'Your test photos'), saved));
  loadSaved().catch((err) => clear(saved, h('p.muted', err.message)));
}
