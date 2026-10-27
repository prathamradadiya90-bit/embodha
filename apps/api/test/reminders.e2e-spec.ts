import { eq } from 'drizzle-orm';
import { Clock } from '../src/common/clock';
import { breathingSessions, chapterProgress, heldPushes, reminderLog, staffRoles, users } from '../src/db/schema';
import { PushMessage, PushService } from '../src/notifications/push.service';
import { NotificationsScheduler } from '../src/notifications/scheduler.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

// Monday 2 November 2026. India is UTC+5:30; New York is on EST (UTC-5) from the day before.
const at = (iso: string) => new Date(iso);
const SEVEN_THIRTY_ONE_IST = at('2026-11-02T02:01:00Z');

describe('Reminders and scheduled messages', () => {
  let t: TestApp;
  let f: Fixtures;
  let admin: string;
  const tokens: Record<string, string> = {};
  let pushed: PushMessage[] = [];
  const idOf = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0].id;
  const tick = (iso: string) => t.app.get(NotificationsScheduler).tick(at(iso));
  const clockAt = (iso: string) => jest.spyOn(t.app.get(Clock), 'now').mockReturnValue(at(iso));
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const member = async (name: string, me: Record<string, string | null>) => {
    tokens[name] = (await signIn(t, `${name}@embodha.test`)).accessToken;
    await t.http().patch('/v1/me').set(bearer(tokens[name])).send(me).expect(200);
    await t.http().post('/v1/devices').set(bearer(tokens[name])).send({ token: `ExponentPushToken[${name}]`, platform: 'ios' }).expect(204);
  };
  const to = (name: string) => pushed.filter((m) => m.to === `ExponentPushToken[${name}]`);

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    admin = (await signIn(t, 'editor@embodha.test')).accessToken;
    await t.db.insert(staffRoles).values({ userId: await idOf('editor@embodha.test'), role: 'content' });
    jest.spyOn(t.app.get(PushService), 'send').mockImplementation(async (messages) => {
      pushed.push(...messages);
      return messages.length;
    });
    await member('early', { timezone: 'Asia/Kolkata', reminderTime: '07:30' });
    await member('done', { timezone: 'Asia/Kolkata', reminderTime: '07:30' });
    await member('learner', { timezone: 'Asia/Kolkata', reminderTime: '07:15' });
    await member('newyork', { timezone: 'America/New_York', reminderTime: '07:30' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('reminds each member once at their time, unless they have practised, and points learners back to their course', async () => {
    // "done" finished a breath at 06:45 their time; "learner" is partway through Gentle Spine.
    await t.db.insert(breathingSessions).values({ userId: await idOf('done@embodha.test'), seconds: 120, completedAt: at('2026-11-02T01:15:00Z') });
    await t.db.insert(chapterProgress).values({ userId: await idOf('learner@embodha.test'), chapterId: f.preview.id, positionS: 200, updatedAt: at('2026-11-01T14:00:00Z') });

    await tick('2026-11-02T01:59:00Z'); // 07:29 in India: too early for the 07:30s, but 07:15 has come
    expect(pushed.map((m) => m.to)).toEqual(['ExponentPushToken[learner]']);
    expect(to('learner')[0]).toMatchObject({ title: 'Pick up where you left off', body: 'gentle-spine is waiting for you.', data: { url: '/course/gentle-spine' } });

    await tick(SEVEN_THIRTY_ONE_IST.toISOString());
    expect(to('early')).toEqual([expect.objectContaining({ data: { url: '/breathe' } })]);
    expect(to('done')).toEqual([]);
    expect(to('newyork')).toEqual([]); // it's 21:01 the evening before there

    // A minute later, nobody is reminded again; the member who'd practised is logged, not pushed.
    await tick('2026-11-02T02:02:00Z');
    expect(pushed).toHaveLength(2);
    const log = await t.db.select().from(reminderLog).where(eq(reminderLog.userId, await idOf('done@embodha.test')));
    expect(log).toEqual([expect.objectContaining({ day: '2026-11-02', sent: false })]);

    // New York's 07:30 comes later the same Monday, by the clock in India.
    await tick('2026-11-02T12:31:00Z');
    expect(to('newyork')).toHaveLength(1);
  });

  it('skips a reminder that would arrive more than two hours late', async () => {
    await member('sleepy', { timezone: 'Asia/Kolkata', reminderTime: '07:30' });
    await tick('2026-11-02T05:00:00Z'); // 10:30 in India
    expect(to('sleepy')).toEqual([]);
    expect(await t.db.select().from(reminderLog).where(eq(reminderLog.userId, await idOf('sleepy@embodha.test')))).toEqual([]);
  });

  it('sends a scheduled message on time, holding phone pushes for people in their quiet hours until 08:00 their time', async () => {
    clockAt('2026-11-02T15:00:00Z');
    const message = { title: 'New: Strong hips', body: 'Ten minutes, three times a week.', audience: {} };
    await t.http().post('/v1/admin/notifications').set(bearer(admin)).send({ ...message, sendAt: '2026-11-02T14:00:00Z' }).expect(400);
    await t.http().post('/v1/admin/notifications').set(bearer(admin)).send({ ...message, sendAt: '2027-02-01T00:00:00Z' }).expect(400);
    // 22:30 in India, 12:00 in New York.
    const { body } = await t.http().post('/v1/admin/notifications').set(bearer(admin)).send({ ...message, sendAt: '2026-11-02T17:00:00Z' }).expect(201);
    expect(body).toEqual({ id: expect.any(String), scheduledFor: '2026-11-02T17:00:00.000Z' });
    const list = async () => (await t.http().get('/v1/admin/notifications').set(bearer(admin)).expect(200)).body;
    expect((await list())[0]).toMatchObject({ id: body.id, sentAt: null, scheduledAt: '2026-11-02T17:00:00.000Z' });

    pushed = [];
    await tick('2026-11-02T16:59:00Z');
    expect((await t.http().get('/v1/notifications').set(bearer(tokens.early)).expect(200)).body.items).toEqual([]);

    await tick('2026-11-02T17:00:00Z');
    await settle();
    // Everyone has it in the bell; only New York's phone buzzed.
    expect((await t.http().get('/v1/notifications').set(bearer(tokens.early)).expect(200)).body.items).toEqual([expect.objectContaining({ title: 'New: Strong hips' })]);
    expect(pushed.filter((m) => m.data?.notificationId === body.id).map((m) => m.to)).toEqual(['ExponentPushToken[newyork]']);
    const held = await t.db.select().from(heldPushes);
    expect(held).toHaveLength(4); // early, done, learner, sleepy
    expect(new Set(held.map((h) => h.sendAfter.toISOString()))).toEqual(new Set(['2026-11-03T02:30:00.000Z']));
    expect((await list()).find((c: { id: string }) => c.id === body.id)).toMatchObject({ heldCount: 4, sentAt: '2026-11-02T17:00:00.000Z' });

    // "early" read it in the app before 08:00, so their phone isn't pushed. The rest are, at 08:00.
    await t.http().post('/v1/notifications/read').set(bearer(tokens.early)).send({}).expect(200);
    await tick('2026-11-03T02:29:00Z');
    expect(pushed.filter((m) => m.data?.notificationId === body.id)).toHaveLength(1);
    await tick('2026-11-03T02:30:00Z');
    const morning = pushed.filter((m) => m.data?.notificationId === body.id).map((m) => m.to).sort();
    expect(morning).toEqual(['ExponentPushToken[done]', 'ExponentPushToken[learner]', 'ExponentPushToken[newyork]', 'ExponentPushToken[sleepy]']);
    expect(await t.db.select().from(heldPushes)).toEqual([]);
  });

  it('calls a scheduled message back before it goes, but not after', async () => {
    clockAt('2026-11-02T15:00:00Z');
    const later = await t.http().post('/v1/admin/notifications').set(bearer(admin)).send({ title: 'Diwali hours', body: 'Support is slower this week.', audience: {}, sendAt: '2026-11-05T05:00:00Z' }).expect(201);
    await t.http().delete(`/v1/admin/notifications/${later.body.id}`).set(bearer(admin)).expect(204);
    const list = (await t.http().get('/v1/admin/notifications').set(bearer(admin)).expect(200)).body;
    expect(list.find((c: { id: string }) => c.id === later.body.id)).toBeUndefined();
    await t.http().delete(`/v1/admin/notifications/${later.body.id}`).set(bearer(admin)).expect(404);
    const sent = list.find((c: { sentAt: string | null }) => c.sentAt);
    expect((await t.http().delete(`/v1/admin/notifications/${sent.id}`).set(bearer(admin)).expect(409)).body.code).toBe('already_sent');
    // Members can't schedule anything.
    await t.http().post('/v1/admin/notifications').set(bearer(tokens.early)).send({ title: 'Hi', body: 'Hello there', audience: {} }).expect(403);
  });
});
