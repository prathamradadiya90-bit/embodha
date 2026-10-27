import { and, eq } from 'drizzle-orm';
import { breathingPatterns, breathingSessions, chapterProgress, entitlements, users, watchDaily } from '../src/db/schema';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

describe('Practice: breathing, streaks, progress, home and library', () => {
  let t: TestApp;
  let f: Fixtures;
  let token: string;
  let userId: string;
  const progressOf = async (chapterId: string) =>
    (await t.db.select().from(chapterProgress).where(and(eq(chapterProgress.userId, userId), eq(chapterProgress.chapterId, chapterId))))[0];
  const beat = (chapterId: string, positionS: number, seconds: number, offsetMs = 0) => ({
    chapterId,
    positionS,
    seconds,
    at: new Date(Date.now() + offsetMs).toISOString(),
  });

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    await t.db.insert(breathingPatterns).values({ slug: 'box', name: 'Box breathing', inhaleS: 4, holdInS: 4, exhaleS: 4, holdOutS: 4, rounds: 6 });
    token = (await signIn(t, 'practice@embodha.test')).accessToken;
    [{ id: userId }] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'practice@embodha.test'));
    await t.db.insert(entitlements).values({ userId, courseId: f.paid.id, source: 'grant' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('serves breathing patterns to guests and logs sessions for members', async () => {
    const patterns = await t.http().get('/v1/breathing/patterns').expect(200);
    expect(patterns.body[0]).toMatchObject({ slug: 'box', inhaleS: 4, rounds: 6 });
    const stats = await t.http().post('/v1/breathing/sessions').set(bearer(token)).send({ patternId: patterns.body[0].id, seconds: 96 }).expect(201);
    expect(stats.body).toEqual({ streakDays: 1, practicedToday: true, totalMinutes: 1, breathingSessions: 1 });
  });

  it("counts a streak in the member's own time zone", async () => {
    await t.http().patch('/v1/me').set(bearer(token)).send({ timezone: 'Asia/Kolkata' }).expect(200);
    const day = 86_400_000;
    await t.db.insert(breathingSessions).values([
      { userId, seconds: 60, completedAt: new Date(Date.now() - day) },
      { userId, seconds: 60, completedAt: new Date(Date.now() - 2 * day) },
      { userId, seconds: 60, completedAt: new Date(Date.now() - 4 * day) },
    ]);
    const stats = await t.http().get('/v1/me/stats').set(bearer(token)).expect(200);
    // Today, yesterday and the day before; the gap on day four ends it.
    expect(stats.body.streakDays).toBe(3);
  });

  it('turns heartbeats into progress and marks a chapter complete near the end', async () => {
    const first = await t
      .http()
      .post('/v1/playback/heartbeats')
      .set(bearer(token))
      .send({ events: [beat(f.locked.id, 120, 30), beat(f.locked.id, 150, 30, 1000)] })
      .expect(200);
    expect(first.body).toEqual({ accepted: 2, ignored: 0 });
    expect(await progressOf(f.locked.id)).toMatchObject({ positionS: 150, completedAt: null });
    const [watched] = await t.db.select().from(watchDaily).where(eq(watchDaily.userId, userId));
    expect(watched.seconds).toBe(60);

    await t.http().post('/v1/playback/heartbeats').set(bearer(token)).send({ events: [beat(f.locked.id, 580, 30, 2000)] }).expect(200);
    expect((await progressOf(f.locked.id)).completedAt).not.toBeNull();
    const course = await t.http().get('/v1/courses/gentle-spine').set(bearer(token)).expect(200);
    expect(course.body.chapters[1].progress).toEqual({ positionS: 580, completed: true });
  });

  it('lets heartbeats from a download played offline count for their own day, without moving a newer place back', async () => {
    // Watched on the train two days ago with no signal; the phone only now gets them through.
    const twoDaysAgo = -2 * 86_400_000;
    await t
      .http()
      .post('/v1/playback/heartbeats')
      .set(bearer(token))
      .send({ events: [beat(f.locked.id, 200, 30, twoDaysAgo), beat(f.locked.id, 230, 30, twoDaysAgo + 30_000)] })
      .expect(200);
    expect(await progressOf(f.locked.id)).toMatchObject({ positionS: 580 }); // the place reached since stays
    expect((await progressOf(f.locked.id)).completedAt).not.toBeNull();
    const days = await t.db.select().from(watchDaily).where(and(eq(watchDaily.userId, userId), eq(watchDaily.chapterId, f.locked.id)));
    expect(days).toHaveLength(2); // the train day has its own minutes

    // A first play of another chapter, only ever offline, still saves the place.
    await t.http().post('/v1/playback/heartbeats').set(bearer(token)).send({ events: [beat(f.preview.id, 90, 30, twoDaysAgo)] }).expect(200);
    expect(await progressOf(f.preview.id)).toMatchObject({ positionS: 90, completedAt: null });
    // And a later one moves it on.
    await t.http().post('/v1/playback/heartbeats').set(bearer(token)).send({ events: [beat(f.preview.id, 140, 30)] }).expect(200);
    expect(await progressOf(f.preview.id)).toMatchObject({ positionS: 140 });
  });

  it("drops heartbeats for chapters the member can't play", async () => {
    const { accessToken } = await signIn(t, 'stranger@embodha.test');
    const res = await t.http().post('/v1/playback/heartbeats').set(bearer(accessToken)).send({ events: [beat(f.locked.id, 10, 10)] }).expect(200);
    expect(res.body).toEqual({ accepted: 0, ignored: 1 });
  });

  it('builds the home screen in one call, for guests and members', async () => {
    const guest = await t.http().get('/v1/home').expect(200);
    expect(guest.body).toMatchObject({ breathing: { slug: 'box' }, freeCourse: { slug: 'morning-breath' }, continueWatching: [], daily: null });
    expect(guest.body.newCourses.map((c: { slug: string }) => c.slug)).toEqual(['gentle-spine']);
    expect(guest.body.categories[0].slug).toBe('yoga');

    await t.http().post('/v1/playback/heartbeats').set(bearer(token)).send({ events: [beat(f.preview.id, 60, 30)] }).expect(200);
    const member = await t.http().get('/v1/home').set(bearer(token)).expect(200);
    expect(member.body.continueWatching).toEqual([
      { positionS: 60, chapter: expect.objectContaining({ id: f.preview.id }), course: expect.objectContaining({ slug: 'gentle-spine' }) },
    ]);
  });

  it('lists owned and started courses in the library, for members only', async () => {
    const res = await t.http().get('/v1/library').set(bearer(token)).expect(200);
    expect(res.body.courses.map((c: { slug: string }) => c.slug)).toEqual(['gentle-spine']);
    await t.http().get('/v1/library').expect(401);
  });
});
