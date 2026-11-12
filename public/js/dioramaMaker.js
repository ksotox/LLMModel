// A free card diorama, made on this device from the card's own official picture: the card standing
// tall in a holographic frame on a glowing metal pedestal, its Pokémon (or trainer) cut out of the
// artwork and bursting out of the card, elemental ribbons and particles in the card's type, and a
// small copy of the card at the lower right, on a pale lavender studio background. It follows the
// look of the owner's delivered dioramas (assets/card-effects), drawn with canvas and OpenCV's
// GrabCut instead of a paid image model.
//
// The pure parts (theme, layout, art window, random numbers) are at the top, for tests.

export const DIORAMA_SIZE = { width: 1122, height: 1402 };

/** Repeatable random numbers (the same card always gets the same diorama). */
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from a string (the card's name and id). */
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

const THEMES = {
  fire: { colors: ['#ff6a00', '#ffb000', '#ff2d00'], glow: '#ff8a1c', particle: 'embers' },
  water: { colors: ['#28a7ff', '#7fdcff', '#1d5bff'], glow: '#38b6ff', particle: 'bubbles' },
  lightning: { colors: ['#ffe14a', '#fff6b0', '#ffb300'], glow: '#ffd21f', particle: 'sparks' },
  psychic: { colors: ['#b45cff', '#ff7ad9', '#6f5bff'], glow: '#c26bff', particle: 'rings' },
  grass: { colors: ['#3fbf4a', '#a6e35a', '#0f8a4a'], glow: '#5fd35a', particle: 'leaves' },
  fighting: { colors: ['#d9772b', '#f3b35c', '#9a4a1c'], glow: '#ef8f3a', particle: 'shards' },
  dark: { colors: ['#6d3bd1', '#2a1650', '#c46bff'], glow: '#8a4dff', particle: 'smoke' },
  metal: { colors: ['#b8c4d6', '#ffffff', '#7d8aa3'], glow: '#c9d6ea', particle: 'shards' },
  dragon: { colors: ['#e3b23c', '#2fc4b2', '#7b5cff'], glow: '#e3b23c', particle: 'stars' },
  fairy: { colors: ['#ff8ccf', '#ffd1ec', '#c86bff'], glow: '#ff9ad8', particle: 'stars' },
  trainer: { colors: ['#ff4fb0', '#7c5cff', '#38d1ff'], glow: '#ff6fc0', particle: 'stars' },
  colorless: { colors: ['#ffd6f5', '#c7f0ff', '#fff1b8'], glow: '#e8d8ff', particle: 'stars' },
};

/** The look for a card: its first type's colours and particles (trainers get a stage theme). */
export function dioramaTheme(card) {
  if (/trainer|supporter|item|stadium|tool/i.test(String(card.category ?? ''))) return { key: 'trainer', ...THEMES.trainer };
  const types = Array.isArray(card.types) ? card.types : String(card.types ?? '').split(',');
  const t = String(types[0] ?? '').trim().toLowerCase();
  const key = /fire/.test(t) ? 'fire' : /water|ice/.test(t) ? 'water' : /lightning|electric/.test(t) ? 'lightning'
    : /psychic|poison|ghost/.test(t) ? 'psychic' : /grass|bug/.test(t) ? 'grass' : /fighting|rock|ground/.test(t) ? 'fighting'
      : /dark/.test(t) ? 'dark' : /metal|steel/.test(t) ? 'metal' : /dragon/.test(t) ? 'dragon' : /fairy/.test(t) ? 'fairy' : 'colorless';
  return { key, ...THEMES[key] };
}

/**
 * Where the artwork is on the card picture (fractions): the picture window of an ordinary card, or
 * nearly the whole card for full-art printings (illustration, special, hyper and ultra rares).
 */
export function artWindow(card) {
  const fullArt = /illustration|special|hyper|ultra|secret|full/i.test(String(card.rarity ?? '')) || card.variant === 'full-art';
  return fullArt ? { x0: 0.06, y0: 0.09, x1: 0.94, y1: 0.86, fullArt: true } : { x0: 0.075, y0: 0.105, x1: 0.925, y1: 0.545, fullArt: false };
}

/** Where everything goes on a W × H diorama. */
export function dioramaLayout(W = DIORAMA_SIZE.width, H = DIORAMA_SIZE.height) {
  const pedestal = { cx: W * 0.49, top: H * 0.8, rx: W * 0.46, ry: H * 0.058, depth: H * 0.1 };
  const cardW = W * 0.6;
  const cardH = cardW * 88 / 63;
  const card = { x: pedestal.cx - cardW / 2, y: Math.max(H * 0.06, pedestal.top - cardH + pedestal.ry * 0.3), w: cardW, h: cardH };
  const small = { w: W * 0.2, h: W * 0.2 * 88 / 63 };
  small.x = W * 0.94 - small.w;
  small.y = pedestal.top + pedestal.depth * 0.6 - small.h;
  return { W, H, pedestal, card, small };
}

// ---------------------------------------------------------------- drawing (browser only)

const loadPicture = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('The card picture could not be loaded'));
  img.src = src;
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function background(ctx, L) {
  const g = ctx.createLinearGradient(0, 0, 0, L.H);
  g.addColorStop(0, '#f1ecfa');
  g.addColorStop(0.6, '#e2d9f3');
  g.addColorStop(1, '#d3c7ea');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, L.W, L.H);
  const light = ctx.createRadialGradient(L.W * 0.48, L.H * 0.4, 20, L.W * 0.48, L.H * 0.4, L.W * 0.75);
  light.addColorStop(0, 'rgba(255,255,255,0.85)');
  light.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, L.W, L.H);
}

function pedestal(ctx, L, theme) {
  const { cx, top, rx, ry, depth } = L.pedestal;
  // Shadow on the floor.
  ctx.save();
  ctx.fillStyle = 'rgba(70,50,110,0.22)';
  ctx.filter = 'blur(18px)';
  ctx.beginPath();
  ctx.ellipse(cx, top + depth + ry * 0.4, rx * 1.05, ry * 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Metal side.
  const side = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  side.addColorStop(0, '#8e889f');
  side.addColorStop(0.25, '#f6f4fb');
  side.addColorStop(0.5, '#b7b1c6');
  side.addColorStop(0.75, '#ffffff');
  side.addColorStop(1, '#827c93');
  ctx.fillStyle = side;
  ctx.beginPath();
  ctx.ellipse(cx, top + depth, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(cx - rx, top);
  ctx.ellipse(cx, top, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  // Glowing band around the side.
  ctx.save();
  ctx.strokeStyle = theme.glow;
  ctx.lineWidth = 6;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 28;
  ctx.beginPath();
  ctx.ellipse(cx, top + depth * 0.55, rx * 0.995, ry, 0, 0, Math.PI);
  ctx.stroke();
  ctx.restore();
  // Top surface.
  const face = ctx.createRadialGradient(cx, top, 10, cx, top, rx);
  face.addColorStop(0, '#ffffff');
  face.addColorStop(0.7, '#dcd6e8');
  face.addColorStop(1, '#a9a2bb');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.ellipse(cx, top, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.strokeStyle = theme.glow;
  ctx.lineWidth = 4;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 22;
  ctx.beginPath();
  ctx.ellipse(cx, top, rx * 0.92, ry * 0.86, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // Poké Ball emblem on the front.
  const ey = top + depth * 0.55 + ry * 0.55;
  const er = depth * 0.42;
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#4b4560';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.beginPath();
  ctx.ellipse(cx, ey, er * 1.2, er * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - er * 1.2, ey);
  ctx.lineTo(cx + er * 1.2, ey);
  ctx.stroke();
  ctx.fillStyle = theme.glow;
  ctx.shadowColor = theme.glow;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.ellipse(cx, ey, er * 0.32, er * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function holoCard(ctx, picture, box, { tilt = 0, frame = 0.025, shadow = true } = {}) {
  const pad = box.w * frame;
  ctx.save();
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
  ctx.rotate(tilt);
  ctx.translate(-box.w / 2, -box.h / 2);
  if (shadow) {
    ctx.shadowColor = 'rgba(60,30,100,0.35)';
    ctx.shadowBlur = box.w * 0.06;
    ctx.shadowOffsetY = box.w * 0.02;
  }
  // Holographic frame.
  const holo = ctx.createLinearGradient(0, 0, box.w, box.h);
  ['#ff9ad5', '#ffe68a', '#8ff0c8', '#8fc8ff', '#c79bff', '#ff9ad5'].forEach((c, i, a) => holo.addColorStop(i / (a.length - 1), c));
  ctx.fillStyle = holo;
  roundRect(ctx, -pad, -pad, box.w + pad * 2, box.h + pad * 2, box.w * 0.06);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  // The card itself.
  ctx.save();
  roundRect(ctx, 0, 0, box.w, box.h, box.w * 0.045);
  ctx.clip();
  ctx.drawImage(picture, 0, 0, box.w, box.h);
  // A holographic sheen across it.
  const sheen = ctx.createLinearGradient(0, 0, box.w, box.h);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  sheen.addColorStop(0.5, 'rgba(180,220,255,0.28)');
  sheen.addColorStop(0.55, 'rgba(255,200,240,0.18)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, box.w, box.h);
  ctx.restore();
  ctx.restore();
}

/** Ribbons of the card's colours swirling around it (`front`: the ones passing in front). */
function ribbons(ctx, L, theme, r, front) {
  const { card } = L;
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h * 0.45;
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const [c1, c2] = [theme.colors[i % theme.colors.length], theme.colors[(i + 1) % theme.colors.length]];
    const rx = card.w * (0.66 + r() * 0.16);
    const ry = card.h * (0.14 + r() * 0.12);
    const rot = -0.45 + r() * 0.9;
    // Ribbons in front pass below the middle (not across the character's face).
    const yOff = front ? card.h * (0.12 + r() * 0.25) : (r() - 0.5) * card.h * 0.55;
    const start = front ? 0.08 * Math.PI : 1.05 * Math.PI;
    const end = start + Math.PI * (0.62 + r() * 0.22);
    const grad = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    const trace = () => { ctx.beginPath(); ctx.ellipse(cx, cy + yOff, rx, ry, rot, start, end); ctx.stroke(); };
    ctx.lineCap = 'round';
    ctx.shadowColor = c1;
    ctx.shadowBlur = 26;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 22 + r() * 14;
    trace();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    trace();
  }
  ctx.restore();
}

function particles(ctx, L, theme, r) {
  const { card } = L;
  const n = 70;
  ctx.save();
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.35 + r() * 0.55;
    const x = card.x + card.w / 2 + Math.cos(a) * card.w * d;
    const y = card.y + card.h * 0.45 + Math.sin(a) * card.h * d * 0.6;
    const s = 3 + r() * 9;
    const color = theme.colors[Math.floor(r() * theme.colors.length)];
    ctx.globalAlpha = 0.55 + r() * 0.45;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    switch (theme.particle) {
      case 'bubbles':
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, s * 1.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(x - s * 0.5, y - s * 0.5, s * 0.35, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'sparks': {
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        let px = x;
        let py = y;
        ctx.moveTo(px, py);
        for (let k = 0; k < 4; k++) {
          px += (r() - 0.5) * s * 4;
          py += s * 1.5 * (r() < 0.5 ? -1 : 1);
          ctx.lineTo(px, py);
        }
        ctx.stroke();
        break;
      }
      case 'leaves':
        ctx.beginPath();
        ctx.ellipse(x, y, s * 1.6, s * 0.7, r() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'rings':
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, y, s * 2, s * 0.9, r() * Math.PI, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'shards':
        ctx.beginPath();
        ctx.moveTo(x, y - s * 1.5);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x + s * 0.2, y + s * 1.3);
        ctx.lineTo(x - s, y + s * 0.2);
        ctx.closePath();
        ctx.fill();
        break;
      case 'smoke':
        ctx.globalAlpha *= 0.5;
        ctx.filter = 'blur(4px)';
        ctx.beginPath();
        ctx.arc(x, y, s * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.filter = 'none';
        break;
      case 'embers':
        ctx.beginPath();
        ctx.ellipse(x, y, s * 0.6, s * 1.4, -0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      default: { // stars and sparkles
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const rad = k % 2 ? s * 0.4 : s * 1.4;
          const ang = (k / 8) * Math.PI * 2;
          ctx[k ? 'lineTo' : 'moveTo'](x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** GrabCut's foreground as 0/255, only its largest connected shape (stray bits of frame dropped). */
function keepLargest(cv, mask, w, h) {
  const fg = new cv.Mat(h, w, cv.CV_8UC1);
  for (let i = 0; i < w * h; i++) fg.data[i] = mask.data[i] === 1 || mask.data[i] === 3 ? 255 : 0;
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const n = cv.connectedComponentsWithStats(fg, labels, stats, centroids, 8, cv.CV_32S);
  let best = 0;
  let bestArea = 0;
  for (let k = 1; k < n; k++) {
    const area = stats.intAt(k, cv.CC_STAT_AREA);
    if (area > bestArea) { best = k; bestArea = area; }
  }
  const out = new Uint8ClampedArray(w * h);
  const lab = labels.data32S;
  for (let i = 0; i < out.length; i++) out[i] = best && lab[i] === best ? 255 : 0;
  for (const m of [fg, labels, stats, centroids]) m.delete();
  return out;
}

/**
 * Whether a cut-out is a character and not the whole picture: a sensible share of the window, and
 * not running along most of the window's edges (that is the background, cut along with it).
 */
export function cutLooksRight(alpha, w, h, rect) {
  if (!alpha) return false;
  let fg = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i]) fg++;
  const share = fg / alpha.length;
  // Characters fill about 20–50% of their picture window; much more is the background coming along.
  if (share < 0.08 || share > 0.52) return false;
  let edge = 0;
  let total = 0;
  const x0 = rect.x + 2;
  const y0 = rect.y + 2;
  const x1 = Math.min(w - 1, rect.x + rect.width - 3);
  const y1 = Math.min(h - 1, rect.y + rect.height - 3);
  for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) { total++; if (alpha[y * w + x]) edge++; }
  for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) { total++; if (alpha[y * w + x]) edge++; }
  return total > 0 && edge / total < 0.35;
}

/**
 * The card's character cut out of its artwork (OpenCV GrabCut, started from the picture window),
 * as a canvas the size of the window; null when the cut isn't convincing (then the diorama keeps
 * the card without a cut-out).
 */
async function cutOut(picture, win) {
  const { loadOpenCV } = await import('./vision/opencv.js');
  const { cv } = await loadOpenCV();
  const sx = win.x0 * picture.naturalWidth;
  const sy = win.y0 * picture.naturalHeight;
  const sw = (win.x1 - win.x0) * picture.naturalWidth;
  const sh = (win.y1 - win.y0) * picture.naturalHeight;
  const scale = Math.min(1, 380 / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * scale));
  const hh = Math.max(8, Math.round(sh * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = hh;
  small.getContext('2d').drawImage(picture, sx, sy, sw, sh, 0, 0, w, hh);
  const rgba = cv.imread(small);
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  const mask = new cv.Mat();
  const bgd = new cv.Mat();
  const fgd = new cv.Mat();
  const inset = win.fullArt ? 0.08 : 0.04;
  const rect = new cv.Rect(Math.round(w * inset), Math.round(hh * inset), Math.round(w * (1 - 2 * inset)), Math.round(hh * (1 - inset)));
  let alpha = null;
  try {
    cv.grabCut(rgb, mask, rect, bgd, fgd, 4, cv.GC_INIT_WITH_RECT);
    alpha = keepLargest(cv, mask, w, hh);
    if (!cutLooksRight(alpha, w, hh, rect)) alpha = null;
  } finally {
    for (const m of [rgba, rgb, mask, bgd, fgd]) m.delete();
  }
  if (!alpha) return null;
  // Soft edges, at the picture's own resolution.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = hh;
  const mctx = maskCanvas.getContext('2d');
  const md = mctx.createImageData(w, hh);
  for (let i = 0; i < alpha.length; i++) md.data[i * 4 + 3] = alpha[i];
  mctx.putImageData(md, 0, 0);
  const out = document.createElement('canvas');
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  const octx = out.getContext('2d');
  octx.drawImage(picture, sx, sy, sw, sh, 0, 0, out.width, out.height);
  octx.globalCompositeOperation = 'destination-in';
  octx.filter = `blur(${Math.max(1, out.width / 260)}px)`;
  octx.drawImage(maskCanvas, 0, 0, out.width, out.height);
  return out;
}

/** The character bursting out of the card: bigger than its window, with a shadow and a rim of light. */
function popOut(ctx, L, theme, cut, win) {
  const { card } = L;
  const winW = (win.x1 - win.x0) * card.w;
  const winH = (win.y1 - win.y0) * card.h;
  const scale = win.fullArt ? 1.2 : 1.55;
  const w = winW * scale;
  const h = winH * scale;
  const cx = card.x + (win.x0 + win.x1) / 2 * card.w;
  // Raised so the character rises out of the top of its picture window and past the card's sides.
  const cy = card.y + (win.y0 + win.y1) / 2 * card.h - card.h * (win.fullArt ? 0.03 : 0.02);
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.save();
  ctx.filter = 'blur(14px)';
  ctx.globalAlpha = 1;
  const rim = document.createElement('canvas');
  rim.width = cut.width;
  rim.height = cut.height;
  const rctx = rim.getContext('2d');
  rctx.drawImage(cut, 0, 0);
  rctx.globalCompositeOperation = 'source-in';
  rctx.fillStyle = theme.glow;
  rctx.fillRect(0, 0, rim.width, rim.height);
  ctx.drawImage(rim, x - 6, y - 6, w + 12, h + 12);
  ctx.restore();
  ctx.save();
  ctx.shadowColor = 'rgba(50,25,90,0.45)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 18;
  ctx.drawImage(cut, x, y, w, h);
  ctx.restore();
}

/**
 * Make a diorama for a card: { name, category, types, rarity, variant, picture (same-origin URL) }.
 * Returns a WebP (or PNG) Blob of DIORAMA_SIZE.
 */
export async function makeDiorama(card, { seed = seedOf(`${card.name}|${card.set_code}|${card.number}`) } = {}) {
  const picture = await loadPicture(card.picture);
  const L = dioramaLayout();
  const theme = dioramaTheme(card);
  const win = artWindow(card);
  const r = rng(seed);
  const canvas = document.createElement('canvas');
  canvas.width = L.W;
  canvas.height = L.H;
  const ctx = canvas.getContext('2d');
  background(ctx, L);
  ribbons(ctx, L, theme, r, false);
  pedestal(ctx, L, theme);
  holoCard(ctx, picture, L.card, { tilt: -0.012 });
  const cut = await cutOut(picture, win).catch(() => null);
  if (cut) popOut(ctx, L, theme, cut, win);
  ribbons(ctx, L, theme, r, true);
  particles(ctx, L, theme, r);
  holoCard(ctx, picture, L.small, { tilt: 0.12, frame: 0.04 });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  return blob ?? new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
