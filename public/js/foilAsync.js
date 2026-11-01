// The foil measurements of foil.js, run in a Web Worker when the browser can (falls back to the
// main thread otherwise, e.g. where module workers aren't supported).
import { analyseCard, compareAngles } from './foil.js';

let worker = null;
let broken = false;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (broken) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./foilWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: { id, result, error } }) => {
        const p = waiting.get(id);
        waiting.delete(id);
        if (p) (error ? p.reject(new Error(error)) : p.resolve(result));
      };
      worker.onerror = () => {
        // The worker couldn't start: answer what's waiting on the main thread from now on.
        broken = true;
        worker = null;
        for (const p of waiting.values()) p.fallback();
        waiting.clear();
      };
    } catch {
      broken = true;
      return null;
    }
  }
  return worker;
}

function run(op, payload, local) {
  const w = getWorker();
  if (!w) return Promise.resolve().then(local);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, fallback: () => { try { resolve(local()); } catch (err) { reject(err); } } });
    w.postMessage({ id, op, ...payload });
  });
}

/** analyseCard(), in the worker. */
export const analyseCardAsync = (image) => run('analyse', { image }, () => analyseCard(image));

/** compareAngles(), in the worker. */
export const compareAnglesAsync = (images) => run('compare', { images }, () => compareAngles(images));
