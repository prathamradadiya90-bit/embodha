import { and, eq } from 'drizzle-orm';
import { auditLog, courses, emailCodes, entitlements, events, installs, instructorSubscriptions, notes, payments, reviews, sessions, staffRoles, users } from '../src/db/schema';
import { RazorpayService } from '../src/money/razorpay.service';
import { ErasureService } from '../src/privacy/erasure.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, latestMail, signIn, TestApp } from './helpers';

const DAY = 86_400_000;

describe('Downloading your data', () => {
  let t: TestApp;
  let f: Fixtures;
  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it('emails the member everything held about them, readable, and none of the server’s own secrets', async () => {
    const tokens = await signIn(t, 'mine@embodha.test');
    await t.http().post(`/v1/chapters/${f.freeChapter.id}/notes`).set(bearer(tokens.accessToken)).send({ body: 'Left hip tight today', timestampS: 42 }).expect(201);

    const res = await t.http().post('/v1/me/export').set(bearer(tokens.accessToken)).expect(200);
    expect(res.body).toEqual({ sent: true, to: 'mine@embodha.test' });

    const mail = latestMail(t.mail, 'mine@embodha.test');
    expect(mail.subject).toBe('Your Embodha data');
    const [file] = mail.attachments!;
    expect(file).toMatchObject({ filename: expect.stringMatching(/^embodha-data-\d{4}-\d{2}-\d{2}\.json$/), contentType: 'application/json' });
    const text = file.content.toString('utf8');
    const data = JSON.parse(text);
    expect(data.account).toMatchObject({ email: 'mine@embodha.test' });
    expect(data.notes).toEqual([expect.objectContaining({ chapterId: f.freeChapter.id, body: 'Left hip tight today', timestampS: 42 })]); // decrypted
    expect(data.signedInDevices).toHaveLength(1);
    expect(data).toHaveProperty('purchases');
    expect(data).toHaveProperty('breathingSessions');
    expect(text).not.toContain('refreshTokenHash');
    expect(text).not.toContain(tokens.refreshToken.split('.')[1]);
  });

  it('allows three a day, so it can’t be used to flood an inbox', async () => {
    const { accessToken } = await signIn(t, 'again@embodha.test');
    await t.http().post('/v1/me/export').expect(401);
    for (let i = 0; i < 3; i++) await t.http().post('/v1/me/export').set(bearer(accessToken)).expect(200);
    expect((await t.http().post('/v1/me/export').set(bearer(accessToken)).expect(429)).body.code).toBe('too_many_exports');
    // Someone else on the same network isn't held up by it.
    const other = await signIn(t, 'neighbour@embodha.test');
    await t.http().post('/v1/me/export').set(bearer(other.accessToken)).expect(200);
  });

  describe('deleting an account', () => {
    const idOf = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]?.id;
    const deleteAccount = async (token: string) => (await t.http().delete('/v1/me').set(bearer(token)).expect(202)).body;
    const ageRequest = (id: string, days: number) => t.db.update(users).set({ deletedAt: new Date(Date.now() - days * DAY) }).where(eq(users.id, id));
    const erasure = () => t.app.get(ErasureService);

    it('stops renewals Embodha can stop, and says how many only the App Store can', async () => {
      const { accessToken } = await signIn(t, 'subscribed@embodha.test');
      const id = await idOf('subscribed@embodha.test');
      const month = new Date(Date.now() + 20 * DAY);
      await t.db.insert(instructorSubscriptions).values([
        { userId: id, instructorId: f.asha.id, channel: 'razorpay', externalId: 'sub_leaving', status: 'active', currentPeriodEnd: month },
        { userId: id, instructorId: f.asha.id, channel: 'apple', externalId: '2000000555', status: 'active', currentPeriodEnd: month },
      ]);
      const cancelled: string[] = [];
      jest.spyOn(t.app.get(RazorpayService), 'cancelSubscription').mockImplementation(async (subscriptionId) => {
        cancelled.push(subscriptionId);
        return { id: subscriptionId, status: 'cancelled' } as never;
      });

      const result = await deleteAccount(accessToken);
      expect(result).toMatchObject({ status: 'deleting', appStoreSubscriptions: 1 });
      expect(cancelled).toEqual(['sub_leaving']);
      const subs = await t.db.select().from(instructorSubscriptions).where(eq(instructorSubscriptions.userId, id));
      expect(Object.fromEntries(subs.map((s) => [s.channel, s.autoRenew]))).toEqual({ razorpay: false, apple: true });
      // Signed out everywhere straight away.
      await t.http().get('/v1/me').set(bearer(accessToken)).expect(401);
    });

    it('erases an account 30 days on, leaving app events behind with no link to the person', async () => {
      const { accessToken } = await signIn(t, 'leaving@embodha.test');
      const id = await idOf('leaving@embodha.test');
      await t.http().post(`/v1/chapters/${f.freeChapter.id}/notes`).set(bearer(accessToken)).send({ body: 'Shoulders first', timestampS: 3 }).expect(201);
      await t.http().post('/v1/events').set(bearer(accessToken)).send({ anonId: 'leaving-phone-01', platform: 'android', events: [{ name: 'app_open' }] }).expect(200);
      await t.http().post('/v1/breathing/sessions').set(bearer(accessToken)).send({ seconds: 60 }).expect(201);
      await deleteAccount(accessToken);
      // Not yet: twenty-nine days in, nothing is touched.
      await ageRequest(id, 29);
      expect(await erasure().eraseDue()).toBe(0);
      expect(await idOf('leaving@embodha.test')).toBe(id);

      await ageRequest(id, 31);
      expect(await erasure().eraseDue()).toBe(1);
      expect(await t.db.select().from(users).where(eq(users.id, id))).toEqual([]);
      expect(await t.db.select().from(notes).where(eq(notes.userId, id))).toEqual([]);
      expect(await t.db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);
      expect(await t.db.select().from(emailCodes).where(eq(emailCodes.email, 'leaving@embodha.test'))).toEqual([]);
      const [left] = await t.db.select().from(events).where(eq(events.anonId, 'leaving-phone-01'));
      expect(left).toMatchObject({ name: 'app_open', userId: null });
      expect((await t.db.select().from(installs).where(eq(installs.anonId, 'leaving-phone-01')))[0].userId).toBeNull();
      const [entry] = await t.db.select().from(auditLog).where(and(eq(auditLog.action, 'account.erase'), eq(auditLog.entityId, id)));
      expect(entry.after).toEqual({ kept: [] });
    });

    it('keeps an empty account row when there are payments to keep, and the email can start afresh', async () => {
      const { accessToken } = await signIn(t, 'buyer@embodha.test');
      const id = await idOf('buyer@embodha.test');
      await t.db.update(users).set({ country: 'IN', state: '29' }).where(eq(users.id, id));
      const [sale] = await t.db
        .insert(payments)
        .values({ userId: id, channel: 'razorpay', externalId: 'pay_kept', kind: 'course', courseId: f.paid.id, instructorId: f.asha.id, currency: 'INR', grossMinor: 99_900, gstMinor: 15_239, netMinor: 82_303, netInrPaise: 82_303, status: 'captured', invoiceNo: 'EMB/26-27/000777', capturedAt: new Date() })
        .returning();
      await t.db.insert(entitlements).values({ userId: id, courseId: f.paid.id, source: 'purchase', paymentId: sale.id });
      await t.db.insert(reviews).values({ userId: id, courseId: f.paid.id, rating: 2, body: 'Too fast for me' });
      await t.db.update(courses).set({ ratingAvg: '2.00', ratingCount: 1 }).where(eq(courses.id, f.paid.id));
      await deleteAccount(accessToken);
      await ageRequest(id, 31);
      expect(await erasure().eraseDue()).toBe(1);

      const [shell] = await t.db.select().from(users).where(eq(users.id, id));
      expect(shell).toMatchObject({ status: 'erased', name: null, country: null, state: null, email: `erased-${id}@erased.embodha.invalid` });
      expect(await t.db.select().from(payments).where(eq(payments.id, sale.id))).toEqual([expect.objectContaining({ userId: id, invoiceNo: 'EMB/26-27/000777' })]);
      expect(await t.db.select().from(entitlements).where(eq(entitlements.userId, id))).toEqual([]);
      expect(await t.db.select().from(reviews).where(eq(reviews.userId, id))).toEqual([]);
      const [course] = await t.db.select().from(courses).where(eq(courses.id, f.paid.id));
      expect(course).toMatchObject({ ratingCount: 0, ratingAvg: null });
      const [entry] = await t.db.select().from(auditLog).where(and(eq(auditLog.action, 'account.erase'), eq(auditLog.entityId, id)));
      expect(entry.after).toEqual({ kept: ['payments'] });

      // Support can't bring it back or add to it: there's no one there.
      const support = await signIn(t, 'support@embodha.test');
      await t.db.insert(staffRoles).values({ userId: await idOf('support@embodha.test'), role: 'support' });
      const refused = await t.http().patch(`/v1/admin/users/${id}`).set(bearer(support.accessToken)).send({ status: 'active' }).expect(409);
      expect(refused.body.code).toBe('erased');

      // The same address later is a new member, with none of the old account.
      const again = await signIn(t, 'buyer@embodha.test');
      expect(again.isNewUser).toBe(true);
      expect(await idOf('buyer@embodha.test')).not.toBe(id);
    });
  });
});
