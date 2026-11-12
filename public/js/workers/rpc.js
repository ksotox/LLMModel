// Calling into a Web Worker like an async library, so heavy work (finding cards, reading text,
// cutting out artwork) runs off the page's main thread and the page never freezes.
//
// Page:    const vision = connect(new Worker('/js/workers/vision.worker.js', { type: 'module' }));
//          const quads = await vision.call('detect', { bitmap }, { transfer: [bitmap], timeout: 30000 });
// Worker:  serve({ async detect({ bitmap }, { signal, progress }) { …; return transfer(result, [buffer]); } });
//
// Works with anything that has postMessage and message events: a Worker, the worker's own `self`,
// or a MessagePort (which is what the unit tests use).

const TRANSFER = Symbol('transfer');

/** Wrap a result so its buffers/bitmaps are moved to the other side instead of copied. */
export function transfer(value, list) {
  return { [TRANSFER]: list, value };
}

const listen = (port, fn) => {
  port.addEventListener('message', fn);
  port.start?.(); // MessagePorts only deliver once started
  return () => port.removeEventListener('message', fn);
};

const toError = (e) => Object.assign(new Error(e?.message ?? String(e)), { name: e?.name ?? 'Error', remoteStack: e?.stack });

/**
 * The page's side. Returns { call(method, args, { transfer, timeout, signal, onProgress }), close() }.
 * A call rejects when the worker throws, the timeout passes, the signal aborts, or the worker fails
 * to load; a timed-out or aborted call is also cancelled in the worker (its `signal` aborts).
 */
export function connect(port) {
  let nextId = 1;
  const pending = new Map();
  const finish = (id, fn) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.signal?.removeEventListener('abort', p.onAbort);
    fn(p);
  };
  const stop = listen(port, (e) => {
    const msg = e.data;
    if (!msg || typeof msg.id !== 'number') return;
    if ('progress' in msg) { pending.get(msg.id)?.onProgress?.(msg.progress); return; }
    finish(msg.id, (p) => (msg.ok ? p.resolve(msg.value) : p.reject(toError(msg.error))));
  });
  const failAll = (err) => { for (const id of [...pending.keys()]) finish(id, (p) => p.reject(err)); };
  const onError = (e) => failAll(new Error(`The background worker stopped: ${e?.message ?? 'it could not start'}`));
  port.addEventListener?.('error', onError);

  return {
    call(method, args, { transfer: list = [], timeout = 0, signal, onProgress } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason ?? new Error('Cancelled')); return; }
        const id = nextId++;
        const cancel = (err) => {
          port.postMessage({ id, cancel: true });
          finish(id, (p) => p.reject(err));
        };
        const entry = { resolve, reject, onProgress, signal };
        if (timeout > 0) entry.timer = setTimeout(() => cancel(new Error(`“${method}” took longer than ${Math.round(timeout / 1000)} s`)), timeout);
        if (signal) {
          entry.onAbort = () => cancel(signal.reason ?? new Error('Cancelled'));
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        pending.set(id, entry);
        port.postMessage({ id, method, args }, list);
      });
    },
    /** Reject what's pending, stop listening, and end the worker. */
    close() {
      failAll(new Error('The background worker was closed'));
      stop();
      port.removeEventListener?.('error', onError);
      port.terminate?.();
      port.close?.();
    },
  };
}

/**
 * The worker's side: answer calls with `handlers[method](args, { signal, progress })`. A handler may
 * return transfer(value, list) to move buffers back. Returns a function that stops serving.
 */
export function serve(handlers, port = globalThis) {
  const running = new Map();
  return listen(port, async (e) => {
    const msg = e.data;
    if (!msg || typeof msg.id !== 'number') return;
    if (msg.cancel) { running.get(msg.id)?.abort(new Error('Cancelled')); return; }
    const controller = new AbortController();
    running.set(msg.id, controller);
    try {
      const fn = Object.hasOwn(handlers, msg.method) ? handlers[msg.method] : null;
      if (typeof fn !== 'function') throw new Error(`Unknown worker call “${msg.method}”`);
      const out = await fn(msg.args, { signal: controller.signal, progress: (p) => port.postMessage({ id: msg.id, progress: p }) });
      if (controller.signal.aborted) return;
      if (out && typeof out === 'object' && TRANSFER in out) port.postMessage({ id: msg.id, ok: true, value: out.value }, out[TRANSFER]);
      else port.postMessage({ id: msg.id, ok: true, value: out });
    } catch (err) {
      if (!controller.signal.aborted) port.postMessage({ id: msg.id, ok: false, error: { name: err?.name, message: err?.message ?? String(err), stack: err?.stack } });
    } finally {
      running.delete(msg.id);
    }
  });
}
