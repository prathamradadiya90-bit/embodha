import { eq } from 'drizzle-orm';
import { chapters, entitlements, instructorSubscriptions, mediaAssets, users } from '../src/db/schema';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TEST_ENV, TestApp } from './helpers';

describe('Catalogue and playback', () => {
  let t: TestApp;
  let f: Fixtures;
  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  const play = (chapterId: string, token?: string) => {
    const req = t.http().get(`/v1/chapters/${chapterId}/playback`);
    return token ? req.set(bearer(token)) : req;
  };
  const userId = async (email: string) => (await t.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;

  it('lists categories with their topics', async () => {
    const res = await t.http().get('/v1/categories').expect(200);
    // The draft course doesn't count.
    expect(res.body).toEqual([
      { slug: 'yoga', name: 'Yoga', icon: null, topics: [{ slug: 'back-care', name: 'Back care', coverUrl: null, courseCount: 2 }] },
    ]);
  });

  it("prices courses in the buyer's currency", async () => {
    const guest = await t.http().get('/v1/courses/gentle-spine').expect(200);
    expect(guest.body.price).toEqual({ currency: 'INR', amountMinor: 99_900, display: '₹999' });
    expect(guest.body.instructorSubscription).toEqual({ price: { currency: 'INR', amountMinor: 49_900, display: '₹499' } });
    expect(guest.body.access).toEqual({ unlocked: false, via: null });
    expect(guest.body.chapters.map((c: { playable: boolean }) => c.playable)).toEqual([true, false, false]);

    const usd = await t.http().get('/v1/courses/gentle-spine?currency=usd').expect(200);
    expect(usd.body.price.display).toBe('$12');

    const { accessToken } = await signIn(t, 'abroad@embodha.test');
    await t.http().patch('/v1/me').set(bearer(accessToken)).send({ country: 'GB' }).expect(200);
    const member = await t.http().get('/v1/courses/gentle-spine').set(bearer(accessToken)).expect(200);
    expect(member.body.price.currency).toBe('USD');

    const topic = await t.http().get('/v1/topics/back-care').expect(200);
    expect(topic.body.courses.map((c: { slug: string }) => c.slug).sort()).toEqual(['gentle-spine', 'morning-breath']);
  });

  it('plays the free course and preview chapters for anyone, on signed URLs', async () => {
    const res = await play(f.freeChapter.id).expect(200);
    expect(res.body.url).toMatch(/^https:\/\/vz-test\.b-cdn\.net\/bcdn_token=[\w-]+&token_path=%2F[\w-]+%2F&expires=\d+\/[\w-]+\/playlist\.m3u8$/);
    expect(res.body).toMatchObject({ type: 'video', durationS: 600, resumePositionS: 0, title: 'Arrive', next: null });
    const preview = await play(f.preview.id).expect(200);
    // The next chapter is offered even though it's locked; the app shows the unlock options when it's tapped.
    expect(preview.body).toMatchObject({ course: { slug: 'gentle-spine', title: 'gentle-spine' }, next: { id: f.locked.id, title: 'Day 2' } });
  });

  it('locks paid chapters and says what would unlock them', async () => {
    const res = await play(f.locked.id).expect(402);
    expect(res.body).toMatchObject({
      code: 'locked',
      requiresAccount: true,
      course: { slug: 'gentle-spine' },
      price: { amountMinor: 99_900, display: '₹999' },
      instructorSubscription: { price: { amountMinor: 49_900 } },
    });
  });

  it('unlocks a course the member owns', async () => {
    const email = 'buyer@embodha.test';
    const { accessToken } = await signIn(t, email);
    const denied = await play(f.locked.id, accessToken).expect(402);
    expect(denied.body.requiresAccount).toBe(false);

    await t.db.insert(entitlements).values({ userId: await userId(email), courseId: f.paid.id, source: 'grant' });
    await play(f.locked.id, accessToken).expect(200);
    const detail = await t.http().get('/v1/courses/gentle-spine').set(bearer(accessToken)).expect(200);
    expect(detail.body.access).toEqual({ unlocked: true, via: 'grant' });
    expect(detail.body.chapters.every((c: { playable: boolean }) => c.playable)).toBe(true);
  });

  it("unlocks all of an instructor's courses while a subscription is paid up", async () => {
    const email = 'subscriber@embodha.test';
    const { accessToken } = await signIn(t, email);
    const [subscription] = await t.db
      .insert(instructorSubscriptions)
      .values({
        userId: await userId(email),
        instructorId: f.asha.id,
        channel: 'razorpay',
        externalId: 'sub_test_1',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();
    await play(f.locked.id, accessToken).expect(200);

    // Cancelled and the paid month has run out: locked again.
    await t.db
      .update(instructorSubscriptions)
      .set({ status: 'cancelled', currentPeriodEnd: new Date(Date.now() - 86_400_000) })
      .where(eq(instructorSubscriptions.id, subscription.id));
    await play(f.locked.id, accessToken).expect(402);
  });

  it('says so when a chapter is still processing', async () => {
    const { accessToken } = await signIn(t, 'asha@embodha.test');
    const res = await play(f.processing.id, accessToken).expect(409);
    expect(res.body.code).toBe('not_ready');
  });

  it('hides draft courses from members but lets their instructor preview them', async () => {
    await t.http().get('/v1/courses/draft-course').expect(404);
    await play(f.draftChapter.id).expect(404);
    const { accessToken } = await signIn(t, 'asha@embodha.test');
    await play(f.draftChapter.id, accessToken).expect(200);
  });

  it('plays the dev sample stream as-is in development, and never in production', async () => {
    const url = 'https://streams.example.test/sample.m3u8';
    const [sample] = await t.db.insert(mediaAssets).values({ kind: 'video', provider: 'dev_sample', hostAssetId: url, status: 'ready' }).returning();
    const [chapter] = await t.db
      .insert(chapters)
      .values({ courseId: f.free.id, title: 'Sample', type: 'video', sort: 9, durationS: 300, mediaAssetId: sample.id })
      .returning();
    const res = await play(chapter.id).expect(200);
    expect(res.body).toMatchObject({ url, expiresAt: null, durationS: 300 });

    TEST_ENV.NODE_ENV = 'production';
    try {
      expect((await play(chapter.id).expect(409)).body.code).toBe('not_ready');
    } finally {
      TEST_ENV.NODE_ENV = 'test';
    }
  });

  it('turns away a bad chapter ID and a stale token', async () => {
    await play('not-a-uuid').expect(400);
    const res = await t.http().get('/v1/courses/gentle-spine').set(bearer('stale.token.here')).expect(401);
    expect(res.body.code).toBe('token_expired');
  });
});
