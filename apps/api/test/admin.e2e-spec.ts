import { eq } from 'drizzle-orm';
import { currentMonth } from '../src/common/month';
import { chapters, courses, mediaAssets, staffRoles, users, watchDaily } from '../src/db/schema';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

describe('Admin', () => {
  let t: TestApp;
  let f: Fixtures;
  let admin: string;

  const call = (token: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };
  const staff = async (email: string, role: (typeof staffRoles.$inferInsert)['role']) => {
    const tokens = await signIn(t, email);
    const [user] = await t.db.select().from(users).where(eq(users.email, email));
    await t.db.insert(staffRoles).values({ userId: user.id, role });
    return { token: tokens.accessToken, id: user.id };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    admin = (await staff('boss@embodha.test', 'super_admin')).token;
  });
  afterAll(async () => {
    await t.close();
  });

  it('is for staff only, and each role sees its own part', async () => {
    const member = (await signIn(t, 'member@embodha.test')).accessToken;
    expect((await call(member, 'get', '/v1/admin/overview').expect(403)).body.code).toBe('not_staff');

    const support = (await staff('help@embodha.test', 'support')).token;
    await call(support, 'get', '/v1/admin/users').expect(200);
    const denied = await call(support, 'post', `/v1/admin/instructors/${f.asha.id}/share`, { percentBps: 9000 }).expect(403);
    expect(denied.body).toMatchObject({ code: 'forbidden', message: 'This needs the finance role.' });
  });

  it('adds an instructor by email, who can then sign in to the studio', async () => {
    const added = await call(admin, 'post', '/v1/admin/instructors', { email: ' Ravi@Embodha.test ', displayName: 'Ravi Menon' }).expect(201);
    expect(added.body).toMatchObject({ slug: 'ravi-menon', email: 'ravi@embodha.test', status: 'approved', sharePercentBps: 6000 });
    await call(admin, 'post', '/v1/admin/instructors', { email: 'ravi@embodha.test', displayName: 'Ravi again' }).expect(409);

    const ravi = (await signIn(t, 'ravi@embodha.test')).accessToken;
    expect((await call(ravi, 'get', '/v1/studio/me').expect(200)).body).toMatchObject({ sharePercentBps: 6000, plan: { enabled: false } });

    await call(admin, 'post', `/v1/admin/instructors/${added.body.id}/share`, { percentBps: 7000, reason: 'Signed the yearly deal' }).expect(200);
    expect((await call(ravi, 'get', '/v1/studio/me').expect(200)).body.sharePercentBps).toBe(7000);
    const list = await call(admin, 'get', '/v1/admin/instructors').expect(200);
    expect(list.body.find((i: { id: string }) => i.id === added.body.id)).toMatchObject({ sharePercentBps: 7000, courses: { total: 0 } });

    await call(admin, 'patch', `/v1/admin/instructors/${added.body.id}`, { status: 'suspended' }).expect(200);
    expect((await call(ravi, 'get', '/v1/studio/me').expect(403)).body.code).toBe('not_instructor');
  });

  it('takes a course from draft, through review, to live', async () => {
    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    const course = (await call(asha, 'post', '/v1/studio/courses', { topicId: f.topic.id, title: 'Shoulders After Desk Work' }).expect(201)).body;
    expect((await call(asha, 'post', `/v1/studio/courses/${course.id}/submit`).expect(409)).body.code).toBe('no_chapters');

    const chapter = (await call(asha, 'post', `/v1/studio/courses/${course.id}/chapters`, { title: 'Neck release', type: 'video' }).expect(201)).body;
    const notReady = await call(asha, 'post', `/v1/studio/courses/${course.id}/submit`).expect(409);
    expect(notReady.body).toMatchObject({ code: 'chapters_not_ready', chapters: ['Neck release'] });
    const [video] = await t.db.insert(mediaAssets).values({ kind: 'video', provider: 'bunny_stream', hostAssetId: 'guid-shoulders', status: 'ready' }).returning();
    await t.db.update(chapters).set({ mediaAssetId: video.id, durationS: 480 }).where(eq(chapters.id, chapter.id));
    expect((await call(asha, 'post', `/v1/studio/courses/${course.id}/submit`).expect(409)).body.code).toBe('no_price');

    await call(asha, 'patch', `/v1/studio/courses/${course.id}`, { pricePointId: f.paid.pricePointId }).expect(200);
    expect((await call(asha, 'post', `/v1/studio/courses/${course.id}/submit`).expect(200)).body.status).toBe('in_review');
    const overview = await call(admin, 'get', '/v1/admin/overview').expect(200);
    expect(overview.body.reviewQueue).toEqual([expect.objectContaining({ id: course.id, instructor: 'Asha Rao' })]);

    // Sent back with a note the instructor sees, then resubmitted and published.
    await call(admin, 'post', `/v1/admin/courses/${course.id}/review`, { decision: 'return' }).expect(400);
    await call(admin, 'post', `/v1/admin/courses/${course.id}/review`, { decision: 'return', comments: 'Add a caution for neck injuries.' }).expect(200);
    const returned = await call(asha, 'get', `/v1/studio/courses/${course.id}`).expect(200);
    expect(returned.body).toMatchObject({ status: 'draft', review: { decision: 'rejected', comments: 'Add a caution for neck injuries.' } });

    await call(asha, 'post', `/v1/studio/courses/${course.id}/submit`).expect(200);
    const listed = await call(admin, 'get', '/v1/admin/courses?status=in_review').expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: course.id, price: '₹999', chapters: 1, readyChapters: 1 })]);
    await call(admin, 'post', `/v1/admin/courses/${course.id}/review`, { decision: 'publish' }).expect(200);
    await t.http().get(`/v1/courses/${course.slug}`).expect(200);

    // Nobody owns it yet, so it can be archived; the free course can't be.
    await call(admin, 'post', `/v1/admin/courses/${course.id}/archive`).expect(200);
    expect((await call(admin, 'post', `/v1/admin/courses/${f.free.id}/archive`).expect(409)).body.code).toBe('free_course');
  });

  it('moves the free course', async () => {
    await call(admin, 'post', `/v1/admin/courses/${f.paid.id}/free`).expect(200);
    const rows = await t.db.select({ id: courses.id, isFree: courses.isFree }).from(courses).where(eq(courses.isFree, true));
    expect(rows).toEqual([{ id: f.paid.id, isFree: true }]);
    await call(admin, 'post', `/v1/admin/courses/${f.free.id}/free`).expect(200);
  });

  it('looks after members: search, suspend, gift a course, delete', async () => {
    const member = (await signIn(t, 'meera@embodha.test')).accessToken;
    const found = await call(admin, 'get', '/v1/admin/users?q=meera').expect(200);
    expect(found.body).toMatchObject({ total: 1, items: [{ email: 'meera@embodha.test', instructor: false, staff: [] }] });
    const id = found.body.items[0].id;

    await call(admin, 'patch', `/v1/admin/users/${id}`, { status: 'suspended' }).expect(200);
    expect((await call(member, 'get', '/v1/me').expect(401)).body.code).toBe('account_unavailable');
    await call(admin, 'patch', `/v1/admin/users/${id}`, { status: 'active' }).expect(200);
    await call(member, 'get', '/v1/me').expect(200);

    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(402);
    await call(admin, 'post', `/v1/admin/users/${id}/grants`, { courseId: f.paid.id }).expect(201);
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);
    expect((await call(admin, 'get', `/v1/admin/users/${id}`).expect(200)).body.courses).toEqual([
      expect.objectContaining({ courseId: f.paid.id, source: 'grant' }),
    ]);
    await call(admin, 'delete', `/v1/admin/users/${id}/grants/${f.paid.id}`).expect(204);
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(402);

    const me = (await call(admin, 'get', '/v1/me').expect(200)).body;
    expect((await call(admin, 'patch', `/v1/admin/users/${me.id}`, { status: 'suspended' }).expect(400)).body.code).toBe('own_account');
    expect((await call(admin, 'delete', `/v1/admin/users/${id}`).expect(202)).body.status).toBe('deleting');

    const created = await call(admin, 'post', '/v1/admin/users', { email: 'gift@embodha.test', name: 'Gift' }).expect(201);
    expect(created.body).toMatchObject({ email: 'gift@embodha.test', status: 'active' });
    await call(admin, 'post', '/v1/admin/users', { email: 'gift@embodha.test' }).expect(409);
  });

  it('adds categories hidden, and shows them once switched on', async () => {
    const category = (await call(admin, 'post', '/v1/admin/categories', { name: 'Sleep stories' }).expect(201)).body;
    expect(category).toMatchObject({ slug: 'sleep-stories', active: false });
    await call(admin, 'post', '/v1/admin/topics', { categoryId: category.id, name: 'Rain sounds' }).expect(201);
    expect((await t.http().get('/v1/categories').expect(200)).body.map((c: { slug: string }) => c.slug)).not.toContain('sleep-stories');

    await call(admin, 'patch', `/v1/admin/categories/${category.id}`, { active: true }).expect(200);
    const live = (await t.http().get('/v1/categories').expect(200)).body.find((c: { slug: string }) => c.slug === 'sleep-stories');
    expect(live.topics).toEqual([{ slug: 'rain-sounds', name: 'Rain sounds', coverUrl: null, courseCount: 0 }]);
  });

  it("reports each instructor's minutes for the month", async () => {
    const [someone] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'member@embodha.test'));
    const [other] = await t.db.select({ id: users.id }).from(users).where(eq(users.email, 'boss@embodha.test'));
    const date = `${currentMonth()}-01`;
    await t.db.insert(watchDaily).values([
      { userId: someone.id, chapterId: f.freeChapter.id, instructorId: f.asha.id, date, seconds: 600 },
      { userId: other.id, chapterId: f.preview.id, instructorId: f.asha.id, date, seconds: 330 },
    ]);
    const report = await call(admin, 'get', '/v1/admin/reports/watch').expect(200);
    expect(report.body).toMatchObject({
      month: currentMonth(),
      rows: [{ instructor: { displayName: 'Asha Rao' }, minutes: 15, members: 2 }],
      totals: { minutes: 15, members: 2 },
    });
    await call(admin, 'get', '/v1/admin/reports/watch?month=2026-13').expect(400);
  });

  it('sets the quote of the day that the app shows', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await call(admin, 'put', `/v1/admin/daily/${today}`, { text: 'Slow is smooth.', author: 'A teacher' }).expect(200);
    expect((await t.http().get(`/v1/home?date=${today}`).expect(200)).body.daily).toEqual({ type: 'quote', text: 'Slow is smooth.', author: 'A teacher' });
    expect((await call(admin, 'get', `/v1/admin/daily?from=${today}`).expect(200)).body).toEqual([
      { date: today, type: 'quote', text: 'Slow is smooth.', author: 'A teacher', width: null, height: null, media: null },
    ]);
    await call(admin, 'put', '/v1/admin/daily/2026-02-31', { text: 'Nope' }).expect(400);
    await call(admin, 'delete', `/v1/admin/daily/${today}`).expect(204);
    expect((await t.http().get(`/v1/home?date=${today}`).expect(200)).body.daily).toBeNull();
  });
});
