// Signing in, the first-run setup, the profile page, and the light / dark theme.

import { api } from './api.js';
import { clear, confirmDialog, h, toast } from './ui.js';

/** "light" (default), "dark", or "system" (follow the computer). */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = ['dark', 'system'].includes(theme) ? theme : 'light';
}

const field = (label, input) => h('label.field', h('span', label), input);

function authCard(title, intro, form) {
  return h('div.auth-page',
    h('div.auth-card',
      h('div.auth-brand', h('span.pokeball', { 'aria-hidden': 'true' }), h('strong', 'My Pokédex')),
      h('h1', title), h('p.muted', intro), form));
}

/** First start: create the owner profile (an existing collection becomes theirs). */
export function renderSetup(root, onDone) {
  const username = h('input', { type: 'text', autocomplete: 'username', required: true, minLength: 3 });
  const display = h('input', { type: 'text', autocomplete: 'nickname', placeholder: 'Shown in the app' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
  const error = h('p.form-error', { role: 'alert' });
  const form = h('form.form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const { user } = await api.setup({ username: username.value, display_name: display.value || username.value, password: password.value });
        onDone(user);
      } catch (err) {
        error.textContent = err.message;
      }
    },
  }, field('Username', username), field('Display name', display), field('Password (6+ characters)', password), error,
  h('button.btn.primary.block', { type: 'submit' }, 'Create my profile'));
  clear(root, authCard('Welcome!', 'Create your profile to start. Any cards already in the app become yours, and you can add profiles for others later.', form));
  username.focus();
}

export function renderLogin(root, onDone) {
  const username = h('input', { type: 'text', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p.form-error', { role: 'alert' });
  const form = h('form.form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const { user } = await api.login({ username: username.value, password: password.value });
        onDone(user);
      } catch (err) {
        error.textContent = err.message;
        password.select();
      }
    },
  }, field('Username', username), field('Password', password), error, h('button.btn.primary.block', { type: 'submit' }, 'Sign in'));
  clear(root, authCard('Sign in', 'Each profile has its own collection.', form));
  username.focus();
}

/** The name in the header, with Profile and Sign out. */
export function accountMenu(host, user, { onSignOut, onUserChange = () => {} }) {
  if (!user) return clear(host);
  const dark = () => document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const themeButton = h('button', {
    type: 'button',
    onclick: async () => {
      const theme = dark() ? 'light' : 'dark';
      applyTheme(theme);
      themeButton.textContent = dark() ? '☀️ Light mode' : '🌙 Dark mode';
      try { onUserChange(await api.updateMe({ settings: { theme } })); } catch { /* kept for this visit */ }
    },
  }, dark() ? '☀️ Light mode' : '🌙 Dark mode');
  const menu = h('div.account-menu', { hidden: true },
    h('a', { href: '#/profile', onclick: () => { menu.hidden = true; } }, 'Profile & settings'),
    themeButton,
    h('button', {
      type: 'button',
      onclick: async () => {
        await api.logout().catch(() => {});
        onSignOut();
      },
    }, 'Sign out'));
  const button = h('button.account-button', { type: 'button', 'aria-haspopup': 'true', onclick: () => { menu.hidden = !menu.hidden; } },
    h('span.avatar', (user.display_name || user.username).slice(0, 1).toUpperCase()), h('span.account-name', user.display_name));
  document.addEventListener('click', (e) => { if (!host.contains(e.target)) menu.hidden = true; });
  clear(host, button, menu);
}

export async function renderProfile(root, { user, onUserChange }) {
  const display = h('input', { type: 'text', value: user.display_name });
  const theme = h('select', h('option', { value: 'light' }, 'Light'), h('option', { value: 'dark' }, 'Dark'), h('option', { value: 'system' }, 'Match my computer'));
  theme.value = user.settings?.theme ?? 'light';
  theme.addEventListener('change', async () => {
    applyTheme(theme.value);
    onUserChange(await api.updateMe({ settings: { theme: theme.value } }));
  });
  const heic = h('input', { type: 'checkbox', checked: user.settings?.convertHeic !== false });
  heic.addEventListener('change', async () => onUserChange(await api.updateMe({ settings: { convertHeic: heic.checked } })));
  const saveName = h('form.form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        onUserChange(await api.updateMe({ display_name: display.value }));
        toast('Saved', 'success');
      } catch (err) { toast(err.message, 'error'); }
    },
  }, field('Display name', display), h('button.btn', { type: 'submit' }, 'Save name'));

  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minLength: 6 });
  const passwordForm = h('form.form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api.updateMe({ current_password: current.value, new_password: next.value });
        current.value = next.value = '';
        toast('Password changed. Other devices have been signed out.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    },
  }, field('Current password', current), field('New password (6+ characters)', next), h('button.btn', { type: 'submit' }, 'Change password'));

  const profiles = h('div');
  const loadProfiles = async () => {
    const { users } = await api.users();
    const username = h('input', { type: 'text', required: true, minLength: 3 });
    const name = h('input', { type: 'text' });
    const password = h('input', { type: 'password', required: true, minLength: 6, autocomplete: 'new-password' });
    clear(profiles,
      h('table.simple-table',
        h('thead', h('tr', h('th', 'Profile'), h('th', 'Username'), h('th.num', 'Cards'), h('th', ''))),
        h('tbody', users.map((u) => h('tr',
          h('td', u.display_name, u.is_owner ? h('span.chip', ' owner') : ''),
          h('td', u.username),
          h('td.num', u.cards),
          h('td', !u.is_owner && h('button.btn.small.ghost.danger-text', {
            type: 'button',
            onclick: async () => {
              if (!(await confirmDialog(`Delete ${u.display_name}'s profile and their whole collection (${u.cards} cards)? This can't be undone.`))) return;
              await api.deleteUser(u.id);
              loadProfiles();
            },
          }, 'Delete')))))),
      h('form.form.inline-form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api.addUser({ username: username.value, display_name: name.value || username.value, password: password.value });
            toast('Profile added', 'success');
            loadProfiles();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, h('h3', 'Add a profile'), h('div.field-row', field('Username', username), field('Display name', name), field('Password', password)),
      h('button.btn.primary', { type: 'submit' }, 'Add profile')));
  };

  clear(root,
    h('div.page-head', h('h1', 'Profile & settings'), h('p.muted', `Signed in as ${user.username}.`)),
    h('section.panel', h('h2', 'Appearance'), field('Theme', theme)),
    h('section.panel', h('h2', 'Adding cards'),
      h('label.check', heic, ' Convert iPhone HEIC photos to JPEG automatically'),
      h('p.small.muted', 'Browsers other than Safari can’t open HEIC photos. With this on, they are converted in your browser before the cards are found (it takes a few seconds per photo).')),
    h('section.panel', h('h2', 'Your profile'), saveName),
    h('section.panel', h('h2', 'Password'), passwordForm),
    user.is_owner && h('section.panel', h('h2', 'Profiles'), h('p.muted', 'Everyone gets their own collection. Only you (the owner) can add or remove profiles.'), profiles));
  if (user.is_owner) loadProfiles();
}
