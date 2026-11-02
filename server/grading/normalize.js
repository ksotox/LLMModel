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
  };
}
export function mimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: '.png' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}
export function pngDataUriToBuffer(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:image/png;base64,') || uri.length > 5_500_000) return null;
  const payload = uri.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  const data = Buffer.from(payload, 'base64');
  if (data.length > 4_000_000 || !mimeFromMagic(data) || mimeFromMagic(data).mime !== 'image/png') return null;
  return data;
}
