// Controls for real-time PokéBattles: keyboard, mouse, gamepads and touch, all turned into one
// intent per side: { forward, right, jump, dodge, use }. Moving is relative to the rival: forward
// goes towards it, right circles round it (the camera stands behind your Pokémon, looking at it).
//
//   Player 1: WASD move · Space jump · Shift dodge · Q / E / right click / F (or 1–4) moves
//   Player 2: arrows move · K jump · L dodge · U / I / O / P (or numpad 1–4) moves
//   Gamepads: left stick move · A jump · B dodge · LB / RB / LT / RT moves (pad 1 → player 1, pad 2 → player 2)
//   Touch: the joystick at the bottom left, and the Jump, Dodge and move buttons

const KEYS = [
  {
    up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    jump: ['Space'], dodge: ['ShiftLeft', 'ShiftRight'],
    moves: [['KeyQ', 'Digit1'], ['KeyE', 'Digit2'], ['Mouse2', 'Digit3'], ['KeyF', 'Digit4']],
  },
  {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    jump: ['KeyK', 'NumpadEnter'], dodge: ['KeyL', 'Numpad0'],
    moves: [['KeyU', 'Numpad1'], ['KeyI', 'Numpad2'], ['KeyO', 'Numpad3'], ['KeyP', 'Numpad4']],
  },
];
const PAD_MOVES = [4, 5, 6, 7]; // LB, RB, LT, RT
const DEAD = 0.2;

/** Turn a side's forward/right input into a direction on the field, given where it and its rival stand. */
export function toWorld({ forward = 0, right = 0 }, me, foe) {
  const dx = foe.x - me.x;
  const dz = foe.z - me.z;
  const d = Math.hypot(dx, dz) || 1;
  const fx = dx / d;
  const fz = dz / d;
  // Seen from behind, "right" of a direction (fx, fz) on the field is (−fz, fx).
  return { x: fx * forward - fz * right, z: fz * forward + fx * right };
}

/**
 * Listen for input. `players`: 1 or 2 (two players share the keyboard; pads 1 and 2).
 * Returns { read(side) → intent, press(side, what), setStick(side, x, y), dispose() }.
 * Jump and dodge fire once per press; holding a move key keeps using it as it comes back.
 */
export function createControls(target = window, { players = 1 } = {}) {
  const down = new Set();
  const pressed = [new Set(), new Set()]; // one-shot presses waiting to be read
  const sticks = [{ x: 0, y: 0 }, { x: 0, y: 0 }]; // touch joystick (x right, y forward)
  const held = [new Set(), new Set()]; // touch buttons held
  const sideOfCode = (code) => KEYS.findIndex((k, i) => i < players && Object.values(k).flat(2).includes(code));

  const onKey = (e) => {
    const side = sideOfCode(e.code);
    if (side < 0) return;
    if (e.target?.closest?.('input, select, textarea')) return;
    e.preventDefault();
    if (e.type === 'keydown') {
      if (!down.has(e.code)) for (const what of ['jump', 'dodge']) if (KEYS[side][what].includes(e.code)) pressed[side].add(what);
      down.add(e.code);
    } else {
      down.delete(e.code);
    }
  };
  const onMouse = (e) => {
    if (e.button !== 2) return;
    if (e.type === 'mousedown') down.add('Mouse2'); else down.delete('Mouse2');
  };
  const noMenu = (e) => e.preventDefault();
  const onBlur = () => down.clear();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);
  target.addEventListener('mousedown', onMouse);
  window.addEventListener('mouseup', onMouse);
  target.addEventListener('contextmenu', noMenu);

  const padState = [{}, {}];
  const readPad = (side) => {
    const pad = navigator.getGamepads?.()[side];
    if (!pad) return null;
    const was = padState[side];
    const btn = (i) => Boolean(pad.buttons[i]?.pressed || pad.buttons[i]?.value > 0.5);
    for (const [what, i] of [['jump', 0], ['dodge', 1]]) {
      if (btn(i) && !was[what]) pressed[side].add(what);
      was[what] = btn(i);
    }
    const [lx = 0, ly = 0] = pad.axes;
    return {
      right: Math.abs(lx) > DEAD ? lx : 0,
      forward: Math.abs(ly) > DEAD ? -ly : 0,
      use: PAD_MOVES.findIndex((i) => btn(i)),
    };
  };

  return {
    read(side) {
      const k = KEYS[side];
      const is = (codes) => codes.some((c) => down.has(c));
      let forward = (is(k.up) ? 1 : 0) - (is(k.down) ? 1 : 0) + sticks[side].y;
      let right = (is(k.right) ? 1 : 0) - (is(k.left) ? 1 : 0) + sticks[side].x;
      let use = k.moves.findIndex((codes) => is(codes));
      if (use < 0) use = [...held[side]][0] ?? -1;
      const pad = readPad(side);
      if (pad) {
        forward += pad.forward;
        right += pad.right;
        if (use < 0) use = pad.use;
      }
      const m = Math.hypot(forward, right);
      if (m > 1) { forward /= m; right /= m; }
      const intent = { forward, right, jump: pressed[side].has('jump'), dodge: pressed[side].has('dodge'), use: use >= 0 ? use : null };
      pressed[side].clear();
      return intent;
    },
    /** A tap on a touch button: "jump", "dodge", or a move held down (index) until released. */
    press(side, what) { pressed[side].add(what); },
    hold(side, index, on) { if (on) held[side].add(index); else held[side].delete(index); },
    setStick(side, x, y) { sticks[side] = { x, y }; },
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      target.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
      target.removeEventListener('contextmenu', noMenu);
    },
  };
}

/** The on-screen joystick for touch screens: drag inside the ring; returns its element. */
export function joystick(onMove) {
  const base = document.createElement('div');
  base.className = 'rt-stick';
  const knob = document.createElement('div');
  knob.className = 'rt-knob';
  base.append(knob);
  let id = null;
  const R = 44;
  const move = (e) => {
    if (e.pointerId !== id) return;
    const r = base.getBoundingClientRect();
    let x = e.clientX - (r.left + r.width / 2);
    let y = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(x, y);
    if (d > R) { x *= R / d; y *= R / d; }
    knob.style.transform = `translate(${x}px, ${y}px)`;
    onMove(x / R, -y / R);
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = '';
    onMove(0, 0);
  };
  base.addEventListener('pointerdown', (e) => { id = e.pointerId; base.setPointerCapture(id); move(e); });
  base.addEventListener('pointermove', move);
  base.addEventListener('pointerup', end);
  base.addEventListener('pointercancel', end);
  return base;
}
