// MEMORY.md is the handoff file for the next agent. It must stay short enough to read in one go,
// so it's capped here; finished details belong in docs/HISTORY.md instead.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const MAX_LINES = 150;
const MAX_BYTES = 10 * 1024;

test('MEMORY.md stays within its size budget', async () => {
  // Count it as stored in git: a Windows checkout turns every \n into \r\n, one byte more per line.
  const text = (await readFile(new URL('../MEMORY.md', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const lines = text.split('\n').length;
  const bytes = Buffer.byteLength(text);
  assert.ok(lines <= MAX_LINES, `MEMORY.md has ${lines} lines (max ${MAX_LINES}). Move finished details to docs/HISTORY.md.`);
  assert.ok(bytes <= MAX_BYTES, `MEMORY.md is ${bytes} bytes (max ${MAX_BYTES}). Move finished details to docs/HISTORY.md.`);
});
