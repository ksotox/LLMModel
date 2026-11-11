// Loading OpenCV.js (about 10 MB, served by this app from node_modules and cached by the browser
// after the first time), in the page or inside a Web Worker.
//
// Resolves to { cv }: OpenCV's module object is "thenable", so it is passed around wrapped.
// Resolving a promise with it directly (or returning it from an async function) would wait on it
// forever.

const URL_PATH = '/vendor/opencv/opencv.js';
let cvPromise = null;

const ready = (resolve, reject) => {
  const started = Date.now();
  const poll = () => {
    if (globalThis.cv?.Mat) return resolve({ cv: globalThis.cv });
    if (Date.now() - started > 60000) return reject(new Error('The image tools took too long to start'));
    setTimeout(poll, 50);
  };
  poll();
};

function loadInPage() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = URL_PATH;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the image tools'));
    script.onload = () => ready(resolve, reject);
    document.head.append(script);
  });
}

// A module worker can't use importScripts, so the script is fetched and run in the worker's global
// scope. Its UMD wrapper registers `cv` on the global object when it sees a worker.
async function loadInWorker() {
  const res = await fetch(new URL(URL_PATH, globalThis.location.origin));
  if (!res.ok) throw new Error('Could not load the image tools');
  const code = await res.text();
  if (typeof globalThis.importScripts !== 'function') globalThis.importScripts = () => { throw new Error('not available'); };
  (0, eval)(`${code}\n//# sourceURL=${URL_PATH}`); // eslint-disable-line no-eval
  return new Promise(ready);
}

export function loadOpenCV() {
  cvPromise ??= (typeof document === 'undefined' ? loadInWorker() : loadInPage()).catch((err) => {
    cvPromise = null;
    throw err;
  });
  return cvPromise;
}
