// How long a chapter takes to start (src/lib/start-clock.ts). Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startClock } from '../src/lib/start-clock.ts';

test('times the start from opening the player, with the server’s part, once', () => {
  const clock = startClock(1_000);
  clock.answered(1_240);
  clock.answered(1_900); // a second answer (a refetch) doesn't move it
  assert.deepEqual(clock.started(2_730), { ms: 1_730, apiMs: 240, abandoned: false });
  assert.equal(clock.started(3_000), null); // quality switches fire the first-frame event again
  assert.equal(clock.left(9_000), null);
});

test('leaving first gives the wait, marked abandoned, even before the server answered', () => {
  assert.deepEqual(startClock(0).left(4_200), { ms: 4_200, apiMs: null, abandoned: true });
});

test('a locked or failed chapter gives no reading', () => {
  const clock = startClock(0);
  clock.cancel();
  assert.equal(clock.started(500), null);
  assert.equal(clock.left(800), null);
});
