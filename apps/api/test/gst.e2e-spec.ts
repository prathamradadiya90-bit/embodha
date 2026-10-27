import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { currentMonth } from '../src/common/month';
import { payments, refunds, staffRoles, users } from '../src/db/schema';
import { InvoicesService } from '../src/money/invoices.service';
import { PaymentsService } from '../src/money/payments.service';
import { RazorpayOrder, RazorpayPayment, RazorpayService } from '../src/money/razorpay.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

const sign = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');
/** A made-up GSTIN in Karnataka (29), with a correct check digit. */
const GSTIN = '29ABCDE1234F1ZW';

describe('GST on invoices', () => {
  let t: TestApp;
  let f: Fixtures;
  let finance: string;
  const orders = new Map<string, RazorpayOrder>();
  const paid = new Map<string, RazorpayPayment>();

  const call = (token: string, method: 'get' | 'post' | 'patch' | 'put', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };
  /** A member who lives where they say, buying the ₹999 course on the website. */
  const buyer = async (email: string, where: { country: string; state?: string }) => {
    const token = (await signIn(t, email)).accessToken;
    await call(token, 'patch', '/v1/me', where).expect(200);
    const started = (await call(token, 'post', '/v1/checkout/course', { courseId: f.paid.id }).expect(200)).body;
    const order = orders.get(started.orderId)!;
    const paymentId = `pay_${email.split('@')[0]}`;
    paid.set(paymentId, { id: paymentId, order_id: order.id, amount: order.amount, currency: order.currency, status: 'captured', fee: order.currency === 'INR' ? 2358 : undefined });
    const proof = { orderId: order.id, paymentId, signature: sign('rzp-test-secret', `${order.id}|${paymentId}`) };
    await call(token, 'post', '/v1/checkout/confirm', proof).expect(200);
    await call(token, 'post', '/v1/checkout/confirm', proof).expect(200); // the app and the webhook both get through
    const [row] = await t.db.select().from(payments).where(eq(payments.externalId, paymentId));
    return { token, row };
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
    jest.spyOn(razorpay, 'refund').mockImplementation(async (id, amount) => ({ id: `rfnd_${id}`, payment_id: id, amount, status: 'processed' }));
    finance = (await signIn(t, 'books@embodha.test')).accessToken;
    const [person] = await t.db.select().from(users).where(eq(users.email, 'books@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: person.id, role: 'finance' });
    await call(finance, 'put', '/v1/admin/money-settings', {
      seller: { name: 'Embodha Wellness Private Limited', address: '12 Example Road, Bengaluru 560001', gstin: GSTIN, sac: '999293' },
      noteAbroad: 'Supply meant for export under letter of undertaking without payment of IGST. LUT AD2903260000000.',
    }).expect(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('splits by where the buyer lives: CGST and SGST in Karnataka, IGST elsewhere, nothing abroad', async () => {
    const home = await buyer('meera@example.com', { country: 'IN', state: '29' });
    expect(home.row).toMatchObject({ gstMinor: 15_239, gstRateBps: 1800, buyerState: '29', placeOfSupply: '29', cgstMinor: 7619, sgstMinor: 7620, igstMinor: 0, invoiceNo: expect.stringMatching(/^EMB\/\d{2}-\d{2}\/000001$/) });

    const away = await buyer('arjun@example.com', { country: 'IN', state: '27' });
    expect(away.row).toMatchObject({ buyerState: '27', placeOfSupply: '27', cgstMinor: 0, sgstMinor: 0, igstMinor: 15_239 });

    // GST rules want the buyer's state on every invoice for an online service, so checkout asks for it first.
    const unsure = (await signIn(t, 'kiran@example.com')).accessToken;
    await call(unsure, 'patch', '/v1/me', { country: 'IN' }).expect(200);
    const refused = await call(unsure, 'post', '/v1/checkout/course', { courseId: f.paid.id }).expect(409);
    expect(refused.body).toMatchObject({ code: 'state_needed', message: expect.stringMatching(/Your details/) });
    await call(unsure, 'post', '/v1/checkout/subscription', { instructorId: f.asha.id }).expect(409);

    // A renewal for someone who never gave a state can't be refused: it's taxed in the seller's state, and flagged.
    const [kiran] = await t.db.select().from(users).where(eq(users.email, 'kiran@example.com'));
    const renewal = await t.app.get(PaymentsService).book({ charge: { channel: 'razorpay', externalId: 'pay_kiran_renewal', currency: 'INR', grossMinor: 49_900, feeRateBps: 236 }, userId: kiran.id, instructorId: f.asha.id });
    expect(renewal).toMatchObject({ buyerState: null, placeOfSupply: '29', gstMinor: 7612, cgstMinor: 3806, sgstMinor: 3806 });
    expect((await t.app.get(InvoicesService).document(renewal.id, 'invoice'))!.document.buyer.where).toBe('Not given');

    const abroad = await buyer('sam@example.com', { country: 'GB' });
    expect(abroad.row).toMatchObject({ currency: 'USD', gstMinor: 0, gstRateBps: 0, buyerState: null, placeOfSupply: '96', cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });

    // Four sales, four numbers in a row: confirming twice, or a refused checkout, never used one up.
    const numbers = (await t.db.select({ no: payments.invoiceNo }).from(payments)).map((r) => r.no!.slice(-6)).sort();
    expect(numbers).toEqual(['000001', '000002', '000003', '000004']);
  });

  it('prints the place of supply and each tax, with the seller as they were on the day', async () => {
    const invoices = t.app.get(InvoicesService);
    const [home] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_meera'));
    const [away] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_arjun'));
    const [abroad] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_sam'));

    // Moving the office afterwards doesn't rewrite invoices already sent.
    await call(finance, 'put', '/v1/admin/money-settings', { seller: { name: 'Embodha Wellness Private Limited', address: 'New address, Mumbai', gstin: '27ABCDE1234F1Z0' } }).expect(200);

    const homeDoc = (await invoices.document(home.id, 'invoice'))!.document;
    expect(homeDoc).toMatchObject({
      seller: { gstin: GSTIN, address: '12 Example Road, Bengaluru 560001', sac: '999293', state: 'Karnataka (29)' },
      buyer: { name: null, email: 'meera@example.com', where: 'Karnataka (29)' },
      placeOfSupply: { code: '29', label: 'Karnataka (29)' },
      taxes: [
        { name: 'CGST', rateBps: 900, minor: 7619 },
        { name: 'SGST', rateBps: 900, minor: 7620 },
      ],
    });
    expect((await invoices.document(away.id, 'invoice'))!.document).toMatchObject({ placeOfSupply: { label: 'Maharashtra (27)' }, taxes: [{ name: 'IGST', rateBps: 1800, minor: 15_239 }] });
    expect((await invoices.document(abroad.id, 'invoice'))!.document).toMatchObject({
      placeOfSupply: { code: '96', label: 'Outside India (96)' },
      taxes: [],
      buyer: { where: 'GB' },
      note: expect.stringMatching(/^Supply meant for export/),
    });
    const pdf = await call(finance, 'get', `/v1/payments/${home.id}/invoice`).buffer(true).expect(200);
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('issues a credit note for a refund, emails it, and lets the member and finance download it', async () => {
    const [away] = await t.db.select().from(payments).where(eq(payments.externalId, 'pay_arjun'));
    const member = (await signIn(t, 'arjun@example.com')).accessToken;
    await call(member, 'get', `/v1/payments/${away.id}/credit-note`).expect(404); // nothing refunded yet

    await call(finance, 'post', `/v1/admin/payments/${away.id}/refund`, { reason: 'Bought twice' }).expect(200);
    const [refund] = await t.db.select().from(refunds).where(eq(refunds.paymentId, away.id));
    expect(refund).toMatchObject({ creditNoteNo: expect.stringMatching(/^CN\/\d{2}-\d{2}\/000001$/), amountMinor: 99_900, gstMinor: 15_239, igstMinor: 15_239, cgstMinor: 0, sgstMinor: 0 });

    const mail = [...t.mail.outbox].reverse().find((m) => m.to === 'arjun@example.com' && /credit note/.test(m.subject))!;
    expect(mail.subject).toBe(`Your Embodha refund: credit note ${refund.creditNoteNo}`);
    expect(mail.text).toContain(`against invoice ${away.invoiceNo}`);
    expect(mail.attachments![0]).toMatchObject({ contentType: 'application/pdf', filename: expect.stringMatching(/^embodha-credit-note-CN-/) });

    const doc = (await t.app.get(InvoicesService).document(away.id, 'credit_note'))!.document;
    expect(doc).toMatchObject({ kind: 'credit_note', number: refund.creditNoteNo, against: { number: away.invoiceNo }, taxes: [{ name: 'IGST', minor: 15_239 }] });
    await call(member, 'get', `/v1/payments/${away.id}/credit-note`).expect(200);
    await call(finance, 'get', `/v1/payments/${away.id}/credit-note`).expect(200);
    await call((await signIn(t, 'nosy@example.com')).accessToken, 'get', `/v1/payments/${away.id}/credit-note`).expect(404);
  });

  it('adds up the month for the accountant: by place of supply, less credit notes, plus exports and the document ranges', async () => {
    const month = currentMonth();
    const res = await call(finance, 'get', `/v1/admin/reports/gst/${month}`).expect(200);
    const report = res.body;
    expect(report.seller).toMatchObject({ gstin: '27ABCDE1234F1Z0', state: 'Maharashtra (27)' });

    // Meera's course and Kiran's renewal: ₹999 and ₹499.
    const karnataka = report.india.byPlace.find((p: { code: string }) => p.code === '29');
    expect(karnataka).toMatchObject({
      place: 'Karnataka (29)',
      invoices: 2,
      sales: { taxableMinor: 84_661 + 42_288, cgstMinor: 7619 + 3806, sgstMinor: 7620 + 3806, igstMinor: 0, totalMinor: 99_900 + 49_900 },
      creditNotes: 0,
      net: { taxableMinor: 84_661 + 42_288, cgstMinor: 7619 + 3806, sgstMinor: 7620 + 3806 },
    });
    expect(report.stateMissing).toBe(1);
    const maharashtra = report.india.byPlace.find((p: { code: string }) => p.code === '27');
    expect(maharashtra).toMatchObject({ invoices: 1, sales: { igstMinor: 15_239 }, creditNotes: 1, credited: { igstMinor: 15_239 }, net: { taxableMinor: 0, igstMinor: 0, totalMinor: 0 } });
    expect(report.india.totals).toMatchObject({ invoices: 3, creditNotes: 1, net: { taxableMinor: 84_661 + 42_288, cgstMinor: 7619 + 3806, sgstMinor: 7620 + 3806, igstMinor: 0 } });

    // $12 at the default 88 rupees to the dollar.
    expect(report.exports).toMatchObject({ invoices: 1, sales: { totalMinor: 1200, taxableMinor: 1200 }, salesInrPaise: 105_600, creditNotes: 0 });
    expect(report.unsplit).toEqual({ invoices: 0, gstMinor: 0, creditNotes: 0, creditedGstMinor: 0 });
    expect(report.documents.invoices).toMatchObject({ count: 4, from: expect.stringMatching(/000001$/), to: expect.stringMatching(/000004$/) });
    expect(report.documents.creditNotes).toMatchObject({ count: 1 });
    expect(report.register).toHaveLength(5);
    expect(report.register.find((r: { type: string }) => r.type === 'Credit note')).toMatchObject({ place: 'Maharashtra (27)', buyerState: 'Maharashtra (27)', igstMinor: 15_239, against: expect.stringMatching(/^EMB\//) });

    await call(finance, 'get', '/v1/admin/reports/gst/2026-13').expect(400);
    const support = (await signIn(t, 'desk@embodha.test')).accessToken;
    const [desk] = await t.db.select().from(users).where(eq(users.email, 'desk@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: desk.id, role: 'support' });
    await call(support, 'get', `/v1/admin/reports/gst/${month}`).expect(403);
  });
});
