/** Stable, conservative storage format. Never retain engine-supplied paths/URLs/HTML. */
const ENGINES = new Set(['viridian-cv']);
const text = (v, limit = 300) => typeof v === 'string' ? v.slice(0, limit) : '';
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
export function cleanMetric(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['grade', 'left_right', 'top_bottom', 'axis_note', 'worst_pct', 'per_corner', 'per_edge', 'scuff', 'confidence', 'method', 'ok', 'horizontal', 'vertical', 'note', 'left', 'right', 'top', 'bottom']) {
    const v = value[key];
    if (typeof v === 'boolean') result[key] = v;
    else if (typeof v === 'string') result[key] = text(v, 100);
    else if (typeof v === 'number' && Number.isFinite(v)) result[key] = v;
    else if (Array.isArray(v) && v.length <= 4) result[key] = v.filter((n) => typeof n === 'number' && Number.isFinite(n));
  }
  return result;
}
function cleanSide(side) {
  if (!side || typeof side !== 'object') return null;
  return {
    centering: cleanMetric(side.centering),
    corners: cleanMetric(side.corners),
    edges: cleanMetric(side.edges),
    surface: cleanMetric(side.surface),
    experimental_overall: num(side.experimental_overall),
  };
}
function cleanCapture(capture) {
  if (!capture || typeof capture !== 'object') return null;
  return {
    ok: capture.ok === true,
    blur: num(capture.blur),
    glare: num(capture.glare),
    brightness: num(capture.brightness),
    card_px: num(capture.card_px),
    warnings: Array.isArray(capture.warnings) ? capture.warnings.slice(0, 8).map((s) => text(s, 250)) : [],
  };
}
const SIDES = ['front', 'back'];
const SEVERITIES = new Set(['none', 'minor', 'moderate', 'heavy', 'unknown']);
export const CORNER_KEYS = { tl: 'Top-left corner', tr: 'Top-right corner', bl: 'Bottom-left corner', br: 'Bottom-right corner' };
export const EDGE_KEYS = { top: 'Top edge', bottom: 'Bottom edge', left: 'Left edge', right: 'Right edge' };

function cleanRegions(list, keys) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && Object.hasOwn(keys, r.key)).slice(0, 4).map((r) => ({
    key: r.key,
    label: keys[r.key],
    fraction: num(r.fraction),
    grade: num(r.grade),
    severity: SEVERITIES.has(r.severity) ? r.severity : 'unknown',
    white: num(r.white),
    dark: num(r.dark),
  }));
}

/** Per-corner / per-edge measurements (the pictures are saved separately by the router). */
function cleanPrecision(precision) {
  if (!precision || typeof precision !== 'object') return null;
  const out = {};
  for (const side of SIDES) {
    const p = precision[side];
    if (!p || typeof p !== 'object') continue;
    out[side] = { corners: cleanRegions(p.corners, CORNER_KEYS), edges: cleanRegions(p.edges, EDGE_KEYS) };
  }
  return Object.keys(out).length ? out : null;
}

function cleanFindings(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).filter((f) => f && SIDES.includes(f.side)).map((f) => ({
    side: f.side,
    area: text(f.area, 60),
    kind: text(f.kind, 60),
    severity: SEVERITIES.has(f.severity) ? f.severity : 'unknown',
    grade: num(f.grade),
    detail: text(f.detail, 240),
  }));
}

/**
 * Every picture the engine sent, as [file name, buffer] pairs with fixed, safe names. Only PNG and
 * JPEG data URIs that really are PNG / JPEG are kept; anything else is dropped.
 */
export function analysisImages(answer) {
  const out = [];
  const add = (name, uri, ext) => {
    const buf = imageDataUriToBuffer(uri, ext === '.png' ? 'image/png' : 'image/jpeg');
    if (buf) out.push([`${name}${ext}`, buf]);
  };
  add('front_overlay', answer?.front_overlay, '.png');
  add('back_overlay', answer?.back_overlay, '.png');
  add('reference_overlay', answer?.reference_overlay, '.png');
  for (const side of SIDES) {
    const p = answer?.precision?.[side];
    if (!p || typeof p !== 'object') continue;
    add(`${side}_flat`, p.flat, '.jpg');
    add(`${side}_surface_map`, p.surface_map, '.png');
    for (const [group, keys] of [['corners', CORNER_KEYS], ['edges', EDGE_KEYS]]) {
      for (const r of Array.isArray(p[group]) ? p[group].slice(0, 4) : []) {
        if (!r || !Object.hasOwn(keys, r.key)) continue;
        const base = `${side}_${group === 'corners' ? 'corner' : 'edge'}_${r.key}`;
        add(base, r.image, '.jpg');
        add(`${base}_map`, r.mask, '.png');
      }
    }
  }
  return out;
}

export function normalizeAnalysis(answer) {
  if (!answer || answer.ok !== true || !ENGINES.has(answer.engine) || !answer.front || !answer.back) {
    throw new Error('Unexpected response from grading engine');
  }
  return {
    engine: answer.engine,
    screening_only: true,
    status: answer.status === 'retake' ? 'retake' : 'complete',
    experimental_overall: num(answer.experimental_overall),
    front: cleanSide(answer.front),
    back: cleanSide(answer.back),
    capture: { front: cleanCapture(answer.capture?.front), back: cleanCapture(answer.capture?.back) },
    reference_used: answer.reference_used === true,
    warnings: Array.isArray(answer.warnings) ? answer.warnings.slice(0, 12).map((s) => text(s, 250)) : [],
    precision: cleanPrecision(answer.precision),
    findings: cleanFindings(answer.findings),
  };
}
export function mimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: '.png' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}
/** A PNG or JPEG data URI as a Buffer, only if its content really is that type (≤ 4 MB). */
export function imageDataUriToBuffer(uri, mime) {
  const prefix = `data:${mime};base64,`;
  if (typeof uri !== 'string' || !uri.startsWith(prefix) || uri.length > 5_500_000) return null;
  const payload = uri.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const data = Buffer.from(payload, 'base64');
  if (data.length > 4_000_000 || mimeFromMagic(data)?.mime !== mime) return null;
  return data;
}

export function pngDataUriToBuffer(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,') || uri.length > 5_500_000) return null;
  const payload = uri.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const data = Buffer.from(payload, 'base64');
  if (data.length > 4_000_000 || !mimeFromMagic(data) || mimeFromMagic(data).mime !== 'image/png') return null;
  return data;
}
