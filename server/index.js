import { spawn } from 'node:child_process';
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

// `--open` (used by the "Start Pokedex" launcher) opens the app in the default browser.
const openBrowser = process.argv.includes('--open');
const url = `http://localhost:${port}`;

function launchBrowser() {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: true }).on('error', () => {}).unref();
}

const app = createApp({ dataDir, catalog });
const server = app.listen(port);
server.on('listening', () => {
  console.log(`Pokédex collection running at ${url}`);
  console.log(`Collection data is stored in ${dataDir}`);
  const { tracker } = app.locals;
  console.log(tracker.configured
    ? `PokemonPriceTracker: on (${tracker.dailyCredits} credits a day)`
    : 'PokemonPriceTracker: off (set POKEMONPRICETRACKER_API_KEY to add graded eBay sales)');
  if (openBrowser) {
    console.log('Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.');
    launchBrowser();
  }
});
server.on('error', (err) => {
  // Clicking the icon again while the app is already running just opens it again.
  if (err.code === 'EADDRINUSE' && openBrowser) {
    console.log(`The Pokédex is already running: opening ${url}`);
    launchBrowser();
    process.exit(0);
  }
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is the app already running?` : err.message);
  process.exit(1);
});

// Keep every card's price history growing while the app is running.
createScheduler({ store: app.locals.store, refreshCardMarket: app.locals.refreshCardMarket, tracker: app.locals.tracker }).start();
