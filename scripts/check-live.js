// Checks the real online sources with the three reference cards:
//   npm run check:live
// Prints what each source returned, so you can see which ones are reachable from this computer.

import { CardCatalog } from '../server/catalog.js';
import { normalizeCard, PriceTrackerClient, tcgplayerImages } from '../server/priceTracker.js';
import { TcgCsvClient, USER_AGENT } from '../server/prices.js';
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

// tcgcsv.com access: which requests it accepts (it answered 401 to plain requests).
console.log('\ntcgcsv.com access');
for (const [label, headers] of [['as this app', { 'User-Agent': USER_AGENT }], ['with no app name', {}]]) {
  for (const path of ['/groups', '/24451/products']) {
    try {
      const res = await fetch(`https://tcgcsv.com/tcgplayer/3${path}`, { headers, signal: AbortSignal.timeout(15000) });
      (res.ok ? ok : fail)(`${path} ${label}`, `HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`);
    } catch (err) {
      fail(`${path} ${label}`, err.cause ?? err);
    }
  }
}

// Promos have no picture on TCGdex or in the dataset: TCGplayer's product picture is used instead.
console.log('\nFroakie MEP 060 (promo)');
try {
  const urls = await catalog.fallbackImages({ tcg_id: 'mep-060', set_id: 'mep', set_code: 'MEP', set_name: 'MEP Black Star Promos', number: '060', name: 'Froakie' });
  let found = false;
  for (const url of urls) {
    const img = await catalog.download(url).catch(() => null);
    if (img && /^image\//.test(img.contentType)) {
      ok('Promo picture', `${url} (${img.buffer.length} bytes, ${img.contentType})`);
      found = true;
      break;
    }
    fail('Promo picture', `${url} not downloadable`);
  }
  if (!found) fail('Promo picture', 'no source had it');
  const price = await tcgcsv.price({ setCode: 'MEP', number: '060', name: 'Froakie', variant: 'promo' });
  price ? ok('Promo price', money(price)) : fail('Promo price', 'no match');
} catch (err) {
  fail('Promo', err.cause ?? err);
}

// TCGplayer's picture straight from its image server, by product number (Froakie MEP 060 is 709974).
console.log('\nTCGplayer picture server');
for (const url of tcgplayerImages('709974')) {
  const img = await catalog.download(url).catch((err) => ({ error: err.cause ?? err }));
  if (img?.buffer && /^image\//.test(img.contentType)) ok('Froakie by product number', `${url} (${img.buffer.length} bytes, ${img.contentType})`);
  else fail('Froakie by product number', `${url} ${img?.error?.message ?? 'not downloadable'}`);
}

// With a PokemonPriceTracker key: the route the app uses when no other source has a picture.
console.log('\nPokemonPriceTracker picture lookup');
if (!process.env.POKEMONPRICETRACKER_API_KEY) {
  fail('PokemonPriceTracker', 'no POKEMONPRICETRACKER_API_KEY set in this window (skipped)');
} else {
  try {
    const { cards, credits } = await new PriceTrackerClient().cards({ search: 'Froakie', limit: 10 });
    const promo = cards.map((c) => normalizeCard(c)).find((c) => /promo/i.test(c.setName ?? '') && /(^|\D)0*60$/.test(String(c.number ?? '').split('/')[0]));
    if (!promo) fail('Froakie promo', `not among ${cards.length} results (${credits} credits used)`);
    else ok('Froakie promo', `TCGplayer ${promo.tcgPlayerId}, "${promo.setName}" ${promo.number}, pictures: ${promo.images.join(' ') || 'none listed'} (${credits} credits used)`);
  } catch (err) {
    fail('PokemonPriceTracker', err.cause ?? err);
  }
}

console.log('\nExchange rate');
try {
  const rate = await catalog.fx.usdRate('EUR');
  rate?.live ? ok('Euro → dollar rate', `1 EUR = ${rate.rate} USD (${rate.date})`) : fail('Euro → dollar rate', `service unreachable, using the fallback ${rate?.rate}`);
} catch (err) {
  fail('Euro → dollar rate', err.cause ?? err);
}
