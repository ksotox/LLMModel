// "Find the official card" picker: searches the online card database and lets the user pick a match.

import { api } from './api.js';
import { h, clear } from './ui.js';

export function describeBrief(b) {
  const num = b.number ? (b.setTotal ? `${b.number}/${b.setTotal}` : b.number) : '';
  return [b.setCode || b.setName, num].filter(Boolean).join(' · ');
}

/**
 * @param {object} opts
 * @param {(brief|null) => void} opts.onSelect  called when the user picks (or un-picks) a match
 * @param {string} [opts.selectedId]            tcgId that is already linked
 * @param {boolean} [opts.autoSelectSingle]     pick the match automatically when the search finds exactly one
 */
export function lookupPanel({ onSelect, selectedId = null, autoSelectSingle = true }) {
  let selected = selectedId;
  let results = [];
  let seq = 0;
  const status = h('p.lookup-status.muted', 'Enter the name, or the set code and number from the bottom of the card, to find the official image.');
  const grid = h('div.lookup-results');
  const el = h('div.lookup', status, grid);

  const render = () => {
    clear(grid, results.map((b) => h('button.lookup-result', {
      type: 'button',
      class: b.tcgId === selected ? 'selected' : '',
      title: `${b.name} — ${b.setName ?? b.setId} ${b.number ?? ''}`,
      'aria-pressed': String(b.tcgId === selected),
      onclick: () => {
        selected = selected === b.tcgId ? null : b.tcgId;
        render();
        onSelect(selected ? b : null);
      },
    },
    b.thumb || b.image
      ? h('img', { src: b.thumb || b.image, alt: b.name, loading: 'lazy', onerror: (e) => { if (b.image && e.target.src !== b.image) e.target.src = b.image; } })
      : h('div.lookup-noimg', 'No image'),
    h('span.lookup-name', b.name),
    h('span.lookup-meta', describeBrief(b)))));
  };

  async function search({ name, setCode, number }) {
    name = (name ?? '').trim();
    setCode = (setCode ?? '').trim();
    number = (number ?? '').trim();
    const id = ++seq;
    if (name.length < 2 && !(setCode && number) && !number.includes('/')) {
      results = [];
      render();
      status.textContent = 'Enter the name, or the set code and number from the bottom of the card, to find the official image.';
      return;
    }
    status.textContent = 'Searching the online card database…';
    try {
      const { results: found } = await api.lookup({ name, setCode, number });
      if (id !== seq) return;
      results = found;
      if (autoSelectSingle && found.length === 1 && selected !== found[0].tcgId) {
        selected = found[0].tcgId;
        onSelect(found[0]);
      }
      status.textContent = found.length
        ? `${found.length === 1 ? '1 match' : `${found.length} matches`} — tap the right one to use its official image.`
        : 'No matches online. Check the spelling, set code or number — or save it without an official image.';
      render();
    } catch (err) {
      if (id !== seq) return;
      results = [];
      render();
      status.textContent = err.message;
    }
  }

  return {
    el,
    search,
    get selected() {
      return results.find((r) => r.tcgId === selected) ?? null;
    },
  };
}
