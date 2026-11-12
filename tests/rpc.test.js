// The worker helper (public/js/workers/rpc.js), over a MessageChannel standing in for a Worker.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect, serve, transfer } from '../public/js/workers/rpc.js';

const pair = (handlers) => {
  const { port1, port2 } = new MessageChannel();
  const stop = serve(handlers, port2);
  const client = connect(port1);
  return { client, done: () => { client.close(); stop(); port2.close(); } };
};

describe('worker calls', () => {
  test('a call returns the handler’s result; calls overlap and each gets its own answer', async () => {
    const { client, done } = pair({
      add: ({ a, b }) => a + b,
      slow: async (ms) => { await new Promise((r) => setTimeout(r, ms)); return ms; },
    });
    const [slow, fast] = await Promise.all([client.call('slow', 40), client.call('slow', 5)]);
    assert.deepEqual([slow, fast], [40, 5]);
    assert.equal(await client.call('add', { a: 2, b: 3 }), 5);
    done();
  });

  test('errors in the worker reach the caller with their message; unknown calls are refused', async () => {
    const { client, done } = pair({ fail: () => { throw new TypeError('no card here'); } });
    await assert.rejects(client.call('fail'), (err) => err.message === 'no card here' && err.name === 'TypeError');
    await assert.rejects(client.call('nope'), /Unknown worker call “nope”/);
    await assert.rejects(client.call('toString'), /Unknown worker call/, 'only the handlers’ own methods');
    done();
  });

  test('buffers can be moved both ways instead of copied', async () => {
    const { client, done } = pair({ double: ({ buf }) => { const a = new Uint8Array(buf).map((v) => v * 2); return transfer({ buf: a.buffer }, [a.buffer]); } });
    const src = new Uint8Array([1, 2, 3]);
    const { buf } = await client.call('double', { buf: src.buffer }, { transfer: [src.buffer] });
    assert.equal(src.byteLength, 0, 'the input buffer moved to the worker');
    assert.deepEqual([...new Uint8Array(buf)], [2, 4, 6]);
    done();
  });

  test('progress is reported while a call runs', async () => {
    const { client, done } = pair({ steps: async (n, { progress }) => { for (let i = 1; i <= n; i++) progress(i / n); return 'ok'; } });
    const seen = [];
    assert.equal(await client.call('steps', 4, { onProgress: (p) => seen.push(p) }), 'ok');
    assert.deepEqual(seen, [0.25, 0.5, 0.75, 1]);
    done();
  });

  test('a timeout or an abort rejects the call and cancels it in the worker', async () => {
    let cancelled = 0;
    const wait = (ms, { signal }) => new Promise((resolve) => {
      const t = setTimeout(() => resolve('finished'), ms);
      signal.addEventListener('abort', () => { clearTimeout(t); cancelled++; resolve('stopped'); });
    });
    const { client, done } = pair({ wait });
    await assert.rejects(client.call('wait', 1000, { timeout: 30 }), /took longer than/);
    const ac = new AbortController();
    const p = client.call('wait', 1000, { signal: ac.signal });
    ac.abort(new Error('user left'));
    await assert.rejects(p, /user left/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cancelled, 2, 'the worker stopped both');
    assert.equal(await client.call('wait', 1), 'finished', 'and still answers new calls');
    done();
  });

  test('closing rejects what is still pending', async () => {
    const { client, done } = pair({ never: () => new Promise(() => {}) });
    const p = client.call('never');
    done();
    await assert.rejects(p, /closed/);
  });
});
