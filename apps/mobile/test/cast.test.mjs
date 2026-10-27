// Chromecast without the Cast SDK (src/lib/cast-core.ts): what the TV is told to play, the second try in fMP4, the
// TV's progress turned into heartbeats, and the connection as the screens see it. A pretend TV and a hand-wound
// clock stand in for the Cast SDK and real time. Run: npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CastController, CastLoader, castRequest, CastTracker, contentTypeOf } from '../src/lib/cast-core.ts';

const video = {
  chapterId: 'ch-2',
  type: 'video',
  title: 'Cat and cow',
  course: { slug: '7-day-gentle-spine', title: '7-Day Gentle Spine' },
  durationS: 840,
  streamUrl: 'https://vz-1a2b.b-cdn.net/bcdn_token=abc&token_path=%2Fguid%2F&expires=1792900000/guid/playlist.m3u8',
  thumbnailUrl: 'https://vz-1a2b.b-cdn.net/guid/thumbnail.jpg',
};
const audio = { ...video, chapterId: 'ch-9', type: 'audio', title: 'Yoga nidra', streamUrl: 'https://audio.b-cdn.net/audio/ch-9/m.m4a?token=x&expires=1', thumbnailUrl: null };

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Time that only moves when a test says so, with the controller's timers on it. */
function handClock(start = Date.parse('2026-10-23T19:00:00Z')) {
  let now = start;
  let timers = [];
  let ids = 0;
  const add = (ms, run, every) => {
    const timer = { at: now + ms, every, run, id: ++ids };
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  return {
    now: () => now,
    timers: { every: (ms, run) => add(ms, run, ms), after: (ms, run) => add(ms, run, 0) },
    /** Moves time on, running what falls due on the way, and lets the promises it starts finish. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every;
        else timers = timers.filter((t) => t !== due);
        due.run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/**
 * A Chromecast as far as the phone can tell: it plays from where it was told, moves on with the clock, and reports
 * each change. Like the real thing, a finished chapter reports position 0, and a session that's suspended says nothing.
 */
function pretendTv(clock) {
  const on = { connection: new Set(), session: new Set(), status: new Set() };
  const tv = { device: null, media: null, loads: [], fail: [], hold: false, held: null, suspended: false, cached: null };
  const position = () => {
    const m = tv.media;
    if (!m) return null;
    return m.state === 'playing' ? m.base + (clock.now() - m.since) / 1000 : m.base;
  };
  const status = () => {
    const m = tv.media;
    if (!m) return null;
    return { chapterId: m.chapterId, sender: m.sender, state: m.state, idleReason: m.idleReason, positionS: m.idleReason === 'finished' ? 0 : position(), durationS: m.durationS };
  };
  const emit = (update = status()) => {
    if (!tv.suspended) for (const listener of on.status) listener(update);
  };
  const change = (state, idleReason = null) => {
    const m = tv.media;
    m.base = position();
    m.since = clock.now();
    m.state = state;
    m.idleReason = idleReason;
    emit();
  };
  const connection = (value) => {
    for (const listener of on.connection) listener(value);
  };
  const session = (event, device) => {
    for (const listener of on.session) listener(event, device);
  };
  const port = {
    connection: async () => (tv.device ? 'connected' : 'notConnected'),
    onConnection: (listener) => (on.connection.add(listener), () => on.connection.delete(listener)),
    session: async () => (tv.device ? { name: tv.device } : null),
    onSession: (listener) => (on.session.add(listener), () => on.session.delete(listener)),
    async endSession() {
      api.leave();
    },
    media: {
      async loadMedia(request) {
        if (!tv.device || tv.suspended) throw new Error('No session');
        tv.loads.push(request);
        if (tv.held) {
          tv.held.reject(new Error('The request was aborted because a similar and overridding request was initiated.'));
          tv.held = null;
        }
        if (tv.hold) {
          tv.hold = false;
          return new Promise((resolve, reject) => {
            tv.held = { resolve, reject };
          });
        }
        const error = tv.fail.shift();
        if (error) {
          tv.media = null;
          emit({ chapterId: null, sender: null, state: 'idle', idleReason: 'error', positionS: 0, durationS: null });
          throw new Error(error);
        }
        const data = request.mediaInfo.customData;
        tv.media = { chapterId: data.chapterId, sender: data.sender, durationS: request.mediaInfo.streamDuration ?? null, base: request.startTime, since: clock.now(), state: 'playing', idleReason: null };
        emit();
      },
      play: async () => change('playing'),
      pause: async () => change('paused'),
      async seek({ position: to, relative }) {
        tv.media.base = relative ? position() + to : to;
        tv.media.since = clock.now();
        emit();
      },
      position: async () => {
        if (tv.suspended) throw new Error('No session');
        return position();
      },
      status: async () => tv.cached ?? status(),
      async requestStatus() {
        if (tv.suspended || !tv.device) throw new Error('No session');
        emit();
      },
      onStatus: (listener) => (on.status.add(listener), () => on.status.delete(listener)),
    },
  };
  const api = {
    tv,
    port,
    position,
    join(name = 'Living room TV') {
      connection('connecting');
      tv.device = name;
      session('started', { name });
      connection('connected');
    },
    leave() {
      tv.device = null;
      tv.media = null;
      session('ended', null);
      connection('notConnected');
    },
    /** iOS in the background: the phone stops hearing from the TV, which carries on. */
    suspend() {
      tv.cached = status();
      session('suspended', null);
      tv.suspended = true;
    },
    /** Back again: the SDK repeats its old status as it reconnects, before the TV's own. */
    resume() {
      tv.suspended = false;
      session('resumed', { name: tv.device });
      if (tv.cached) for (const listener of on.status) listener(tv.cached);
      tv.cached = null;
    },
    finish() {
      tv.media.base = tv.media.durationS;
      change('idle', 'finished');
    },
    breakDown() {
      tv.media = null;
      emit({ chapterId: null, sender: null, state: 'idle', idleReason: 'error', positionS: 0, durationS: null });
    },
    /** Someone else's phone puts its own chapter on. */
    loadFrom(sender, chapterId) {
      tv.media = { chapterId, sender, durationS: 600, base: 0, since: clock.now(), state: 'playing', idleReason: null };
      emit();
    },
    /** The connection drops with no word from the SDK, as when a resume fails. */
    vanish() {
      tv.device = null;
      tv.media = null;
      connection('notConnected');
    },
  };
  return api;
}

function setUp({ sender = 'phone-a' } = {}) {
  const clock = handClock();
  const tv = pretendTv(clock);
  const beats = [];
  const completed = [];
  const sent = [];
  const failures = [];
  const cast = new CastController(tv.port, {
    tracker: { addBeat: (b) => beats.push(b), sendBeats: async () => undefined, complete: (id) => completed.push(id) },
    sender: async () => sender,
    sent: (chapter, startS) => sent.push([chapter.chapterId, startS]),
    failed: (chapterId, type, message) => failures.push([chapterId, type, message]),
    timers: clock.timers,
    now: clock.now,
  });
  return { clock, tv, cast, beats, completed, sent, failures, played: () => beats.reduce((n, b) => n + b.seconds, 0) };
}

test('tells the TV to play the signed stream from where the member is, with the course on screen', () => {
  const request = castRequest(video, 312.8, 'ts', 'phone-a');
  assert.deepEqual(request, {
    autoplay: true,
    startTime: 312,
    mediaInfo: {
      contentId: 'ch-2',
      contentUrl: video.streamUrl,
      contentType: 'application/x-mpegURL',
      streamType: 'buffered',
      streamDuration: 840,
      metadata: { type: 'movie', title: 'Cat and cow', subtitle: '7-Day Gentle Spine', images: [{ url: video.thumbnailUrl }] },
      customData: { chapterId: 'ch-2', courseSlug: '7-day-gentle-spine', sender: 'phone-a' },
    },
  });
  // Audio gets the music screen; a recording isn't HLS, so no segment format either way.
  const track = castRequest(audio, 0, 'fmp4');
  assert.equal(track.mediaInfo.contentType, 'audio/mp4');
  assert.deepEqual(track.mediaInfo.metadata, { type: 'musicTrack', title: 'Yoga nidra', albumTitle: '7-Day Gentle Spine', artist: 'Embodha', images: [] });
  assert.equal(track.mediaInfo.hlsSegmentFormat, undefined);
  assert.throws(() => castRequest({ ...video, streamUrl: null }, 0), /no stream/);
  assert.equal(contentTypeOf('http://localhost:8081/sample.webm', 'video'), 'video/webm');
  assert.equal(contentTypeOf('https://x/play_480p.mp4?token=1', 'video'), 'video/mp4');
});

test('when the TV turns the stream down, it asks once more in fMP4, then gives up; a newer chapter wins', async () => {
  const sent = [];
  let refuse = 0;
  const tv = {
    loadMedia: async (request) => {
      sent.push(request);
      if (refuse-- > 0) throw new Error('LOAD_FAILED');
    },
  };
  const loader = new CastLoader();
  assert.deepEqual(await loader.play(tv, video, 60, 'phone-a'), { result: 'sent' });
  assert.equal(sent[0].mediaInfo.hlsSegmentFormat, undefined);

  refuse = 1;
  assert.deepEqual(await loader.play(tv, video, 60, 'phone-a'), { result: 'sent' });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].mediaInfo.hlsSegmentFormat, 'FMP4');
  assert.equal(sent[2].mediaInfo.hlsVideoSegmentFormat, 'FMP4');
  assert.equal(sent[2].startTime, 60);

  refuse = 2;
  assert.deepEqual(await loader.play(tv, video, 60), { result: 'failed', error: 'LOAD_FAILED' });
  // A recording isn't HLS: there's no other way to ask.
  refuse = 1;
  const before = sent.length;
  assert.deepEqual(await loader.play(tv, audio, 0), { result: 'failed', error: 'LOAD_FAILED' });
  assert.equal(sent.length, before + 1);

  // Sent again before the first had loaded: the first one's "replaced" isn't a failure to retry.
  let release;
  const slow = { loadMedia: (request) => (request.mediaInfo.contentId === 'ch-2' ? new Promise((_, reject) => (release = reject)) : Promise.resolve()) };
  const first = loader.play(slow, video, 0);
  assert.deepEqual(await loader.play(slow, audio, 0), { result: 'sent' });
  release(new Error('The request was aborted because a similar and overridding request was initiated.'));
  assert.deepEqual(await first, { result: 'superseded' });
});

test('turns the TV’s progress into a heartbeat every 30 seconds, counting only time it was playing', () => {
  let now = Date.parse('2026-10-23T19:00:00Z');
  const beats = [];
  let sends = 0;
  const completed = [];
  const tracker = new CastTracker({ addBeat: (b) => beats.push(b), sendBeats: async () => void (sends += 1), complete: (id) => completed.push(id), now: () => now });
  const tick = (chapterId, positionS, playing, ms = 1000) => {
    now += ms;
    tracker.progress(chapterId, positionS, playing);
  };

  tick('ch-2', 312, true);
  for (let s = 1; s <= 20; s++) tick('ch-2', 312 + s, true); // 20 seconds playing
  for (let s = 0; s < 10; s++) tick('ch-2', 332, false); // 10 paused
  assert.deepEqual(beats, [{ chapterId: 'ch-2', positionS: 332, seconds: 20, at: '2026-10-23T19:00:31.000Z' }]);
  assert.equal(sends, 1);

  // Skipping ahead while paused moves the place without counting as practice.
  tick('ch-2', 600, false);
  for (let s = 0; s < 30; s++) tick('ch-2', 600, false);
  assert.deepEqual(beats.at(-1), { chapterId: 'ch-2', positionS: 600, seconds: 0, at: '2026-10-23T19:01:01.000Z' });
  for (let s = 0; s < 40; s++) tick('ch-2', 600, false);
  assert.equal(beats.length, 2); // paused and still: nothing new to say

  // Two minutes unseen, and the TV is 300 seconds on: it can't have played more than the two minutes.
  tick('ch-2', 900, true, 120_000);
  tracker.flush();
  assert.equal(beats.at(-1).seconds, 120);
  assert.equal(beats.at(-1).positionS, 900);

  // The TV moves on to the next chapter: the last beat for this one goes first.
  for (let s = 1; s <= 5; s++) tick('ch-2', 900 + s, true);
  tick('ch-3', 0, true);
  assert.deepEqual(beats.at(-1), { chapterId: 'ch-2', positionS: 905, seconds: 5, at: new Date(now).toISOString() });

  // Played to the end: done once, however many statuses say so.
  for (let s = 1; s <= 4; s++) tick('ch-3', s, true);
  tracker.ended('ch-3');
  tracker.ended('ch-3');
  assert.deepEqual(completed, ['ch-3']);
  assert.deepEqual(beats.at(-1), { chapterId: 'ch-3', positionS: 4, seconds: 4, at: new Date(now).toISOString() });

  // Twenty minutes asleep while the TV played: the waking reading makes them up, as the beats the phone would have
  // sent, none over the server's two minutes, the last one with where the TV is now.
  tick('ch-4', 100, true);
  const asleepAt = now;
  tracker.flush();
  const before = beats.length;
  tick('ch-4', 100, true, 20 * 60_000); // an old status, repeated on waking: says nothing
  tick('ch-4', 1300, true, 500);
  const madeUp = beats.slice(before);
  assert.equal(madeUp.length, 10);
  assert.equal(madeUp.reduce((n, b) => n + b.seconds, 0), 1200);
  assert.ok(madeUp.every((b) => b.seconds <= 120 && b.chapterId === 'ch-4'));
  assert.deepEqual(madeUp[0], { chapterId: 'ch-4', positionS: 220, seconds: 120, at: new Date(asleepAt + (now - asleepAt) / 10).toISOString() });
  assert.deepEqual(madeUp.at(-1), { chapterId: 'ch-4', positionS: 1300, seconds: 120, at: new Date(now).toISOString() });

  // Signed out: what wasn't sent stays unsent.
  for (let s = 1; s <= 10; s++) tick('ch-4', 1300 + s, true);
  const count = beats.length;
  tracker.reset();
  tracker.flush();
  tick('ch-5', 0, true);
  assert.equal(beats.length, count);
});

test('a class on the TV from start to finish: sent from the phone, counted while it plays, done at the end', async () => {
  const { clock, tv, cast, beats, completed, sent, played } = setUp();
  const seen = [];
  cast.subscribe(() => seen.push(cast.getSnapshot()));
  cast.start();
  cast.setTracking(true);
  await clock.advance(10);
  assert.equal(cast.getSnapshot().connection, 'notConnected');
  assert.equal(await cast.send(video, 0), false, 'nothing to send to');

  tv.join();
  await clock.advance(10);
  assert.equal(cast.getSnapshot().connection, 'connected');
  assert.equal(cast.getSnapshot().deviceName, 'Living room TV');
  assert.equal(cast.getSnapshot().session, 1);
  assert.equal(cast.getSnapshot().checked, true, 'asked the TV what it has on');
  assert.ok(seen.some((s) => s.connection === 'connecting'));

  assert.equal(await cast.send(video, 312.4), true);
  assert.deepEqual(sent, [['ch-2', 312.4]]);
  assert.equal(tv.tv.loads[0].mediaInfo.customData.sender, 'phone-a');
  assert.ok(seen.some((s) => s.sending === 'ch-2'), 'the screen saw it on its way');
  assert.deepEqual(cast.getSnapshot().tv, { chapterId: 'ch-2', state: 'playing', positionS: 312, durationS: 840, finished: false });
  assert.equal(cast.getSnapshot().sending, null);

  // Half a minute on the TV: the screen follows it every second, and one heartbeat goes up.
  await clock.advance(30_000);
  assert.equal(Math.round(cast.getSnapshot().tv.positionS), 342);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].positionS, 342);
  assert.equal(beats[0].seconds, 30);

  // Paused from the phone: the button changes before the TV answers, and nothing counts while paused.
  const pausing = cast.pause();
  assert.equal(cast.getSnapshot().tv.state, 'paused');
  await pausing;
  await clock.advance(60_000);
  assert.equal(played(), 30);

  await cast.play();
  await clock.advance(5_000);
  await cast.seekTo(830); // a jump forward isn't practice
  await clock.advance(10_000);
  tv.finish();
  await clock.advance(10);
  assert.deepEqual(completed, ['ch-2']);
  assert.equal(cast.getSnapshot().tv.finished, true);
  assert.equal(cast.getSnapshot().tv.positionS, 840, 'a finished chapter is at its end, whatever the TV says');
  assert.equal(beats.at(-1).positionS, 840);
  const total = played();
  assert.ok(total >= 45 && total <= 47, `about 30 + 5 + 10 seconds played, not the jump (got ${total})`);

  // Stopping leaves the TV: the screen goes back to the phone.
  await cast.stop();
  await clock.advance(10);
  assert.equal(cast.getSnapshot().connection, 'notConnected');
  assert.equal(cast.getSnapshot().tv, null);
  assert.equal(cast.getSnapshot().deviceName, null);
  assert.equal(played(), total);
});

test('an iPhone asleep through the class: the time the TV played meanwhile counts when the app is back', async () => {
  const { clock, tv, cast, beats, played } = setUp();
  cast.start();
  cast.setTracking(true);
  tv.join();
  await clock.advance(10);
  await cast.send(video, 0);
  await clock.advance(10_000);

  // The screen locks: what was played goes up, and the SDK suspends the session.
  cast.setForeground(false);
  tv.suspend();
  assert.equal(played(), 10);
  await clock.advance(5 * 60_000);
  assert.equal(beats.length, 1, 'nothing while asleep');

  // Five minutes on, the app opens again and the session comes back.
  cast.setForeground(true);
  tv.resume();
  await clock.advance(1000);
  const made = played();
  assert.ok(made >= 309 && made <= 311, `about five minutes and ten seconds in all (got ${made})`);
  assert.ok(beats.every((b) => b.seconds <= 120));
  assert.ok(Math.abs(beats.at(-1).positionS - 310) <= 1);

  // And carries on counting from there.
  await clock.advance(30_000);
  const after = played();
  assert.ok(after - made >= 29 && after - made <= 31, `half a minute more (got ${after - made})`);
  assert.equal(cast.getSnapshot().session, 1, 'the same session, back again');
});

test('a session that went quiet and never came back is taken as over', async () => {
  const { clock, tv, cast } = setUp();
  cast.start();
  tv.join();
  await clock.advance(10);
  await cast.send(video, 0);
  cast.setForeground(false);
  tv.suspend();
  tv.tv.device = null; // the TV was switched off meanwhile
  cast.setForeground(true);
  await clock.advance(11_000);
  assert.equal(cast.getSnapshot().connection, 'notConnected');
  assert.equal(cast.getSnapshot().tv, null);

  // Ending without a word, out of the background: castState going to "not connected" is enough.
  tv.join();
  await clock.advance(10);
  assert.equal(cast.getSnapshot().session, 2);
  tv.vanish();
  await clock.advance(10);
  assert.equal(cast.getSnapshot().connection, 'notConnected');
});

test('counts only what this phone put on the TV, and nothing once signed out', async () => {
  const { clock, tv, cast, beats, played } = setUp();
  cast.start();
  cast.setTracking(true);
  tv.join();
  await clock.advance(10);

  // Another phone in the house casts its own chapter: this one shows it, but doesn't count it.
  tv.loadFrom('phone-b', 'ch-7');
  await clock.advance(60_000);
  assert.equal(cast.getSnapshot().tv.chapterId, 'ch-7');
  assert.equal(beats.length, 0);

  await cast.send(audio, 0);
  await clock.advance(31_000);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].chapterId, 'ch-9');

  // Signed out mid-class: the rest isn't sent for anyone.
  await clock.advance(20_000);
  cast.setTracking(false);
  await clock.advance(60_000);
  tv.leave();
  await clock.advance(10);
  assert.equal(beats.length, 1);
  assert.ok(played() >= 30 && played() <= 32);
});

test('a chapter the TV can’t play shows as failed, and clears when it plays after all', async () => {
  const { clock, tv, cast, failures } = setUp();
  cast.start();
  tv.join();
  await clock.advance(10);

  tv.tv.fail = ['LOAD_FAILED', 'LOAD_FAILED'];
  assert.equal(await cast.send(video, 0), false);
  assert.equal(cast.getSnapshot().failed, 'ch-2');
  assert.equal(tv.tv.loads.length, 2);
  assert.equal(tv.tv.loads[1].mediaInfo.hlsSegmentFormat, 'FMP4');
  assert.deepEqual(failures, [['ch-2', 'video', 'LOAD_FAILED']], 'one failure, not one per try');

  // Try again, and the TV takes it the second way.
  tv.tv.fail = ['LOAD_FAILED'];
  assert.equal(await cast.send(video, 0), true);
  assert.equal(cast.getSnapshot().failed, null);
  assert.equal(cast.getSnapshot().tv.state, 'playing');

  // It stops with an error after it had started (the stream ran out, say).
  await clock.advance(5000);
  tv.breakDown();
  await clock.advance(10);
  assert.equal(cast.getSnapshot().failed, 'ch-2');
  assert.equal(cast.getSnapshot().tv, null);
  assert.equal(failures.length, 2);

  // The next chapter goes while the first is still loading: only the second counts as sent.
  tv.tv.hold = true;
  const first = cast.send(video, 0);
  await settle();
  assert.equal(await cast.send(audio, 0), true);
  assert.equal(await first, false);
  assert.equal(cast.getSnapshot().sending, null);
  assert.equal(cast.getSnapshot().tv.chapterId, 'ch-9');
  assert.equal(failures.length, 2);
});
