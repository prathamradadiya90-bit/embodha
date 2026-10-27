import { and, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { adjustments, payments, payoutLines, reconciliationLines, refunds, splits, staffRoles, users } from '../src/db/schema';
import { Charge, PaymentsService } from '../src/money/payments.service';
import { RazorpayOrder, RazorpayPayment, RazorpayService, RazorpaySubscription } from '../src/money/razorpay.service';
import { ReconciliationService } from '../src/money/reconciliation.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, latestMail, signIn, TEST_ENV, TestApp } from './helpers';

const sign = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  d.setUTCDate(10);
  return d;
};

/** A zip as Play's Cloud Storage hands one out: one deflated CSV. */
function zipOf(name: string, text: string) {
  const raw = Buffer.from(text, 'utf8');
  const data = deflateRawSync(raw);
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + file.length, 12);
  end.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

describe('Reconciliation', () => {
  let t: TestApp;
  let f: Fixtures;
  let finance: string;
  let support: string;
  let money: PaymentsService;

  // Razorpay, faked at its HTTP edge.
  const orders = new Map<string, RazorpayOrder>();
  const paid = new Map<string, RazorpayPayment>();
  const subscriptions = new Map<string, RazorpaySubscription>();
  const settledOn = new Map<string, Record<string, unknown>[]>();

  const userId = async (email: string) => {
    const [row] = await t.db.select().from(users).where(eq(users.email, email));
    if (row) return row.id;
    const [made] = await t.db.insert(users).values({ email, name: email.split('@')[0], country: 'IN', state: '29' }).returning();
    return made.id;
  };
  const payment = async (channel: 'razorpay' | 'google' | 'apple', externalId: string) =>
    (await t.db.select().from(payments).where(and(eq(payments.channel, channel), eq(payments.externalId, externalId))))[0];
  const splitOf = async (paymentId: string) => (await t.db.select().from(splits).where(eq(splits.paymentId, paymentId)))[0];

  /** A website purchase through Checkout, as the app makes it. `fee` and `tax` are what Razorpay puts on the payment. */
  async function websiteSale(email: string, id: string, extra: Partial<RazorpayPayment> = {}, confirm = true) {
    const member = (await signIn(t, email)).accessToken;
    await t.http().patch('/v1/me').set(bearer(member)).send({ country: extra.currency === 'USD' ? 'GB' : 'IN', state: extra.currency === 'USD' ? undefined : '29' }).expect(200);
    const started = (await t.http().post('/v1/checkout/course').set(bearer(member)).send({ courseId: f.paid.id }).expect(200)).body;
    const order = orders.get(started.orderId)!;
    paid.set(id, { id, order_id: order.id, amount: order.amount, currency: order.currency, status: 'captured', ...extra });
    if (confirm) await t.http().post('/v1/checkout/confirm').set(bearer(member)).send({ orderId: order.id, paymentId: id, signature: sign('rzp-test-secret', `${order.id}|${id}`) }).expect(200);
    return order;
  }

  /** One line of Razorpay's settlement recon, as its API returns it. */
  const settled = (entity: string, type: string, values: Record<string, unknown>) => ({
    entity_id: entity,
    type,
    debit: 0,
    credit: 0,
    amount: 0,
    currency: 'INR',
    fee: 0,
    tax: 0,
    on_hold: false,
    settled: true,
    created_at: 1_760_000_000,
    settled_at: 1_761_000_000,
    settlement_id: 'setl_RkQ1',
    settlement_utr: 'UTIB0001234',
    payment_id: null,
    order_id: null,
    ...values,
  });
  const fetchDays = (from: string, to: string, token = finance) => t.http().post('/v1/admin/reconciliation/razorpay').set(bearer(token)).send({ from, to });

  /** A sale in the apps, booked the way the store flows book it. */
  const storeSale = async (channel: 'google' | 'apple', externalId: string, email: string, charge: Partial<Charge> & Pick<Charge, 'currency' | 'grossMinor'>, kind: 'course' | 'subscription' = 'course') =>
    money.book({
      charge: { channel, externalId, feeRateBps: 1500, feeBase: 'after_gst', capturedAt: new Date('2026-09-10T08:00:00Z'), productId: kind === 'course' ? 'course.gentle_spine' : 'plan.asha_rao', ...charge },
      userId: await userId(email),
      instructorId: f.asha.id,
      ...(kind === 'course' ? { courseId: f.paid.id } : {}),
    });

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    money = t.app.get(PaymentsService);
    const razorpay = t.app.get(RazorpayService);
    jest.spyOn(razorpay, 'createOrder').mockImplementation(async (input) => {
      const order = { id: `order_${orders.size + 1}`, amount: input.amount, currency: input.currency, status: 'created', notes: input.notes };
      orders.set(order.id, order);
      return order;
    });
    jest.spyOn(razorpay, 'fetchOrder').mockImplementation(async (id) => orders.get(id)!);
    jest.spyOn(razorpay, 'fetchPayment').mockImplementation(async (id) => paid.get(id)!);
    jest.spyOn(razorpay, 'refund').mockImplementation(async (id, amount) => ({ id: 'rfnd_R1', payment_id: id, amount, status: 'processed' }));
    jest.spyOn(razorpay, 'fetchInvoice').mockImplementation(async (id) => ({ id, subscription_id: id === 'inv_7' ? 'sub_7' : null }));
    jest.spyOn(razorpay, 'fetchSubscription').mockImplementation(async (id) => subscriptions.get(id)!);
    jest.spyOn(razorpay, 'settlementRecon').mockImplementation(async ({ year, month, day }) => settledOn.get(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) ?? []);

    finance = (await signIn(t, 'books@embodha.test')).accessToken;
    support = (await signIn(t, 'help@embodha.test')).accessToken;
    await t.db.insert(staffRoles).values([
      { userId: await userId('books@embodha.test'), role: 'finance' },
      { userId: await userId('help@embodha.test'), role: 'support' },
    ]);
  });
  afterAll(async () => {
    await t.close();
  });

  it("matches Razorpay's settlements to the books: real fees in, missed sales and refunds booked, the rest listed", async () => {
    // A: Razorpay's fee on the payment at the time (₹23.58, of which ₹3.60 is GST that comes back).
    await websiteSale('a@embodha.test', 'pay_A', { fee: 2358, tax: 360 });
    // B: no fee on the payment yet, so the usual 2% was booked; the settlement says UPI cost nothing.
    await websiteSale('b@embodha.test', 'pay_B');
    // C: dollars, converted by Razorpay at ₹88.70.
    await websiteSale('c@embodha.test', 'pay_C', { currency: 'USD', base_amount: 106_440, base_currency: 'INR', fee: 3768, tax: 575 });
    // D: paid, but the app never came back and the webhook went astray.
    const paidAt = Math.floor(Date.now() / 1000) - 120;
    const lost = await websiteSale('d@embodha.test', 'pay_D', { fee: 2358, tax: 360, created_at: paidAt }, false);
    // R: refunded by finance afterwards.
    await websiteSale('r@embodha.test', 'pay_R', { fee: 2358, tax: 360 });
    const refundee = await payment('razorpay', 'pay_R');
    await t.http().post(`/v1/admin/payments/${refundee.id}/refund`).set(bearer(finance)).send({ reason: 'Bought it twice' }).expect(200);
    // A subscription's renewal that the books never heard about.
    subscriptions.set('sub_7', { id: 'sub_7', plan_id: 'plan_1', status: 'active', current_start: 1_760_000_000, current_end: 1_762_600_000, notes: { kind: 'subscription', user_id: await userId('a@embodha.test'), instructor_id: f.asha.id } });
    paid.set('pay_S', { id: 'pay_S', order_id: 'order_sub', amount: 49_900, currency: 'INR', status: 'captured', fee: 1178, tax: 180, invoice_id: 'inv_7' });
    orders.set('order_sub', { id: 'order_sub', amount: 49_900, currency: 'INR', status: 'paid', notes: [] });
    // Someone else's payment on the same account.
    paid.set('pay_X', { id: 'pay_X', order_id: 'order_x', amount: 50_000, currency: 'INR', status: 'captured', fee: 1180, tax: 180 });
    orders.set('order_x', { id: 'order_x', amount: 50_000, currency: 'INR', status: 'paid', notes: { kind: 'gift' } });

    settledOn.set('2026-10-20', [
      settled('pay_A', 'payment', { amount: 99_900, fee: 2358, tax: 360, credit: 97_542, order_id: 'order_1' }),
      settled('pay_B', 'payment', { amount: 99_900, fee: 0, tax: 0, credit: 99_900 }),
      settled('pay_C', 'payment', { amount: 106_440, fee: 3768, tax: 575, credit: 102_672 }),
      settled('pay_D', 'payment', { amount: 99_900, fee: 2358, tax: 360, credit: 97_542, order_id: lost.id }),
    ]);
    settledOn.set('2026-10-21', [
      settled('pay_R', 'payment', { amount: 99_900, fee: 2358, tax: 360, credit: 97_542 }),
      settled('rfnd_R1', 'refund', { amount: 99_900, debit: 99_900, payment_id: 'pay_R' }),
      settled('pay_S', 'payment', { amount: 49_900, fee: 1178, tax: 180, credit: 48_722 }),
      settled('pay_X', 'payment', { amount: 50_000, fee: 1180, tax: 180, credit: 48_820 }),
      settled('adj_1', 'adjustment', { amount: 5000, debit: 5000, description: 'Chargeback fee' }),
    ]);

    const fetched = (await fetchDays('2026-10-20', '2026-10-21').expect(200)).body;
    expect(fetched).toMatchObject({ label: 'Razorpay settlements, 20–21 Oct 2026', channel: 'razorpay', repeated: 0 });
    expect(fetched.counts).toEqual({ matched: 4, corrected: 1, booked: 2, unbooked: 1, other: 1 });

    // A matched as booked, with what reached the bank.
    expect(await payment('razorpay', 'pay_A')).toMatchObject({ feeMinor: 1998, feeSource: 'channel', netInrPaise: 82_663, settledInrPaise: 97_542, reconciledAt: expect.any(Date) });
    // B: the fee is what Razorpay charged, and the instructor's share follows.
    const b = await payment('razorpay', 'pay_B');
    expect(b).toMatchObject({ feeMinor: 0, feeTaxPaise: 0, feeSource: 'report', netMinor: 84_661, netInrPaise: 84_661, settledInrPaise: 99_900 });
    expect(await splitOf(b.id)).toMatchObject({ netInrPaise: 84_661, instructorPaise: 50_797, embodhaPaise: 33_864 });
    // C: dollars at Razorpay's own rate, already right.
    expect(await payment('razorpay', 'pay_C')).toMatchObject({ currency: 'USD', feeMinor: 36, grossInrPaise: 106_440, netInrPaise: 103_247, settledInrPaise: 102_672, feeSource: 'channel' });
    // D and the renewal are in the books now: the member has the course, the instructor the share.
    const d = await payment('razorpay', 'pay_D');
    // Booked on the day it was paid, not the day the settlement turned it up.
    expect(d).toMatchObject({ kind: 'course', invoiceNo: expect.stringMatching(/^EMB\//), capturedAt: new Date(paidAt * 1000), reconciledAt: expect.any(Date) });
    expect(await payment('razorpay', 'pay_S')).toMatchObject({ kind: 'subscription', grossMinor: 49_900, feeMinor: 998, reconciledAt: expect.any(Date) });

    const page = (await t.http().get(`/v1/admin/reconciliation?month=${new Date().toISOString().slice(0, 7)}`).set(bearer(finance)).expect(200)).body;
    const site = page.channels.find((c: { channel: string }) => c.channel === 'razorpay');
    expect(site).toMatchObject({ sales: 6, reconciled: 6, corrected: 1, waiting: 0, late: 0, currencies: ['INR', 'USD'] });
    expect(page.imports[0]).toMatchObject({ label: 'Razorpay settlements, 20–21 Oct 2026', source: 'api', lines: 9, open: 2, corrected: 1 });
    expect(page.attention.map((line: { ref: string; status: string }) => [line.ref, line.status])).toEqual(
      expect.arrayContaining([
        ['pay_X', 'unbooked'],
        ['adj_1', 'other'],
      ]),
    );
    const stranger = page.attention.find((line: { ref: string }) => line.ref === 'pay_X');
    expect(stranger.note).toMatch(/That payment is not for an Embodha course/);

    // The same days again: nothing new.
    expect((await fetchDays('2026-10-20', '2026-10-21').expect(200)).body).toMatchObject({ id: null, repeated: 9 });

    // Finance looks into the adjustment and says what it was.
    const adjustment = page.attention.find((line: { ref: string }) => line.ref === 'adj_1');
    await t.http().post(`/v1/admin/reconciliation/lines/${adjustment.id}/explain`).set(bearer(finance)).send({ explanation: 'Chargeback fee on an order from 2025; expected.' }).expect(200);
    const after = (await t.http().get('/v1/admin/reconciliation').set(bearer(finance)).expect(200)).body;
    expect(after.attention.map((line: { ref: string }) => line.ref)).not.toContain('adj_1');
    await t.http().post(`/v1/admin/reconciliation/lines/${adjustment.id}/explain`).set(bearer(finance)).send({ explanation: 'again' }).expect(409);
  });

  it("moves a corrected share on an open statement, and puts it on the next one once the statement's closed", async () => {
    const month = lastMonth().toISOString().slice(0, 7);
    for (const [email, id] of [
      ['e@embodha.test', 'pay_E'],
      ['f@embodha.test', 'pay_F'],
    ]) {
      await websiteSale(email, id);
      const row = await payment('razorpay', id);
      await t.db.update(payments).set({ capturedAt: lastMonth() }).where(eq(payments.id, row.id));
      await t.db.update(splits).set({ payableFrom: lastMonth() }).where(eq(splits.paymentId, row.id));
    }
    const statement = (await t.http().post(`/v1/admin/payouts/${month}/prepare`).set(bearer(finance)).expect(200)).body;
    expect(statement.lines[0]).toMatchObject({ payablePaise: 99_196, netPaise: 99_196 });

    settledOn.set('2026-10-22', [settled('pay_E', 'payment', { amount: 99_900, credit: 99_900 })]);
    expect((await fetchDays('2026-10-22', '2026-10-22').expect(200)).body.counts).toEqual({ corrected: 1 });
    const [line] = await t.db.select().from(payoutLines).where(eq(payoutLines.id, statement.lines[0].id));
    expect(line).toMatchObject({ payablePaise: 100_395, netPaise: 100_395 });

    await t.http().post(`/v1/admin/payouts/${month}/close`).set(bearer(finance)).expect(200);
    settledOn.set('2026-10-23', [settled('pay_F', 'payment', { amount: 99_900, credit: 99_900 })]);
    await fetchDays('2026-10-23', '2026-10-23').expect(200);
    expect(await t.db.select({ amountPaise: adjustments.amountPaise, reason: adjustments.reason }).from(adjustments)).toEqual([
      { amountPaise: 1199, reason: expect.stringMatching(/^Correction from Razorpay's figures for EMB\//) },
    ]);
  });

  it('reads Google Play’s earnings report: real commission, shares payable, a missed refund booked, a lost sale found', async () => {
    // August, so its statement is still to be prepared.
    const august = new Date('2026-08-10T08:00:00Z');
    const one = await storeSale('google', 'GPA.1111-2222-3333-44444', 'g1@embodha.test', { currency: 'INR', grossMinor: 99_900, capturedAt: august });
    const renewal = await storeSale('google', 'GPA.1111-2222-3333-55555..0', 'g2@embodha.test', { currency: 'INR', grossMinor: 49_900, capturedAt: august }, 'subscription');
    const abroad = await storeSale('google', 'GPA.1111-2222-3333-66666', 'g3@embodha.test', { currency: 'USD', grossMinor: 1200, capturedAt: august });
    const refunded = await storeSale('google', 'GPA.1111-2222-3333-88888', 'g4@embodha.test', { currency: 'INR', grossMinor: 99_900, capturedAt: august });
    // A store's share waits for the store's report.
    expect((await splitOf(one.id)).payableFrom).toBeNull();
    expect(abroad).toMatchObject({ feeMinor: 180, netMinor: 1020, netInrPaise: 89_760, feeSource: 'estimate' });

    const header =
      'Description,Transaction Date,Transaction Time,Tax Type,Transaction Type,Refund Type,Product Title,Package ID,Product Type,SKU ID,Hardware,Buyer Country,Buyer State,Buyer Postcode,Buyer Currency,Amount (Buyer Currency),Currency Conversion Rate,Merchant Currency,Amount (Merchant Currency),Base Plan or Purchase Option ID,Offer ID,Group ID,First USD 1M Eligible,Service Fee %,Fee Description,Promotion ID,Sales Channel';
    const row = (order: string, date: string, type: string, buyer: string, merchant: string, currency = 'INR', rate = '1') =>
      `${order},"${date}",10:02:12 AM UTC,,${type},,Gentle Spine,com.embodha.app,inapp,course.gentle_spine,,IN,KA,,${currency},${buyer},${rate},INR,${merchant},,,,,15,,,`;
    const csv = [
      header,
      // Google kept the GST and its 15%: proceeds are exactly what was booked.
      row('GPA.1111-2222-3333-44444', 'Aug 10, 2026', 'Charge', '999.00', '999.00'),
      row('GPA.1111-2222-3333-44444', 'Aug 10, 2026', 'Tax', '-152.39', '-152.39'),
      row('GPA.1111-2222-3333-44444', 'Aug 10, 2026', 'Google fee', '-126.99', '-126.99'),
      // Google took 15% of the whole price and passed the GST on: Embodha owes the GST, and the share is smaller.
      row('GPA.1111-2222-3333-55555..0', 'Aug 10, 2026', 'Charge', '499.00', '499.00'),
      row('GPA.1111-2222-3333-55555..0', 'Aug 10, 2026', 'Google fee', '-74.85', '-74.85'),
      // Dollars, converted by Google at ₹84.50.
      row('GPA.1111-2222-3333-66666', 'Aug 10, 2026', 'Charge', '12.00', '1014.00', 'USD', '84.5'),
      row('GPA.1111-2222-3333-66666', 'Aug 10, 2026', 'Google fee', '-1.80', '-152.10', 'USD', '84.5'),
      // A sale that never reached Embodha.
      row('GPA.1111-2222-3333-77777', 'Aug 12, 2026', 'Charge', '999.00', '999.00'),
      row('GPA.1111-2222-3333-77777', 'Aug 12, 2026', 'Google fee', '-126.99', '-126.99'),
      // A refund whose notice never came.
      row('GPA.1111-2222-3333-88888', 'Aug 20, 2026', 'Charge refund', '-999.00', '-999.00'),
      row('GPA.1111-2222-3333-88888', 'Aug 20, 2026', 'Google fee refund', '126.99', '126.99'),
      `Adjustment,"Aug 30, 2026",,,Adjustment,,,,,,,,,,,,,INR,-50.00,,,,,,,,`,
    ].join('\n');
    const upload = (file: Buffer, name: string) => t.http().post('/v1/admin/reconciliation/upload').set(bearer(finance)).attach('file', file, name);

    const [result] = (await upload(zipOf('earnings_202608.csv', csv), 'earnings_202608.zip').expect(200)).body;
    expect(result).toMatchObject({ channel: 'google', label: 'Google Play earnings, August 2026', repeated: 0 });
    expect(result.counts).toEqual({ matched: 1, corrected: 2, unbooked: 1, booked: 1, other: 1 });

    // Google's figures bear the estimate out: it stands, now checked.
    expect(await payment('google', 'GPA.1111-2222-3333-44444')).toMatchObject({ feeMinor: 12_699, netInrPaise: 71_962, settledInrPaise: 71_962, feeSource: 'estimate', reconciledAt: expect.any(Date) });
    expect((await splitOf(one.id)).payableFrom).toEqual(expect.any(Date));
    const sub = await payment('google', renewal.externalId);
    expect(sub).toMatchObject({ feeMinor: 7485, netMinor: 34_803, netInrPaise: 34_803, settledInrPaise: 42_415, feeSource: 'report' });
    expect(await splitOf(sub.id)).toMatchObject({ instructorPaise: 20_882, payableFrom: expect.any(Date) });
    const [subLine] = await t.db.select().from(reconciliationLines).where(eq(reconciliationLines.ref, renewal.externalId));
    expect(subLine.note).toMatch(/GST on this sale is Embodha's to pay/);
    // Google's 15% stays $1.80; the rupees are what its own rate made of the sale.
    expect(await payment('google', 'GPA.1111-2222-3333-66666')).toMatchObject({ feeMinor: 180, netMinor: 1020, netInrPaise: 86_190, grossInrPaise: 101_400, fxRate: '84.500000', feeSource: 'report' });
    const [dollarLine] = await t.db.select().from(reconciliationLines).where(eq(reconciliationLines.ref, 'GPA.1111-2222-3333-66666'));
    expect(dollarLine.note).toBe('Google converted at ₹84.50 to the dollar; the books had ₹88.00.');
    // The refund Google made is in the books now: no course, no share.
    expect(await payment('google', refunded.externalId)).toMatchObject({ status: 'refunded' });
    expect((await splitOf(refunded.id)).state).toBe('reversed');
    expect(await t.db.select().from(refunds).where(eq(refunds.paymentId, refunded.id))).toHaveLength(1);

    // Store shares are payable now that Google has reported them.
    const statement = (await t.http().post('/v1/admin/payouts/2026-08/prepare').set(bearer(finance)).expect(200)).body;
    expect(statement.lines[0].payablePaise).toBe(Math.round(71_962 * 0.6) + 20_882 + Math.round(86_190 * 0.6));

    // The same report again changes nothing.
    expect((await upload(zipOf('earnings_202608.csv', csv), 'earnings_202608.zip').expect(200)).body[0]).toMatchObject({ id: null, repeated: 6 });
    expect((await upload(Buffer.from('just,some\nwords,here'), 'notes.csv').expect(422)).body.code).toBe('unreadable_report');
  });

  it('reads the App Store’s financial report: units to the oldest matching sales, dollars once the rate is in', async () => {
    const charged = (currency: string, price: string) => ({ charged: { currency, price } });
    const first = await storeSale('apple', '2000000001', 'i1@embodha.test', { currency: 'INR', grossMinor: 99_900, ...charged('INR', '999.00'), capturedAt: new Date('2026-09-02T08:00:00Z') });
    await storeSale('apple', '2000000002', 'i2@embodha.test', { currency: 'INR', grossMinor: 99_900, ...charged('INR', '999.00') });
    await storeSale('apple', '2000000003', 'i3@embodha.test', { currency: 'INR', grossMinor: 99_900, ...charged('INR', '999.00') });
    const later = await storeSale('apple', '2000000004', 'i4@embodha.test', { currency: 'INR', grossMinor: 99_900, ...charged('INR', '999.00'), capturedAt: new Date('2026-10-20T08:00:00Z') });
    const dollar = await storeSale('apple', '2000000005', 'i5@embodha.test', { currency: 'USD', grossMinor: 1200, ...charged('USD', '12.00') });

    const header =
      'Start Date\tEnd Date\tUPC\tISRC/ISBN\tVendor Identifier\tQuantity\tPartner Share\tExtended Partner Share\tPartner Share Currency\tSales or Return\tApple Identifier\tArtist/Show/Developer/Author\tTitle\tLabel/Studio/Network/Developer/Publisher\tGrid\tProduct Type Identifier\tISAN/Other Identifier\tCountry Of Sale\tPre-order Flag\tPromo Code\tCustomer Price\tCustomer Currency';
    const row = (product: string, quantity: number, share: string, extended: string, currency: string, saleOrReturn: string, country: string, price: string, customerCurrency: string) =>
      ['08/30/2026', '09/26/2026', '', product, product, quantity, share, extended, currency, saleOrReturn, '6740000000', 'Embodha Wellness Pvt Ltd', product, '', '', 'IA1', '', country, '', '', price, customerCurrency].join('\t');
    const report = [
      header,
      row('course.gentle_spine', 3, '719.62', '2158.86', 'INR', 'S', 'IN', '999.00', 'INR'),
      row('course.gentle_spine', 1, '10.20', '10.20', 'USD', 'S', 'US', '12.00', 'USD'),
      row('plan.asha_rao', 1, '359.45', '359.45', 'INR', 'S', 'IN', '499.00', 'INR'),
      row('course.gentle_spine', -1, '719.62', '-719.62', 'INR', 'R', 'IN', '-999.00', 'INR'),
      'Total_Rows\t4',
      'Total_Amount\t1809.69',
    ].join('\n');
    const [result] = (
      await t.http().post('/v1/admin/reconciliation/upload').set(bearer(finance)).attach('file', gzipSync(report), 'financial_report_0926.txt.gz').expect(200)
    ).body;
    expect(result).toMatchObject({ channel: 'apple', label: 'App Store financial report, 30 Aug – 26 Sep 2026', needsRates: ['USD'] });
    expect(result.counts).toEqual({ matched: 1, needs_rate: 1, unbooked: 1, differs: 1 });

    // Three units at ₹719.62 each went to the three September sales; October's waits for October's report.
    expect(await payment('apple', '2000000001')).toMatchObject({ netInrPaise: 71_962, settledInrPaise: 71_962, reconciledAt: expect.any(Date) });
    expect((await splitOf(first.id)).payableFrom).toEqual(expect.any(Date));
    expect((await payment('apple', later.externalId)).reconciledAt).toBeNull();
    expect((await payment('apple', dollar.externalId)).reconciledAt).toBeNull();

    const { lines } = (await t.http().get(`/v1/admin/reconciliation/imports/${result.id}`).set(bearer(finance)).expect(200)).body;
    expect(lines.find((l: { ref: string }) => l.ref.includes('plan.asha_rao')).note).toMatch(/One purchase never reached Embodha/);
    expect(lines.find((l: { kind: string }) => l.kind === 'refund').note).toMatch(/the books refunded 0/);

    // The rupee rate from September's payment in App Store Connect settles the dollar sale.
    await t.http().post(`/v1/admin/reconciliation/imports/${result.id}/rates`).set(bearer(finance)).send({ rates: { usd: 'eighty' } }).expect(200);
    const rated = (await t.http().post(`/v1/admin/reconciliation/imports/${result.id}/rates`).set(bearer(finance)).send({ rates: { USD: '84.50' } }).expect(200)).body;
    expect(rated).toMatchObject({ rates: { USD: '84.50' }, counts: { corrected: 1 } });
    expect(await payment('apple', dollar.externalId)).toMatchObject({ feeMinor: 180, netMinor: 1020, netInrPaise: 86_190, fxRate: '84.500000', feeSource: 'report' });

    const page = (await t.http().get('/v1/admin/reconciliation?month=2026-09').set(bearer(finance)).expect(200)).body;
    // Matched estimates aren't "still estimated" any more.
    expect(page.channels.find((c: { channel: string }) => c.channel === 'apple')).toMatchObject({ sales: 4, reconciled: 4, estimated: 0, corrected: 1, reportedTo: '2026-09-26' });
    const needsRate = page.attention.find((line: { status: string }) => line.status === 'needs_rate');
    expect(needsRate).toBeUndefined();
  });

  it('checks the last week of settlements each night after 3 a.m., once, and writes to finance about anything off', async () => {
    const reconciliation = t.app.get(ReconciliationService);
    (TEST_ENV as { FINANCE_EMAIL?: string }).FINANCE_EMAIL = 'accounts@embodha.test';
    settledOn.set('2026-10-24', [settled('pay_Z', 'payment', { amount: 25_000, fee: 590, tax: 90, credit: 24_410 })]);
    paid.set('pay_Z', { id: 'pay_Z', order_id: 'order_z', amount: 25_000, currency: 'INR', status: 'captured' });
    orders.set('order_z', { id: 'order_z', amount: 25_000, currency: 'INR', status: 'paid', notes: { kind: 'donation' } });

    expect(await reconciliation.nightly(new Date('2026-10-25T20:00:00Z'))).toBeNull(); // 1:30 a.m. in India: too early
    const night = await reconciliation.nightly(new Date('2026-10-25T22:00:00Z')); // 3:30 a.m.
    expect(night).toMatchObject({ label: 'Razorpay settlements, 19–25 Oct 2026', counts: { unbooked: 1 }, repeated: 11 });
    const mail = latestMail(t.mail, 'accounts@embodha.test');
    expect(mail.subject).toBe("Money check: 1 thing in Razorpay's settlements to look at");
    expect(mail.text).toContain('pay_Z: Razorpay settled ₹250.00 for this payment');
    expect(await reconciliation.nightly(new Date('2026-10-25T23:00:00Z'))).toBeNull(); // already done today
    delete (TEST_ENV as { FINANCE_EMAIL?: string }).FINANCE_EMAIL;
  });

  it("is finance's alone, and feeds Beta health's reconciliation bar", async () => {
    await t.http().get('/v1/admin/reconciliation').set(bearer(support)).expect(403);
    await t.http().post('/v1/admin/reconciliation/upload').set(bearer(support)).attach('file', Buffer.from('x'), 'x.csv').expect(403);
    await t.http().get('/v1/admin/reconciliation?month=2026-13').set(bearer(finance)).expect(400);
    await fetchDays('2026-10-01', '2026-11-15').expect(400);
    await t.http().post('/v1/admin/reconciliation/upload').set(bearer(finance)).expect(400);

    const bar = (await t.http().get('/v1/admin/beta?days=14').set(bearer(finance)).expect(200)).body.bars.reconciliation;
    // The website's sales this fortnight all reconcile, but a stranger's payment and the store problems are still open.
    expect(bar).toMatchObject({ ready: true, problems: expect.any(Number), met: false });
    expect(bar.channels.razorpay).toMatchObject({ reconciled: 6 });
    expect(bar.problems).toBeGreaterThan(0);
  });
});
