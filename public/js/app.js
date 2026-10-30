import { renderAddCards, renderAddPacks } from './add.js';
import { api } from './api.js';
import { renderSearch } from './search.js';
import { clear, h } from './ui.js';
import { renderCollection, renderPack, renderPacks } from './views.js';

const root = document.getElementById('view');
let renderSeq = 0;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function setActiveNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
}

async function route() {
  const seq = ++renderSeq;
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    const meta = await api.meta();
    if (seq !== renderSeq) return;
    if (parts[0] === 'add') {
      setActiveNav('add');
      await renderAddCards(root, meta, navigate, { packId: params.get('pack') });
    } else if (parts[0] === 'search') {
      setActiveNav('search');
      renderSearch(root, meta, navigate, params);
    } else if (parts[0] === 'add-packs') {
      setActiveNav('packs');
      renderAddPacks(root, meta, navigate);
    } else if (parts[0] === 'packs' && parts[1]) {
      setActiveNav('packs');
      await renderPack(root, meta, navigate, parts[1]);
    } else if (parts[0] === 'packs') {
      setActiveNav('packs');
      await renderPacks(root, meta, navigate);
    } else {
      setActiveNav('cards');
      await renderCollection(root, meta, navigate, params);
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    clear(root, h('div.empty', h('h2', 'Something went wrong'), h('p.muted', err.message), h('a.btn', { href: '#/' }, 'Back to collection')));
  }
}

window.addEventListener('hashchange', route);
route();
