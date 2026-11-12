// Card dioramas in the browser: which cards have one (for 3D Pop-out), the background maker that
// draws new ones on this device for free (dioramaMaker.js) and sends them to the app, and the
// diorama part of a card's page. The server keeps the jobs (server/cardDioramas.js).

import { h } from './ui.js';

let cache = {}; // cardId -> { status, url, source, error }

/** The latest list from the app (call before drawing a 3D Pop-out grid). */
export async function refreshDioramas() {
  try {
    const res = await fetch('/api/card-effects');
    if (res.ok) cache = (await res.json()).cards ?? {};
  } catch { /* offline: keep what we had */ }
  return cache;
}

/** A ready diorama for a card (or for any copy of a grouped card), else null. */
export function dioramaUrl(card) {
  for (const id of card.ids ?? [card.id]) {
    const entry = cache[id];
    if (entry?.status === 'ready' && entry.url) return entry.url;
  }
  return null;
}

export const dioramaEntry = (cardId) => cache[cardId] ?? null;

const changed = () => window.dispatchEvent(new CustomEvent('dioramas-changed'));

// ---- the background maker ----------------------------------------------------------------

let running = false;
let wake = null;
const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wake = () => { clearTimeout(t); resolve(); };
});
const idle = () => new Promise((resolve) => (window.requestIdleCallback ? requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 200)));

/** Wake the maker now (e.g. right after cards were added). */
export function wakeDioramaMaker() {
  wake?.();
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/**
 * Make the waiting dioramas, one at a time, while the app is open and visible. Free: everything is
 * drawn here, from the card's own picture. Runs until `stop()`.
 */
let stopCurrent = () => {};
export function startDioramaMaker() {
  if (running) return stopCurrent; // already making them (signing in again doesn't start a second one)
  running = true;
  let stopped = false;
  (async () => {
    while (!stopped) {
      if (document.hidden) { await sleep(5000); continue; }
      let jobs = [];
      try {
        ({ jobs } = await post('/api/card-effects/jobs', { limit: 1 }));
      } catch {
        await sleep(60000); // signed out or offline: try again later
        continue;
      }
      if (!jobs.length) { await sleep(45000); continue; }
      const [job] = jobs;
      await idle();
      try {
        if (!job.card.picture) throw new Error('This card has no picture');
        const { makeDiorama } = await import('./dioramaMaker.js');
        const blob = await makeDiorama(job.card);
        const res = await fetch(`/api/card-effects/${job.cardId}`, { method: 'PUT', headers: { 'content-type': blob.type, 'x-fingerprint': job.fingerprint }, body: blob });
        if (!res.ok && res.status !== 409) throw new Error(`Saving the diorama failed (${res.status})`);
      } catch (err) {
        await post(`/api/card-effects/${job.cardId}/failed`, { fingerprint: job.fingerprint, error: err.message }).catch(() => {});
      }
      await refreshDioramas();
      changed();
    }
  })();
  stopCurrent = () => { stopped = true; running = false; wake?.(); };
  return stopCurrent;
}

// ---- on a card's page ----------------------------------------------------------------------

/** The diorama part of a card's page: the picture, or what's happening, with Make / Try again. */
export function dioramaSection(card) {
  const host = h('div.diorama-section');
  const ask = async () => {
    await post(`/api/card-effects/${card.id}/request`).catch(() => null);
    await refreshDioramas();
    wakeDioramaMaker();
    render();
  };
  let shown = false;
  const render = () => {
    if (shown && !host.isConnected) { window.removeEventListener('dioramas-changed', render); return; } // the page was closed
    shown = true;
    const entry = dioramaEntry(card.id);
    const hasPicture = Boolean(card.official_url || card.photo_url) && !/energy/i.test(card.category ?? '');
    let content;
    if (entry?.status === 'ready') {
      content = [
        h('img.diorama-thumb', { src: entry.url, alt: `3D Pop-out diorama: ${card.name}`, loading: 'lazy' }),
        h('span.small.muted', entry.source === 'bundled' ? 'Shown in 3D Pop-out.' : 'Made on this device; shown in 3D Pop-out.'),
      ];
    } else if (entry?.status === 'pending') {
      content = h('span.small.muted', 'Being made on this device… it appears in 3D Pop-out when ready.');
    } else if (entry?.status === 'failed') {
      content = [h('span.small', `The diorama couldn’t be made: ${entry.error ?? 'unknown error'}.`), h('button.btn.small', { type: 'button', onclick: ask }, 'Try again')];
    } else if (hasPicture) {
      content = h('button.btn.small', { type: 'button', onclick: ask }, 'Make a 3D diorama');
    } else {
      return host.replaceChildren();
    }
    host.replaceChildren(h('strong.small', '3D diorama'), ...[content].flat());
  };
  refreshDioramas().then(render);
  window.addEventListener('dioramas-changed', render);
  render();
  return host;
}
