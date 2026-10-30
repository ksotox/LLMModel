import path from 'node:path';
import { createApp } from './app.js';
import { CardCatalog } from './catalog.js';
import { TcgCsvClient } from './prices.js';
import { PtcgDataClient } from './ptcgData.js';
import { createScheduler } from './scheduler.js';
import { TcgClient } from './tcg.js';

const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const catalog = new CardCatalog({
  tcgdex: new TcgClient({ baseUrl: process.env.TCGDEX_URL }),
  ptcg: new PtcgDataClient({ baseUrl: process.env.PTCG_DATA_URL }),
  tcgcsv: new TcgCsvClient({ baseUrl: process.env.TCGCSV_URL }),
});

const app = createApp({ dataDir, catalog });
app.listen(port, () => {
  console.log(`Pokédex collection running at http://localhost:${port}`);
  console.log(`Collection data is stored in ${dataDir}`);
  const { tracker } = app.locals;
  console.log(tracker.configured
    ? `PokemonPriceTracker: on (${tracker.dailyCredits} credits a day)`
    : 'PokemonPriceTracker: off (set POKEMONPRICETRACKER_API_KEY to add graded eBay sales)');
});

// Keep every card's price history growing while the app is running.
createScheduler({ store: app.locals.store, refreshCardMarket: app.locals.refreshCardMarket, tracker: app.locals.tracker }).start();
