import { eq, sql } from 'drizzle-orm';
import { AppErrorsService } from '../src/beta/beta.module';
import { appErrors, auditLog, feedback, instructorSubscriptions, payments, staffRoles, users } from '../src/db/schema';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, latestMail, signIn, TEST_ENV, TestApp } from './helpers';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** Postgres's percentile_cont: linear between the two nearest values. */
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const low = Math.floor(at);
  return Math.round(sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low));
}

describe('Hearing from the beta', () => {
  let t: TestApp;
  let f: Fixtures;
  let support: string;
  let finance: string;
  let member: string;
  const userId = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0].id;
  const report = (days = 14) => t.http().get(`/v1/admin/beta?days=${days}`).set(bearer(finance)).expect(200);
  const events = (platform: string, list: object[], appVersion = '1.0.0', anonId = `device-${platform}-0001`) =>
    t.http().post('/v1/events').send({ anonId, platform, appVersion, events: list }).expect(200);

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    support = (await signIn(t, 'help@embodha.test')).accessToken;
    finance = (await signIn(t, 'books@embodha.test')).accessToken;
    await t.db.insert(staffRoles).values([
      { userId: await userId('help@embodha.test'), role: 'support' },
      { userId: await userId('books@embodha.test'), role: 'finance' },
    ]);
    member = (await signIn(t, 'tester@embodha.test')).accessToken;
    await t.http().patch('/v1/me').set(bearer(member)).send({ name: 'Meera Iyer', country: 'IN', state: '29' }).expect(200);
  });
  afterAll(async () => {
    delete (TEST_ENV as { FEEDBACK_EMAIL?: string }).FEEDBACK_EMAIL;
    await t.close();
  });

  it('takes crash and error reports, signed in or not, and groups the same problem once', async () => {
    const stack = (line: number) => `TypeError: Cannot read property 'title' of undefined\n    at ChapterRow (address at index.android.bundle:1:${line})`;
    const sent = await t
      .http()
      .post('/v1/app-errors')
      .send({
        anonId: 'device-android-0001',
        platform: 'android',
        appVersion: '1.0.1',
        osVersion: '15',
        device: 'Redmi Note 13',
        reports: [
          // Saved when the app crashed on 1.0.0, sent after the update to 1.0.1.
          { kind: 'crash', message: "Cannot read property 'title' of undefined", stack: stack(40213), screen: '/course/gentle-spine', appVersion: '1.0.0', at: ago(1).toISOString() },
          { kind: 'error', message: "Couldn't save details for meera@example.com", screen: '/onboarding' },
          { kind: 'made-up', message: 'dropped' },
        ],
      })
      .expect(200);
    expect(sent.body).toEqual({ accepted: 2 });
    const rows = await t.db.select().from(appErrors);
    expect(rows.find((r) => r.kind === 'crash')).toMatchObject({ appVersion: '1.0.0', device: 'Redmi Note 13', osVersion: '15', userId: null, screen: '/course/gentle-spine' });
    expect(rows.find((r) => r.kind === 'error')!.message).toBe("Couldn't save details for [email]");

    // The same crash from a signed-in iPhone on another build: one problem, two installs.
    await t
      .http()
      .post('/v1/app-errors')
      .set(bearer(member))
      .send({ anonId: 'device-ios-0001', platform: 'ios', appVersion: '1.0.0', reports: [{ kind: 'crash', message: "Cannot read property 'title' of undefined", stack: stack(51877) }] })
      .expect(200);
    expect((await t.db.select().from(appErrors).where(eq(appErrors.platform, 'ios')))[0].userId).toBe(await userId('tester@embodha.test'));

    const { problems } = (await report()).body;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ kind: 'crash', reports: 2, installs: 2, platforms: ['android', 'ios'], versions: ['1.0.0'] });
    expect(problems[1]).toMatchObject({ kind: 'error', reports: 1, screen: '/onboarding' });

    await t.http().post('/v1/app-errors').send({ anonId: 'short', platform: 'ios', reports: [] }).expect(400);
    await t.http().post('/v1/app-errors').send({ anonId: 'device-ios-0001', platform: 'windows', reports: [] }).expect(400);
    await t.http().post('/v1/app-errors').send({ anonId: 'device-ios-0001', platform: 'ios', reports: Array(11).fill({ kind: 'error', message: 'x' }) }).expect(400);
  });

  it('works out crash-free sessions from app opens, and holds the verdict until there are enough', async () => {
    const opens = (n: number) => Array.from({ length: n }, () => ({ name: 'app_open' }));
    await events('android', opens(30));
    let bar = (await report()).body.bars.crashFree;
    expect(bar).toMatchObject({ sessions: 30, crashes: 2, enough: false, met: false });

    await events('android', opens(50));
    await events('android', opens(20), '1.0.1');
    await events('ios', opens(50));
    await events('web', opens(10)); // the web app's opens aren't phone sessions
    const body = (await report()).body;
    bar = body.bars.crashFree;
    // Two crashes in 150 phone sessions: 98.67% crash-free, short of 99.5%.
    expect(bar).toMatchObject({ sessions: 150, crashes: 2, valueBps: 9867, targetBps: 9950, minSessions: 100, enough: true, met: false });
    expect(body.crashes.byPlatform).toEqual([
      { platform: 'ios', sessions: 50, crashes: 1, crashFreeBps: 9800 },
      { platform: 'android', sessions: 100, crashes: 1, crashFreeBps: 9900 },
    ]);
    expect(body.crashes.byVersion).toContainEqual({ platform: 'android', version: '1.0.1', sessions: 20, crashes: 0, crashFreeBps: 10_000 });

    // A week later the crashes are outside a 7-day window.
    await t.db.update(appErrors).set({ at: ago(8) });
    expect((await report(7)).body.bars.crashFree).toMatchObject({ crashes: 0, valueBps: 10_000, met: true });

    // After 90 days a report is deleted.
    await t.db.update(appErrors).set({ at: ago(91) }).where(eq(appErrors.kind, 'error'));
    expect(await t.app.get(AppErrorsService).prune()).toBe(1);
    expect(await t.db.select().from(appErrors)).toHaveLength(2);
  });

  it('measures how long chapters take to start, by connection, with the bar on 4G in the phone apps', async () => {
    const fourG = Array.from({ length: 30 }, (_, i) => 900 + i * 40); // 900 ms to 2060 ms
    const start = (ms: number, extra: object = {}) => ({ name: 'video_start', props: { chapterId: f.freeChapter.id, ms, apiMs: 120, kind: 'video', network: 'cellular', generation: '4g', ...extra } });
    await events('android', fourG.slice(0, 20).map((ms) => start(ms)));
    await events('ios', [...fourG.slice(20).map((ms) => start(ms)), start(1500, { network: 'wifi', generation: '' }), start(400, { abandoned: true })]);
    await events('web', [start(3000)]); // a browser saying "4g" is a guess about bandwidth, not a network
    await events('android', [start(140, { saved: true })]); // played from a download: the network had no part in it
    // Nonsense from a modified app is left out, not allowed to break the page.
    await events('android', [start('fast' as unknown as number), start(-5), start(9_000_000)]);
    await t.http().post('/v1/events').set(bearer(member)).send({ anonId: 'device-ios-0002', platform: 'ios', events: [start(5200, { abandoned: true }), { name: 'video_error', props: { chapterId: f.locked.id } }] }).expect(200);
    // Two chapters sent to a TV, one of which it couldn't play.
    const tv = (name: string) => ({ name, props: { chapterId: f.freeChapter.id, kind: 'video' } });
    await events('android', [tv('cast_start'), tv('cast_start'), { ...tv('cast_error'), props: { ...tv('cast_error').props, message: 'LOAD_FAILED' } }]);

    const { bars, video } = (await report()).body;
    // The member who gave up after 5.2 s counts as a slow start; the one who left after 0.4 s doesn't count at all.
    const counted = [...fourG, 5200];
    expect(bars.videoStart).toMatchObject({ starts: 31, p90Ms: percentile(counted, 0.9), targetMs: 2000, minStarts: 30, enough: true });
    expect(bars.videoStart.met).toBe(percentile(counted, 0.9) <= 2000);
    expect(video.byConnection.map((c: { connection: string; starts: number }) => [c.connection, c.starts])).toEqual([
      ['4G', 31],
      ['Web browser', 1],
      ['Wi-Fi', 1],
    ]);
    expect(video.byPlace).toEqual([expect.objectContaining({ place: 'Karnataka', starts: 1, p50Ms: 5200 })]);
    expect(video).toMatchObject({ abandoned: 2, gaveUpSlow: 1, errors: 1, casts: 2, castErrors: 1 });
    expect(video.overall.apiP50Ms).toBe(120);

    // Faster phones next week: the slow ones age out and the bar is met.
    await t.db.execute(
      sql`update events set at = now() - interval '9 days' where name = 'video_start' and case when jsonb_typeof(props->'ms') = 'number' then (props->>'ms')::numeric > 1800 else false end`,
    );
    const week = (await report(7)).body.bars.videoStart;
    expect(week.p90Ms).toBeLessThanOrEqual(2000);
    expect(week).toMatchObject({ enough: false, met: false }); // 23 starts left: not enough to call it
  });

  it("checks a teacher's switch-off: renewals due after it, and any charge that came anyway", async () => {
    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    expect((await report()).body.bars.switchOff).toMatchObject({ switchOffs: 0, enough: false, met: false });

    await t.http().put('/v1/studio/plan').set(bearer(asha)).send({ enabled: false }).expect(200);
    const [off] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'studio.plan'));
    expect(off).toMatchObject({ entityId: f.asha.id, before: expect.objectContaining({ enabled: true }), after: expect.objectContaining({ enabled: false }) });
    await t.db.update(auditLog).set({ at: ago(10) }).where(eq(auditLog.id, off.id));

    // Two members were paid up when it was switched off; both months have ended since.
    const subscriber = async (email: string, channel: 'razorpay' | 'apple', periodEnd: Date) => {
      await t.db.insert(users).values({ email }).onConflictDoNothing();
      const [row] = await t.db
        .insert(instructorSubscriptions)
        .values({ userId: await userId(email), instructorId: f.asha.id, channel, externalId: `${channel}-${email}`, status: 'active', currentPeriodEnd: periodEnd, autoRenew: false, createdAt: ago(40) })
        .returning();
      return row;
    };
    await subscriber('web-sub@embodha.test', 'razorpay', ago(5));
    const apple = await subscriber('iphone-sub@embodha.test', 'apple', ago(3));
    let body = (await report()).body;
    expect(body.switchOffs).toEqual([
      expect.objectContaining({ instructor: 'Asha Rao', renewalsDue: { website: 1, appStore: 1, googlePlay: 0 }, chargedAfter: { website: 0, appStore: 0, googlePlay: 0 }, testCharges: 0 }),
    ]);
    expect(body.bars.switchOff).toMatchObject({ switchOffs: 1, renewalsTested: 2, chargedAfter: 0, enough: true, met: true });

    // A sandbox renewal on the iPhone three days ago: the switch-off didn't hold there.
    await t.db.insert(payments).values({
      userId: apple.userId,
      channel: 'apple',
      externalId: 'apple-renewal-1',
      kind: 'subscription',
      subscriptionId: apple.id,
      instructorId: f.asha.id,
      currency: 'INR',
      grossMinor: 49_900,
      netMinor: 42_288,
      netInrPaise: 42_288,
      status: 'captured',
      isTest: true,
      capturedAt: ago(3),
    });
    body = (await report()).body;
    expect(body.switchOffs[0]).toMatchObject({ chargedAfter: { website: 0, appStore: 1, googlePlay: 0 }, testCharges: 1 });
    expect(body.bars.switchOff).toMatchObject({ chargedAfter: 1, met: false });

    // Switched back on four days ago: the charge after that is an ordinary renewal, and only the earlier month was due.
    await t.db.insert(auditLog).values({ actorId: null, action: 'studio.plan', entityType: 'instructor', entityId: f.asha.id, before: { enabled: false }, after: { enabled: true }, at: ago(4) });
    body = (await report()).body;
    expect(body.switchOffs[0]).toMatchObject({ renewalsDue: { website: 1, appStore: 0, googlePlay: 0 }, chargedAfter: { website: 0, appStore: 0, googlePlay: 0 } });
    expect(body.bars.switchOff).toMatchObject({ renewalsTested: 1, chargedAfter: 0, met: true });
    expect(body.bars.reconciliation).toMatchObject({ ready: true, sales: 0, met: false }); // the store charges here are tests
  });

  it('takes feedback from members, emails the team if an address is set, and lets support work through it', async () => {
    const from = { platform: 'android', appVersion: '1.0.1', osVersion: '15', device: 'Redmi Note 13', screen: '/play/abc' };
    await t.http().post('/v1/feedback').send({ message: 'Lovely app', ...from }).expect(401);
    await t.http().post('/v1/feedback').set(bearer(member)).send({ message: 'ok', ...from }).expect(400);
    await t.http().post('/v1/feedback').set(bearer(member)).send({ message: 'The video froze', platform: 'blackberry' }).expect(400);

    const outbox = t.mail.outbox.length;
    await t.http().post('/v1/feedback').set(bearer(member)).send({ message: 'The first chapter took ages to start on Jio.', ...from }).expect(200);
    expect(t.mail.outbox.length).toBe(outbox); // no team address yet: the Feedback page only

    (TEST_ENV as { FEEDBACK_EMAIL?: string }).FEEDBACK_EMAIL = 'beta@embodha.test';
    await t.http().post('/v1/feedback').set(bearer(member)).send({ message: 'Breathing timer kept going after I locked the phone.\nSecond line.', ...from }).expect(200);
    const mail = latestMail(t.mail, 'beta@embodha.test');
    expect(mail).toMatchObject({ replyTo: 'tester@embodha.test', subject: 'Feedback from Meera Iyer: Breathing timer kept going after I locked the phone. Second…' });
    expect(mail.text).toContain('App 1.0.1 on Redmi Note 13, Android 15, on /play/abc');

    await t.http().get('/v1/admin/feedback').set(bearer(member)).expect(403);
    await t.http().get('/v1/admin/feedback').set(bearer(finance)).expect(403);
    let list = (await t.http().get('/v1/admin/feedback').set(bearer(support)).expect(200)).body;
    expect(list.open).toBe(2);
    expect(list.items[0]).toMatchObject({ message: 'Breathing timer kept going after I locked the phone.\nSecond line.', member: { email: 'tester@embodha.test', name: 'Meera Iyer' }, device: 'Redmi Note 13', handledAt: null });
    expect((await report()).body.feedbackOpen).toBe(2);

    await t.http().post(`/v1/admin/feedback/${list.items[1].id}/handled`).set(bearer(support)).send({}).expect(200);
    list = (await t.http().get('/v1/admin/feedback').set(bearer(support)).expect(200)).body;
    expect(list).toMatchObject({ open: 1, items: [expect.objectContaining({ message: expect.stringContaining('Breathing') })] });
    const everything = (await t.http().get('/v1/admin/feedback?all=1').set(bearer(support)).expect(200)).body;
    expect(everything.items).toHaveLength(2);
    expect(everything.items[1].handledAt).not.toBeNull();
    await t.http().post('/v1/admin/feedback/00000000-0000-0000-0000-000000000000/handled').set(bearer(support)).send({}).expect(404);
    expect((await t.db.select().from(auditLog).where(eq(auditLog.action, 'feedback.handled'))).length).toBe(1);
    const [row] = await t.db.select().from(feedback).where(eq(feedback.message, 'The first chapter took ages to start on Jio.'));
    expect(row.handledBy).toBe(await userId('help@embodha.test'));

    // Both messages and the crash from their iPhone are theirs: in their data download, without who handled what.
    await t.http().post('/v1/me/export').set(bearer(member)).expect(200);
    const data = JSON.parse(latestMail(t.mail, 'tester@embodha.test').attachments![0].content.toString('utf8'));
    expect(data.feedback).toHaveLength(2);
    expect(data.feedback[0]).not.toHaveProperty('handledBy');
    expect(data.appErrors).toEqual([expect.objectContaining({ kind: 'crash', platform: 'ios' })]);

    // Marked handled by mistake: back on the open list.
    await t.http().post(`/v1/admin/feedback/${row.id}/handled`).set(bearer(support)).send({ handled: false }).expect(200);
    expect((await t.http().get('/v1/admin/feedback').set(bearer(support)).expect(200)).body.open).toBe(2);
  });

  it('keeps the page to staff, and to 7, 14 or 30 days', async () => {
    await t.http().get('/v1/admin/beta').expect(401);
    await t.http().get('/v1/admin/beta').set(bearer(member)).expect(403);
    await t.http().get('/v1/admin/beta?days=5').set(bearer(support)).expect(400);
    expect((await t.http().get('/v1/admin/beta').set(bearer(support)).expect(200)).body.days).toBe(14);
  });
});
