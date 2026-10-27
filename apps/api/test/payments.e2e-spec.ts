import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { currentMonth } from '../src/common/month';
import { adjustments, entitlements, payments, splits, staffRoles, users } from '../src/db/schema';
import { RazorpayOrder, RazorpayPayment, RazorpayService } from '../src/money/razorpay.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

const sign = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');

describe('Payments', () => {
  let t: TestApp;
  let f: Fixtures;
  let finance: string;
  // Razorpay, faked at its HTTP edge. The signature maths stays real.
  const orders = new Map<string, RazorpayOrder>();
  const paid = new Map<string, RazorpayPayment>();
  let refundCalls: { id: string; amount: number }[] = [];

  const call = (token: string, method: 'get' | 'post' | 'patch', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };
  const checkout = async (token: string) => (await call(token, 'post', '/v1/checkout/course', { courseId: f.paid.id }).expect(200)).body;
  const payFor = (orderId: string, paymentId: string, extra: Partial<RazorpayPayment> = {}) => {
    const order = orders.get(orderId)!;
    paid.set(paymentId, { id: paymentId, order_id: orderId, amount: order.amount, currency: order.currency, status: 'captured', ...extra });
    return { orderId, paymentId, signature: sign('rzp-test-secret', `${orderId}|${paymentId}`) };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    const razorpay = t.app.get(RazorpayService);
    jest.spyOn(razorpay, 'createOrder').mockImplementation(async (input) => {
      const order = { id: `order_${orders.size + 1}`, amount: input.amount, currency: input.currency, status: 'created', notes: input.notes };
      orders.set(order.id, order);
      return order;
    });
    jest.spyOn(razorpay, 'fetchOrder').mockImplementation(async (id) => orders.get(id)!);
    jest.spyOn(razorpay, 'fetchPayment').mockImplementation(async (id) => paid.get(id)!);
    jest.spyOn(razorpay, 'refund').mockImplementation(async (id, amount) => {
      refundCalls.push({ id, amount });
      return { id: `rfnd_${refundCalls.length}`, payment_id: id, amount, status: 'processed' };
    });
    const tokens = await signIn(t, 'money@embodha.test');
    const [person] = await t.db.select().from(users).where(eq(users.email, 'money@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: person.id, role: 'finance' });
    finance = tokens.accessToken;
  });
  afterAll(async () => {
    await t.close();
  });

  it('sells a course in rupees once: GST inside the price, the real fee, the split at the share', async () => {
    const member = (await signIn(t, 'buyer@embodha.test')).accessToken;
    await call(member, 'patch', '/v1/me', { country: 'IN', state: '29' }).expect(200); // the invoice needs the state
    const started = await checkout(member);
    expect(started).toMatchObject({ keyId: 'rzp_test_key', amount: 99_900, currency: 'INR', display: '₹999', description: 'gentle-spine' });
    expect(orders.get(started.orderId)!.notes).toMatchObject({ kind: 'course', course_id: f.paid.id });

    // Razorpay's fee: 2% plus 18% GST on it, which Embodha claims back as input credit.
    const proof = payFor(started.orderId, 'pay_inr1', { fee: 2358, tax: 360 });
    await call(member, 'post', '/v1/checkout/confirm', { ...proof, signature: sign('wrong', 'x') }).expect(400);
    const done = await call(member, 'post', '/v1/checkout/confirm', proof).expect(200);
    expect(done.body).toMatchObject({ unlocked: true, course: { slug: 'gentle-spine' }, invoiceNo: expect.stringMatching(/^EMB\/\d{2}-\d{2}\/000001$/) });
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);

    // The spec's worked example: ₹999 = ₹846.61 + ₹152.39 GST; Razorpay's fee ₹19.98 (its ₹3.60 GST comes back);
    // 60% of the ₹826.63 left is ₹495.98.
    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_inr1'));
    expect(row).toMatchObject({
      grossMinor: 99_900,
      gstMinor: 15_239,
      feeMinor: 1998,
      feeTaxPaise: 360,
      feeSource: 'channel',
      netMinor: 82_663,
      netInrPaise: 82_663,
      grossInrPaise: 99_900,
      status: 'captured',
    });
    const [split] = await t.db.select().from(splits).where(eq(splits.paymentId, row.id));
    expect(split).toMatchObject({ percentBps: 6000, instructorPaise: 49_598, embodhaPaise: 33_065, state: 'pending' });

    // Confirming twice, or buying again, changes nothing.
    expect((await call(member, 'post', '/v1/checkout/confirm', proof).expect(200)).body.invoiceNo).toBe(done.body.invoiceNo);
    expect(await t.db.select().from(payments)).toHaveLength(1);
    expect((await call(member, 'post', '/v1/checkout/course', { courseId: f.paid.id }).expect(409)).body.code).toBe('already_unlocked');
  });

  it('records a payment from the webhook when the app never came back, in dollars for members abroad', async () => {
    const member = (await signIn(t, 'abroad@embodha.test')).accessToken;
    await call(member, 'patch', '/v1/me', { country: 'GB' }).expect(200);
    const started = await checkout(member);
    expect(started).toMatchObject({ amount: 1200, currency: 'USD', display: '$12' });
    // Razorpay converts at the bank's rate on the day (₹88.70 here) and charges 3% of the rupees, plus GST.
    payFor(started.orderId, 'pay_usd1', { base_amount: 106_440, base_currency: 'INR', fee: 3768, tax: 575 });

    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_usd1' } } } });
    const hook = (signature: string) => t.http().post('/v1/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', signature).send(body);
    await hook(sign('rzp-hook-secret', 'tampered')).expect(401);
    await hook(sign('rzp-hook-secret', body)).expect(200);
    await hook(sign('rzp-hook-secret', body)).expect(200); // Razorpay retries; still one payment

    // $12, no GST abroad. Booked at Razorpay's rate: ₹1,064.40 less its ₹31.93 fee is ₹1,032.47; the fee is 36¢.
    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_usd1'));
    expect(row).toMatchObject({
      currency: 'USD',
      grossMinor: 1200,
      gstMinor: 0,
      feeMinor: 36,
      netMinor: 1164,
      netInrPaise: 103_247,
      grossInrPaise: 106_440,
      fxRate: '88.700000',
      feeSource: 'channel',
    });
    const [split] = await t.db.select().from(splits).where(eq(splits.paymentId, row.id));
    expect(split.instructorPaise).toBe(61_948);
    await call(member, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(200);
  });

  it('refunds in full: the course leaves the library and the share is reversed', async () => {
    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_inr1'));
    await call(finance, 'post', `/v1/admin/payments/${row.id}/refund`, { reason: 'Bought by mistake' }).expect(200);
    expect(refundCalls).toEqual([{ id: 'pay_inr1', amount: 99_900 }]);
    expect(await t.db.select().from(entitlements).where(eq(entitlements.paymentId, row.id))).toHaveLength(0);
    expect((await t.db.select().from(splits).where(eq(splits.paymentId, row.id)))[0].state).toBe('reversed');
    await call(finance, 'post', `/v1/admin/payments/${row.id}/refund`, { reason: 'Again' }).expect(409);

    const buyer = (await signIn(t, 'buyer@embodha.test')).accessToken;
    await call(buyer, 'get', `/v1/chapters/${f.locked.id}/playback`).expect(402);
    expect((await call(buyer, 'get', '/v1/me/purchases').expect(200)).body).toEqual([
      expect.objectContaining({ course: { slug: 'gentle-spine', title: 'gentle-spine' }, amount: expect.objectContaining({ display: '₹999' }), status: 'refunded' }),
    ]);
  });

  it('pays instructors monthly: prepare, close, mark paid, and claw back a later refund', async () => {
    // Move the dollar sale into last month, past the refund window.
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const month = lastMonth.toISOString().slice(0, 7);
    const [sale] = await t.db.update(payments).set({ capturedAt: lastMonth }).where(eq(payments.externalId, 'pay_usd1')).returning();
    await t.db.update(splits).set({ payableFrom: lastMonth }).where(eq(splits.paymentId, sale.id));

    expect((await call(finance, 'post', `/v1/admin/payouts/${currentMonth()}/prepare`).expect(409)).body.code).toBe('month_not_over');
    const statement = await call(finance, 'post', `/v1/admin/payouts/${month}/prepare`).expect(200);
    expect(statement.body).toMatchObject({ status: 'open', lines: [{ instructor: { displayName: 'Asha Rao' }, payablePaise: 61_948, tdsPaise: 0, netPaise: 61_948 }] });

    const lineId = statement.body.lines[0].id;
    expect((await call(finance, 'post', `/v1/admin/payout-lines/${lineId}/paid`, { bankReference: 'UTR123' }).expect(409)).body.code).toBe('close_first');
    await call(finance, 'post', `/v1/admin/payouts/${month}/close`).expect(200);
    const after = await call(finance, 'post', `/v1/admin/payout-lines/${lineId}/paid`, { bankReference: 'UTR123' }).expect(200);
    expect(after.body).toMatchObject({ status: 'paid', lines: [{ bankReference: 'UTR123', paidAt: expect.any(String) }] });
    expect((await t.db.select().from(splits).where(eq(splits.paymentId, sale.id)))[0].state).toBe('paid');
    await call(finance, 'post', `/v1/admin/payouts/${month}/prepare`).expect(409);

    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    const earnings = await call(asha, 'get', '/v1/studio/earnings').expect(200);
    expect(earnings.body).toMatchObject({ unpaidPaise: 0, payouts: [{ netPaise: 61_948, bankReference: 'UTR123' }] });

    // Refunding a sale that's already been paid out comes off the instructor's next payout.
    await call(finance, 'post', `/v1/admin/payments/${sale.id}/refund`, { reason: 'Card dispute' }).expect(200);
    expect(await t.db.select({ amountPaise: adjustments.amountPaise }).from(adjustments)).toEqual([{ amountPaise: -61_948 }]);
  });
});
