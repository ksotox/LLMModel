// PokéBattles: pick one or two Pokémon cards from your collection. With one, it pops out of its card
// in 3D and you try its moves on a practice target. With two, they battle: against the computer or
// two players on one device, choosing attacks and abilities each turn.
//
// three.js is only loaded when a showcase or battle starts, so the rest of the app stays light.

import { DIFFICULTIES, ENVIRONMENTS, environmentName, saveArena, savedArena, STYLES, weatherName, WEATHERS } from './battle/arenas.js';
import { createControls, joystick, toWorld } from './battle/controls.js';
import { createRealtime, step as stepRealtime, STEP, TIME_LIMIT } from './battle/realtime.js';
import { act, attackCost, cpuChoice, createBattle, damageFor, expectedDamage, makeFighter, MAX_ENERGY } from './battle/engine.js';
import { clear, h, toast } from './ui.js';

const TYPE_HEX = {
  Grass: '#4caf50', Fire: '#ff6d1f', Water: '#2f8cff', Lightning: '#e6b800', Psychic: '#b44cff', Fighting: '#d2691e',
  Darkness: '#5b3a8c', Metal: '#8a9aa3', Fairy: '#ff7fd0', Dragon: '#d4a017', Colorless: '#9ca3af',
};
const typeHex = (t) => TYPE_HEX[t] ?? TYPE_HEX.Colorless;
const FORM_LABELS = { regular: 'Regular', shiny: 'Shiny', mega: 'Mega', megaShiny: 'Mega (shiny)', gmax: 'Gigantamax', alolan: 'Alolan', galar: 'Galarian', hisuian: 'Hisuian' };

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) window.dispatchEvent(new Event('signin-needed'));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const costPips = (cost = []) => h('span.cost-pips', { title: cost.length ? `${cost.length} energy` : 'Free' },
  cost.length ? cost.map((t) => h('span.pip', { style: { background: typeHex(t) }, title: t })) : h('span.pip.free', { title: 'Free' }));
const typeChip = (t) => h('span.type-chip', { style: { background: typeHex(t) } }, t);
const damageLabel = (a) => (a.damage?.base ? `${a.damage.base}${a.damage.mod === 'x' ? '×' : a.damage.mod ?? ''}` : '—');

const TYPE_SYMBOLS = { Grass: '🍃', Fire: '🔥', Water: '💧', Lightning: '⚡', Psychic: '👁', Fighting: '✊', Darkness: '🌙', Metal: '⚙', Fairy: '✨', Dragon: '🐉', Colorless: '★' };
const typeOrb = (t) => h('span.type-orb', { style: { background: typeHex(t) }, title: t }, TYPE_SYMBOLS[t] ?? '★');

/**
 * The card's details floating above the Pokémon, like an AR card scanner's banner: the card's
 * picture, name, set and number, its type and HP, then its attacks.
 */
function infoPanel(entry) {
  const b = entry.battle;
  const c = entry.card;
  const thumb = c.official_url || c.photo_url;
  return h('div.card-info-panel',
    h('div.cip-row',
      thumb && h('img.cip-thumb', { src: thumb, alt: '' }),
      h('div.cip-id', h('strong', c.name), h('small', [c.set_name || c.set_code, c.number && `${c.number}${c.set_total ? `/${c.set_total}` : ''}`].filter(Boolean).join(' · ') || 'Your card')),
      h('div.cip-right', h('span.cip-orbs', b.types.slice(0, 2).map(typeOrb)), h('span.cip-hp', `HP ${b.hp}`))),
    h('ul.cip-attacks', b.attacks.map((a) => h('li', costPips(a.cost), h('span', a.name), h('b', damageLabel(a))))),
    b.abilities.length > 0 && h('p.cip-ability', '✦ ', h('b', b.abilities[0].name)),
    (b.weaknesses[0] || b.resistances[0]) && h('p.cip-foot', [b.weaknesses[0] && `Weak: ${b.weaknesses[0].type} ${b.weaknesses[0].value}`, b.resistances[0] && `Resist: ${b.resistances[0].type} ${b.resistances[0].value}`].filter(Boolean).join(' · ')),
    !b.fromCard && h('p.cip-note', 'No attack data for this card yet: using a basic attack.'));
}

let activeCleanup = null;

/**
 * The picker. After a battle, "Different opponent" comes back here with `keep` (your Pokémon,
 * still chosen) and the same mode, so only a new opponent has to be picked.
 */
// Where the next battle happens and its weather: chosen on the setup screen, remembered.
let arena = savedArena();

/** WebGL (3D) is needed for real-time battles; without it only turn-based battles are offered. */
let webgl = null;
function hasWebGL() {
  if (webgl == null) {
    try {
      const c = document.createElement('canvas');
      webgl = Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

/** The two pickers on the setup screen: the place and the weather, each with a line saying what it is. */
function arenaPicker({ difficulty = false } = {}) {
  const about = h('p.muted.small.bt-place-about');
  const describe = () => {
    const place = ENVIRONMENTS.find((e) => e.id === arena.environment);
    const sky = WEATHERS.find((w) => w.id === arena.weather);
    about.textContent = `${place.about}${sky.id === 'clear' ? '' : ` ${sky.name}: ${sky.about}`}`;
  };
  const picker = (label, list, key) => h('label.field',
    h('span', label),
    h('select', {
      'aria-label': label,
      onchange: (e) => { arena = saveArena({ ...arena, [key]: e.target.value }); describe(); },
    }, list.map((x) => h('option', { value: x.id, selected: x.id === arena[key] }, x.name))));
  describe();
  return h('div.bt-place', h('div.bt-place-fields', picker('Arena', ENVIRONMENTS, 'environment'), picker('Weather', WEATHERS, 'weather'),
    difficulty && picker('Difficulty', DIFFICULTIES, 'difficulty')), about);
}

export async function renderBattles(root, { keep = null, mode: startMode = 'cpu' } = {}) {
  activeCleanup?.();
  activeCleanup = null;
  const selected = keep ? [{ id: keep.id, card: keep.card, entry: keep.entry, form: keep.form }] : []; // [{ id, entry? , form }]
  let mode = startMode;
  const list = h('div.bt-picker', h('p.muted', 'Loading your Pokémon…'));
  const filter = h('input.search', { type: 'search', placeholder: 'Search your Pokémon…', 'aria-label': 'Search Pokémon' });
  const tray = h('div.bt-tray');
  let cards = [];

  clear(root,
    h('div.page-head',
      h('h1', 'PokéBattles'),
      h('p.muted', 'Pick a Pokémon card from your collection to see it pop out of its card in 3D and try its moves — or pick two and battle with their attacks.')),
    tray,
    h('div.toolbar', filter),
    list,
    rulesHelp());

  const loadEntry = async (sel) => {
    try {
      sel.entry = await getJson(`/api/battles/cards/${sel.id}`);
      sel.form = sel.entry.models.default;
    } catch (err) {
      sel.error = err.message;
    }
    drawTray();
  };

  const toggle = (card) => {
    const i = selected.findIndex((s) => s.id === card.id);
    if (i >= 0) selected.splice(i, 1);
    else {
      if (selected.length === 2) selected.shift();
      const sel = { id: card.id, card };
      selected.push(sel);
      loadEntry(sel);
    }
    drawList();
    drawTray();
  };

  function drawTray() {
    const ready = selected.length > 0 && selected.every((s) => s.entry || s.error) && !selected.some((s) => s.error);
    clear(tray,
      h('div.bt-slots', [0, 1].map((i) => {
        const s = selected[i];
        if (!s) return h('div.bt-slot.empty', { class: keep && i === 1 ? 'wanted' : '' }, h('span', i === 0 ? 'Choose your Pokémon' : keep ? `Pick a new opponent for ${keep.card.name} below` : 'Add an opponent (optional)'));
        const forms = s.entry?.models.forms ?? [];
        const formSel = forms.length > 1 && h('select', { 'aria-label': `3D form for ${s.card.name}`, onchange: (e) => { s.form = e.target.value; } },
          forms.map((f) => h('option', { value: f.form, selected: f.form === s.form }, FORM_LABELS[f.form] ?? f.name)));
        return h('div.bt-slot',
          h('img', { src: s.card.official_url || s.card.photo_url || '', alt: '' }),
          h('div',
            h('small', i === 0 ? 'Player 1' : mode === 'cpu' ? 'Computer' : 'Player 2'),
            h('strong', s.card.name),
            s.error ? h('span.bt-warn', s.error) : !s.entry ? h('span.muted', 'Getting its attacks…') : [
              h('span.muted', `HP ${s.entry.battle.hp} · ${s.entry.battle.attacks.length} attack${s.entry.battle.attacks.length === 1 ? '' : 's'}`),
              h('span', { class: s.entry.models.available ? 'bt-ok' : 'bt-warn' }, s.entry.models.available ? '3D model ✓' : 'Card only (no 3D model)'),
              formSel,
            ]),
          h('button.btn.small.ghost', { type: 'button', 'aria-label': `Remove ${s.card.name}`, onclick: () => toggle(s.card) }, '✕'));
      })),
      selected.length === 2 && h('div.segmented.bt-mode', { role: 'group', 'aria-label': 'Opponent' },
        [['cpu', 'vs Computer'], ['pvp', 'Two players']].map(([v, label]) => h('button', {
          type: 'button', class: v === mode ? 'active' : '', onclick: () => { mode = v; drawTray(); },
        }, label))),
      selected.length === 2 && hasWebGL() && h('div.segmented.bt-mode', { role: 'group', 'aria-label': 'Battle style' },
        STYLES.map((st) => h('button', {
          type: 'button', class: st.id === arena.style ? 'active' : '', title: st.about,
          onclick: () => { arena = saveArena({ ...arena, style: st.id }); drawTray(); },
        }, st.name))),
      selected.length > 0 && arenaPicker({ difficulty: selected.length === 2 && mode === 'cpu' && arena.style === 'realtime' && hasWebGL() }),
      h('button.btn.primary.bt-start', {
        type: 'button',
        disabled: !ready,
        onclick: () => (selected.length === 2
          ? (arena.style === 'realtime' && hasWebGL() ? startRealtime : startBattle)(root, [...selected], mode, () => renderBattles(root), (picks, m) => renderBattles(root, { keep: picks[0], mode: m }))
          : startShowcase(root, selected[0], () => renderBattles(root))),
      }, selected.length === 2 ? '⚔ Battle!' : selected.length === 1 ? '✨ Showcase' : 'Pick a Pokémon'));
  }

  function drawList() {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = cards.filter((c) => words.every((w) => `${c.name} ${c.set_code ?? ''} ${c.types ?? ''}`.toLowerCase().includes(w)));
    clear(list, shown.length ? h('div.bt-grid', shown.map((c) => {
      const pick = selected.findIndex((s) => s.id === c.id);
      return h('button.bt-tile', { type: 'button', class: pick >= 0 ? `picked p${pick}` : '', 'aria-pressed': String(pick >= 0), onclick: () => toggle(c) },
        h('img', { src: c.official_url || c.photo_url || '', alt: '', loading: 'lazy' }),
        h('span.bt-tile-name', c.name),
        h('span.bt-tile-meta', [c.hp && `HP ${c.hp}`, c.types].filter(Boolean).join(' · ')),
        pick >= 0 && h('span.bt-badge', pick === 0 ? 'P1' : mode === 'cpu' ? 'CPU' : 'P2'));
    })) : h('div.empty', h('p', cards.length ? 'No Pokémon match.' : 'Add some Pokémon cards to your collection first.')));
  }

  filter.addEventListener('input', drawList);
  drawTray();
  try {
    cards = (await getJson('/api/battles/fighters')).cards;
  } catch (err) {
    clear(list, h('p.muted', err.message));
    return;
  }
  drawList();
  // Sent here from the Sanctuary ("Battle" on a Pokémon there): it is chosen already.
  let sent = null;
  try { sent = sessionStorage.getItem('pokedex.battleKeep'); sessionStorage.removeItem('pokedex.battleKeep'); } catch { /* storage unavailable */ }
  const card = sent && cards.find((c) => String(c.id) === sent);
  if (card && !selected.some((sel) => sel.id === card.id)) toggle(card);
}

function rulesHelp() {
  return h('details.bt-rules',
    h('summary', 'How PokéBattles work'),
    h('ul',
      h('li', 'Each Pokémon uses its own card: its HP, its printed attacks and damage, its abilities, weakness and resistance. These are simple rules made for this app, not the official card game rules.'),
      h('li', 'Energy: each side gets 1 at the start of its turn (up to 6). An attack needs as much energy as its cost shows, and uses it up. Rest skips your turn for 1 more energy.'),
      h('li', '“30+” flips a coin: heads doubles it. “20×” flips 3 coins: 20 for each heads. An attack with no damage heals 20 if it mentions healing, otherwise it gives 2 energy.'),
      h('li', 'Weakness (×2 or +N) and resistance (−N) apply as printed on the card being hit.'),
      h('li', 'Each ability can be used once per battle: it takes your turn and powers up your next attack by 50%.'),
      h('li', 'A coin flip decides who goes first. The first Pokémon to reach 0 HP faints.'),
      h('li', 'Arena: the meadow or one of three stadiums. It changes the scenery only.'),
      h('li', 'Weather changes the battle: ', WEATHERS.filter((w) => w.id !== 'clear').map((w, i) => [i ? ' ' : '', h('strong', `${w.name}: `), w.about]))));
}

// ---------------------------------------------------------------------------
// The arena (shared by showcase and battle)

async function makeStage(host, mode) {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (document.documentElement.dataset.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const scene = await import('./battle/scene.js');
  if (scene.webglAvailable()) {
    try {
      return new scene.BattleStage(host, { mode, dark, environment: arena.environment, weather: arena.weather });
    } catch (err) {
      console.warn('3D unavailable, using cards:', err);
    }
  }
  return new scene.FlatStage(host, { mode });
}

const modelUrl = (sel) => sel.entry.models.forms.find((f) => f.form === sel.form)?.url ?? null;
const cardUrls = (sel) => [sel.card.official_url?.startsWith('/') ? sel.card.official_url : null, sel.card.photo_url];

/**
 * The battle screen: the stage fills the window and the controls lie over it as glass panels
 * (the app's menu bar is hidden meanwhile). Top left: the opponent's HP plate (in `hud`); top
 * right: Back, graphics, full screen; bottom dock: your HP plate, the message, then the moves
 * (or, when the battle is over, the result with the question what to do next).
 */
function arenaShell(title, onBack) {
  const host = h('div.stage-host');
  const hud = h('div.stage-hud');
  const message = h('div.bt-message', { role: 'status', 'aria-live': 'polite' });
  const controls = h('div.bt-controls');
  const detail = h('div.bt-detail', { hidden: true });
  const plateSlot = h('div.bt-dock-plate');
  const skip = h('button.btn.small.bt-skip', { type: 'button', hidden: true }, 'Skip intro ⏭');
  const frame = h('div.stage-frame', host, hud);
  const graphics = h('span.bt-graphics');
  const dock = h('div.bt-dock', plateSlot, detail, message, controls);
  const el = h('div.bt-arena');
  const full = el.requestFullscreen && h('button.btn.small.bt-full', {
    type: 'button', title: 'Full screen', 'aria-label': 'Full screen',
    onclick: () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen().catch(() => {})),
  }, '⛶');
  el.append(frame, h('h2.bt-title', title),
    h('div.bt-top', h('button.btn.small.bt-back', { type: 'button', onclick: onBack }, '← Back'), graphics, full || ''),
    skip, dock);
  document.body.classList.add('battle-mode');

  // The stage keeps the Pokémon clear of the dock: it is told how tall the dock gets.
  let stage = null;
  let tallest = 0;
  const report = () => {
    tallest = Math.max(tallest, dock.offsetHeight);
    frame.style.setProperty('--dock', `${tallest}px`);
    stage?.setInset?.(tallest);
  };
  const watcher = new ResizeObserver(report);
  watcher.observe(dock);
  const onResize = () => { tallest = 0; report(); };
  window.addEventListener('resize', onResize);

  /** Full card text for a move, shown above the message box; the same button closes it. */
  let detailFor = null;
  const hideDetail = () => {
    detail.hidden = true;
    detailFor?.setAttribute('aria-expanded', 'false');
    detailFor = null;
  };
  const showDetail = (button, name, text) => {
    const again = detailFor === button;
    hideDetail();
    if (again) return;
    clear(detail, h('button', { type: 'button', 'aria-label': 'Close', onclick: hideDetail }, '✕'), h('strong', name), text);
    detail.hidden = false;
    detailFor = button;
    button.setAttribute('aria-expanded', 'true');
  };

  return {
    el, host, hud, message, controls, skip, frame, graphics, plateSlot, showDetail, hideDetail,
    setStage(st) { stage = st; report(); },
    dispose() {
      watcher.disconnect();
      window.removeEventListener('resize', onResize);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      document.body.classList.remove('battle-mode');
    },
  };
}

/** Typewriter text in the message box; resolves when it's done (and a beat to read it). */
function say(box, text, { hold = 500 } = {}) {
  return new Promise((resolve) => {
    box.textContent = '';
    let i = 0;
    const step = () => {
      i += 2;
      box.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 14);
      else setTimeout(resolve, hold);
    };
    step();
  });
}

function plate(fighter, side, label) {
  const bar = h('span.hp-fill');
  const hpText = h('span.hp-text');
  const pips = h('span.energy-pips');
  const status = h('span.plate-status');
  const el = h('div.hp-plate', { class: `side-${side}` },
    h('div.plate-top', h('strong', fighter.name), h('small', label)),
    h('div.hp-bar', h('span.hp-label', 'HP'), h('span.hp-track', bar)),
    h('div.plate-bottom', pips, hpText, status));
  const update = () => {
    const pct = Math.max(0, fighter.hp / fighter.maxHp);
    bar.style.width = `${pct * 100}%`;
    bar.className = `hp-fill ${pct > 0.5 ? 'high' : pct > 0.2 ? 'mid' : 'low'}`;
    hpText.textContent = `${fighter.hp}/${fighter.maxHp}`;
    clear(pips, Array.from({ length: MAX_ENERGY }, (_, i) => h('span.e-pip', { class: i < fighter.energy ? 'on' : '' })));
    status.textContent = fighter.boost ? 'Powered up' : '';
  };
  update();
  return { el, update };
}

/** High (sharpest, densest grass), Standard, or Basic for computers without a graphics card. Remembered. */
function graphicsToggle(a, stage) {
  if (!stage.setQuality) return;
  const sel = h('select', { 'aria-label': 'Graphics quality' },
    h('option', { value: 'high' }, 'High'), h('option', { value: 'standard' }, 'Standard'), h('option', { value: 'basic' }, 'Basic'));
  sel.title = 'Graphics: High is the sharpest; Basic is the fastest, for computers without a graphics card';
  sel.value = stage.quality;
  sel.addEventListener('change', () => stage.setQuality(sel.value));
  clear(a.graphics, h('label', h('span.bt-graphics-label', 'Graphics '), sel));
}

function cleanupOnLeave(stage, shell) {
  shell.setStage(stage);
  const done = () => {
    window.removeEventListener('hashchange', done);
    shell.dispose();
    try { stage.dispose(); } catch { /* already gone */ }
    if (activeCleanup === done) activeCleanup = null;
  };
  window.addEventListener('hashchange', done);
  activeCleanup = done;
  return done;
}

/** The summon intro for one side: the card drops in, the Pokémon pops out, its details float in. */
async function introduce(stage, a, slot, sel) {
  const panel = infoPanel(sel.entry);
  panel.classList.add(`slot-${slot}`);
  await stage.summon(slot);
  a.hud.append(panel);
  stage.anchor?.(panel, slot); // floats above the Pokémon (3D stage); a corner otherwise
  requestAnimationFrame(() => panel.classList.add('in'));
  // On small screens the panel would cover the Pokémon: it shrinks to its name and HP after a
  // moment, and a tap opens it again.
  panel.addEventListener('click', () => panel.classList.toggle('mini'));
  if (matchMedia('(max-width: 720px)').matches) setTimeout(() => panel.classList.add('mini'), 3500);
  return panel;
}

// ---------------------------------------------------------------------------
// Showcase: one Pokémon and a practice target

async function startShowcase(root, sel, onBack) {
  const a = arenaShell(`${sel.card.name}`, () => { cleanup(); onBack(); });
  clear(root, a.el);
  const stage = await makeStage(a.host, 'showcase');
  const cleanup = cleanupOnLeave(stage, a);
  graphicsToggle(a, stage);
  const me = makeFighter(sel.entry.battle, { name: sel.card.name });
  const dummy = makeFighter({ hp: 999, types: ['Colorless'] }, { name: 'Practice target' });
  let busy = false;

  const formSel = sel.entry.models.forms.length > 1 && h('select', { 'aria-label': '3D form' },
    sel.entry.models.forms.map((f) => h('option', { value: f.form, selected: f.form === sel.form }, FORM_LABELS[f.form] ?? f.name)));

  const setButtons = (on) => { for (const b of a.controls.querySelectorAll('button, select')) b.disabled = !on; };
  const summonCurrent = async () => {
    busy = true;
    setButtons(false);
    clear(a.hud);
    const added = await stage.addFighter(0, { name: sel.card.name, types: sel.entry.battle.types, modelUrl: modelUrl(sel), cardUrls: cardUrls(sel) });
    if (!stage.slots[1]) stage.addTarget();
    a.skip.hidden = false;
    a.skip.onclick = () => stage.skip();
    say(a.message, `${sel.card.name} is coming out of its card…`);
    await introduce(stage, a, 0, sel);
    a.skip.hidden = true;
    stage.resume();
    await say(a.message, added.hasModel
      ? `Here's ${sel.card.name}! Drag to turn it around, scroll or pinch to zoom, and try its moves below.`
      : `${sel.card.name} has no 3D model yet, so its card stands in. Try its moves below.`);
    busy = false;
    setButtons(true);
  };

  const run = async (fn) => {
    if (busy) return;
    busy = true;
    setButtons(false);
    try { await fn(); } finally {
      busy = false;
      setButtons(true);
    }
  };

  const tryAttack = (attack) => run(async () => {
    const hit = damageFor(me, dummy, attack, Math.random, arena.weather);
    me.boost = 0;
    stage.boost(0, false);
    say(a.message, `${sel.card.name} used ${attack.name}!`, { hold: 0 });
    await stage.attack(0, { type: me.types[0] });
    if ((attack.damage?.base ?? 0) > 0) {
      await stage.hit(1, { amount: hit.amount });
      const coins = hit.coins.length ? ` (coins: ${hit.coins.map((c) => (c ? 'heads' : 'tails')).join(', ')})` : '';
      await say(a.message, `It would deal ${hit.amount} damage${coins}.${attack.effect ? ` Card text: ${attack.effect}` : ''}`, { hold: 200 });
    } else {
      await stage.charge(0, 0);
      await say(a.message, attack.effect ? `Card text: ${attack.effect}` : `${attack.name} doesn’t deal damage.`, { hold: 200 });
    }
  });

  const tryAbility = (ability) => run(async () => {
    me.boost = 0.5;
    await say(a.message, `${sel.card.name}’s ability: ${ability.name}!`, { hold: 0 });
    await stage.boost(0, true);
    await say(a.message, `${ability.effect || ''} In a battle, this powers up the next attack by 50%.`.trim(), { hold: 200 });
  });

  clear(a.controls,
    h('div.move-grid', sel.entry.battle.attacks.map((atk) => moveButton(a, atk, me, dummy, () => tryAttack(atk), true))),
    sel.entry.battle.abilities.length > 0 && h('div.move-grid.side', sel.entry.battle.abilities.map((ab) => sideButton(a, {
      kind: 'ability', name: `✦ ${ab.name}`, note: ab.effect || 'Ability', info: ab.effect, onClick: () => tryAbility(ab),
    }))),
    h('div.bt-row',
      formSel && h('label.bt-form', '3D form ', formSel),
      h('button.btn.small', { type: 'button', onclick: () => { if (!busy) summonCurrent(); } }, '↻ Summon again')));
  if (formSel) formSel.addEventListener('change', () => { sel.form = formSel.value; summonCurrent(); });
  await summonCurrent();
}

/** A small ⓘ beside a move that opens its full card text above the message box. */
function infoButton(a, name, text) {
  return h('button.move-info', {
    type: 'button', 'aria-label': `Card text for ${name}`, 'aria-expanded': 'false',
    onclick: (e) => a.showDetail(e.currentTarget, name, text),
  }, 'i');
}

/** An attack: name and damage, cost pips, type and expected damage, and the first line of its card text. */
function moveButton(a, attack, me, foe, onClick, practice = false) {
  const cost = attackCost(attack);
  const enough = practice || me.energy >= cost;
  const est = expectedDamage(me, foe, attack, arena.weather);
  return h('div.move', { class: attack.effect ? 'has-info' : '' },
    h('button.move-btn', {
      type: 'button',
      disabled: !enough,
      title: attack.effect || attack.name,
      style: { '--move': typeHex(me.types[0]) },
      onclick: onClick,
    },
    h('span.move-top', h('span.move-name', attack.name), h('b.move-dmg', damageLabel(attack))),
    h('span.move-bottom', costPips(attack.cost), h('span.move-type', me.types[0] ?? 'Colorless'),
      !practice && h('small', enough ? `~${est} dmg` : `needs ${cost} energy`)),
    attack.effect && h('span.move-effect', attack.effect)),
    attack.effect && infoButton(a, attack.name, attack.effect));
}

/** An ability or Rest: a name and one line of explanation. */
function sideButton(a, { kind, name, note, info, disabled = false, onClick }) {
  return h('div.move', { class: info ? 'has-info' : '' },
    h('button.move-btn', { type: 'button', class: kind, disabled, title: info || note, onclick: onClick },
      h('span.move-name', name), h('span.move-effect', note)),
    info && infoButton(a, name, info));
}

// ---------------------------------------------------------------------------
// Battle: two Pokémon, vs the computer or two players

async function startBattle(root, picks, mode, onBack, onNewOpponent = onBack) {
  const [p1, p2] = picks;
  const a = arenaShell(`${p1.card.name} vs ${p2.card.name}`, () => { cleanup(); onBack(); });
  clear(root, a.el);
  const stage = await makeStage(a.host, 'battle');
  const cleanup = cleanupOnLeave(stage, a);
  graphicsToggle(a, stage);
  a.skip.hidden = false;
  a.skip.onclick = () => stage.skip();
  say(a.message, 'Getting the cards ready…', { hold: 0 });
  const added = await Promise.all([p1, p2].map((sel, slot) => stage.addFighter(slot, { name: sel.card.name, types: sel.entry.battle.types, modelUrl: modelUrl(sel), cardUrls: cardUrls(sel) })));
  a.frame.dataset.fighters = added.map((r) => (r.hasModel ? '3d' : 'card')).join(',');

  // Intro: each card drops in and its Pokémon pops out, its details floating beside it.
  await say(a.message, `${p1.card.name}, come on out!`, { hold: 0 });
  const panel1 = await introduce(stage, a, 0, p1);
  await say(a.message, `${mode === 'cpu' ? 'The computer' : 'Player 2'} sends out ${p2.card.name}!`, { hold: 0 });
  const panel2 = await introduce(stage, a, 1, p2);
  await stage.wait(1200);
  a.skip.hidden = true;
  stage.resume();
  panel1.remove();
  panel2.remove();

  let battle;
  const newBattle = () => createBattle(
    { battle: p1.entry.battle, name: p1.card.name, cardId: p1.id },
    { battle: p2.entry.battle, name: p2.card.name, cardId: p2.id },
    { mode, weather: arena.weather },
  );
  battle = newBattle();
  const plates = battle.fighters.map((f, i) => plate(f, i, i === 0 ? 'Player 1' : mode === 'cpu' ? 'Computer' : 'Player 2'));
  a.hud.append(plates[1].el);
  a.plateSlot.append(plates[0].el);
  const refresh = () => plates.forEach((p) => p.update());
  const name = (i) => battle.fighters[i].name;
  const banner = h('div.turn-banner');
  a.frame.append(banner);

  const play = async (events) => {
    for (const e of events) {
      if (e.type === 'start') {
        await say(a.message, `Coin flip: ${e.coin}! ${name(e.first)} goes first.`);
        if (battle.weather !== 'clear') await say(a.message, `${weatherName(battle.weather)} over the ${environmentName(arena.environment)}. ${WEATHERS.find((w) => w.id === battle.weather).about}`);
      } else if (e.type === 'turn') {
        refresh();
        banner.textContent = mode === 'pvp' ? `Player ${e.who + 1}'s turn` : e.who === 0 ? 'Your turn' : 'Computer’s turn';
        banner.className = `turn-banner side-${e.who} show`;
      } else if (e.type === 'use') {
        refresh();
        if (e.kind === 'attack') {
          const wasBoosted = stage.slots?.[e.who]?.aura || stage.slots?.[e.who]?.classList?.contains('boosted');
          say(a.message, `${name(e.who)} used ${e.name}!`, { hold: 0 });
          await stage.attack(e.who, { type: e.attackType });
          if (wasBoosted) stage.boost(e.who, false);
        } else if (e.kind === 'ability') {
          await say(a.message, `${name(e.who)} used its ability, ${e.name}!`, { hold: 200 });
        } else {
          await say(a.message, `${name(e.who)} rests and gathers energy.`, { hold: 100 });
        }
      } else if (e.type === 'coins') {
        await say(a.message, `Coin flip${e.coins.length > 1 ? 's' : ''}: ${e.coins.map((c) => (c ? 'heads' : 'tails')).join(', ')}!`, { hold: 300 });
      } else if (e.type === 'hit') {
        await stage.hit(e.who, { amount: e.amount, weakness: e.weakness });
        refresh();
        if (e.amount === 0) await say(a.message, 'It had no effect…');
        else if (e.weakness) await say(a.message, `It hit ${name(e.who)}’s weakness! ${e.amount} damage!`);
        else if (e.resisted) await say(a.message, `${name(e.who)} resisted some of it. ${e.amount} damage.`);
        else await say(a.message, `${e.amount} damage!`, { hold: 250 });
      } else if (e.type === 'weather') {
        await stage.hit(e.who, { amount: e.amount, weakness: false, attackType: 'Fighting' });
        refresh();
        await say(a.message, `The sandstorm wears ${name(e.who)} down: ${e.amount} damage.`, { hold: 250 });
      } else if (e.type === 'heal') {
        await stage.heal(e.who, e.amount);
        refresh();
        await say(a.message, `${name(e.who)} healed ${e.amount} HP.`);
      } else if (e.type === 'energy') {
        await stage.charge(e.who, e.amount);
        refresh();
      } else if (e.type === 'boost') {
        await stage.boost(e.who, true);
        refresh();
        await say(a.message, `${name(e.who)} is powered up! Its next attack does 50% more.`);
      } else if (e.type === 'ko') {
        await say(a.message, `${name(e.who)} fainted!`, { hold: 0 });
        await stage.faint(e.who);
      } else if (e.type === 'end') {
        refresh();
        banner.className = 'turn-banner';
        showResult(e);
      }
    }
  };

  const showResult = (e) => {
    const w = e.winner;
    const f = battle.fighters;
    a.hideDetail();
    clear(a.controls, h('div.bt-result', { role: 'group', 'aria-label': 'Battle result' },
      h('h3', w == null ? 'It’s a draw!' : mode === 'cpu' ? (w === 0 ? `🏆 You win with ${f[0].name}!` : `The computer’s ${f[1].name} wins!`) : `🏆 Player ${w + 1} wins with ${f[w].name}!`),
      h('p.muted', `${battle.round} round${battle.round === 1 ? '' : 's'} · ${f[0].name} dealt ${f[0].stats.dealt} · ${f[1].name} dealt ${f[1].stats.dealt}`),
      h('p.bt-next', `Battle ${f[1].name} again, or choose a different opponent for ${f[0].name}?`),
      h('div.bt-row',
        h('button.btn.primary', { type: 'button', onclick: () => { cleanup(); startBattle(root, picks, mode, onBack, onNewOpponent); } }, '↻ Same battle again'),
        h('button.btn', { type: 'button', onclick: () => { cleanup(); onNewOpponent(picks, mode); } }, '⇄ Different opponent'),
        h('button.btn.ghost', { type: 'button', onclick: () => { cleanup(); onBack(); } }, 'Choose both again'))));
    a.controls.querySelector('.btn.primary')?.focus();
  };

  const controlsFor = () => {
    const who = battle.turn;
    const me = battle.fighters[who];
    const foe = battle.fighters[1 - who];
    clear(a.controls,
      h('p.bt-whose', mode === 'pvp' ? `Player ${who + 1}: choose ${me.name}’s move` : `Choose ${me.name}’s move`),
      h('div.move-grid', me.attacks.map((atk, i) => moveButton(a, atk, me, foe, () => choose({ type: 'attack', index: i })))),
      h('div.move-grid.side',
        me.abilities.map((ab, i) => sideButton(a, {
          kind: 'ability', name: `✦ ${ab.name}`, info: ab.effect, disabled: me.usedAbilities.includes(i),
          note: me.usedAbilities.includes(i) ? 'Already used' : 'Powers up your next attack (+50%), once',
          onClick: () => choose({ type: 'ability', index: i }),
        })),
        sideButton(a, { kind: 'rest', name: '☾ Rest', note: `+1 energy (${me.energy}/${MAX_ENERGY})`, disabled: me.energy >= MAX_ENERGY, onClick: () => choose({ type: 'rest' }) })));
  };

  const choose = async (action) => {
    a.hideDetail();
    clear(a.controls, h('p.bt-whose', '…'));
    try {
      await play(act(battle, action));
    } catch (err) {
      toast(err.message, 'error');
    }
    next();
  };

  const next = async () => {
    if (battle.over) return;
    if (mode === 'cpu' && battle.turn === 1) {
      clear(a.controls, h('p.bt-whose', `${battle.fighters[1].name} is thinking…`));
      await stage.wait(650);
      await play(act(battle, cpuChoice(battle)));
      return next();
    }
    controlsFor();
  };

  await play(battle.opening);
  await say(a.message, 'Battle start!', { hold: 300 });
  next();
}

// ---------------------------------------------------------------------------
// Real-time battle: both Pokémon move, dodge and attack at the same time (battle/realtime.js)

const KEY_HINTS = ['Q', 'E', 'Right click', 'F'];
const PAD_HINTS = ['U', 'I', 'O', 'P'];

/** A real-time HP plate: name, HP bar and an energy bar. */
function livePlate(f, side, label) {
  const bar = h('span.hp-fill');
  const hpText = h('span.hp-text');
  const energy = h('span.rt-energy-fill');
  const status = h('span.plate-status');
  const el = h('div.hp-plate', { class: `side-${side}` },
    h('div.plate-top', h('strong', f.name), h('small', label)),
    h('div.hp-bar', h('span.hp-label', 'HP'), h('span.hp-track', bar)),
    h('div.plate-bottom', h('span.rt-energy', { title: 'Energy' }, energy), hpText, status));
  const update = () => {
    const pct = Math.max(0, f.hp / f.maxHp);
    bar.style.width = `${pct * 100}%`;
    bar.className = `hp-fill ${pct > 0.5 ? 'high' : pct > 0.2 ? 'mid' : 'low'}`;
    hpText.textContent = `${Math.ceil(f.hp)}/${f.maxHp}`;
    energy.style.width = `${f.energy}%`;
    status.textContent = f.boost > 0 ? 'Powered up' : f.down > 0 ? 'Knocked down' : '';
    el.classList.toggle('boosted', f.boost > 0);
  };
  update();
  return { el, update };
}

async function startRealtime(root, picks, mode, onBack, onNewOpponent = onBack) {
  const [p1, p2] = picks;
  const a = arenaShell(`${p1.card.name} vs ${p2.card.name}`, () => { cleanup(); onBack(); });
  a.el.classList.add('realtime');
  clear(root, a.el);
  const stage = await makeStage(a.host, 'battle');
  let controls = null;
  const leave = cleanupOnLeave(stage, a);
  const cleanup = () => { stage.beforeFrame = null; controls?.dispose(); leave(); };
  window.addEventListener('hashchange', () => controls?.dispose(), { once: true });
  graphicsToggle(a, stage);
  a.skip.hidden = false;
  a.skip.onclick = () => stage.skip();
  say(a.message, 'Getting the cards ready…', { hold: 0 });
  const added = await Promise.all([p1, p2].map((sel, slot) => stage.addFighter(slot, { name: sel.card.name, types: sel.entry.battle.types, modelUrl: modelUrl(sel), cardUrls: cardUrls(sel) })));
  a.frame.dataset.fighters = added.map((r) => (r.hasModel ? '3d' : 'card')).join(',');
  await say(a.message, `${p1.card.name}, come on out!`, { hold: 0 });
  const panel1 = await introduce(stage, a, 0, p1);
  await say(a.message, `${mode === 'cpu' ? 'The computer' : 'Player 2'} sends out ${p2.card.name}!`, { hold: 0 });
  const panel2 = await introduce(stage, a, 1, p2);
  await stage.wait(900);
  a.skip.hidden = true;
  stage.resume();
  panel1.remove();
  panel2.remove();

  const battle = createRealtime(
    { battle: p1.entry.battle, name: p1.card.name, cardId: p1.id },
    { battle: p2.entry.battle, name: p2.card.name, cardId: p2.id },
    { mode, weather: arena.weather, arena: arena.environment, difficulty: arena.difficulty },
  );
  const [f1, f2] = battle.fighters;
  const plates = [livePlate(f1, 0, 'Player 1'), livePlate(f2, 1, mode === 'cpu' ? `Computer · ${arena.difficulty}` : 'Player 2')];
  a.hud.append(plates[1].el);
  a.plateSlot.append(plates[0].el);
  stage.goLive();
  if (battle.rules.shrink) stage.setZone(battle.zone);

  // The dock: your moves (with their cooldown), Dodge and Jump, and the clock.
  controls = createControls(a.host, { players: mode === 'pvp' ? 2 : 1 });
  const touch = matchMedia('(pointer: coarse)').matches;
  const clock = h('span.rt-clock');
  const dodges = h('span.rt-dodges', { title: 'Dodges' });
  const moveBtns = (side) => battle.fighters[side].moves.map((m, i) => {
    const btn = h('button.move-btn.rt-move', {
      type: 'button',
      style: { '--move': typeHex(m.type) },
      title: m.kind === 'boost' ? 'Powers up your attacks by 50% for 10 seconds, once' : m.kind === 'heal' ? 'Heals you' : m.kind === 'charge' ? 'Refills your energy' : `${m.kind === 'melee' ? 'Close-up' : 'Ranged'} attack`,
      onpointerdown: (e) => { e.preventDefault(); controls.hold(side, i, true); },
      onpointerup: () => controls.hold(side, i, false),
      onpointerleave: () => controls.hold(side, i, false),
      onpointercancel: () => controls.hold(side, i, false),
    },
    h('span.move-top', h('span.move-name', m.name), h('b.move-dmg', m.damage ? String(m.damage) : m.kind === 'boost' ? '✦' : m.kind === 'heal' ? '+' : '⚡')),
    h('span.move-bottom', h('span.rt-key', (side ? PAD_HINTS : KEY_HINTS)[i]), m.energy ? h('span.move-type', `${m.energy} energy`) : h('span.move-type', 'free')),
    h('span.rt-cool'));
    return btn;
  });
  const mine = moveBtns(0);
  const theirs = mode === 'pvp' ? moveBtns(1) : [];
  const tap = (side, what, label) => h('button.btn.rt-act', { type: 'button', onpointerdown: (e) => { e.preventDefault(); controls.press(side, what); } }, label);
  clear(a.controls,
    h('div.rt-bar', clock, dodges, h('span.rt-help.muted', touch ? 'Drag the stick to move' : mode === 'pvp' ? 'P1: WASD · Space jump · Shift dodge   P2: arrows · K jump · L dodge' : 'WASD move · Space jump · Shift dodge · Q E right-click F moves')),
    h('div.move-grid.rt-grid', mine),
    theirs.length ? h('div.move-grid.rt-grid.p2', theirs) : '',
    touch ? h('div.rt-touch', tap(0, 'jump', 'Jump'), tap(0, 'dodge', 'Dodge')) : '');
  if (touch) a.frame.append(joystick((x, y) => controls.setStick(0, x, y)));
  say(a.message, 'Battle start!', { hold: 0 });

  let acc = 0;
  let ended = false;
  const name = (side) => battle.fighters[side].name;
  const handle = (e) => {
    if (e.type === 'move') stage.liveMove(e.side, e);
    else if (e.type === 'hit') {
      stage.hit(e.side, { amount: e.amount, weakness: e.weakness });
      if (e.down) say(a.message, `${name(e.side)} was knocked down!`, { hold: 0 });
      else if (e.weakness) say(a.message, `It hit ${name(e.side)}’s weakness!`, { hold: 0 });
    } else if (e.type === 'burst') stage.burstAt(e.x, e.z, e.moveType, e.fizzle);
    else if (e.type === 'dodge') stage.dodgeFx(e.side);
    else if (e.type === 'evade') stage.float(e.side, 'Dodged!', 'miss');
    else if (e.type === 'boost') { stage.boost(e.side, true); say(a.message, `${name(e.side)} is powered up for 10 seconds!`, { hold: 0 }); }
    else if (e.type === 'heal') stage.heal(e.side, e.amount);
    else if (e.type === 'charge') stage.charge(e.side, 'full');
    else if (e.type === 'weather') stage.hit(e.side, { amount: e.amount });
    else if (e.type === 'ringout') say(a.message, `${name(e.side)} fell off the stadium!`, { hold: 0 });
    else if (e.type === 'zone') say(a.message, 'The field is closing in!', { hold: 0 });
    else if (e.type === 'ko') { say(a.message, `${name(e.side)} fainted!`, { hold: 0 }); stage.faint(e.side); }
    else if (e.type === 'end') { ended = true; setTimeout(() => showResult(e), 1300); }
  };
  stage.beforeFrame = (dt) => {
    if (ended) return;
    acc += dt;
    while (acc >= STEP && !battle.over) {
      acc -= STEP;
      const intents = [0, 1].map((side) => {
        if (side === 1 && mode === 'cpu') return null;
        const i = controls.read(side);
        const me = battle.fighters[side];
        return { move: toWorld(i, me, battle.fighters[1 - side]), jump: i.jump, dodge: i.dodge, use: i.use };
      });
      for (const e of stepRealtime(battle, intents)) handle(e);
    }
    for (const f of battle.fighters) stage.setPose(f.side, { x: f.x, y: f.out ? -2 : f.y, z: f.z, facing: f.facing, down: f.down > 0 });
    stage.follow(f1, f2);
    stage.syncShots(battle.projectiles);
    if (battle.rules.shrink) stage.setZone(battle.zone);
    plates.forEach((p) => p.update());
    const left = Math.max(0, TIME_LIMIT - battle.t);
    clock.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    dodges.textContent = '●'.repeat(f1.dodges) + '○'.repeat(2 - f1.dodges);
    const cools = (btns, f) => btns.forEach((btn, i) => {
      const m = f.moves[i];
      const wait = m.once && f.usedOnce.includes(i) ? 1 : f.cooldowns[i] / m.cooldown;
      btn.style.setProperty('--cool', String(Math.max(0, Math.min(1, wait))));
      btn.disabled = f.energy < m.energy || (m.once && f.usedOnce.includes(i));
    });
    cools(mine, f1);
    if (theirs.length) cools(theirs, f2);
  };

  const showResult = (e) => {
    const w = e.winner;
    const f = battle.fighters;
    controls?.dispose();
    stage.syncShots([]);
    a.frame.querySelector('.rt-stick')?.remove();
    clear(a.controls, h('div.bt-result', { role: 'group', 'aria-label': 'Battle result' },
      h('h3', w == null ? 'It’s a draw!' : mode === 'cpu' ? (w === 0 ? `🏆 You win with ${f[0].name}!` : `The computer’s ${f[1].name} wins!`) : `🏆 Player ${w + 1} wins with ${f[w].name}!`),
      h('p.muted', `${e.timeUp ? 'Time up · ' : ''}${Math.round(battle.t)} s · ${f[0].name} dealt ${f[0].stats.dealt} · ${f[1].name} dealt ${f[1].stats.dealt}`),
      h('p.bt-next', `Battle ${f[1].name} again, or choose a different opponent for ${f[0].name}?`),
      h('div.bt-row',
        h('button.btn.primary', { type: 'button', onclick: () => { cleanup(); startRealtime(root, picks, mode, onBack, onNewOpponent); } }, '↻ Same battle again'),
        h('button.btn', { type: 'button', onclick: () => { cleanup(); onNewOpponent(picks, mode); } }, '⇄ Different opponent'),
        h('button.btn.ghost', { type: 'button', onclick: () => { cleanup(); onBack(); } }, 'Choose both again'))));
    a.controls.querySelector('.btn.primary')?.focus();
  };
}
