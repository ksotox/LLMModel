import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ExchangeRates } from '../server/fx.js';
import { startMockSources } from './helpers/mock-sources.js';

describe('prices in US dollars', () => {
  let mock;
  before(async () => { mock = await startMockSources(); });
  after(() => mock.close());

  const euroPrice = { value: 6.09, currency: 'EUR', low: 4, high: null, source: 'Cardmarket price trend' };

  test('converts a euro price at the day’s rate', async () => {
    const usd = await new ExchangeRates({ baseUrl: mock.fxUrl }).toUsd(euroPrice);
    assert.deepEqual([usd.value, usd.currency, usd.low, usd.high], [7.31, 'USD', 4.8, null]);
    assert.equal(usd.source, 'Cardmarket price trend, converted from €6.09');
    assert.deepEqual(usd.original, { value: 6.09, currency: 'EUR', rate: 1.2 });
  });

  test('uses the fallback rate when the rate service is down, and says so', async () => {
    mock.state.fxDown = true;
    try {
      const usd = await new ExchangeRates({ baseUrl: mock.fxUrl, fallback: { EUR: 1.1 } }).toUsd(euroPrice);
      assert.deepEqual([usd.value, usd.currency], [6.7, 'USD']);
      assert.match(usd.source, /approximate rate/);
    } finally {
      mock.state.fxDown = false;
    }
  });

  test('dollar prices and missing prices pass through untouched', async () => {
    const fx = new ExchangeRates({ baseUrl: mock.fxUrl });
    const usd = { value: 1, currency: 'USD', source: 'TCGplayer' };
    assert.equal(await fx.toUsd(usd), usd);
    assert.equal(await fx.toUsd(null), null);
  });
});
