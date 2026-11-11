// Running the free AI models (server/aiModels.js) in the browser with onnxruntime-web, served by
// this app at /vendor/ort (no CDN). Works on the page and inside Web Workers. Uses the graphics
// card through WebGPU where the browser has it, else WebAssembly on the processor.
//
// Every caller has a classic fallback: check aiAvailable(name) first, and on `false` (model not
// listed, couldn't download, or the device can't run it) use the non-AI path.

let ortPromise = null;
let listPromise = null;
const sessions = new Map();

/** Load the runtime once. Resolves to { ort, providers }. */
export function loadOrt() {
  ortPromise ??= (async () => {
    const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(await navigator.gpu.requestAdapter().catch(() => null));
    const ort = await import(gpu ? '/vendor/ort/ort.webgpu.min.mjs' : '/vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = `${globalThis.location.origin}/vendor/ort/`; // absolute: also right inside workers
    // Several threads need a cross-origin isolated page, which would stop official card pictures
    // from other sites loading; one thread is enough for these small models.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    return { ort, providers: gpu ? ['webgpu', 'wasm'] : ['wasm'] };
  })().catch((err) => {
    ortPromise = null;
    throw err;
  });
  return ortPromise;
}

/** The models the app knows about: [{ name, purpose, license, size, ready }]. */
export function aiModelList() {
  listPromise ??= fetch('/api/ai/models', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((d) => d.models ?? [])
    .catch(() => []);
  return listPromise;
}

/** Whether a model is listed (it may still need its one-time download). Never throws. */
export async function aiAvailable(name) {
  if (typeof WebAssembly !== 'object') return false;
  return (await aiModelList()).some((m) => m.name === name);
}

/**
 * An inference session for a model (downloaded on first use, then cached by the browser and the
 * server). Resolves to null when it can't be had, so the caller falls back.
 */
export function aiSession(name) {
  if (!sessions.has(name)) {
    sessions.set(name, (async () => {
      if (!(await aiAvailable(name))) return null;
      const res = await fetch(`/api/ai/models/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`AI model ${name}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { ort, providers } = await loadOrt();
      return ort.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: 'all' });
    })().catch((err) => {
      console.warn(`AI model ${name} unavailable, using the classic method:`, err?.message ?? err);
      sessions.delete(name); // try again next time (e.g. after coming back online)
      return null;
    }));
  }
  return sessions.get(name);
}
