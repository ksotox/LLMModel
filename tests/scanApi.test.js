import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

test('scan retries are idempotent, printing details round-trip, and special printing prices stay blank', async () => {
  const mock = await startMockSources();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-api-'));
  const app = createApp({ dataDir: dir, catalog: mockCatalog(mock), requireLogin: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const add = async (cards) => { const form = new FormData(); form.append('cards', JSON.stringify(cards)); const res = await fetch(`${base}/api/cards`, { method: 'POST', body: form }); return { status: res.status, data: await res.json() }; };
  try {
    const card = { tcg_id: 'sv02-066', name: 'Voltorb', variant: 'reverse-holo', foil_pattern: 'master-ball', texture: 'smooth', stamp: 'staff', edition: 'first-edition', scan_token: '0123456789abcdef-0' };
    const first = await add([card]); assert.equal(first.status, 201);
    const again = await add([card]); assert.equal(again.data.cards[0].id, first.data.cards[0].id);
    const saved = first.data.cards[0]; assert.equal(saved.foil_pattern, 'master-ball'); assert.equal(saved.market_price, null);
    const different = await add([{ ...card, scan_token: '0123456789abcdef-1', foil_pattern: 'standard' }]);
    assert.notEqual(different.data.cards[0].id, saved.id);
    assert.equal((await add([{ ...card, foil_pattern: 'invented' }])).status, 400);
    assert.equal((await add([card, card])).status, 400);
    const image = await fetch(`${base}/api/catalog/cards/sv02-066/scan-image`);
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    const changed = await fetch(`${base}/api/cards/${saved.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scan_token: 'another0123456789' }) });
    assert.equal(changed.status, 400);
  } finally { await new Promise((r) => server.close(r)); app.locals.store.close(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
