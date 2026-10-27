// Crash and error reports (src/lib/crashes.ts), with the API, the crash file, the phone's error handler and the
// browser played by test code. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const offline = async () => {
  throw new TypeError('Network request failed');
};
const accept = async (_path, body) => ({ accepted: body.reports.length });

let fresh = 0;
/**
 * A clean copy of the module, as if the app had just been launched, with the system's own error handler underneath.
 * `crashFile` is what the phone kept from last time.
 */
async function launch({ os = 'android', server = accept, crashFile = null, sharing = true, rejections = true } = {}) {
  const state = { os, server, calls: [], crashFile, appListeners: [], appStateNow: 'active', systemSaw: [], listeners: {} };
  globalThis.__store = state;
  let handler = (error, isFatal) => state.systemSaw.push([error.message ?? String(error), isFatal]);
  globalThis.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (next) => (handler = next) };
  globalThis.HermesInternal = rejections ? { enablePromiseRejectionTracker: (options) => (state.rejections = options) } : undefined;
  globalThis.addEventListener = (type, listener) => (state.listeners[type] = listener);
  globalThis.location = { origin: 'https://app.embodha.test' };
  const crashes = await import(`../src/lib/crashes.ts?${++fresh}`);
  crashes.installCrashReporting({ identity: async () => 'install-0001-abcd', sharing: async () => sharing, sendAfterMs: 0 });
  await settle(); // last time's crashes go up first
  const sent = () => state.calls.filter((call) => call[1] === '/v1/app-errors').map((call) => call[2]);
  const fail = (error, isFatal) => handler(error, isFatal);
  return { crashes, state, sent, fail, saved: () => JSON.parse(state.crashFile ?? '[]') };
}

const boom = (message = "Cannot read property 'title' of undefined", frame = 'ChapterRow') => {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at ${frame} (address at index.android.bundle:1:40213)`;
  return error;
};

test('a crash is written to the phone before the system closes the app, and goes up on the next launch', async () => {
  const first = await launch();
  first.crashes.noteScreen('/course/gentle-spine');
  first.fail(boom(), true);
  assert.deepEqual(first.state.systemSaw, [["Cannot read property 'title' of undefined", true]]); // still the system's to handle
  const [kept] = first.saved();
  assert.equal(kept.kind, 'crash');
  assert.equal(kept.message, "TypeError: Cannot read property 'title' of undefined");
  assert.equal(kept.screen, '/course/gentle-spine');
  assert.equal(kept.appVersion, '2.4.0');
  assert.match(kept.stack, /at ChapterRow/);
  await settle();
  assert.equal(first.sent().length, 0); // the app is gone by now; nothing tries to send

  const next = await launch({ crashFile: first.state.crashFile });
  assert.equal(next.sent().length, 1);
  const [batch] = next.sent();
  assert.deepEqual(
    { anonId: batch.anonId, platform: batch.platform, appVersion: batch.appVersion, osVersion: batch.osVersion, device: batch.device },
    { anonId: 'install-0001-abcd', platform: 'android', appVersion: '2.4.0', osVersion: '15', device: 'Redmi Note 13' },
  );
  assert.deepEqual(batch.reports, [kept]);
  assert.equal(next.state.crashFile, null);
});

test('offline, the crash waits on the phone for another launch; turned down by the server, it is dropped', async () => {
  const first = await launch();
  first.fail(boom(), true);
  const offlineLaunch = await launch({ crashFile: first.state.crashFile, server: offline });
  assert.equal(offlineLaunch.saved().length, 1);

  const rejected = await launch({ crashFile: offlineLaunch.state.crashFile, server: async () => ({ error: { status: 400, code: 'invalid_request', message: 'no' } }) });
  assert.equal(rejected.state.crashFile, null);
});

test('keeps the five latest crashes, and none at all when sharing is off', async () => {
  const first = await launch();
  for (let i = 0; i < 7; i++) first.fail(boom(`crash ${i}`), true);
  assert.deepEqual(
    first.saved().map((r) => r.message),
    [2, 3, 4, 5, 6].map((i) => `TypeError: crash ${i}`),
  );
  const quiet = await launch({ crashFile: first.state.crashFile, sharing: false });
  assert.equal(quiet.sent().length, 0);
  assert.equal(quiet.state.crashFile, null);
});

test('other errors go up together, each different one once per launch, twenty at most', async () => {
  const { fail, sent, state } = await launch({ os: 'ios' });
  fail(boom('first'), false);
  fail(boom('first'), false); // the same again
  fail(boom('first', 'OtherPlace'), false); // same words, somewhere else
  assert.deepEqual(state.systemSaw.length, 3);
  await settle();
  assert.equal(sent().length, 1);
  assert.deepEqual(
    sent()[0].reports.map((r) => [r.kind, r.message]),
    [
      ['error', 'TypeError: first'],
      ['error', 'TypeError: first'],
    ],
  );
  assert.equal(sent()[0].platform, 'ios');

  for (let i = 0; i < 30; i++) fail(boom(`loop ${i}`), false);
  await settle();
  // Two already this launch, so eighteen more, in batches of ten.
  assert.deepEqual(
    sent().slice(1).map((batch) => batch.reports.length),
    [10, 8],
  );
});

test('promises nobody caught are reported too', async () => {
  const { state, sent } = await launch();
  state.rejections.onUnhandled(7, new Error('Playback address expired'));
  await settle();
  assert.equal(sent()[0].reports[0].message, 'Playback address expired');
});

test('a screen that failed to draw goes straight away, while the app is still open', async () => {
  const { crashes, sent, state } = await launch();
  crashes.noteScreen('/play/abc');
  crashes.reportScreenCrash(boom('render failed'));
  await settle();
  assert.equal(sent().length, 1);
  assert.deepEqual(sent()[0].reports.map((r) => [r.kind, r.screen]), [['crash', '/play/abc']]);
  assert.equal(state.crashFile, null);
});

test('a broken disk never gets between the error and the system', async () => {
  const { fail, state } = await launch();
  state.storageBroken = true;
  fail(boom(), true);
  assert.equal(state.systemSaw.length, 1);
});

test('in the web app: page errors and rejected promises, but not other sites’ scripts or browser noise', async () => {
  const { state, sent } = await launch({ os: 'web' });
  state.listeners.error({ error: boom('web broke'), filename: 'https://app.embodha.test/_expo/static/js/web/entry.js' });
  state.listeners.error({ error: boom('extension broke'), filename: 'chrome-extension://abc/content.js' });
  state.listeners.error({ message: 'Script error.' });
  state.listeners.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  state.listeners.unhandledrejection({ reason: 'Timed out' });
  await settle();
  assert.deepEqual(
    sent().flatMap((batch) => batch.reports.map((r) => r.message)),
    ['TypeError: web broke', 'Timed out'],
  );
  assert.equal(sent()[0].platform, 'web');
  assert.equal(sent()[0].device, 'Redmi Note 13');
});

test('reads only well-formed crashes back from the phone', async () => {
  const { crashes } = await launch();
  assert.deepEqual(crashes.readPending('not json'), []);
  assert.deepEqual(crashes.readPending(JSON.stringify([{ kind: 'crash' }, { kind: 'crash', message: 'x', at: '2026-10-22T10:00:00.000Z', appVersion: '2.4.0' }])).length, 1);
  assert.deepEqual(crashes.describeError('plain words'), { message: 'plain words' });
  assert.deepEqual(crashes.describeError({ code: 42 }), { message: '{"code":42}' });
});
