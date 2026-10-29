// Checks the real online sources with the three reference cards:
//   npm run check:live
// Prints what each source returned, so you can see which ones are reachable from this computer.

import { CardCatalog } from '../server/catalog.js';
import { TcgCsvClient } from '../server/prices.js';
import { PtcgDataClient } from '../server/ptcgData.js';
import { pullChance } from '../server/pullRates.js';
import { TcgClient } from '../server/tcg.js';

const CARDS = [
  { name: 'Voltorb', setCode: 'PAL', number: '066/193', variant: 'reverse-holo' },
  { name: 'Punk Helmet', setCode: 'PFL', number: '092/094', variant: 'normal' },
  { name: 'Linoone', setCode: 'OBF', number: '168/197', variant: 'normal' },
];

const tcgdex = new TcgClient();
const ptcg = new PtcgDataClient();
const tcgcsv = new TcgCsvClient();
const catalog = new CardCatalog({ tcgdex, ptcg, tcgcsv });

const ok = (label, value) => console.log(`  ✓ ${label}: ${value}`);
const fail = (label, err) => console.log(`  ✗ ${label}: ${err?.message ?? err}`);
const money = (p) => (p ? `${p.currency === 'EUR' ? '€' : '$'}${p.value.toFixed(2)} — ${p.source}` : 'no price');

for (const q of CARDS) {
  console.log(`\n${q.name} ${q.setCode} ${q.number} (${q.variant})`);

  let tcgdexHit = null;
  try {
    [tcgdexHit] = await tcgdex.search(q);
    tcgdexHit ? ok('TCGdex lookup', `${tcgdexHit.tcgId} ${tcgdexHit.image}`) : fail('TCGdex lookup', 'no match');
  } catch (err) {
    fail('TCGdex lookup', err.cause ?? err);
  }

  try {
    const [hit] = await ptcg.search(q);
    hit ? ok('Pokémon TCG data lookup', `${hit.tcgId} ${hit.rarity} ${hit.image}`) : fail('Pokémon TCG data lookup', 'no match');
    const profile = await ptcg.rarityProfile({ setCode: q.setCode });
    const pull = pullChance({ rarity: hit?.rarity, variant: q.variant, profile });
    pull ? ok('Pull chance', `${(pull.chance * 100).toFixed(2)}% (1 in ${pull.oneIn} packs) — ${pull.source}`) : fail('Pull chance', 'not available');
  } catch (err) {
    fail('Pokémon TCG data', err.cause ?? err);
  }

  if (tcgdexHit) {
    try {
      const details = await catalog.details(tcgdexHit.tcgId);
      const market = await catalog.market({ ...details, variant: q.variant });
      ok('Price', money(market.price));
    } catch (err) {
      fail('Price', err.cause ?? err);
    }
  }

  try {
    const price = await tcgcsv.price({ setName: tcgdexHit?.setName, setCode: q.setCode, number: q.number, name: q.name, variant: q.variant });
    price ? ok('tcgcsv backup price', money(price)) : fail('tcgcsv backup price', 'no match');
  } catch (err) {
    fail('tcgcsv backup price', err.cause ?? err);
  }

  if (tcgdexHit?.image) {
    try {
      const img = await catalog.download(tcgdexHit.image);
      img ? ok('Official image download', `${img.buffer.length} bytes, ${img.contentType}`) : fail('Official image download', 'not found');
    } catch (err) {
      fail('Official image download', err.cause ?? err);
    }
  }
}
