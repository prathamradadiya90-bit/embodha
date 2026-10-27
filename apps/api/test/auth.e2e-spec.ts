import { eq } from 'drizzle-orm';
import { sessions, staffRoles, users } from '../src/db/schema';
import { bearer, codeFrom, createTestApp, latestMail, linkTokenFrom, signIn, TestApp } from './helpers';

describe('Email sign-in and account', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('creates an account from an emailed code and recognises it next time', async () => {
    const first = await signIn(t, 'Priya@Example.com');
    expect(first.isNewUser).toBe(true);
    const me = await t.http().get('/v1/me').set(bearer(first.accessToken)).expect(200);
    expect(me.body).toMatchObject({ email: 'priya@example.com', profileComplete: false, roles: { staff: [], instructor: null } });
    expect((await signIn(t, 'priya@example.com')).isNewUser).toBe(false);
  });

  it('keeps members signed in for 60 days of use, and staff for 12 hours', async () => {
    await signIn(t, 'stays@embodha.test');
    const [member] = await t.db.select().from(users).where(eq(users.email, 'stays@embodha.test'));
    await signIn(t, 'finance-person@embodha.test');
    const [staff] = await t.db.select().from(users).where(eq(users.email, 'finance-person@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: staff.id, role: 'finance' });
    await signIn(t, 'finance-person@embodha.test'); // a new session, now as staff
    const newest = async (userId: string) =>
      (await t.db.select().from(sessions).where(eq(sessions.userId, userId))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0].expiresAt.getTime() - Date.now();
    expect(await newest(member.id)).toBeGreaterThan(59 * 86_400_000);
    const staffLeft = await newest(staff.id);
    expect(staffLeft).toBeLessThanOrEqual(12 * 3_600_000);
    expect(staffLeft).toBeGreaterThan(11 * 3_600_000);
  });

  it('rejects wrong codes and stops after five tries', async () => {
    const email = 'guess@example.com';
    await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const code = codeFrom(latestMail(t.mail, email).text);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await t.http().post('/v1/auth/email/verify').send({ email, code: wrong }).expect(400);
      expect(res.body.code).toBe('code_invalid');
    }
    const locked = await t.http().post('/v1/auth/email/verify').send({ email, code }).expect(429);
    expect(locked.body.code).toBe('too_many_attempts');
  });

  it('limits how many codes one address can ask for in an hour', async () => {
    const email = 'impatient@example.com';
    for (let i = 0; i < 5; i++) await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const res = await t.http().post('/v1/auth/email/start').send({ email }).expect(429);
    expect(res.body.code).toBe('too_many_codes');
  });

  it('only accepts the newest code', async () => {
    const email = 'twice@example.com';
    await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const older = codeFrom(latestMail(t.mail, email).text);
    await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const newer = codeFrom(latestMail(t.mail, email).text);
    if (older !== newer) await t.http().post('/v1/auth/email/verify').send({ email, code: older }).expect(400);
    await t.http().post('/v1/auth/email/verify').send({ email, code: newer }).expect(200);
  });

  it('signs in from the one-tap link, once', async () => {
    const email = 'phone@example.com';
    await t.http().post('/v1/auth/email/start').send({ email }).expect(200);
    const token = linkTokenFrom(latestMail(t.mail, email).text);
    await t.http().post('/v1/auth/email/verify').send({ token }).expect(200);
    const again = await t.http().post('/v1/auth/email/verify').send({ token }).expect(400);
    expect(again.body.code).toBe('link_expired');
  });

  it('rejects malformed requests with field-level messages', async () => {
    const res = await t.http().post('/v1/auth/email/start').send({ email: 'not-an-email', extra: 1 }).expect(400);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.fields.map((f: { field: string }) => f.field).sort()).toEqual(['email', 'extra']);
  });

  it('rotates refresh tokens and ends the session if an old one is replayed', async () => {
    const { refreshToken } = await signIn(t, 'rotate@example.com');
    const next = await t.http().post('/v1/auth/refresh').send({ refreshToken }).expect(200);
    expect(next.body.refreshToken).not.toBe(refreshToken);
    await t.http().post('/v1/auth/refresh').send({ refreshToken }).expect(401);
    // The replay revoked the session, so even the newest token is dead now.
    await t.http().post('/v1/auth/refresh').send({ refreshToken: next.body.refreshToken }).expect(401);
  });

  it('logs out by revoking the session', async () => {
    const { accessToken, refreshToken } = await signIn(t, 'leaving@example.com');
    await t.http().post('/v1/auth/logout').set(bearer(accessToken)).expect(204);
    await t.http().post('/v1/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('lets the App Review account in with its fixed code and sends no email', async () => {
    const before = t.mail.outbox.filter((m) => m.to === 'review@embodha.test').length;
    await t.http().post('/v1/auth/email/start').send({ email: 'review@embodha.test' }).expect(200);
    expect(t.mail.outbox.filter((m) => m.to === 'review@embodha.test').length).toBe(before);
    await t.http().post('/v1/auth/email/verify').send({ email: 'review@embodha.test', code: '246810' }).expect(200);
  });

  it('asks for details after sign-up and keeps under-18s out', async () => {
    const { accessToken } = await signIn(t, 'details@example.com');
    const tooYoung = new Date().getUTCFullYear() - 16;
    const res = await t.http().patch('/v1/me').set(bearer(accessToken)).send({ birthYear: tooYoung }).expect(400);
    expect(res.body.code).toBe('under_age');
    const ok = await t
      .http()
      .patch('/v1/me')
      .set(bearer(accessToken))
      .send({ name: 'Meera', country: 'in', birthYear: 1990, gender: 'female', timezone: 'Asia/Kolkata', goals: ['sleep', 'stress'], reminderTime: '07:30' })
      .expect(200);
    // In India the state decides CGST and SGST or IGST on website invoices, so the details aren't done without it.
    expect(ok.body).toMatchObject({ name: 'Meera', country: 'IN', state: null, profileComplete: false, preferences: { goals: ['sleep', 'stress'], reminderTime: '07:30' } });
    await t.http().patch('/v1/me').set(bearer(accessToken)).send({ state: '99' }).expect(400);
    const done = await t.http().patch('/v1/me').set(bearer(accessToken)).send({ state: '27' }).expect(200);
    expect(done.body).toMatchObject({ state: '27', profileComplete: true });
    // A state means nothing outside India, so moving abroad clears it.
    const moved = await t.http().patch('/v1/me').set(bearer(accessToken)).send({ country: 'GB', state: '27' }).expect(200);
    expect(moved.body).toMatchObject({ country: 'GB', state: null, profileComplete: true });
  });

  it('closes the account on request, and reopens it if they sign in during the grace period', async () => {
    const { accessToken } = await signIn(t, 'closing@example.com');
    const res = await t.http().delete('/v1/me').set(bearer(accessToken)).expect(202);
    expect(res.body.status).toBe('deleting');
    await t.http().get('/v1/me').set(bearer(accessToken)).expect(401);
    const back = await signIn(t, 'closing@example.com');
    await t.http().get('/v1/me').set(bearer(back.accessToken)).expect(200);
  });
});
