// Offline downloads on the phone (src/lib/downloads-core.ts), with the phone's storage, its network, the Embodha API
// and the file host all played by test code. Run: npm test. Node strips the TypeScript.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DownloadManager, KEEP_FREE_BYTES, sizeLabel } from '../src/lib/downloads-core.ts';

const MEMBER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DAY = 86_400_000;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const course = {
  id: 'course-gentle-spine',
  slug: 'gentle-spine',
  title: 'Gentle spine',
  instructor: 'Asha Rao',
  chapters: [
    { id: 'ch-1', title: 'Day 1: Cat and cow', type: 'video', durationS: 600 },
    { id: 'ch-2', title: 'Day 2: Twists', type: 'video', durationS: 720 },
    { id: 'ch-3', title: 'Day 3: Lying down', type: 'audio', durationS: 900 },
  ],
};
const chapters = (...ids) => course.chapters.filter((c) => ids.includes(c.id));

class ApiProblem extends Error {
  constructor(status, code, message) {
    super(message);
    this.apiProblem = { status, code, message };
  }
}
const offline = () => Object.assign(new TypeError('Network request failed'), { offline: true });

/**
 * A phone: its disk (files by name and size, the manifest), its network, a clock and timers, the API and the file
 * host. `disk` can be handed to a second phone() to play the next launch.
 */
function phone({ platform = 'android', disk = { files: new Map(), manifest: null, free: 20e9 }, net = { connected: true, wifi: true }, label = 'Pixel 8' } = {}) {
  const state = { now: Date.parse('2026-10-23T08:00:00Z'), timers: [], net, netListeners: [], transfers: [], calls: [], links: 0, verdicts: null, refuse: null };
  const files = {
    readManifest: () => disk.manifest,
    writeManifest: (text) => {
      disk.manifest = text;
    },
    list: () => [...disk.files.keys()],
    size: (name) => (disk.files.has(name) ? disk.files.get(name) : null),
    remove: (name) => {
      disk.files.delete(name);
    },
    uri: (name) => `file:///data/downloads/${name}`,
    freeBytes: () => disk.free,
    download(job) {
      let settle;
      let fail;
      const result = new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const transfer = {
        job,
        state: 'active',
        written: 0,
        progress(written, total) {
          transfer.written = written;
          job.onProgress(written, total);
        },
        finish(size = 100_000_000) {
          disk.files.set(job.name, size);
          job.onProgress(size, size);
          transfer.state = 'done';
          settle({ kind: 'done' });
        },
        drop(status, resume) {
          transfer.state = 'failed';
          const error = new Error(status ? `HTTP ${status}` : 'The network connection was lost.');
          if (status) error.status = status;
          if (resume !== undefined) error.resume = resume;
          fail(error);
        },
      };
      state.transfers.push(transfer);
      return {
        result,
        pause() {
          transfer.state = 'paused';
          settle({ kind: 'paused', resume: { offset: transfer.written } });
        },
        cancel() {
          transfer.state = 'cancelled';
          fail(new Error('cancelled'));
        },
      };
    },
  };
  const offer = (chapterId) => {
    const chapter = course.chapters.find((c) => c.id === chapterId);
    const audio = chapter.type === 'audio';
    return {
      chapterId,
      url: `https://vz-test.b-cdn.net/${chapterId}/play_480p.mp4?token=t${++state.links}`,
      expiresAt: new Date(state.now + 6 * 3600_000).toISOString(),
      kind: chapter.type,
      height: audio ? null : 480,
      extension: audio ? 'm4a' : 'mp4',
      estimatedBytes: audio ? 14_400_000 : 100_000_000,
      keepUntil: new Date(state.now + 30 * DAY).toISOString(),
      chapter,
      course,
    };
  };
  const api = async (path, init = {}) => {
    state.calls.push([init.method ?? 'GET', path, init.body ?? null]);
    if (!state.net.connected) throw offline();
    if (state.refuse) {
      const answer = state.refuse(path, init.body);
      if (answer) throw answer;
    }
    if (path === '/v1/downloads') return offer(init.body.chapterId);
    if (path === '/v1/downloads/check') {
      return {
        checkedAt: new Date(state.now).toISOString(),
        chapters: init.body.chapterIds.map((chapterId) => state.verdicts?.[chapterId] ?? { chapterId, keep: true, keepUntil: new Date(state.now + 30 * DAY).toISOString() }),
      };
    }
    if (init.method === 'DELETE') return undefined;
    throw new Error(`no route for ${path}`);
  };
  const manager = new DownloadManager({
    platform,
    label,
    files,
    api,
    problemOf: (error) => error?.apiProblem ?? null,
    network: async () => state.net,
    onNetwork: (listener) => {
      state.netListeners.push(listener);
      return () => undefined;
    },
    randomId: (() => {
      let n = 0;
      return () => `install-${platform}-${String(++n).padStart(4, '0')}`;
    })(),
    now: () => state.now,
    setTimer: (run, ms) => {
      const timer = { run, at: state.now + ms };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      state.timers = state.timers.filter((t) => t !== timer);
    },
  });
  const helpers = {
    manager,
    state,
    disk,
    snap: () => manager.getSnapshot(),
    item: (id) => manager.getSnapshot().byChapter[id],
    posts: () => state.calls.filter(([method, path]) => method === 'POST' && path === '/v1/downloads').map(([, , body]) => body.chapterId),
    checks: () => state.calls.filter(([, path]) => path === '/v1/downloads/check').map(([, , body]) => body.chapterIds),
    live: () => state.transfers.filter((t) => t.state === 'active'),
    async setNet(next) {
      state.net = next;
      state.netListeners.forEach((listener) => listener(next));
      await settle();
    },
    async advance(ms) {
      state.now += ms;
      for (const timer of state.timers.filter((t) => t.at <= state.now)) {
        state.timers = state.timers.filter((t) => t !== timer);
        timer.run();
      }
      await settle();
    },
    /** Finishes whatever is downloading, one chapter at a time, until the queue is empty. */
    async finishAll(size) {
      for (let i = 0; i < 20; i++) {
        const [transfer] = helpers.live();
        if (!transfer) return;
        transfer.finish(size);
        await settle();
      }
    },
  };
  return helpers;
}

async function signedIn(options) {
  const p = phone(options);
  await p.manager.start();
  await p.manager.setUser(MEMBER);
  await settle();
  return p;
}

test('saves chapters one at a time, in order, each cleared with the server first', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1', 'ch-2'), course);
  await settle();
  assert.deepEqual(p.posts(), ['ch-1']); // the second waits its turn
  assert.equal(p.live().length, 1);
  const [first] = p.live();
  assert.equal(first.job.name, 'ch-1-1.mp4');
  assert.match(first.job.url, /play_480p\.mp4\?token=t1$/);
  // The check-in at sign-in went first, with nothing on the phone yet.
  assert.deepEqual(p.state.calls[0], ['POST', '/v1/downloads/check', { deviceId: 'install-android-0001', platform: 'android', label: 'Pixel 8', chapterIds: [] }]);
  assert.deepEqual(p.state.calls[1][2], { deviceId: 'install-android-0001', platform: 'android', label: 'Pixel 8', chapterId: 'ch-1', quality: 'standard' });

  first.progress(40_000_000, 100_000_000);
  await p.advance(300);
  assert.equal(p.item('ch-1').state, 'downloading');
  assert.equal(p.item('ch-1').written, 40_000_000);

  first.finish(98_500_000);
  await settle();
  assert.equal(p.item('ch-1').state, 'done');
  assert.deepEqual(p.posts(), ['ch-1', 'ch-2']);
  await p.finishAll(120_000_000);
  assert.deepEqual(
    p.snap().items.map((i) => [i.chapterId, i.state, i.written]),
    [
      ['ch-1', 'done', 98_500_000],
      ['ch-2', 'done', 120_000_000],
    ],
  );
  assert.equal(p.snap().usedBytes, 218_500_000);
  assert.equal(sizeLabel(p.snap().usedBytes), '219 MB');

  // Plays offline from the saved file, with the course to step through.
  const local = p.manager.playable('ch-1');
  assert.equal(local.uri, 'file:///data/downloads/ch-1-1.mp4');
  assert.equal(local.course.chapters.length, 3);
  // Written to disk, so the next launch knows.
  assert.equal(JSON.parse(p.disk.manifest).items.length, 2);
});

test('waits for Wi-Fi unless mobile data is allowed, and carries on from where a dropped download stopped', async () => {
  const p = await signedIn({ net: { connected: true, wifi: false } });
  p.manager.add(chapters('ch-1'), course);
  await settle();
  assert.deepEqual(p.posts(), []);
  assert.equal(p.snap().waiting, 'wifi');

  await p.setNet({ connected: true, wifi: true });
  assert.deepEqual(p.posts(), ['ch-1']);
  p.live()[0].progress(30_000_000, 100_000_000);

  // Out of the house: onto mobile data, which isn't allowed. The download stops and keeps what it has.
  await p.setNet({ connected: true, wifi: false });
  assert.equal(p.item('ch-1').state, 'paused');
  assert.deepEqual(p.item('ch-1').resume, { offset: 30_000_000 });

  // Back on Wi-Fi: a fresh link (the old one may have run out) and the bytes already saved.
  await p.setNet({ connected: true, wifi: true });
  assert.deepEqual(p.posts(), ['ch-1', 'ch-1']);
  const resumed = p.live()[0];
  assert.deepEqual(resumed.job.resume, { offset: 30_000_000 });
  assert.equal(resumed.job.name, 'ch-1-1.mp4');
  assert.match(resumed.job.url, /token=t2$/);
  resumed.finish(100_000_000);
  await settle();
  assert.equal(p.item('ch-1').state, 'done');

  // With mobile data allowed, it doesn't wait.
  p.manager.setMobileData(true);
  await p.setNet({ connected: true, wifi: false });
  p.manager.add(chapters('ch-2'), course);
  await settle();
  assert.deepEqual(p.posts(), ['ch-1', 'ch-1', 'ch-2']);
});

test('on an iPhone, Wi-Fi-only downloads pause in the background; with mobile data allowed they carry on there', async () => {
  const p = await signedIn({ platform: 'ios', label: 'iPhone 15' });
  p.manager.add(chapters('ch-1'), course);
  await settle();
  assert.equal(p.live()[0].job.background, false); // Wi-Fi only can't be promised once iOS takes over
  p.live()[0].progress(10_000_000, 100_000_000);
  p.manager.backgrounded();
  await settle();
  assert.equal(p.item('ch-1').state, 'paused');
  p.manager.foreground();
  await settle();
  assert.equal(p.live()[0].job.background, false);
  assert.deepEqual(p.live()[0].job.resume, { offset: 10_000_000 });

  // Allowing mobile data restarts it as a background download.
  p.manager.setMobileData(true);
  await settle();
  assert.equal(p.live()[0].job.background, true);
  p.manager.backgrounded();
  await settle();
  assert.equal(p.item('ch-1').state, 'downloading');
});

test('stops the queue at the phone limit, with the server’s words, until a place is freed', async () => {
  const p = await signedIn();
  const message = 'Your downloads are on 3 phones already (Redmi Note 12, iPhone 13 and Galaxy A54). Remove one from Downloads on any phone, then try again.';
  p.state.refuse = (path) => (path === '/v1/downloads' ? new ApiProblem(409, 'device_limit', message) : null);
  p.manager.add(chapters('ch-1', 'ch-2'), course);
  await settle();
  assert.deepEqual(p.posts(), ['ch-1']); // not ch-2 as well: it would hear the same
  assert.deepEqual(p.snap().block, { code: 'device_limit', message });
  assert.equal(p.snap().waiting, 'blocked');
  assert.equal(p.item('ch-1').state, 'queued');

  p.state.refuse = null; // the member removed the old Galaxy from the list
  p.manager.unblock();
  await settle();
  assert.deepEqual(p.posts(), ['ch-1', 'ch-1']);
  assert.equal(p.snap().block, null);
});

test('never fills the phone: it leaves 300 MB free, and says so', async () => {
  const p = await signedIn({ disk: { files: new Map(), manifest: null, free: 380_000_000 } });
  p.manager.add(chapters('ch-1'), course);
  await settle();
  assert.equal(p.live().length, 0);
  assert.equal(p.snap().block.code, 'space');
  assert.equal(
    p.snap().block.message,
    "There isn't room for Day 1: Cat and cow. It needs about 100 MB, and the phone has 380 MB free. Embodha always leaves 300 MB free so the phone keeps working. Clear some space, then try again.",
  );
  assert.equal(KEEP_FREE_BYTES, 300_000_000);

  p.disk.free = 2e9; // photos moved off the phone
  p.manager.retry();
  await settle();
  assert.equal(p.live().length, 1);
});

test('asks for a new link when the old one has run out, and gives up after the host refuses twice', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1'), course);
  await settle();
  p.live()[0].drop(403);
  await settle();
  assert.deepEqual(p.posts(), ['ch-1', 'ch-1']);
  assert.equal(p.live()[0].job.name, 'ch-1-2.mp4'); // a fresh file for the fresh attempt
  p.live()[0].drop(403);
  await settle();
  assert.equal(p.item('ch-1').state, 'failed');
  assert.equal(p.item('ch-1').problem.message, "The download didn't go through. Try again in a while.");

  // A chapter whose copy Bunny never made.
  p.manager.add(chapters('ch-2'), course);
  await settle();
  p.live()[0].drop(404);
  await settle();
  assert.deepEqual(p.item('ch-2').problem, { code: 'not_downloadable', message: "This chapter can't be downloaded yet. It still plays here as usual." });
});

test('when the connection or the server falters, waits a little longer each time before trying again', async () => {
  const p = await signedIn();
  p.state.refuse = (path) => (path === '/v1/downloads' ? new ApiProblem(503, 'unavailable', 'Back soon.') : null);
  p.manager.add(chapters('ch-1'), course);
  await settle();
  assert.equal(p.snap().waiting, 'retrying');
  await p.advance(29_000);
  assert.equal(p.posts().length, 1);
  await p.advance(1_000);
  assert.equal(p.posts().length, 2); // after 30 seconds
  await p.advance(59_000);
  assert.equal(p.posts().length, 2);
  await p.advance(1_000);
  assert.equal(p.posts().length, 3); // then a minute
  p.state.refuse = null;
  await p.advance(120_000);
  assert.equal(p.live().length, 1);

  // A dropped connection mid-download keeps the bytes (Android carries on from the file).
  p.live()[0].progress(50_000_000, 100_000_000);
  p.live()[0].drop(undefined, { offset: 50_000_000 });
  await settle();
  assert.equal(p.item('ch-1').state, 'paused');
  await p.advance(30_000);
  assert.deepEqual(p.live()[0].job.resume, { offset: 50_000_000 });
});

test('locked or missing chapters fail on their own; the rest of the queue goes on', async () => {
  const p = await signedIn();
  p.state.refuse = (path, body) =>
    path === '/v1/downloads' && body.chapterId === 'ch-1' ? new ApiProblem(402, 'locked', 'Downloads come with the course. Unlock it to keep its chapters on your phone.') : null;
  p.manager.add(chapters('ch-1', 'ch-2'), course);
  await settle();
  assert.deepEqual(p.item('ch-1').problem, { code: 'locked', message: 'Downloads come with the course. Unlock it to keep its chapters on your phone.' });
  assert.deepEqual(p.posts(), ['ch-1', 'ch-2']);
});

test('check-ins renew what the member may keep and delete the rest, saying why', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1', 'ch-2', 'ch-3'), course);
  await settle();
  await p.finishAll();
  assert.deepEqual(p.checks().at(-1), []); // the one at sign-in, before anything was saved

  p.state.now += 7 * DAY;
  p.state.verdicts = { 'ch-2': { chapterId: 'ch-2', keep: false, reason: 'replaced' } };
  await p.manager.checkIn();
  await settle();
  assert.deepEqual(p.checks().at(-1), ['ch-1', 'ch-2', 'ch-3']);
  assert.equal(Date.parse(p.item('ch-1').keepUntil), p.state.now + 30 * DAY);
  // The instructor put up a new take of Day 2: it downloads again.
  assert.equal(p.item('ch-2').state, 'downloading');
  assert.equal(p.disk.files.has('ch-2-1.mp4'), false);
  await p.finishAll();
  assert.equal(p.item('ch-2').file, 'ch-2-2.mp4');

  // The subscription it came with ran out.
  p.state.verdicts = Object.fromEntries(['ch-1', 'ch-2', 'ch-3'].map((id) => [id, { chapterId: id, keep: false, reason: 'subscription_ended' }]));
  await p.manager.checkIn(true);
  await settle();
  assert.deepEqual(p.snap().items, []);
  assert.deepEqual([...p.disk.files.keys()], []);
  assert.equal(p.snap().notices[0].text, 'Gentle spine: 3 downloaded chapters came off this phone. Your subscription to Asha Rao has ended.');
  assert.deepEqual(p.snap().courses, {});
});

test('a phone taken off the list elsewhere deletes everything at its next check-in', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1'), course);
  await settle();
  await p.finishAll();
  p.state.verdicts = { 'ch-1': { chapterId: 'ch-1', keep: false, reason: 'device_removed' } };
  await p.manager.checkIn(true);
  assert.deepEqual(p.snap().items, []);
  assert.match(p.snap().notices[0].text, /^This phone was taken off your list of phones with downloads/);
});

test('plays offline only inside the keep date, and keeps the place the member got to', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-3'), course);
  await settle();
  await p.finishAll(14_000_000);
  assert.equal(p.item('ch-3').file, 'ch-3-1.m4a');
  p.manager.savePosition('ch-3', 421.7);
  assert.deepEqual(p.manager.playable('ch-3').item.position, { s: 421, at: new Date(p.state.now).toISOString() });

  await p.setNet({ connected: false, wifi: false });
  p.state.now += 31 * DAY; // a month away from any connection
  assert.equal(p.manager.playable('ch-3'), null);
  assert.ok(p.manager.saved('ch-3')); // the file is still there for when the server says yes
  await p.setNet({ connected: true, wifi: true }); // back online: checks in at once
  assert.ok(p.manager.playable('ch-3'));
});

test('the next launch picks up: finished ones kept, unfinished ones restarted, cleared ones flagged, strays deleted', async () => {
  const first = await signedIn();
  first.manager.add(chapters('ch-1', 'ch-2', 'ch-3'), course);
  await settle();
  first.live()[0].finish(100_000_000);
  await settle();
  first.live()[0].progress(20_000_000, 120_000_000); // ch-2, when the app was swiped away
  await first.advance(5_000);
  const disk = first.disk;
  disk.files.set('ch-2-1.mp4', 20_000_000);
  disk.files.set('ch-9-4.mp4', 5_000_000); // left from something long gone
  disk.files.delete('ch-1-1.mp4'); // the phone cleared space

  const next = phone({ disk });
  await next.manager.start();
  await next.manager.setUser(MEMBER);
  await settle();
  assert.deepEqual(next.item('ch-1').problem, { code: 'missing', message: 'Not on this phone any more. Download it again.' });
  assert.equal(next.disk.files.has('ch-9-4.mp4'), false);
  assert.deepEqual(next.posts(), ['ch-2']);
  assert.equal(next.live()[0].job.name, 'ch-2-2.mp4');
  assert.equal(next.snap().deviceId, 'install-android-0001'); // the same phone to the server
});

test('belongs to one member: signing out or someone else signing in deletes it all, with a new phone ID', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1'), course);
  await settle();
  await p.finishAll();
  await p.manager.forget();
  assert.deepEqual(p.state.calls.at(-1).slice(0, 2), ['DELETE', '/v1/downloads/devices/install-android-0001']);
  assert.deepEqual(p.snap().items, []);
  assert.equal(p.disk.files.size, 0);
  assert.equal(p.snap().deviceId, 'install-android-0002');

  await p.manager.setUser(MEMBER);
  p.manager.add(chapters('ch-1'), course);
  await settle();
  await p.finishAll();
  await p.manager.setUser('another-member-on-the-same-phone');
  assert.deepEqual(p.snap().items, []);
  assert.equal(p.disk.files.size, 0);
});

test('removing the last download tells the server, so the phone stops taking a place', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1', 'ch-2'), course);
  await settle();
  await p.finishAll();
  await p.manager.remove('ch-2');
  assert.deepEqual([...p.disk.files.keys()], ['ch-1-1.mp4']);
  await p.manager.removeCourse(course.id);
  await p.advance(1_500);
  assert.deepEqual(p.checks().at(-1), []);
  assert.deepEqual(p.snap().courses, {});
});

test('pausing stops the download under way and keeps it; resuming carries on', async () => {
  const p = await signedIn();
  p.manager.add(chapters('ch-1'), course);
  await settle();
  p.live()[0].progress(60_000_000, 100_000_000);
  p.manager.pause();
  await settle();
  assert.equal(p.item('ch-1').state, 'paused');
  assert.equal(p.snap().waiting, 'paused');
  p.manager.resume();
  await settle();
  assert.deepEqual(p.live()[0].job.resume, { offset: 60_000_000 });

  // Removing a chapter while it downloads stops it and deletes the part saved.
  await p.manager.remove('ch-1');
  await settle();
  assert.equal(p.state.transfers.at(-1).state, 'cancelled');
  assert.equal(p.disk.files.size, 0);
});
