import { eq, sql } from 'drizzle-orm';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { notes, searchLog, staffRoles, users } from '../src/db/schema';
import { AudioService } from '../src/media/audio.service';
import { Clock } from '../src/common/clock';
import { PushService } from '../src/notifications/push.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('Search, reviews, notes, notifications and audio', () => {
  let t: TestApp;
  let f: Fixtures;
  let admin: string;
  let meera: string;
  let ravi: string;

  const call = (token: string | null, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) => {
    const req = t.http()[method](url);
    if (token) req.set(bearer(token));
    return body ? req.send(body) : req;
  };
  const played = (token: string, chapterId: string) =>
    call(token, 'post', '/v1/playback/heartbeats', { events: [{ chapterId, positionS: 30, seconds: 30, at: new Date().toISOString() }] }).expect(200);

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    admin = (await signIn(t, 'boss@embodha.test')).accessToken;
    const [boss] = await t.db.select().from(users).where(eq(users.email, 'boss@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: boss.id, role: 'super_admin' });
    meera = (await signIn(t, 'meera@embodha.test')).accessToken;
    ravi = (await signIn(t, 'ravi@embodha.test')).accessToken;
    await call(meera, 'patch', '/v1/me', { name: 'Meera Krishnan', gender: 'female', birthYear: 1990, country: 'IN' }).expect(200);
    await call(ravi, 'patch', '/v1/me', { name: 'Ravi', gender: 'male', birthYear: 1960, country: 'GB' }).expect(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('finds live courses by title, instructor or topic, and logs what people search for', async () => {
    const slugs = async (q: string) => (await t.http().get(`/v1/search?q=${encodeURIComponent(q)}`).expect(200)).body.courses.map((c: { slug: string }) => c.slug).sort();
    expect(await slugs('spine')).toEqual(['gentle-spine']);
    expect(await slugs('asha')).toEqual(['gentle-spine', 'morning-breath']);
    expect(await slugs('draft')).toEqual([]);
    const topic = await t.http().get('/v1/search?q=back').expect(200);
    expect(topic.body.topics).toEqual([{ slug: 'back-care', name: 'Back care', category: 'Yoga' }]);
    expect((await t.http().get('/v1/search?q=a').expect(200)).body).toEqual({ query: 'a', courses: [], topics: [] });
    const logged = await t.db.select().from(searchLog);
    expect(logged.map((row) => row.query)).toEqual(expect.arrayContaining(['spine', 'asha', 'draft', 'back']));
  });

  it('takes reviews from members who started the course, and keeps the stars honest', async () => {
    const url = '/v1/courses/morning-breath/reviews';
    expect((await call(meera, 'put', `${url}/mine`, { rating: 4 }).expect(403)).body.code).toBe('not_started');

    await played(meera, f.freeChapter.id);
    await played(ravi, f.freeChapter.id);
    await call(meera, 'put', `${url}/mine`, { rating: 4, body: ' Calm and clear. ' }).expect(200);
    await call(ravi, 'put', `${url}/mine`, { rating: 2, body: 'Too slow for me.' }).expect(200);
    let list = (await t.http().get(url).expect(200)).body;
    expect(list).toMatchObject({ average: 3, count: 2, canReview: false, mine: null });
    expect(list.items.map((r: { author: string }) => r.author).sort()).toEqual(['Meera K.', 'Ravi']);
    expect((await call(meera, 'get', url).expect(200)).body).toMatchObject({ canReview: true, mine: { rating: 4, body: 'Calm and clear.' } });

    // Staff hide one and reply to the other; only visible reviews count towards the stars.
    const queue = (await call(admin, 'get', '/v1/admin/reviews').expect(200)).body;
    const raviReview = queue.find((r: { member: { email: string } }) => r.member.email === 'ravi@embodha.test');
    const meeraReview = queue.find((r: { member: { email: string } }) => r.member.email === 'meera@embodha.test');
    await call(admin, 'patch', `/v1/admin/reviews/${raviReview.id}`, { status: 'hidden' }).expect(200);
    await call(admin, 'put', `/v1/admin/reviews/${meeraReview.id}/reply`, { reply: 'Thank you, Meera.' }).expect(200);
    list = (await t.http().get(url).expect(200)).body;
    expect(list).toMatchObject({ average: 4, count: 1, items: [{ author: 'Meera K.', teamReply: 'Thank you, Meera.' }] });
    expect((await t.http().get('/v1/courses/morning-breath').expect(200)).body.rating).toEqual({ average: 4, count: 1 });
    expect((await call(ravi, 'get', url).expect(200)).body.mine).toMatchObject({ rating: 2, hidden: true });

    await call(meera, 'delete', `${url}/mine`).expect(204);
    expect((await t.http().get(url).expect(200)).body).toMatchObject({ average: null, count: 0, items: [] });
  });

  it('keeps notes private and encrypted', async () => {
    const url = `/v1/chapters/${f.freeChapter.id}/notes`;
    const note = (await call(meera, 'post', url, { body: 'Shoulders drop on the out-breath.', timestampS: 42 }).expect(201)).body;
    expect(note).toMatchObject({ body: 'Shoulders drop on the out-breath.', timestampS: 42 });
    const [stored] = await t.db.select().from(notes).where(eq(notes.id, note.id));
    expect(stored.bodyEnc).toMatch(/^v1:/);
    expect(stored.bodyEnc).not.toContain('Shoulders');

    expect((await call(ravi, 'get', url).expect(200)).body).toEqual([]);
    await call(ravi, 'patch', `/v1/notes/${note.id}`, { body: 'mine now' }).expect(404);
    await call(meera, 'patch', `/v1/notes/${note.id}`, { body: 'Shoulders drop. Jaw too.' }).expect(200);
    expect((await call(meera, 'get', url).expect(200)).body.map((n: { body: string }) => n.body)).toEqual(['Shoulders drop. Jaw too.']);
    await call(meera, 'delete', `/v1/notes/${note.id}`).expect(204);
    await call(meera, 'post', url, { body: '   ' }).expect(400);
  });

  it('sends campaigns by gender and age to the bell and to phones', async () => {
    // Midday in India, so the push isn't held for quiet hours whenever the suite happens to run.
    jest.spyOn(t.app.get(Clock), 'now').mockReturnValue(new Date('2026-10-21T06:30:00Z'));
    const push = jest.spyOn(t.app.get(PushService), 'send').mockResolvedValue(1);
    await call(meera, 'post', '/v1/devices', { token: 'ExponentPushToken[meera-phone]', platform: 'ios' }).expect(204);
    await call(ravi, 'post', '/v1/devices', { token: 'not-a-token', platform: 'android' }).expect(400);

    expect((await call(admin, 'post', '/v1/admin/notifications/reach', { audience: { genders: ['female'] } }).expect(200)).body).toEqual({ members: 1, withPush: 1 });
    expect((await call(admin, 'post', '/v1/admin/notifications/reach', { audience: { ageMin: 50 } }).expect(200)).body).toEqual({ members: 1, withPush: 0 });
    expect((await call(admin, 'post', '/v1/admin/notifications/reach', { audience: { countries: ['GB'] } }).expect(200)).body.members).toBe(1);

    const sent = await call(admin, 'post', '/v1/admin/notifications', {
      title: 'A new course is up',
      body: 'Ten minutes for tight hips.',
      deepLink: '/course/morning-breath',
      audience: { genders: ['female'], ageMax: 45 },
    }).expect(201);
    expect(sent.body).toMatchObject({ members: 1, phones: 1 });
    for (let i = 0; i < 50 && !push.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(push).toHaveBeenCalledWith([
      { to: 'ExponentPushToken[meera-phone]', title: 'A new course is up', body: 'Ten minutes for tight hips.', data: { url: '/course/morning-breath', notificationId: sent.body.id } },
    ]);

    expect((await call(meera, 'get', '/v1/notifications/unread').expect(200)).body).toEqual({ unread: 1 });
    expect((await call(meera, 'get', '/v1/notifications').expect(200)).body.items).toEqual([
      expect.objectContaining({ title: 'A new course is up', deepLink: '/course/morning-breath', readAt: null }),
    ]);
    expect((await call(ravi, 'get', '/v1/notifications').expect(200)).body).toEqual({ unread: 0, items: [] });
    expect((await call(meera, 'post', '/v1/notifications/read', {}).expect(200)).body).toEqual({ unread: 0 });
    expect((await call(admin, 'get', '/v1/admin/notifications').expect(200)).body[0]).toMatchObject({ title: 'A new course is up', members: 1, read: 1 });

    await call(meera, 'delete', `/v1/devices/${encodeURIComponent('ExponentPushToken[meera-phone]')}`).expect(204);
    expect((await call(admin, 'post', '/v1/admin/notifications/reach', { audience: { genders: ['female'] } }).expect(200)).body.withPush).toBe(0);
    await call(meera, 'get', '/v1/admin/notifications').expect(403);
  });

  (hasFfmpeg ? it : it.skip)('normalises an audio chapter with ffmpeg, stores it, and plays it back', async () => {
    const put = jest.spyOn(t.app.get(AudioService), 'put').mockResolvedValue();
    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    const course = (await call(asha, 'post', '/v1/studio/courses', { topicId: f.topic.id, title: 'Evening Wind-Down' }).expect(201)).body;
    const chapter = (await call(asha, 'post', `/v1/studio/courses/${course.id}/chapters`, { title: 'Body scan', type: 'audio' }).expect(201)).body;
    const video = (await call(asha, 'post', `/v1/studio/courses/${course.id}/chapters`, { title: 'Stretch', type: 'video' }).expect(201)).body;

    const wav = path.join(mkdtempSync(path.join(tmpdir(), 'embodha-')), 'scan.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-y', wav]);
    expect((await call(asha, 'post', `/v1/studio/chapters/${chapter.id}/upload`).expect(400)).body.code).toBe('audio_chapter');
    expect((await t.http().post(`/v1/studio/chapters/${video.id}/audio`).set(bearer(asha)).attach('file', wav).expect(400)).body.code).toBe('video_chapter');

    const started = await t.http().post(`/v1/studio/chapters/${chapter.id}/audio`).set(bearer(asha)).attach('file', wav).expect(202);
    expect(started.body.status).toBe('processing');
    let media = { status: 'processing', durationS: null as number | null };
    for (let i = 0; i < 150 && media.status === 'processing'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      media = (await call(asha, 'get', `/v1/studio/media/${started.body.mediaId}`).expect(200)).body;
    }
    expect(media).toMatchObject({ status: 'ready', durationS: 3 });
    const storedAs = `audio/${chapter.id}/${started.body.mediaId}.m4a`;
    expect(put).toHaveBeenCalledWith(storedAs, expect.stringMatching(/\.m4a$/));

    const playback = await call(asha, 'get', `/v1/chapters/${chapter.id}/playback`).expect(200);
    expect(playback.body).toMatchObject({ type: 'audio', url: `https://audio-test.b-cdn.net/${storedAs}`, durationS: 3 });
    const [{ n }] = (await t.db.execute(sql`select count(*)::int as n from chapters where id = ${chapter.id} and duration_s = 3`)).rows as { n: number }[];
    expect(n).toBe(1);

    // A playlist pretending to be audio would make ffmpeg read other files on the server. It's refused untouched.
    const sneaky = path.join(mkdtempSync(path.join(tmpdir(), 'embodha-')), 'track.mp3');
    writeFileSync(sneaky, '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    put.mockClear();
    const refused = await t.http().post(`/v1/studio/chapters/${chapter.id}/audio`).set(bearer(asha)).attach('file', sneaky, { contentType: 'audio/mpeg' }).expect(202);
    let outcome = { status: 'processing', error: null as string | null };
    for (let i = 0; i < 150 && outcome.status === 'processing'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      outcome = (await call(asha, 'get', `/v1/studio/media/${refused.body.mediaId}`).expect(200)).body;
    }
    expect(outcome.status).toBe('failed');
    expect(put).not.toHaveBeenCalled();
  });
});
