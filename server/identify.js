// Turns what OCR read off a card photo into the actual card. OCR on small print is noisy, so the
// client sends several readings of each area; this module votes on the set code and number, then
// checks candidates against the card database and ranks them by how close their name is.

import { SET_CODES, hasJapanese, isJapaneseCode, sameNumber } from './setCodes.js';

const DIGIT_TO_LETTER = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B' };

export function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Latin letters without accents, plus Japanese (kana, kanji, the long-vowel mark), for comparing names.
const letters = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\u00c0-\u024f]/g, (c) => c.normalize('NFD')[0])
  .replace(/[^a-z\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]/gu, '');

/** 0..1: how alike two card names are, ignoring case, accents and punctuation. */
export function nameSimilarity(a, b) {
  const x = letters(a);
  const y = letters(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ratio = 1 - editDistance(x, y) / Math.max(x.length, y.length);
  // OCR often loses the first letter or adds noise around the name: reward a long shared run.
  const contained = x.length >= 4 && y.includes(x) ? x.length / y.length : y.length >= 4 && x.includes(y) ? y.length / x.length : 0;
  return Math.max(ratio, contained * 0.95);
}

function knownSets() {
  return Object.entries(SET_CODES).map(([code, s]) => ({ code, total: s.total ?? null }));
}

/** Vote for the set code across all readings of the bottom-left line. */
export function findSetCode(texts) {
  const votes = new Map();
  for (const text of texts) {
    const tokens = String(text ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 2 && t !== 'EN');
    for (const { code } of knownSets()) {
      let best = 0;
      for (const t of tokens) {
        const asLetters = t.replace(/\d/g, (d) => DIGIT_TO_LETTER[d] ?? d);
        if (t === code || asLetters === code) best = Math.max(best, 3);
        else if (t.length >= 4 && (t.includes(code) || asLetters.includes(code))) best = Math.max(best, 2);
        else if (t.length >= 2 && t.length <= 4 && Math.min(editDistance(t, code), editDistance(asLetters, code)) <= 1 && code.length === 3) best = Math.max(best, 1);
      }
      if (best) votes.set(code, (votes.get(code) ?? 0) + best);
    }
  }
  const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  return winner && winner[1] >= 2 ? winner[0] : null;
}

/** Vote for a Japanese set code ("SV2a", "SV4a", "M1L", "SV-P") across readings of the bottom-left line. */
export function findJapaneseSetCode(texts) {
  const votes = new Map();
  for (const text of texts) {
    for (const raw of String(text ?? '').toUpperCase().split(/[^A-Z0-9-]+/)) {
      // OCR often reads the S of "SV" as a 5.
      const t = raw.replace(/^5(?=V?\d)/, 'S').replace(/^-+|-+$/g, '');
      if (t.length >= 2 && isJapaneseCode(t) && !/^S\d{3,}$/.test(t)) votes.set(t, (votes.get(t) ?? 0) + 1);
    }
  }
  const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return winner?.[0] ?? null;
}

/**
 * Vote for the card number (and printed set total) across readings: "066/193", "0667193" (slash
 * read as 7), or a lone "060" on promos.
 */
export function findNumber(texts, setCode) {
  const known = setCode && SET_CODES[setCode]?.total ? [SET_CODES[setCode].total] : [...new Set(knownSets().map((s) => s.total).filter(Boolean))];
  const votes = new Map();
  const vote = (n, t, score) => {
    const key = `${String(Number(n)).padStart(3, '0')}/${t ?? ''}`;
    votes.set(key, (votes.get(key) ?? 0) + score);
  };
  for (const text of texts) {
    const up = String(text ?? '').toUpperCase();
    for (const m of up.matchAll(/(\d{1,3})\s*\/\s*(\d{2,3})/g)) {
      // A clipped number ("06/193") is less trustworthy than a full one ("066/193").
      const lengthBonus = m[1].length >= m[2].length ? 0.5 : -1;
      const t = Number(m[2]);
      if (known.includes(t)) {
        vote(m[1], String(t).padStart(3, '0'), 3 + lengthBonus);
        continue;
      }
      // One digit misread in the total ("066/793"): snap to the known total it's closest to.
      const near = known.find((k) => String(k).padStart(3, '0').length === m[2].length && editDistance(String(k).padStart(3, '0'), m[2]) === 1);
      vote(m[1], near ? String(near).padStart(3, '0') : m[2], (near ? 2 : 1) + lengthBonus);
    }
    if (/\//.test(up)) continue;
    // No slash read: look for a known set total in a run of digits ("06671930" → 066 / 193).
    for (const run of up.match(/\d{5,}/g) ?? []) {
      for (const total of known) {
        const t = String(total).padStart(3, '0');
        const at = run.indexOf(t, 2);
        if (at < 0) continue;
        const before = run.slice(0, at);
        const n = before.length === 4 && /[71]$/.test(before) ? before.slice(0, 3) : before.length <= 3 ? before : null;
        if (n) vote(n, t, 2);
      }
    }
    // A lone number is how promos are printed ("060"); OCR sometimes drops its leading zero.
    for (const m of up.matchAll(/(?:^|[^\d/])(\d{2,3})(?![\d/])/g)) vote(m[1], null, m[1].length === 3 ? 1 : 0.5);
  }
  const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (!winner) return { number: null, total: null };
  const [number, total] = winner[0].split('/');
  return { number, total: total || null };
}

const LABELS = /^(basic|stage\d?|stagei+|trainer|item|supporter|stadium|tool|pokemon|pokémon|energy|special|evolves|from|hp)$/i;

/** Name guesses from the OCR readings of the name strip: whole cleaned lines plus long fragments. */
export function nameCandidates(texts) {
  const out = [];
  const add = (s) => {
    const v = s.trim();
    if (letters(v).length >= 4 && !out.some((o) => letters(o) === letters(v))) out.push(v);
  };
  for (const text of texts) {
    // Japanese names: runs of kana / kanji (ピカチュウ, ビリリダマ, ミュウ).
    for (const run of String(text ?? '').normalize('NFKC').match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]{2,}/gu) ?? []) {
      if (!out.includes(run)) out.push(run);
    }
    const words = String(text ?? '').replace(/[^A-Za-zÀ-ÿ'’.\- ]+/g, ' ').split(/\s+/)
      .map((w) => w.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ.]+$/g, ''))
      .filter((w) => w && !LABELS.test(w));
    const proper = words.filter((w) => w.length >= 3 || /^(ex|V|X|Y|GX)$/i.test(w));
    if (proper.length) add(proper.join(' '));
    for (const w of proper) if (w.length >= 4) add(w);
  }
  // Misread first letters ("ahroakie" for "Froakie") are common: also try without one or two of them.
  for (const c of [...out]) {
    if (c.includes(' ') || c.length < 6) continue;
    add(c.slice(1));
    if (c.length >= 7) add(c.slice(2));
  }
  return out.slice(0, 8);
}

/** Whether two card numbers differ in exactly one digit ("065" vs "066"), as a misread would. */
export function nearNumber(a, b) {
  const x = String(a ?? '').replace(/^\D+/, '');
  const y = String(b ?? '').replace(/^\D+/, '');
  if (!x || !y || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return false;
  const [p, q] = [x.padStart(3, '0'), y.padStart(3, '0')];
  if (p.length !== q.length) return false;
  let diff = 0;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) diff++;
  return diff === 1;
}

/**
 * Identify a card from OCR readings: { names: [...], lines: [...] }.
 * Returns { match, candidates, read, confidence } where confidence is 'high', 'medium' or 'low'.
 */
export async function identifyCard(catalog, { names = [], lines = [] }) {
  // A Japanese code ("SV2a": letters + digits) is unmistakable, so it wins over an English code
  // guessed from a fragment (a lone "SV" read off the corner can look like "SVI").
  const setCode = findJapaneseSetCode(lines) ?? findSetCode(lines);
  const { number, total } = findNumber(lines, setCode);
  const guesses = nameCandidates(names);
  const read = { name: guesses.find((g) => hasJapanese(g)) ?? guesses[0] ?? null, setCode, number, total };

  // A Japanese code means a Japanese card: search only Japanese (the English 151 is also /165).
  const japaneseCode = isJapaneseCode(setCode);
  const attempts = [];
  if (setCode && number) attempts.push({ setCode, number: total ? `${number}/${total}` : number });
  if (number && total && !japaneseCode) attempts.push({ number: `${number}/${total}` });
  for (const name of guesses.filter((g) => !japaneseCode || hasJapanese(g)).slice(0, 5)) {
    attempts.push({ name, ...(number ? { number } : {}) });
    // The number may be misread: also look for the name within the set, or (no set code read)
    // among all its printings, where the set total still tells them apart.
    if (setCode) attempts.push({ name, setCode });
    else if (number || total) attempts.push({ name });
  }

  const found = new Map();
  for (const query of attempts) {
    let results = [];
    try {
      results = await catalog.search(query);
    } catch {
      continue;
    }
    for (const r of results.slice(0, 30)) if (!found.has(r.tcgId)) found.set(r.tcgId, r);
    // A precise set + number hit that agrees with the name needs no more searching.
    if (query.setCode && results.length === 1 && (!guesses.length || guesses.some((g) => nameSimilarity(g, results[0].name) > 0.5))) break;
    if (found.size >= 30) break;
  }

  const scored = [...found.values()].map((card) => {
    // Compare names in the same script: a Japanese card against what was read in Japanese. Latin
    // OCR of a Japanese name is noise, so with no Japanese reading there is no name evidence.
    const japanese = hasJapanese(card.name);
    const sameScript = guesses.filter((g) => hasJapanese(g) === japanese);
    const sim = sameScript.length ? Math.max(...sameScript.map((g) => nameSimilarity(g, card.name))) : null;
    const numberOk = Boolean(number && sameNumber(card.number, number));
    // One digit misread (6 read as 5, 3 as 8…) in an otherwise matching set: a hint, never enough
    // on its own for an automatic match (only exact numbers give 'high').
    const numberNear = !numberOk && nearNumber(card.number, number);
    const setOk = Boolean(setCode && String(card.setCode ?? '').toUpperCase() === setCode.toUpperCase());
    const totalOk = Boolean(total && card.setTotal && Number(card.setTotal) === Number(total));
    const score = (sim ?? 0) * 4 + (numberOk ? 2 : numberNear && (setOk || totalOk) ? 1 : 0) + (setOk ? 1.5 : 0) + (totalOk ? 1 : 0);
    return { card, score, sim, numberOk, setOk, totalOk, japanese };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return { match: null, candidates: [], read, confidence: 'low' };
  const runnerUp = scored[1];
  const clearWinner = !runnerUp || best.score - runnerUp.score >= 1;
  // The name is the best cross-check: a name that clearly disagrees blocks an automatic match.
  const nameAgrees = best.sim == null || best.sim >= 0.6;
  let confidence = 'low';
  // Without a name to check, a Japanese card needs its code, number and set total to all agree.
  const japaneseUnchecked = best.japanese && best.sim == null && !(best.setOk && best.totalOk);
  if (clearWinner && nameAgrees && best.numberOk && !japaneseUnchecked && (best.setOk || best.totalOk || (best.sim ?? 0) >= 0.75)) confidence = 'high';
  else if (clearWinner && (best.sim ?? 0) >= 0.8 && (best.setOk || best.totalOk || best.numberOk)) confidence = 'medium';
  else if (clearWinner && best.sim == null && best.numberOk && best.setOk) confidence = 'medium';
  return {
    match: confidence === 'low' ? null : best.card,
    candidates: scored.slice(0, 12).map((s) => s.card),
    read,
    confidence,
  };
}
