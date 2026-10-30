// Runs while the app is open (first a minute after start, then hourly) so every card's price history
// keeps growing without anyone opening it:
//  1. cards with no price reading today are re-priced from the free sources (TCGdex / tcgcsv);
//  2. PokemonPriceTracker's leftover daily credits refresh the cards with the oldest data, always
//     leaving the share reserved for cards you open yourself.

const HOUR = 60 * 60 * 1000;

export function createScheduler({ store, refreshCardMarket, tracker, log = console, maxCardsPerRun = 200 }) {
  let running = false;

  async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    const summary = { priced: 0, tracked: 0 };
    try {
      const today = new Date().toISOString().slice(0, 10);
      for (const card of store.cardsNeedingSnapshot(today).slice(0, maxCardsPerRun)) {
        try {
          await refreshCardMarket(card);
          summary.priced++;
        } catch (err) {
          log.warn?.(`Price update failed for card ${card.id}: ${err.message}`);
        }
      }
      if (tracker?.configured) summary.tracked = await tracker.runBackground();
    } finally {
      running = false;
    }
    return summary;
  }

  let timers = [];
  return {
    runOnce,
    start({ firstRunMs = 60 * 1000, everyMs = HOUR } = {}) {
      const run = () => runOnce().then((s) => {
        if (s.priced || s.tracked) log.log?.(`Price history: updated ${s.priced} card${s.priced === 1 ? '' : 's'}, ${s.tracked} from PokemonPriceTracker`);
      }).catch((err) => log.warn?.(`Price history update failed: ${err.message}`));
      timers = [setTimeout(run, firstRunMs), setInterval(run, everyMs)];
      for (const t of timers) t.unref?.();
    },
    stop() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
    },
  };
}
