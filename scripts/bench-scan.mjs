#!/usr/bin/env node
// npm run bench:scan — how well the card scanner finds and identifies cards.
//
// Runs the app's real pipeline (card finder, straightening, text reading, /api/identify against
// the test mock card sources) in headless Chromium over:
//   • the labelled reference photos (docs/reference, labels in tests/fixtures/scan/reference.json);
//   • a synthetic set: real card faces pasted onto made-up tables, rows, binder pages, with dim
//     light, glare, sleeves and blur (scripts/scan-bench/synth.js; the same every run);
//   • your own labelled photos, if data/scan-bench/labels.json exists (same format as reference.json,
//     file names relative to data/scan-bench/).
// Prints a table per group and the roadmap's targets, and saves the details as JSON in
// data/scan-bench/results/.
//
// Options: --quick (find cards only, don't read them), --strict (exit 1 when a target is missed),
//          --tolerance 0.02 (how close, as a fraction of a card's width, counts as found).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, labelledSets, startHarness } from './scan-bench/harness.mjs';
import { checkTargets, summarize } from './scan-bench/metrics.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const read = !flag('quick');
const tolerance = value('tolerance', 0.02);

const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const fmtErr = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

function table(summary) {
  const rows = [['group', 'photos', 'cards', 'found', 'precision', 'corner err', 'find time', 'longest task', 'read', 'correct', 'sure+wrong', 'read time']];
  const add = (name, s) => rows.push([name, s.photos, s.cards, fmtPct(s.recall), fmtPct(s.precision), fmtErr(s.cornerError), fmtMs(s.detectMs), fmtMs(s.longestTask),
    s.read, fmtPct(s.correct), s.confidentWrong, fmtMs(s.readMs)].map(String));
  for (const [g, s] of Object.entries(summary.groups)) add(g, s);
  add('ALL', summary.all);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')).join('\n');
}

const started = Date.now();
const harness = await startHarness();
try {
  const { reference, sets } = labelledSets();
  await harness.page.exposeFunction('benchProgress', (text) => process.stdout.write(`  ${text}\n`));
  console.log(`Scan benchmark (${read ? 'find + read' : 'find only'}, tolerance ${tolerance * 100}% of card width)…`);
  const results = await harness.page.evaluate(async (opts) => {
    const { runBench } = await import('/__bench/mod/run.js');
    return runBench({ ...opts, fileUrl: (f) => `/__bench/file/${f}`, progress: (t) => window.benchProgress(t) });
  }, { sets, reference, read, tolerance });

  const summary = summarize(results);
  const targets = checkTargets(summary);
  console.log(`\n${table(summary)}\n`);
  for (const t of targets) {
    const v = /ms/.test(t.target) ? fmtMs(t.value) : typeof t.value === 'number' && t.value <= 1 && !/= 0/.test(t.target) ? fmtPct(t.value) : String(t.value ?? '—');
    console.log(`${t.ok ? 'PASS' : 'MISS'}  ${t.target}  (now ${v})`);
  }
  const wrong = results.flatMap((r) => (r.reads ?? []).filter((x) => !x.correct).map((x) => `${r.name}: ${x.card} → ${x.got ?? 'not identified'} (${x.confidence})`));
  if (wrong.length) console.log(`\nNot identified correctly (${wrong.length}):\n  ${wrong.slice(0, 25).join('\n  ')}${wrong.length > 25 ? '\n  …' : ''}`);
  if (harness.errors.length) console.log(`\nBrowser errors: ${harness.errors.join(' | ')}`);

  const outDir = path.join(ROOT, 'data', 'scan-bench', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), read, tolerance, summary, targets, results }, null, 2));
  console.log(`\nDetails: ${path.relative(ROOT, file)} · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (flag('strict') && targets.some((t) => !t.ok)) process.exitCode = 1;
} finally {
  await harness.close();
}
