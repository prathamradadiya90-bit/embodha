// The app's event queue (src/lib/analytics.ts), with the API, the phone's storage and its foreground/background
// played by test code. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const offline = async () => {
  throw new TypeError('Network request failed');
};
const accept = async (_path, body) => ({ accepted: body.events.length, dropped: 0 });

let fresh = 0;
/** A clean copy of the module, as if the app had just been launched. `saved` is what the phone kept from last time. */
async function launch({ os = 'ios', server = accept, saved = {} } = {}) {
  const state = { os, server, calls: [], storage: new Map(Object.entries(saved)), appListeners: [], appStateNow: 'active' };
  globalThis.__store = state;
  const analytics = await import(`../src/lib/analytics.ts?${++fresh}`);
  const sent = () => state.calls.filter((call) => call[1] === '/v1/events').map((call) => call[2]);
  const appState = (next) => [...state.appListeners].forEach((listener) => listener(next));
  return { analytics, state, sent, appState, kept: () => Object.fromEntries(state.storage) };
}
const named = (batch) => batch.events.map((event) => [event.name, event.props]);

test('sends a batch with the install’s ID, platform and version, and keeps the same ID on the next launch', async () => {
  const first = await launch({ os: 'android' });
  first.analytics.track('app_open', { cold: true });
  first.analytics.track('course_view', { courseId: 'c1', slug: 'gentle-spine', owned: false });
  await first.analytics.flushEvents();

  const [batch] = first.sent();
  assert.equal(first.sent().length, 1);
  assert.equal(batch.platform, 'android');
  assert.equal(batch.appVersion, '2.4.0');
  assert.match(batch.anonId, /^[A-Za-z0-9-]{8,64}$/);
  assert.deepEqual(named(batch), [
    ['app_open', { cold: true }],
    ['course_view', { courseId: 'c1', slug: 'gentle-spine', owned: false }],
  ]);
  assert.ok(batch.events.every((event) => !Number.isNaN(Date.parse(event.at))));

  const next = await launch({ os: 'android', saved: first.kept() });
  next.analytics.track('app_open', { cold: true });
  await next.analytics.flushEvents();
  assert.equal(next.sent()[0].anonId, batch.anonId);
});

test('goes at twenty without waiting for the timer', async () => {
  const { analytics, sent } = await launch();
  for (let i = 0; i < 19; i++) analytics.track('screen_view', { screen: `/s${i}` });
  await settle();
  assert.equal(sent().length, 0);
  analytics.track('screen_view', { screen: '/s19' });
  await settle();
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].events.length, 20);
});

test('offline, keeps the newest 200 and sends them in fifties once it’s back', async () => {
  const { analytics, state, sent } = await launch({ server: offline });
  for (let i = 0; i < 230; i++) analytics.track('screen_view', { n: i });
  await analytics.flushEvents();
  const failed = sent().length;
  assert.ok(failed >= 1);

  state.server = accept;
  await analytics.flushEvents();
  const delivered = sent().slice(failed);
  assert.deepEqual(delivered.map((batch) => batch.events.length), [50, 50, 50, 50]);
  const numbers = delivered.flatMap((batch) => batch.events.map((event) => event.props.n));
  assert.equal(numbers[0], 30);
  assert.equal(numbers.at(-1), 229);
});

test('drops a batch the server turns down instead of sending it again and again', async () => {
  const { analytics, state, sent } = await launch({ server: async () => ({ error: { status: 400, code: 'invalid_request', message: 'No' } }) });
  analytics.track('app_open');
  await analytics.flushEvents();
  state.server = accept;
  await analytics.flushEvents();
  assert.equal(sent().length, 1);
});

test('switched off, nothing is recorded or sent, what was waiting is dropped, and the choice sticks', async () => {
  const first = await launch();
  first.analytics.track('app_open', { cold: true });
  await first.analytics.setSharingUsage(false);
  first.analytics.track('screen_view', { screen: '/' });
  await first.analytics.flushEvents();
  assert.equal(first.sent().length, 0);
  assert.equal(await first.analytics.sharingUsage(), false);

  // Next launch: the open is counted before the setting has loaded, and must still not go anywhere.
  const next = await launch({ saved: first.kept() });
  next.analytics.track('app_open', { cold: true });
  await next.analytics.flushEvents();
  assert.equal(next.sent().length, 0);

  await next.analytics.setSharingUsage(true);
  next.analytics.track('app_open', { cold: false });
  await next.analytics.flushEvents();
  assert.deepEqual(next.sent().map(named), [[['app_open', { cold: false }]]]);
});

test('a return from the background is an open; a pulled-down control centre isn’t; putting the app away sends', async () => {
  const { analytics, state, sent, appState } = await launch();
  const stop = analytics.startAnalytics();
  appState('inactive');
  appState('active');
  appState('background');
  await settle();
  assert.deepEqual(sent().map(named), [[['app_open', { cold: true }]]]);

  appState('active');
  await analytics.flushEvents();
  assert.deepEqual(named(sent()[1]), [['app_open', { cold: false }]]);
  stop();
  assert.equal(state.appListeners.length, 0);
});

test('after signing out the phone gets a new ID, and what was waiting isn’t sent under it', async () => {
  const { analytics, sent } = await launch();
  analytics.track('app_open', { cold: true });
  await analytics.flushEvents();
  analytics.track('screen_view', { screen: '/profile' });
  await analytics.resetDevice();
  analytics.track('screen_view', { screen: '/' });
  await analytics.flushEvents();

  const [before, after] = sent();
  assert.notEqual(after.anonId, before.anonId);
  assert.deepEqual(named(after), [['screen_view', { screen: '/' }]]);
});
