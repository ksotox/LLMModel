// The ski lift and the mountain it climbs (sanctuary/skiLift.js, battle/world.js LIFT).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chairAt, liftLine, ROPE_HEIGHT, SEAT_DROP, seatAt } from '../public/js/sanctuary/skiLift.js';
import { LIFT, liftLineDistance, terrainHeight } from '../public/js/battle/world.js';
import { PARA } from '../public/js/sanctuary/player.js';

describe('ski lift', () => {
  const line = liftLine(LIFT.base, LIFT.top, terrainHeight);

  test('it runs from the plaza’s edge up to a high summit', () => {
    assert.ok(Math.hypot(LIFT.base.x, LIFT.base.z) < 78, 'the base station is inside the walking area');
    assert.ok(Math.hypot(LIFT.top.x, LIFT.top.z) > 180, 'the top is out in the mountains');
    assert.ok(LIFT.top.y > 40, `the summit is high (${LIFT.top.y.toFixed(0)} m)`);
  });

  test('each station stands on a flat pad of the land', () => {
    for (const s of [LIFT.base, LIFT.top]) {
      for (let a = 0; a < Math.PI * 2; a += 0.5) {
        const y = terrainHeight(s.x + Math.cos(a) * LIFT.pad * 0.9, s.z + Math.sin(a) * LIFT.pad * 0.9);
        assert.ok(Math.abs(y - s.y) < 1e-6, 'flat round the station');
      }
    }
  });

  test('the rope keeps the chairs clear of the ground, and high enough to jump off on most of the way', () => {
    let jumpable = 0;
    let n = 0;
    for (let s = 0; s <= line.length; s += 1) {
      for (const up of [true, false]) {
        const seat = seatAt(line, s, up);
        const air = seat.y - terrainHeight(seat.x, seat.z);
        assert.ok(air > 0.4, `a chair never touches the ground (${air.toFixed(2)} m at ${s} m)`);
        n++;
        if (air - 0.9 > PARA.drop) jumpable++;
      }
    }
    assert.ok(jumpable / n > 0.75, `${Math.round((jumpable / n) * 100)}% of the ride is high enough for the paraglider`);
  });

  test('at the stations the seat is at knee height above the deck', () => {
    for (const [s, up] of [[0, true], [line.length, false]]) {
      const seat = seatAt(line, s, up);
      const deck = terrainHeight(seat.x, seat.z);
      assert.ok(Math.abs(seat.y - deck - (ROPE_HEIGHT - SEAT_DROP)) < 0.3, 'about half a metre');
    }
  });

  test('chairs go up one side and come down the other, round the loop', () => {
    const up = chairAt(line, 0.25);
    const down = chairAt(line, 0.75);
    assert.ok(Math.abs(Math.hypot(up.x - down.x, up.z - down.z) - 3) < 0.2, 'the two sides are 3 m apart at mid-line');
    assert.ok(Math.abs(Math.cos(up.heading - down.heading) + 1) < 1e-9, 'facing opposite ways');
    const a = chairAt(line, 0.999);
    const b = chairAt(line, 0.001);
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 3.2, 'round the bullwheel at the bottom');
  });

  test('the forest keeps clear of the line', () => {
    assert.ok(liftLineDistance((LIFT.base.x + LIFT.top.x) / 2, (LIFT.base.z + LIFT.top.z) / 2) < 1e-9);
    assert.ok(liftLineDistance(0, 0) > 50);
  });
});
