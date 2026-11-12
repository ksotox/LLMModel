// Synthetic photos for the scan benchmark (runs in the browser; served only by the benchmark,
// never by the app). Real card faces, cut from the labelled reference photos, are pasted with
// perspective onto made-up tables, in rows and binder pages, with dim light, glare, sleeves and
// blur. Everything is drawn from a seeded random generator, so the set is the same every run, and
// each card's true corners are known exactly.

import { loadOpenCV, warpCard } from '/js/vision.js';

const CARD_ASPECT = 63 / 88;

/** A small seeded random generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Couldn’t load ${src}`));
  img.src = src;
});

/** Card faces to paste: each labelled reference card that's fully in its photo, straightened. */
export async function cardFaces(reference, fileUrl) {
  const faces = [];
  for (const photo of reference.photos) {
    const img = await loadImage(fileUrl(photo.file));
    for (const card of photo.cards) {
      if (card.partial || card.corners.some(([x, y]) => x <= 1 || y <= 1)) continue; // runs off the photo
      const quad = card.corners.map(([x, y]) => ({ x, y }));
      faces.push({ canvas: await warpCard(img, quad, { width: 520 }), label: { name: card.name, tcgIds: card.tcgIds } });
    }
  }
  return faces;
}

function noise(ctx, w, h, r, amount, alpha = 0.08) {
  for (let i = 0; i < amount; i++) {
    const v = Math.floor(r() * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3);
  }
}

/** Table tops: wood, dark cloth, a white desk, a busy patterned cloth. */
function background(ctx, w, h, kind, r) {
  if (kind === 'wood') {
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      const y = r() * h;
      const tone = 60 + Math.floor(r() * 60);
      ctx.strokeStyle = `rgba(${tone + 40},${tone},${Math.floor(tone * 0.6)},${0.25 + r() * 0.3})`;
      ctx.lineWidth = 1 + r() * 6;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 20) ctx.lineTo(x, y + Math.sin(x / (80 + r() * 60) + i) * 6);
      ctx.stroke();
    }
    noise(ctx, w, h, r, 4000);
  } else if (kind === 'dark') {
    ctx.fillStyle = '#17161a';
    ctx.fillRect(0, 0, w, h);
    noise(ctx, w, h, r, 6000, 0.05);
  } else if (kind === 'light') {
    ctx.fillStyle = '#ece8df';
    ctx.fillRect(0, 0, w, h);
    noise(ctx, w, h, r, 3000, 0.05);
  } else {
    ctx.fillStyle = '#2f4f6f';
    ctx.fillRect(0, 0, w, h);
    const colours = ['#e0b040', '#c03a3a', '#3aa080', '#f0f0f0', '#6040a0'];
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = colours[Math.floor(r() * colours.length)];
      ctx.globalAlpha = 0.5 + r() * 0.4;
      if (r() < 0.5) ctx.fillRect(r() * w, r() * h, 20 + r() * 160, 6 + r() * 30);
      else { ctx.beginPath(); ctx.arc(r() * w, r() * h, 8 + r() * 50, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }
}

/** A card's four corners (TL TR BR BL of the card itself): a rotated rectangle, nudged for perspective. */
function placeQuad(cx, cy, width, angle, tilt, r) {
  const hgt = width / CARD_ASPECT;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => {
    const x = (dx * width) / 2 + (r() - 0.5) * 2 * tilt * width;
    const y = (dy * hgt) / 2 + (r() - 0.5) * 2 * tilt * width;
    return { x: cx + x * c - y * s, y: cy + x * s + y * c };
  });
}

/** Paste a card face onto the scene along `quad`, with a soft shadow; optionally inside a sleeve. */
function paste(cv, ctx, face, quad, { sleeve = false, dim = 1 } = {}) {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs)) - 2;
  const y0 = Math.floor(Math.min(...ys)) - 2;
  const bw = Math.ceil(Math.max(...xs)) - x0 + 4;
  const bh = Math.ceil(Math.max(...ys)) - y0 + 4;
  // Shadow under the card.
  ctx.save();
  ctx.filter = 'blur(6px)';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  quad.forEach((p, i) => (i ? ctx.lineTo(p.x + 5, p.y + 7) : ctx.moveTo(p.x + 5, p.y + 7)));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // The card itself, warped into place.
  const src = cv.imread(face);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, face.width, 0, face.width, face.height, 0, face.height]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x - x0, p.y - y0]));
  const M = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(bw, bh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const tile = document.createElement('canvas');
  tile.width = bw;
  tile.height = bh;
  cv.imshow(tile, out);
  for (const m of [src, from, to, M, out]) m.delete();
  ctx.save();
  if (dim !== 1) ctx.filter = `brightness(${dim})`;
  ctx.drawImage(tile, x0, y0);
  ctx.restore();
  if (sleeve) {
    // A clear plastic sleeve a little bigger than the card: a faint film and a bright rim.
    const cx = quad.reduce((a, p) => a + p.x, 0) / 4;
    const cy = quad.reduce((a, p) => a + p.y, 0) / 4;
    const grown = quad.map((p) => ({ x: cx + (p.x - cx) * 1.06, y: cy + (p.y - cy) * 1.04 }));
    ctx.save();
    ctx.beginPath();
    grown.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }
}

/** Binder page: a dark plastic sheet with a 3×3 grid of clear pockets. Returns the pocket centres and card width. */
function binderPage(ctx, w, h) {
  ctx.fillStyle = '#26282c';
  ctx.fillRect(0, 0, w, h);
  const cardW = w * 0.27;
  const cardH = cardW / CARD_ASPECT;
  const gapX = (w - 3 * cardW) / 4;
  const gapY = (h - 3 * cardH) / 4;
  const centres = [];
  ctx.strokeStyle = 'rgba(220,225,235,0.35)';
  ctx.lineWidth = 2;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = gapX + col * (cardW + gapX);
      const y = gapY + row * (cardH + gapY);
      ctx.strokeRect(x - 10, y - 10, cardW + 20, cardH + 20);
      centres.push({ x: x + cardW / 2, y: y + cardH / 2 });
    }
  }
  return { centres, cardW };
}

/** The scenes: [{ name, group, layout, bg, effects }], fixed for every run. */
export function sceneList() {
  const list = [];
  const add = (group, n, make) => { for (let i = 0; i < n; i++) list.push({ name: `${group}-${i + 1}`, group, ...make(i) }); };
  const bgs = ['wood', 'light', 'pattern', 'wood', 'light', 'pattern'];
  add('synthetic-single', 6, (i) => ({ layout: 'single', bg: bgs[i], effects: [] }));
  add('synthetic-row', 5, (i) => ({ layout: 'row', bg: bgs[i], effects: [] }));
  add('synthetic-binder', 3, () => ({ layout: 'binder', bg: 'binder', effects: [] }));
  add('synthetic-dark', 4, (i) => ({ layout: i % 2 ? 'row' : 'single', bg: 'dark', effects: ['dim'] }));
  add('synthetic-glare', 4, (i) => ({ layout: i % 2 ? 'row' : 'single', bg: bgs[i], effects: ['glare'] }));
  add('synthetic-sleeve', 4, (i) => ({ layout: i % 2 ? 'row' : 'single', bg: bgs[i + 1], effects: ['sleeve'] }));
  add('synthetic-blur', 4, (i) => ({ layout: i % 2 ? 'row' : 'single', bg: bgs[i + 2], effects: ['blur'] }));
  add('synthetic-flipped', 3, (i) => ({ layout: i % 2 ? 'row' : 'single', bg: bgs[i], effects: ['flipped'] })); // upside down
  return list;
}

/**
 * Draw one scene. Returns { canvas, cards: [{ corners: [[x, y]…], name, tcgIds }] }.
 * `faces` comes from cardFaces(); `seed` makes each scene different but repeatable.
 */
export async function drawScene(scene, faces, seed) {
  const { cv } = await loadOpenCV();
  const r = rng(seed);
  const portrait = scene.layout === 'binder';
  const w = portrait ? 1200 : 1600;
  const h = portrait ? 1600 : 1200;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const has = (e) => scene.effects.includes(e);
  const cards = [];
  const pick = () => faces[Math.floor(r() * faces.length)];
  const put = (cx, cy, width, angle, tilt) => {
    const face = pick();
    const quad = placeQuad(cx, cy, width, angle + (has('flipped') ? Math.PI : 0), tilt, r);
    paste(cv, ctx, face.canvas, quad, { sleeve: has('sleeve'), dim: has('dim') ? 0.55 : 1 });
    cards.push({ corners: quad.map((p) => [p.x, p.y]), ...face.label });
  };

  if (scene.layout === 'binder') {
    const { centres, cardW } = binderPage(ctx, w, h);
    for (const c of centres) put(c.x + (r() - 0.5) * 8, c.y + (r() - 0.5) * 8, cardW, (r() - 0.5) * 0.04, 0.005);
  } else {
    background(ctx, w, h, scene.bg, r);
    if (scene.layout === 'single') {
      const width = Math.min(w, h) * (0.38 + r() * 0.17);
      put(w / 2 + (r() - 0.5) * w * 0.2, h / 2 + (r() - 0.5) * h * 0.1, width, (r() - 0.5) * 0.7, 0.03);
    } else {
      const width = w * (0.2 + r() * 0.04);
      for (let i = 0; i < 3; i++) put(w * (0.2 + i * 0.3) + (r() - 0.5) * 30, h / 2 + (r() - 0.5) * 60, width, (r() - 0.5) * 0.25, 0.015);
    }
  }

  if (has('glare')) {
    const c = cards[Math.floor(r() * cards.length)].corners;
    const gx = c.reduce((a, p) => a + p[0], 0) / 4 + (r() - 0.5) * 80;
    const gy = c.reduce((a, p) => a + p[1], 0) / 4 + (r() - 0.5) * 120;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 260);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  if (has('blur')) {
    const copy = document.createElement('canvas');
    copy.width = w;
    copy.height = h;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    ctx.save();
    ctx.filter = 'blur(2.5px)';
    ctx.drawImage(copy, 0, 0);
    ctx.restore();
  }
  return { canvas, cards };
}

/** A scene as an <img>, which is what the app's card finder takes (like a decoded photo). */
export async function asImage(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
