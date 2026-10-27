import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { instructorSubscriptions, payments, splits, staffRoles, users } from '../src/db/schema';
import { MailService } from '../src/mail/mail.service';
import { RazorpayPayment, RazorpayService, RazorpaySubscription } from '../src/money/razorpay.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

const sign = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');
const DAY = 86_400;

describe('Subscriptions, invoices and money settings', () => {
  let t: TestApp;
  let f: Fixtures;
  let finance: string;
  // Razorpay, faked at its HTTP edge.
  const subs = new Map<string, RazorpaySubscription & { plan_id: string }>();
  const paid = new Map<string, RazorpayPayment>();
  const plansMade: string[] = [];
  const cancelled: string[] = [];

  const call = (token: string, method: 'get' | 'post' | 'put' | 'patch', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };
  const hook = (body: object) => {
    const raw = JSON.stringify(body);
    return t.http().post('/v1/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', sign('rzp-hook-secret', raw)).send(raw).expect(200);
  };
  /** Razorpay takes a month's money for a subscription and moves its paid-up period on. */
  const charge = (subscriptionId: string, paymentId: string, amount: number, currency = 'INR') => {
    const sub = subs.get(subscriptionId)!;
    const start = sub.current_end ?? Math.floor(Date.now() / 1000);
    subs.set(subscriptionId, { ...sub, status: 'active', current_start: start, current_end: start + 30 * DAY });
    paid.set(paymentId, { id: paymentId, order_id: `order_for_${paymentId}`, amount, currency, status: 'captured', fee: Math.round(amount * 0.0236) });
  };
  const subscribe = async (token: string) => (await call(token, 'post', '/v1/checkout/subscription', { instructorId: f.asha.id }).expect(200)).body;

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    const razorpay = t.app.get(RazorpayService);
    jest.spyOn(razorpay, 'createPlan').mockImplementation(async () => {
      plansMade.push(`plan_${plansMade.length + 1}`);
      return { id: plansMade[plansMade.length - 1] };
    });
    jest.spyOn(razorpay, 'createSubscription').mockImplementation(async (input) => {
      const sub = { id: `sub_${subs.size + 1}`, plan_id: input.plan_id, status: 'created' as const, notes: input.notes, current_end: null };
      subs.set(sub.id, sub);
      return sub;
    });
    jest.spyOn(razorpay, 'fetchSubscription').mockImplementation(async (id) => subs.get(id)!);
    jest.spyOn(razorpay, 'fetchPayment').mockImplementation(async (id) => paid.get(id)!);
    jest.spyOn(razorpay, 'cancelSubscription').mockImplementation(async (id) => {
      cancelled.push(id);
      return { ...subs.get(id)!, status: 'active' };
    });
    const tokens = await signIn(t, 'money@embodha.test');
    const [person] = await t.db.select().from(users).where(eq(users.email, 'money@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: person.id, role: 'finance' });
    finance = tokens.accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  it("subscribes to an instructor: every one of their courses unlocks, and the invoice arrives by email", async () => {
    const member = (await signIn(t, 'fan@embodha.test')).accessToken;
    await call(member, 'patch', '/v1/me', { country: 'IN', state: '27' }).expect(200); // the invoice needs the state
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(402);
    const started = await subscribe(member);
    expect(started).toMatchObject({ keyId: 'rzp_test_key', subscriptionId: 'sub_1', display: '₹499 a month', description: 'Monthly subscription: Asha Rao' });
    expect(subs.get('sub_1')!.notes).toMatchObject({ kind: 'subscription', instructor_id: f.asha.id });

    charge('sub_1', 'pay_sub1', 49_900);
    const proof = { subscriptionId: 'sub_1', paymentId: 'pay_sub1', signature: sign('rzp-test-secret', 'pay_sub1|sub_1') };
    await call(member, 'post', '/v1/checkout/subscription/confirm', { ...proof, signature: sign('rzp-test-secret', 'sub_1|pay_sub1') }).expect(400);
    const done = await call(member, 'post', '/v1/checkout/subscription/confirm', proof).expect(200);
    expect(done.body).toMatchObject({ subscribed: true, instructor: { slug: 'asha-rao' }, invoiceNo: expect.stringMatching(/^EMB\//) });
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);

    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_sub1'));
    expect(row).toMatchObject({ kind: 'subscription', courseId: null, grossMinor: 49_900, gstMinor: 7612, feeMinor: 1178 });
    expect((await t.db.select().from(splits).where(eq(splits.paymentId, row.id)))[0].instructorPaise).toBe(24_666);

    const mail = [...t.app.get(MailService).outbox].reverse().find((m) => m.to === 'fan@embodha.test')!;
    expect(mail.subject).toBe(`Your Embodha invoice ${done.body.invoiceNo}`);
    expect(mail.attachments![0]).toMatchObject({ contentType: 'application/pdf', filename: expect.stringMatching(/^embodha-invoice-EMB-.*\.pdf$/) });
    expect(mail.attachments![0].content.subarray(0, 5).toString()).toBe('%PDF-');

    expect((await call(member, 'post', '/v1/checkout/subscription', { instructorId: f.asha.id }).expect(409)).body.code).toBe('already_subscribed');
  });

  it('renews from the webhook, once per charge, moving the paid-up date forward', async () => {
    const [before] = await t.db.select().from(instructorSubscriptions).where(eq(instructorSubscriptions.externalId, 'sub_1'));
    charge('sub_1', 'pay_sub2', 49_900);
    const renewal = { event: 'subscription.charged', payload: { subscription: { entity: subs.get('sub_1') }, payment: { entity: { id: 'pay_sub2' } } } };
    await hook(renewal);
    await hook(renewal);
    const [after] = await t.db.select().from(instructorSubscriptions).where(eq(instructorSubscriptions.externalId, 'sub_1'));
    expect(after.currentPeriodEnd.getTime() - before.currentPeriodEnd.getTime()).toBe(30 * DAY * 1000);
    expect(await t.db.select().from(payments).where(eq(payments.subscriptionId, after.id))).toHaveLength(2);
  });

  it('lets the member cancel: no more renewals, access to the end of the paid month', async () => {
    const member = (await signIn(t, 'fan@embodha.test')).accessToken;
    const library = await call(member, 'get', '/v1/library').expect(200);
    const mine = library.body.subscriptions[0];
    expect(mine).toMatchObject({ channel: 'razorpay', renews: true, instructor: { slug: 'asha-rao' } });
    await call(member, 'post', `/v1/me/subscriptions/${mine.id}/cancel`).expect(200);
    expect(cancelled).toEqual(['sub_1']);
    expect((await call(member, 'get', '/v1/library').expect(200)).body.subscriptions[0].renews).toBe(false);
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);

    // Razorpay's own "cancelled" event at the end of the month changes nothing about access already paid for.
    await hook({ event: 'subscription.cancelled', payload: { subscription: { entity: { ...subs.get('sub_1'), status: 'cancelled' } } } });
    const [row] = await t.db.select().from(instructorSubscriptions).where(eq(instructorSubscriptions.externalId, 'sub_1'));
    expect(row).toMatchObject({ status: 'cancelled', autoRenew: false });
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);
  });

  it("stops everyone's renewal when the instructor switches their subscription off", async () => {
    const other = (await signIn(t, 'second@embodha.test')).accessToken;
    await call(other, 'patch', '/v1/me', { country: 'IN', state: '33' }).expect(200);
    await subscribe(other);
    charge('sub_2', 'pay_sub3', 49_900);
    await call(other, 'post', '/v1/checkout/subscription/confirm', { subscriptionId: 'sub_2', paymentId: 'pay_sub3', signature: sign('rzp-test-secret', 'pay_sub3|sub_2') }).expect(200);
    expect(plansMade).toEqual(['plan_1']); // the plan is made once and reused

    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    expect((await call(asha, 'put', '/v1/studio/plan', { enabled: false }).expect(200)).body.stoppedRenewals).toBe(1);
    expect(cancelled).toEqual(['sub_1', 'sub_2']);
    await call(other, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);
    await call(asha, 'put', '/v1/studio/plan', { enabled: true }).expect(200);
  });

  it('hands invoices to the member who paid and to finance, and to nobody else', async () => {
    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_sub1'));
    const owner = (await signIn(t, 'fan@embodha.test')).accessToken;
    const pdf = await call(owner, 'get', `/v1/payments/${row.id}/invoice`).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
    await call(finance, 'get', `/v1/payments/${row.id}/invoice`).expect(200);
    await call((await signIn(t, 'stranger@embodha.test')).accessToken, 'get', `/v1/payments/${row.id}/invoice`).expect(404);
  });

  it('keeps the money settings with finance, checked before they are saved', async () => {
    const saved = await call(finance, 'put', '/v1/admin/money-settings', {
      usdInrRate: 87.25,
      seller: { name: 'Embodha Wellness Pvt Ltd', address: 'Bengaluru, Karnataka', gstin: '29ABCDE1234F1ZW', sac: '999293' },
      noteAbroad: 'Export of services under LUT; no GST charged.',
    }).expect(200);
    expect(saved.body).toMatchObject({ usdInrRate: 87.25, refundWindowDays: 7, seller: { gstin: '29ABCDE1234F1ZW', sac: '999293' }, sellerState: 'Karnataka (29)', gstRateBps: 1800 });
    await call(finance, 'put', '/v1/admin/money-settings', { seller: { name: 'X', address: '', gstin: 'not-a-gstin' } }).expect(400);
    // One character off and the check digit gives it away.
    const typo = await call(finance, 'put', '/v1/admin/money-settings', { seller: { name: 'X', address: '', gstin: '29ABCDE1234F1Z5' } }).expect(400);
    expect(typo.body).toMatchObject({ code: 'invalid_gstin', message: expect.stringMatching(/typo/) });
    await call(finance, 'put', '/v1/admin/money-settings', { seller: { name: 'X', address: '', gstin: '', sac: '99-29' } }).expect(400);
    await call(finance, 'put', '/v1/admin/money-settings', { refundWindowDays: 400 }).expect(400);

    await call(finance, 'put', `/v1/admin/instructors/${f.asha.id}/tds`, { tdsRateBps: 1000 }).expect(200);
    const tokens = await signIn(t, 'help@embodha.test');
    const [helper] = await t.db.select().from(users).where(eq(users.email, 'help@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: helper.id, role: 'support' });
    await call(tokens.accessToken, 'put', '/v1/admin/money-settings', { usdInrRate: 1 }).expect(403);
  });
});
