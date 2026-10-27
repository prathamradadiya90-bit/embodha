import { and, eq, sql } from 'drizzle-orm';
import { activeDays, events, installDays, installs, payments, splits, staffRoles, users, watchDaily } from '../src/db/schema';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, latestMail, signIn, TestApp } from './helpers';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('Analytics', () => {
  let t: TestApp;
  let f: Fixtures;
  let staff: string;
  const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0].id;
  const send = (body: object, token?: string) => {
    const req = t.http().post('/v1/events');
    return (token ? req.set(bearer(token)) : req).send(body);
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    staff = (await signIn(t, 'numbers@embodha.test')).accessToken;
    await t.db.insert(staffRoles).values({ userId: await userId('numbers@embodha.test'), role: 'content' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('takes batches from guests and members, and drops what it does not know', async () => {
    const guest = await send({
      anonId: 'device-guest-0001',
      platform: 'android',
      appVersion: '1.0.0',
      events: [
        { name: 'app_open', at: new Date().toISOString() },
        { name: 'course_view', props: { courseId: f.paid.id, slug: 'gentle-spine' } },
        { name: 'screen_view', props: { screen: '/explore', nested: { a: 1 }, 'bad key': 'x', long: 'y'.repeat(500) } },
        { name: 'made_up_event' },
      ],
    }).expect(200);
    expect(guest.body).toEqual({ accepted: 3, dropped: 1 });
    const [screen] = await t.db.select().from(events).where(eq(events.name, 'screen_view'));
    expect(screen).toMatchObject({ userId: null, anonId: 'device-guest-0001', platform: 'android', appVersion: '1.0.0', clientAt: null });
    expect(screen.props).toEqual({ screen: '/explore', long: 'y'.repeat(200) });
    const [open] = await t.db.select().from(events).where(eq(events.name, 'app_open'));
    expect(open.clientAt).toBeInstanceOf(Date);

    // A clock that's a month out is ignored rather than trusted.
    await send({ anonId: 'device-guest-0001', platform: 'android', events: [{ name: 'breath_start', at: ago(40).toISOString() }] }).expect(200);
    expect((await t.db.select().from(events).where(eq(events.name, 'breath_start')))[0].clientAt).toBeNull();
    await t.db.delete(events).where(eq(events.name, 'breath_start'));

    const member = await signIn(t, 'browser@embodha.test');
    const batch = ['app_open', 'course_view', 'locked_view', 'purchase_start', 'purchase_done'].map((name) => ({ name, props: { courseId: f.paid.id } }));
    await send({ anonId: 'device-member-0002', platform: 'ios', events: batch }, member.accessToken).expect(200);
    expect(await t.db.select().from(events).where(eq(events.userId, await userId('browser@embodha.test')))).toHaveLength(5);

    await send({ platform: 'ios', events: [] }).expect(400);
    await send({ anonId: 'short', platform: 'ios', events: [] }).expect(400);
    await send({ anonId: 'device-guest-0001', platform: 'windows', events: [] }).expect(400);
    await send({ anonId: 'device-guest-0001', platform: 'web', events: Array(51).fill({ name: 'app_open' }) }).expect(400);
  });

  it('adds it up for admin: who is active, who starts practising, who buys, who comes back', async () => {
    // Today: a new member finishes a breath. Ten days ago someone joined and practised two days later; twenty days ago
    // someone joined and never came back.
    const fresh = await signIn(t, 'new@embodha.test');
    await t.http().post('/v1/breathing/sessions').set(bearer(fresh.accessToken)).send({ seconds: 120 }).expect(201);
    const ten = await signIn(t, 'tenday@embodha.test');
    const tenDay = await userId('tenday@embodha.test');
    await t.db.update(users).set({ createdAt: ago(10) }).where(eq(users.id, tenDay));
    // Two days after joining they played a minute of the free course; the phone sent it in a late batch.
    await t
      .http()
      .post('/v1/playback/heartbeats')
      .set(bearer(ten.accessToken))
      .send({ events: [{ chapterId: f.freeChapter.id, positionS: 60, seconds: 60, at: ago(8).toISOString() }] })
      .expect(200);
    await t.db.insert(watchDaily).values({ userId: tenDay, chapterId: f.locked.id, instructorId: f.asha.id, date: ago(8).toISOString().slice(0, 10), seconds: 600 });
    await signIn(t, 'quiet@embodha.test');
    const quiet = await userId('quiet@embodha.test');
    await t.db.update(users).set({ createdAt: ago(20) }).where(eq(users.id, quiet));

    // Someone looks at the course as a guest, signs in on the same phone and looks again: one person, not two.
    await send({ anonId: 'device-switch-0003', platform: 'web', events: [{ name: 'course_view', props: { courseId: f.paid.id } }] }).expect(200);
    const switcher = await signIn(t, 'switch@embodha.test');
    await send({ anonId: 'device-switch-0003', platform: 'web', events: [{ name: 'course_view', props: { courseId: f.paid.id } }] }, switcher.accessToken).expect(200);
    // Looking at a course you already have isn't a chance to sell it.
    await send({ anonId: 'device-new-00004', platform: 'ios', events: [{ name: 'course_view', props: { courseId: f.paid.id, owned: true } }] }, fresh.accessToken).expect(200);
    // Staff poking around the app aren't members.
    await send({ anonId: 'device-staff-0005', platform: 'ios', events: [{ name: 'course_view', props: { courseId: f.paid.id } }] }, staff).expect(200);

    // The member who looked bought it; the new member's purchase was a Play test, which doesn't count.
    const sale = (
      await t.db
        .insert(payments)
        .values({
          userId: await userId('browser@embodha.test'),
          channel: 'razorpay',
          externalId: 'pay_analytics',
          kind: 'course',
          courseId: f.paid.id,
          instructorId: f.asha.id,
          currency: 'INR',
          grossMinor: 99_900,
          gstMinor: 15_239,
          feeMinor: 2358,
          netMinor: 82_303,
          netInrPaise: 82_303,
          status: 'captured',
          capturedAt: new Date(),
        })
        .returning()
    )[0];
    await t.db.insert(splits).values({ paymentId: sale.id, instructorId: f.asha.id, netInrPaise: 82_303, percentBps: 6000, instructorPaise: 49_382, embodhaPaise: 32_921 });
    await t.db.insert(payments).values({
      userId: await userId('new@embodha.test'),
      channel: 'google',
      externalId: 'GPA.test-0001',
      kind: 'course',
      courseId: f.paid.id,
      instructorId: f.asha.id,
      currency: 'INR',
      grossMinor: 99_900,
      netMinor: 0,
      netInrPaise: 0,
      status: 'captured',
      isTest: true,
      capturedAt: new Date(),
    });

    const report = (await t.http().get('/v1/admin/analytics?days=30').set(bearer(staff)).expect(200)).body;

    // Active today: the browsing member, the new member's breath, the member who switched. Not the staff account.
    expect(report.active).toMatchObject({ today: 3, week: 3, month: 4 });
    expect(report.active.daily).toHaveLength(30);
    // The guest phone counts; the phone that signed in later the same day is the member's, not a guest's.
    expect(report.active.daily[29]).toEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), members: 3, guests: 1 });
    // Four member-days in the last thirty, over four members: 1/30 of the month, on average, each day.
    expect(report.active.stickinessBps).toBe(333);

    // Six people joined (Asha, browser, switch, new, tenday, quiet; not staff). Two practised in their first week;
    // three of the others joined today and still have time.
    expect(report.activation).toEqual({ signups: 6, practised: 2, rateBps: 3333, waiting: 3 });

    // Three people looked at the paid course (the guest phone, the browsing member, the switcher); one bought it.
    expect(report.courses).toMatchObject({ viewers: 3, buyers: 1, rateBps: 3333 });
    expect(report.courses.top).toEqual([{ title: 'gentle-spine', slug: 'gentle-spine', viewers: 3, buyers: 1, rateBps: 3333 }]);
    expect(report.lockedFunnel).toEqual({ locked: 1, started: 1, done: 1 });
    expect(report.topCourses).toEqual([
      { title: 'gentle-spine', slug: 'gentle-spine', minutes: 10 },
      { title: 'morning-breath', slug: 'morning-breath', minutes: 1 },
    ]);
    expect(report.topTeachers).toEqual([{ name: 'Asha Rao', minutes: 11, earnedPaise: 49_382 }]);

    // Week one: the ten-day member came back after their first day; the twenty-day one didn't. This week's joiners
    // haven't had their week yet, so that row isn't final.
    const weekOf = async (id: string) =>
      ((await t.db.execute(sql`select to_char(date_trunc('week', created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as w from users where id = ${id}`)).rows[0] as { w: string }).w;
    const cohort = (week: string) => report.weekOne.find((c: { week: string }) => c.week === week);
    expect(cohort(await weekOf(tenDay))).toMatchObject({ signups: 1, returned: 1, rateBps: 10_000 });
    const weekOfQuiet = await weekOf(quiet);
    expect(cohort(weekOfQuiet)).toEqual({ week: weekOfQuiet, final: true, signups: 1, returned: 0, rateBps: 0 });
    expect(report.weekOne[0]).toMatchObject({ week: await weekOf(await userId('switch@embodha.test')), final: false, signups: 4, returned: 0 });

    // A week's view: seven bars, the same stickiness (it's always read over thirty days), and only the weeks the
    // window touches.
    const week = (await t.http().get('/v1/admin/analytics?days=7').set(bearer(staff)).expect(200)).body;
    expect(week.active.daily).toHaveLength(7);
    expect(week.active.stickinessBps).toBe(333);
    expect(week.weekOne.length).toBeLessThanOrEqual(2);
    expect(week.weekOne.find((c: { week: string }) => c.week === weekOfQuiet)).toBeUndefined();

    await t.http().get('/v1/admin/analytics?days=12').set(bearer(staff)).expect(400);
    const member = await signIn(t, 'browser@embodha.test');
    await t.http().get('/v1/admin/analytics').set(bearer(member.accessToken)).expect(403);
  });

  it('keeps a row per member per day, and per phone per day, as things arrive', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const day = async (email: string) => (await t.db.select().from(activeDays).where(and(eq(activeDays.userId, await userId(email)), eq(activeDays.day, today))))[0];
    // Opening the app makes the day active, not practised. A breath makes it practised.
    expect(await day('browser@embodha.test')).toMatchObject({ practised: false });
    expect(await day('new@embodha.test')).toMatchObject({ practised: true });
    // A paused player's heartbeat (nothing played) doesn't count as practice; one that played does.
    const member = await signIn(t, 'browser@embodha.test');
    const beat = (seconds: number) =>
      t.http().post('/v1/playback/heartbeats').set(bearer(member.accessToken)).send({ events: [{ chapterId: f.freeChapter.id, positionS: 0, seconds, at: new Date().toISOString() }] }).expect(200);
    await beat(0);
    expect(await day('browser@embodha.test')).toMatchObject({ practised: false });
    await beat(30);
    expect(await day('browser@embodha.test')).toMatchObject({ practised: true });
    // Opening the app again later doesn't take it back.
    await send({ anonId: 'device-member-0002', platform: 'ios', events: [{ name: 'app_open' }] }, member.accessToken).expect(200);
    expect(await day('browser@embodha.test')).toMatchObject({ practised: true });

    // Phones: the switcher's is now theirs; the guest's belongs to no one and was only ever used signed out.
    const [switched] = await t.db.select().from(installs).where(eq(installs.anonId, 'device-switch-0003'));
    expect(switched).toMatchObject({ userId: await userId('switch@embodha.test'), platform: 'web' });
    expect((await t.db.select().from(installs).where(eq(installs.anonId, 'device-guest-0001')))[0].userId).toBeNull();
    const phoneDays = await t.db.select().from(installDays).where(eq(installDays.day, today));
    expect(phoneDays.find((d) => d.anonId === 'device-guest-0001')).toMatchObject({ signedIn: false });
    expect(phoneDays.find((d) => d.anonId === 'device-switch-0003')).toMatchObject({ signedIn: true });
  });

  it('puts a member’s events, phones and active days in their data download', async () => {
    const member = await signIn(t, 'switch@embodha.test');
    await t.http().post('/v1/me/export').set(bearer(member.accessToken)).expect(200);
    const data = JSON.parse(latestMail(t.mail, 'switch@embodha.test').attachments![0].content.toString('utf8'));
    expect(data.appEvents).toEqual([expect.objectContaining({ name: 'course_view', anonId: 'device-switch-0003', props: { courseId: f.paid.id } })]);
    expect(data.appInstalls).toEqual([expect.objectContaining({ anonId: 'device-switch-0003', platform: 'web' })]);
    expect(data.activeDays).toHaveLength(1);
  });
});
