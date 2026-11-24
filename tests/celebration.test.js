// The 30th Celebration (printed code 30C) and its Classic Collection: two sets under one code. The
// Classic cards print the numbers of the sets they first came from ("58/102"), while TCGdex numbers
// them 001–030 and the Pokémon TCG dataset keeps the originals with no printed total.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { codeFromSetId, isRenumbered, setFromCode, setIdsForCode } from '../server/setCodes.js';
import { findSetCode, identifyCard } from '../server/identify.js';
import { PtcgDataClient } from '../server/ptcgData.js';

describe('30C: two sets under one code', () => {
  test('the code stands for both sets, and each set gives the code back', () => {
    assert.deepEqual(setIdsForCode('30c'), ['30th', '30th-c']);
    assert.equal(codeFromSetId('30th-c'), '30C');
    assert.equal(codeFromSetId('me06'), 'DLR', 'Delta Reign is known too');
    assert.equal(isRenumbered('30th-c'), true);
    assert.equal(isRenumbered('30th'), false);
    assert.equal(setFromCode('30C').tcgplayer, 24722);
    assert.equal(setFromCode('30C', '30th Classic Collection').tcgplayer, 24837, 'Classic prices come from its own TCGplayer group');
  });

  test('a code starting with digits is read through letter look-alikes', () => {
    assert.equal(findSetCode(['3OC 049/128', '30C 049/128']), '30C');
    assert.equal(findSetCode(['SOC 049/128', 'BOC 049/128', '3OC']), '30C');
  });
});

describe('30C cards are identified', () => {
  const card = (tcgId, name, number, setId, setCode, setTotal, setName) => ({ tcgId, name, number, setId, setCode, setTotal, setName });
  const CARDS = [
    card('30th-049', 'Pikachu', '049', '30th', '30C', '128', '30th Celebration'),
    card('30th-058', 'Mewtwo', '058', '30th', '30C', '128', '30th Celebration'),
    card('30th-c-014', 'Pikachu', '014', '30th-c', '30C', '030', '30th Classic Collection'),
    card('base1-58', 'Pikachu', '58', 'base1', null, '102', 'Base'),
  ];
  // A catalog that searches like TcgClient: renumbered sets only by name.
  const catalog = {
    search: async ({ name, setCode, number }) => {
      const [n] = String(number ?? '').split('/');
      const ids = setCode ? setIdsForCode(setCode) : null;
      return CARDS.filter((c) => (!ids || ids.includes(c.setId))
        && (!name || c.name.toLowerCase().includes(name.toLowerCase()))
        && (!n || (isRenumbered(c.setId) ? Boolean(name) : Number(c.number) === Number(n))));
    },
  };

  test('a Classic Collection card ("58/102" under 30C) is the Classic printing, not Base Set', async () => {
    const r = await identifyCard(catalog, { names: ['Pikachu'], lines: ['30C 58/102', '3OC 58/102'] });
    assert.equal(r.match?.tcgId, '30th-c-014');
    assert.ok(r.candidates.some((c) => c.tcgId === 'base1-58'), 'the original stays a candidate');
  });

  test('a main-set card still matches by its number', async () => {
    const r = await identifyCard(catalog, { names: ['Pikachu'], lines: ['30C 049/128'] });
    assert.equal(r.match?.tcgId, '30th-049');
  });
});

describe('the Pokémon TCG dataset: Classic Collection', () => {
  const SETS = [
    { id: 'me55', name: '30th Celebration', series: 'Mega Evolution', ptcgoCode: '30C', printedTotal: 128, releaseDate: '2026/09/16' },
    { id: 'me55c', name: '30th Celebration: Classic Collection', series: 'Mega Evolution', ptcgoCode: '30C', releaseDate: '2026/09/16' },
  ];
  const CARDS = { me55: [{ id: 'me55-49', name: 'Pikachu', number: '49' }], me55c: [{ id: 'me55c-58', name: 'Pikachu', number: '58' }] };
  const fetchImpl = async (url) => {
    const body = url.endsWith('/sets/en.json') ? SETS : CARDS[url.match(/cards\/en\/(.+)\.json$/)?.[1]] ?? null;
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const ptcg = new PtcgDataClient({ baseUrl: 'http://dataset.test', fetchImpl });

  test('a total that isn\'t the main set\'s finds the Classic set; its numbers aren\'t padded', async () => {
    assert.deepEqual((await ptcg.findSets({ setCode: '30C', total: '102' })).map((s) => s.id), ['me55c']);
    assert.deepEqual((await ptcg.findSets({ setCode: '30C', total: '128' })).map((s) => s.id), ['me55']);
    const [hit] = await ptcg.search({ setCode: '30C', number: '58/102' });
    assert.deepEqual([hit?.tcgId, hit?.number], ['ptcg:me55c-58', '58']);
  });
});
