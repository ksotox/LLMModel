// Client-side image work: decoding uploads, cropping cards out of photos, and finding cards in a photo.

const MAX_SAVE_EDGE = 1800;

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(Object.assign(img, { objectUrl: url }));
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read "${file.name}". Try a JPEG or PNG photo.`));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, name) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not encode image'));
      resolve(Object.assign(blob, { name }));
    }, 'image/jpeg', 0.9);
  });
}

/**
 * Crop a region (normalised 0..1 box) out of an image and return a JPEG Blob,
 * scaled down so the longest edge is at most MAX_SAVE_EDGE pixels.
 */
export function cropToBlob(img, box = { x: 0, y: 0, w: 1, h: 1 }, name = 'card.jpg') {
  const sx = Math.round(box.x * img.naturalWidth);
  const sy = Math.round(box.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(box.w * img.naturalWidth));
  const sh = Math.max(1, Math.round(box.h * img.naturalHeight));
  const scale = Math.min(1, MAX_SAVE_EDGE / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, name);
}

/** Evenly split an image into cols × rows boxes, with a small inset so neighbours don't bleed in. */
export function gridBoxes(cols, rows, inset = 0.02) {
  const boxes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = 1 / cols;
      const hgt = 1 / rows;
      boxes.push({ x: c * w + w * inset, y: r * hgt + hgt * inset, w: w * (1 - 2 * inset), h: hgt * (1 - 2 * inset) });
    }
  }
  return boxes;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Find card-shaped bright regions in a photo of cards laid on a darker surface (like a table).
 * Returns normalised boxes sorted in reading order. It's a heuristic: the editor lets the user fix it.
 */
export function detectCards(img) {
  const edge = 360;
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(1, Math.round(img.naturalWidth * scale));
  const H = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  // Cards have bright, low-saturation silver/white borders; tables and carpets are darker or more saturated.
  const lum = new Uint8Array(W * H);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lum[p] = l;
    hist[l]++;
  }
  const t = otsu(hist, W * H);

  let mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) mask[p] = lum[p] > t ? 1 : 0;

  // Morphological opening (erode then dilate) removes thin bright noise such as wood grain and carpet fibres.
  const morph = (src, keep) => {
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        const n = src[p] + src[p - 1] + src[p + 1] + src[p - W] + src[p + W];
        out[p] = keep(n) ? 1 : 0;
      }
    }
    return out;
  };
  mask = morph(mask, (n) => n === 5);
  mask = morph(mask, (n) => n > 0);

  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const boxes = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    while (top) {
      const p = stack[--top];
      const x = p % W;
      const y = (p - x) / W;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || seen[q] || !mask[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        seen[q] = 1;
        stack[top++] = q;
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const area = bw * bh;
    const aspect = Math.min(bw, bh) / Math.max(bw, bh); // a card is 63 × 88 mm ≈ 0.72
    const spansImage = (minX <= 1 && maxX >= W - 2) || (minY <= 1 && maxY >= H - 2);
    if (area < W * H * 0.025 || area > W * H * 0.9) continue;
    if (aspect < 0.55 || aspect > 0.9) continue;
    if (count / area < 0.35 || spansImage) continue;
    boxes.push({ x: minX / W, y: minY / H, w: bw / W, h: bh / H });
  }

  // Drop boxes nested inside a bigger one, pad slightly, then sort into rows (top to bottom, left to right).
  const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  const kept = boxes.filter((b) => !boxes.some((a) => a !== b && a.w * a.h > b.w * b.h && contains(a, b)));
  const padded = kept.map((b) => {
    const px = b.w * 0.02;
    const py = b.h * 0.02;
    const x = Math.max(0, b.x - px);
    const y = Math.max(0, b.y - py);
    return { x, y, w: Math.min(1 - x, b.w + 2 * px), h: Math.min(1 - y, b.h + 2 * py) };
  });
  return padded.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y));
}
