// Computer vision in the browser (OpenCV.js, served from this app): finds each card's four corners in
// a photo and straightens it, so the saved picture is just the card, without background.

const CARD_ASPECT = 63 / 88; // width / height of a Pokémon card
const WORK_EDGE = 900; // detection runs on a downscaled copy this big
export const CARD_W = 734;

let cvPromise = null;

/**
 * Load OpenCV.js once (about 10 MB, cached by the browser after the first time). Resolves to { cv }:
 * OpenCV's module object is "thenable", so it is passed around wrapped. Resolving a promise with it
 * directly (or returning it from an async function) would wait on it forever.
 */
export function loadOpenCV() {
  cvPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/opencv/opencv.js';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the image tools'));
    script.onload = () => {
      const started = Date.now();
      const poll = () => {
        if (window.cv?.Mat) return resolve({ cv: window.cv });
        if (Date.now() - started > 60000) return reject(new Error('The image tools took too long to start'));
        setTimeout(poll, 50);
      };
      poll();
    };
    document.head.append(script);
  }).catch((err) => {
    cvPromise = null;
    throw err;
  });
  return cvPromise;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / 4, y: pts.reduce((s, p) => s + p.y, 0) / 4 };
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // sorted is clockwise in screen coordinates starting near the left; rotate so top-left (min x+y) is first
  let start = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[start].x + sorted[start].y) start = i; });
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
  // make sure the second point is the top-right (clockwise order)
  if (ordered[1].y > ordered[3].y) [ordered[1], ordered[3]] = [ordered[3], ordered[1]];
  return ordered;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** How card-like a quadrilateral is: 1 = perfect 63:88 rectangle. */
function cardScore(quad, contourArea) {
  const [tl, tr, br, bl] = quad;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const hgt = (dist(tl, bl) + dist(tr, br)) / 2;
  const aspect = Math.min(w, hgt) / Math.max(w, hgt);
  const aspectScore = Math.max(0, 1 - Math.abs(aspect - CARD_ASPECT) / 0.25);
  const fill = Math.min(1, contourArea / polygonArea(quad));
  // opposite sides should be similar in length (small perspective only)
  const parallel = Math.min(dist(tl, tr), dist(bl, br)) / Math.max(dist(tl, tr), dist(bl, br))
    * Math.min(dist(tl, bl), dist(tr, br)) / Math.max(dist(tl, bl), dist(tr, br));
  return aspectScore * fill * parallel;
}

/** Reduce a contour to 4 corners: approxPolyDP with growing tolerance, else its rotated bounding box. */
function contourToQuad(cv, contour) {
  const hull = new cv.Mat();
  cv.convexHull(contour, hull, false, true);
  const peri = cv.arcLength(hull, true);
  let quad = null;
  for (const eps of [0.01, 0.02, 0.03, 0.04, 0.06, 0.08]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, eps * peri, true);
    const corners = approx.rows;
    if (corners === 4) {
      quad = [];
      for (let i = 0; i < 4; i++) quad.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
    }
    approx.delete();
    if (quad || corners < 4) break;
  }
  if (!quad) {
    const rect = cv.minAreaRect(hull);
    quad = cv.RotatedRect.points(rect).map((p) => ({ x: p.x, y: p.y }));
  }
  hull.delete();
  return orderCorners(quad);
}

function collectCandidates(cv, binary, offset, scale, out, minArea, maxArea, label) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minArea && area <= maxArea) {
      const quad = contourToQuad(cv, c).map((p) => ({ x: (p.x - offset) / scale, y: (p.y - offset) / scale }));
      const score = cardScore(quad, area / scale / scale);
      if (score > 0.45) out.push({ quad, score, area: area / scale / scale, label });
    }
    c.delete();
  }
  contours.delete();
  hierarchy.delete();
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function intersect(p1, p2, p3, p4) {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return lerp(p2, p3, 0.5);
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
}

/**
 * Snap each side of a rough quad onto the card's real outer edge. The rough outline can sit a little
 * inside the card (glare, white borders) — cutting the card off — so every side is moved outwards to
 * the outermost strong edge within a few percent of the card size. Works on the gradient image `grad`.
 */
function snapToEdges(quad, grad, W, H) {
  const centre = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  const size = (dist(quad[0], quad[1]) + dist(quad[1], quad[2]) + dist(quad[2], quad[3]) + dist(quad[3], quad[0])) / 4;
  const step = Math.max(0.75, size * 0.003);
  const offsets = [];
  for (let o = -size * 0.015; o <= size * 0.06; o += step) offsets.push(o);
  const sample = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1 ? -1 : grad[yi * W + xi];
  };

  const lines = quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    const len = dist(p, q) || 1;
    let n = { x: (q.y - p.y) / len, y: -(q.x - p.x) / len };
    const mid = lerp(p, q, 0.5);
    if ((mid.x - centre.x) * n.x + (mid.y - centre.y) * n.y < 0) n = { x: -n.x, y: -n.y }; // point outwards
    const scored = [];
    for (const o1 of offsets) {
      for (const o2 of offsets) {
        if (Math.abs(o1 - o2) > size * 0.02) continue;
        const a = { x: p.x + n.x * o1, y: p.y + n.y * o1 };
        const b = { x: q.x + n.x * o2, y: q.y + n.y * o2 };
        let sum = 0;
        let inside = 0;
        const samples = 40;
        for (let k = 0; k < samples; k++) {
          const pt = lerp(a, b, 0.12 + (0.76 * k) / (samples - 1)); // skip the rounded corners
          const g = sample(pt.x, pt.y);
          if (g >= 0) { sum += g; inside++; }
        }
        if (inside > samples * 0.5) scored.push({ a, b, score: sum / inside, out: o1 + o2 });
      }
    }
    if (!scored.length) return [p, q]; // this side runs off the photo: keep it
    const best = Math.max(...scored.map((s) => s.score));
    // The outermost line that is nearly as strong as the strongest one is the card's own edge.
    const pick = scored.filter((s) => s.score >= best * 0.7).sort((x, y) => y.out - x.out)[0];
    return [pick.a, pick.b];
  });
  return lines.map((line, i) => {
    const prev = lines[(i + 3) % 4];
    return intersect(prev[0], prev[1], line[0], line[1]);
  });
}

/**
 * Find the cards in a photo. Returns quads (4 corners each, in image pixels, TL/TR/BR/BL),
 * largest first in reading order. Empty when nothing card-shaped was found.
 */
export async function findCards(img) {
  const { cv } = await loadOpenCV();
  const scale = Math.min(1, WORK_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale);
  const H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').drawImage(img, 0, 0, W, H);

  const pad = 12;
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const padded = new cv.Mat();
  // A dark frame around the photo gives cards that touch the photo's edge a closed outline.
  cv.copyMakeBorder(gray, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const blurred = new cv.Mat();
  cv.GaussianBlur(padded, blurred, new cv.Size(5, 5), 0);

  const imageArea = W * H;
  const minArea = imageArea * 0.03;
  const maxArea = (W + 2 * pad) * (H + 2 * pad) * 0.995;
  const candidates = [];
  const k = Math.max(3, Math.round(Math.min(W, H) * 0.012)) | 1;
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));

  // 1. Brightness: card borders are lighter than most tables. Close gaps, then take outer shapes.
  const bin = new cv.Mat();
  cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel);
  collectCandidates(cv, bin, pad, scale, candidates, minArea, maxArea, 'bright');

  // 2. Edges: the card outline, for cards on light backgrounds.
  const edges = new cv.Mat();
  cv.Canny(blurred, edges, 40, 120);
  cv.dilate(edges, edges, kernel);
  collectCandidates(cv, edges, pad, scale, candidates, minArea, maxArea, 'edges');

  // Gradient strength of the (unpadded) photo, for snapping outlines onto the real card edges.
  const smooth = new cv.Mat();
  cv.GaussianBlur(gray, smooth, new cv.Size(3, 3), 0);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(smooth, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(smooth, gy, cv.CV_32F, 0, 1, 3);
  const grad = new Float32Array(W * H);
  for (let i = 0; i < grad.length; i++) grad[i] = Math.hypot(gx.data32F[i], gy.data32F[i]);
  for (const m of [src, gray, padded, blurred, bin, edges, kernel, smooth, gx, gy]) m.delete();

  // Keep the best candidate wherever several overlap.
  candidates.sort((a, b) => b.score * Math.sqrt(b.area) - a.score * Math.sqrt(a.area));
  const bbox = (q) => {
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const overlap = (a, b) => {
    const A = bbox(a);
    const B = bbox(b);
    const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0));
    const iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0));
    const smaller = Math.min((A.x1 - A.x0) * (A.y1 - A.y0), (B.x1 - B.x0) * (B.y1 - B.y0));
    return (ix * iy) / smaller;
  };
  const kept = [];
  for (const c of candidates) if (!kept.some((k2) => overlap(k2.quad, c.quad) > 0.3)) kept.push(c);

  const quads = kept.map((c) => {
    const snapped = snapToEdges(c.quad.map((p) => ({ x: p.x * scale, y: p.y * scale })), grad, W, H);
    return snapped.map((p) => ({
      x: Math.min(img.naturalWidth, Math.max(0, p.x / scale)),
      y: Math.min(img.naturalHeight, Math.max(0, p.y / scale)),
    }));
  });
  const centre = (q) => ({ x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 });
  const rowH = quads.length ? Math.min(...quads.map((q) => bbox(q).y1 - bbox(q).y0)) / 2 : 0;
  return quads.sort((a, b) => {
    const ca = centre(a);
    const cb = centre(b);
    return Math.abs(ca.y - cb.y) < rowH ? ca.x - cb.x : ca.y - cb.y;
  });
}

/**
 * Cut a region out along its 4 corners and straighten it. For cards (the default) the result is a
 * portrait 63:88 picture with transparent rounded corners; `grow` pushes the corners outwards a
 * little so the card's own edge is never cut off.
 */
export async function warpCard(img, quad, { grow = 0.004, width = CARD_W, aspect = CARD_ASPECT, rounded = true, portrait = rounded } = {}) {
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round(width / aspect));
  const { cv } = await loadOpenCV();
  const c = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  const pts = quad.map((p) => ({ x: p.x + (p.x - c.x) * grow * 2, y: p.y + (p.y - c.y) * grow * 2 }));
  const [tl, tr, br, bl] = pts;
  const landscape = (dist(tl, tr) + dist(bl, br)) > (dist(tl, bl) + dist(tr, br));
  // A card photographed sideways: rotate the corner order so the output is portrait.
  const ordered = portrait && landscape ? [bl, tl, tr, br] : [tl, tr, br, bl];

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const src = cv.imread(canvas);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(from, to);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_AREA, cv.BORDER_REPLICATE, new cv.Scalar());
  const flat = document.createElement('canvas');
  flat.width = outW;
  flat.height = outH;
  cv.imshow(flat, dst);
  for (const m of [src, from, to, M, dst]) m.delete();
  if (!rounded) return flat;

  // Real cards have rounded corners: make the corners transparent so no table shows through.
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  ctx.beginPath();
  ctx.roundRect(0, 0, outW, outH, outW * 0.045);
  ctx.clip();
  ctx.drawImage(flat, 0, 0);
  return out;
}
