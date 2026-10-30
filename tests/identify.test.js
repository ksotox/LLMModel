import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { findNumber, findSetCode, identifyCard, nameCandidates, nameSimilarity } from '../server/identify.js';
import { mockCatalog, startMockSources } from './helpers/mock-sources.js';

// These are the real OCR readings the in-browser reader produced for the reference photos.
const READINGS = {
  voltorbRow: {
    names: ['=Voltorb', '<“Voltorb', '“Voltorb'],
    lines: ['4 8 PAL 066/193', '8 PAL 066/193', '8 PA 066/193', 'PA', 'A PA'],
  },
  punkHelmet: {
    names: ['4 me FECES 7) =', '2K _ 2 2 eimmenniaiz) ay', '| Punk Helmet'],
    lines: ['LLY 092/094 NN', 'CLUE 092/094 NES', 'LL 092/094 EIR', 'LL', 'LEE'],
  },
  linoone: {
    names: ['&’Linoone : p.', '& Linoone . ps', 'CLinodna'],
    lines: ['E CISL 168/197 5', 'GIR 168/197', 'CC 168/197'],
  },
  voltorbCloseUp: {
    names: ['<~Voltorb :', '<~Voltorb |', '“"Voltorb'],
    lines: ['WE 06671930 BO', 'MEAPAL 06677930 BT', 'EPAL 0667193 0', 'OM', 'MGA PAL'],
  },
  // A second, worse reading of the same close-up: "06/ 1930" and "066/793" are both misreads.
  voltorbCloseUpNoisy: {
    names: ['<“Voltorb', '=~ Voltorb |', '“"Voltorb'],
    lines: ['WE P06/ 1930 B00', 'ME PAL 066/793 0 BT', 'CUD EK', 'MGAPAL G', 'RA'],
  },
  froakiePromo: {
    names: ['o ro: oakie CESAR 7', 'sEroakie C45'],
    lines: ['UIE 060 WE', 'UIE 60 ASE', 'I VILL 060 ATT', 'VIL A', 'UIE A'],
  },
  // The same promo read in the app: the leading zero and the first letters are lost.
  froakiePromoHard: {
    names: ['ahroakie CE)', 'ghroakic (SCR /', 'VD er A®)8, OE'],
    lines: ['UIE 60 AE', 'UE 60 WS', 'BR VIELE 0 ATT', 'IEE A', 'UL A'],
  },
};

describe('reading the set code and number', () => {
  test('finds the set code even when OCR merges or clips it', () => {
    assert.equal(findSetCode(READINGS.voltorbRow.lines), 'PAL');
    assert.equal(findSetCode(READINGS.voltorbCloseUp.lines), 'PAL', '"MEAPAL", "EPAL" and "MGA PAL"');
    assert.equal(findSetCode(['PFL EN 092/094']), 'PFL');
    assert.equal(findSetCode(['0BF 168/197']), 'OBF', 'zero read instead of O');
    assert.equal(findSetCode(READINGS.linoone.lines), null, 'no guessing from noise');
  });

  test('finds the number and set total', () => {
    assert.deepEqual(findNumber(READINGS.voltorbRow.lines, 'PAL'), { number: '066', total: '193' });
    assert.deepEqual(findNumber(READINGS.punkHelmet.lines, null), { number: '092', total: '094' });
    assert.deepEqual(findNumber(READINGS.linoone.lines, null), { number: '168', total: '197' });
  });

  test('recovers a slash misread as 7', () => {
    assert.deepEqual(findNumber(READINGS.voltorbCloseUp.lines, 'PAL'), { number: '066', total: '193' });
  });

  test('prefers a full number and snaps a misread total to the set’s real one', () => {
    assert.deepEqual(findNumber(READINGS.voltorbCloseUpNoisy.lines, 'PAL'), { number: '066', total: '193' });
  });

  test('promos have a number but no total', () => {
    assert.deepEqual(findNumber(READINGS.froakiePromo.lines, null), { number: '060', total: null });
  });
});

describe('reading the name', () => {
  test('cleans labels and noise', () => {
    assert.equal(nameCandidates(READINGS.voltorbRow.names)[0], 'Voltorb');
    assert.ok(nameCandidates(READINGS.punkHelmet.names).includes('Punk Helmet'));
    assert.ok(nameCandidates(['BASIC Froakie']).includes('Froakie'));
  });

  test('fuzzy name matching tolerates OCR slips', () => {
    assert.ok(nameSimilarity('Linodna', 'Linoone') > 0.6);
    assert.ok(nameSimilarity('oakie', 'Froakie') > 0.6);
    assert.ok(nameSimilarity('Voltorb', 'Electrode') < 0.3);
  });
});

describe('identifying the card', () => {
  let mock;
  let catalog;
  before(async () => {
    mock = await startMockSources();
    catalog = mockCatalog(mock);
  });
  after(() => mock.close());

  test('each reference card is identified from its real OCR readings', async () => {
    const expect = {
      voltorbRow: 'sv02-066',
      punkHelmet: 'me02-092',
      linoone: 'sv03-168',
      voltorbCloseUp: 'sv02-066',
      voltorbCloseUpNoisy: 'sv02-066',
      froakiePromo: 'mep-060',
      froakiePromoHard: 'mep-060',
    };
    for (const [key, id] of Object.entries(expect)) {
      const result = await identifyCard(catalog, READINGS[key]);
      assert.equal(result.match?.tcgId, id, `${key}: ${JSON.stringify(result.read)} → ${result.candidates.map((c) => c.tcgId)}`);
      assert.notEqual(result.confidence, 'low', key);
    }
  });

  test('a number that points at a different card does not win against the name', async () => {
    // Set + number say Heracross (PAL 006), but the name clearly says Voltorb.
    const result = await identifyCard(catalog, { names: ['Voltorb'], lines: ['PAL 006/193'] });
    assert.equal(result.match?.name, 'Voltorb');
    assert.notEqual(result.match?.tcgId, 'ptcg:sv2-6');
  });

  test('gives up rather than guessing when nothing useful was read', async () => {
    const result = await identifyCard(catalog, { names: ['~~ ::'], lines: ['A B'] });
    assert.equal(result.match, null);
    assert.equal(result.confidence, 'low');
  });
});
