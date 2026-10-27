// Heartbeats from chapters played offline (src/lib/beats.ts): kept on the phone, through closing the app, until the
// server has them. The API and the phone's file are played by test code. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

let fresh = 0;
async function launch({ server, beatFile = null } = {}) {
  const state = { server, calls: [], beatFile };
  globalThis.__store = state;
  const beats = await import(`../src/lib/beats.ts?${++fresh}`);
  return { beats, state, sent: () => state.calls.filter((c) => c[1] === '/v1/playback/heartbeats').map((c) => c[2].events) };
}
const beat = (positionS, at) => ({ chapterId: 'ch-1', positionS, seconds: 30, at });
const offline = async () => {
  throw new TypeError('Network request failed');
};

test('keeps heartbeats from a flight through closing the app, and sends them with their own times once online', async () => {
  const plane = await launch({ server: offline });
  plane.beats.addBeat(beat(30, '2026-10-20T06:00:30Z'));
  plane.beats.addBeat(beat(60, '2026-10-20T06:01:00Z'));
  assert.equal(await plane.beats.sendBeats(), false);
  assert.equal(plane.beats.pendingBeats(), 2);

  // The app was closed on landing; the next launch has a connection.
  const home = await launch({ server: async () => ({ accepted: 2, ignored: 0 }), beatFile: plane.state.beatFile });
  assert.equal(home.beats.pendingBeats(), 2);
  assert.equal(await home.beats.sendBeats(), true);
  assert.deepEqual(home.sent(), [[beat(30, '2026-10-20T06:00:30Z'), beat(60, '2026-10-20T06:01:00Z')]]);
  assert.equal(home.beats.pendingBeats(), 0);
  assert.equal(home.state.beatFile, null);
});

test('sends fifty at a time, drops a batch the server turns down, and keeps the rest for a server that is down', async () => {
  let n = 0;
  const p = await launch({
    server: async () => {
      n += 1;
      if (n === 2) return { error: { status: 400, code: 'invalid_request', message: 'Some fields need fixing.' } };
      if (n === 3) return { error: { status: 503, code: 'unavailable', message: 'Back soon.' } };
      return { accepted: 50, ignored: 0 };
    },
  });
  for (let i = 0; i < 160; i++) p.beats.addBeat(beat(i * 30, new Date(Date.UTC(2026, 9, 21, 6, 0, i)).toISOString()));
  assert.equal(await p.beats.sendBeats(), false);
  assert.deepEqual(p.sent().map((batch) => batch.length), [50, 50, 50]);
  assert.equal(p.beats.pendingBeats(), 60); // the third batch waits, and the ten after it
  assert.equal(await p.beats.sendBeats(), true);
  assert.equal(p.beats.pendingBeats(), 0);
});

test('signing out drops what was waiting: it was the last member’s', async () => {
  const p = await launch({ server: offline });
  p.beats.addBeat(beat(30, '2026-10-21T06:00:30Z'));
  p.beats.clearBeats();
  assert.equal(p.beats.pendingBeats(), 0);
  assert.equal(p.state.beatFile, null);
});

test('a send with nothing waiting doesn’t stop the next one from going', async () => {
  const p = await launch({ server: async () => ({ accepted: 1, ignored: 0 }) });
  assert.equal(await p.beats.sendBeats(), true); // at launch, nothing to send
  p.beats.addBeat(beat(30, '2026-10-22T06:00:30Z'));
  assert.equal(await p.beats.sendBeats(), true);
  assert.equal(p.sent().length, 1);
  assert.equal(p.beats.pendingBeats(), 0);
});
