import { accountMenu, applyTheme, renderLogin, renderProfile, renderSetup } from './account.js';
import { renderAddCards, renderAddPacks } from './add.js';
import { renderScanner } from './scanner.js';
import { api } from './api.js';
import { renderSearch } from './search.js';
import { renderGradingLab } from './grading.js';
import { renderBattles } from './battles.js';
import { renderSanctuary } from './sanctuary/sanctuary.js';
import { clear, h } from './ui.js';
import { renderSet, renderSets } from './sets.js';
import { renderCollection, renderPack, renderPacks } from './views.js';
import { renderScanTests } from './scanLabels.js';
import { startDioramaMaker } from './dioramas.js';

const main = document.getElementById('view');
let renderSeq = 0;
let currentUser = null;
let loginRequired = true;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function setActiveNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
}

async function route() {
  if (loginRequired && !currentUser) return;
  const seq = ++renderSeq;
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  // Each visit renders into its own container: a slow page that finishes after the user has moved
  // on only ever writes into its own detached container, never over the page now showing.
  const root = h('div.page');
  try {
    const meta = await api.meta();
    if (seq !== renderSeq) return;
    main.replaceChildren(root);
    if (parts[0] === 'profile') {
      setActiveNav('');
      await renderProfile(root, { user: currentUser, onUserChange: (u) => signedIn(u, { reroute: false }) });
    } else if (parts[0] === 'scan-tests') {
      setActiveNav('');
      await renderScanTests(root, { user: currentUser });
    } else if (parts[0] === 'sets' && parts[1] && parts[2]) {
      setActiveNav('sets');
      await renderSet(root, meta, navigate, parts[1], decodeURIComponent(parts[2]), params);
    } else if (parts[0] === 'sets') {
      setActiveNav('sets');
      await renderSets(root, meta, navigate);
    } else if (parts[0] === 'scan') {
      setActiveNav('scan');
      await renderScanner(root, meta, navigate);
    } else if (parts[0] === 'add') {
      setActiveNav('add');
      await renderAddCards(root, meta, navigate, { packId: params.get('pack') });
    } else if (parts[0] === 'battles') {
      setActiveNav('battles');
      await renderBattles(root);
    } else if (parts[0] === 'sanctuary') {
      setActiveNav('sanctuary');
      await renderSanctuary(root);
    } else if (parts[0] === 'grading') {
      setActiveNav('grading');
      await renderGradingLab(root);
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
    main.replaceChildren(root);
    clear(root, h('div.empty', h('h2', 'Something went wrong'), h('p.muted', err.message), h('a.btn', { href: '#/' }, 'Back to collection')));
  }
}

window.addEventListener('hashchange', route);

// ---- signing in ----
const account = document.getElementById('account');

function signedIn(user, { reroute = true } = {}) {
  currentUser = user;
  window.currentUser = user;
  document.body.classList.remove('signed-out');
  applyTheme(user?.settings?.theme);
  if (loginRequired) accountMenu(account, user, { onSignOut: () => signedOut(), onUserChange: (u) => { currentUser = u; window.currentUser = u; } });
  // New cards' 3D Pop-out dioramas are made in the background on this device (dioramas.js).
  stopDioramas = startDioramaMaker();
  if (reroute) route();
}
let stopDioramas = () => {};

function signedOut() {
  stopDioramas();
  currentUser = null;
  document.body.classList.add('signed-out');
  clear(account);
  renderLogin(main, (user) => signedIn(user));
}

window.addEventListener('signin-needed', () => {
  if (currentUser) signedOut();
});

(async () => {
  let state;
  try {
    state = await api.authState();
  } catch {
    state = { requireLogin: false, user: null };
  }
  loginRequired = state.requireLogin;
  if (state.setupNeeded) {
    document.body.classList.add('signed-out');
    renderSetup(main, (user) => signedIn(user));
  } else if (loginRequired && !state.user) {
    signedOut();
  } else {
    signedIn(state.user);
  }
})();

// Desktop app: when a newer version has been merged, offer to restart into it.
const banner = h('div.update-banner', { hidden: true, role: 'status' });
document.body.prepend(banner);

async function checkForUpdate() {
  let status;
  try {
    status = await api.desktop();
  } catch {
    return;
  }
  if (!status.desktop || !status.update || status.update.sha === status.version?.sha) return;
  const restart = h('button.btn.small', {
    type: 'button',
    onclick: async () => {
      restart.disabled = true;
      restart.textContent = 'Updating…';
      try {
        await api.desktopRestart();
      } catch {
        // the server may already be going down
      }
      // Wait for the new version to answer, then reload into it (up to 5 minutes for a package install).
      const until = Date.now() + 5 * 60 * 1000;
      const poll = async () => {
        const now = await api.desktop().catch(() => null);
        if (now?.version?.sha === status.update.sha) return location.reload();
        if (Date.now() > until) return location.reload();
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 2000);
    },
  }, 'Restart to update');
  clear(banner,
    h('span', h('strong', 'A new version is ready'), status.update.message ? ` — ${status.update.message}` : ''),
    restart);
  banner.hidden = false;
}

checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000);
