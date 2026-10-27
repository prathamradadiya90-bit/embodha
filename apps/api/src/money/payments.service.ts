import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AccessService } from '../catalogue/access.service';
import { priceIn, resolveCurrency } from '../catalogue/price';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { currentMonth, monthRange } from '../common/month';
import { readSetting } from '../common/settings';
import { Db, InjectDb } from '../db/db.module';
import {
  adjustments,
  courses,
  entitlements,
  instructors,
  payments,
  payoutLines,
  payoutStatements,
  pricePoints,
  refunds,
  revenueShareHistory,
  splits,
  users,
} from '../db/schema';
import { nextDocumentNumber } from './document-numbers';
import { buyerStateOf, DEFAULT_SELLER, placeLabel, requireIndianState, sellerStateOf, splitGst, stateTaxName } from './gst';
import { describeItem, InvoicesService } from './invoices.service';
import { computeSplit } from './split';
import { RazorpayPayment, RazorpayService } from './razorpay.service';

/**
 * Razorpay's usual fees, used only when a payment arrives without its fee: 3% on international cards, 2% in India.
 * The GST Razorpay adds on top of its fee isn't a cost to Embodha (it comes back as input credit), so it's left out.
 */
const INTERNATIONAL_FEE_BPS = 300;
const DOMESTIC_FEE_BPS = 200;

type Payment = typeof payments.$inferSelect;
export type Channel = Payment['channel'];

/** One captured charge on any channel, in the currency the member paid. */
export interface Charge {
  channel: Channel;
  /** Razorpay's payment ID, Apple's transaction ID, or Google's order ID. One charge, one ID. */
  externalId: string;
  currency: 'INR' | 'USD';
  grossMinor: number;
  /** What the channel kept, without GST on it, when it says. Otherwise feeRateBps estimates it. */
  feeMinor?: number;
  /** GST the channel charged on its fee, in paise. */
  feeTaxPaise?: number;
  feeRateBps: number;
  /** Razorpay takes its fee on the whole price; the stores take commission on the price before GST. */
  feeBase?: 'gross' | 'after_gst';
  /**
   * A sale in dollars that the channel converted itself (Razorpay's base amount): the rupees the buyer paid and the
   * fee on them. With these, the sale is booked at the channel's own rate instead of the dollar rate in settings.
   */
  inr?: { grossPaise: number; feePaise: number };
  capturedAt?: Date;
  /** App Store sandbox or Play test purchase: the member gets access, nobody gets money. */
  test?: boolean;
  /** In the apps: the store's product ID, and what the store said it charged, in any currency. */
  productId?: string;
  charged?: { currency: string; price: string };
}

/**
 * A Razorpay payment as a charge, with Razorpay's own fee less the GST on it. A dollar payment comes with the rupee
 * amount Razorpay converted it to (at the bank's rate on the day) and its fee in rupees, so it's booked at that rate.
 */
export function razorpayCharge(payment: RazorpayPayment): Charge {
  const inr = payment.currency === 'INR';
  const tax = typeof payment.tax === 'number' ? payment.tax : 0;
  const fee = typeof payment.fee === 'number' ? payment.fee - tax : undefined;
  const base: Charge = {
    channel: 'razorpay',
    externalId: payment.id,
    currency: inr ? 'INR' : 'USD',
    grossMinor: payment.amount,
    feeRateBps: inr ? DOMESTIC_FEE_BPS : INTERNATIONAL_FEE_BPS,
    // The day the buyer paid, even when the books only hear of it days later from a settlement.
    capturedAt: typeof payment.created_at === 'number' ? new Date(payment.created_at * 1000) : undefined,
  };
  if (fee === undefined) return base;
  if (inr) return { ...base, feeMinor: fee, feeTaxPaise: tax };
  if (typeof payment.base_amount === 'number' && payment.base_currency === 'INR') {
    return { ...base, feeTaxPaise: tax, inr: { grossPaise: payment.base_amount, feePaise: fee } };
  }
  return base; // a dollar payment without its rupee amount: estimated until the settlement says
}

/** By the day of the sale, which for one booked late from a report is earlier than the day it was booked. */
const newestSaleFirst = sql`${payments.capturedAt} desc nulls last`;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly razorpay: RazorpayService,
    private readonly access: AccessService,
    private readonly invoices: InvoicesService,
  ) {}

  /* ------------------------------------------------------------ Checkout */

  /**
   * Opens a Razorpay order for one course at the member's price: rupees with GST for members in India, dollars
   * for everyone else. The app passes the result straight to Razorpay Checkout.
   */
  async startCourseCheckout(userId: string, courseId: string) {
    const [row] = await this.db
      .select({ course: courses, price: pricePoints, user: users })
      .from(courses)
      .innerJoin(users, eq(users.id, userId))
      .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
      .where(and(eq(courses.id, courseId), eq(courses.status, 'published')))
      .limit(1);
    if (!row) throw fail(404, 'not_found', 'There is no course at that address.');
    const { course, user } = row;
    if (course.isFree) throw fail(409, 'free_course', 'This course is free for everyone.');
    const via = (await this.access.forCourses(userId, [course])).get(course.id);
    // Subscribers may still buy a course to keep it for good; anyone who already owns it may not pay twice.
    if (via && via !== 'subscription') throw fail(409, 'already_unlocked', 'This course is already yours.');
    const price = priceIn(row.price, resolveCurrency(undefined, user.country));
    if (!price) throw fail(409, 'no_price', "This course doesn't have a price yet.");
    requireIndianState(user, price.currency);

    const order = await this.razorpay.createOrder({
      amount: price.amountMinor,
      currency: price.currency,
      receipt: `course_${randomBytes(6).toString('hex')}`,
      notes: { kind: 'course', user_id: userId, course_id: course.id },
    });
    return {
      keyId: this.razorpay.keyId,
      orderId: order.id,
      amount: price.amountMinor,
      currency: price.currency,
      display: price.display,
      name: 'Embodha',
      description: course.title,
      prefill: { email: user.email, name: user.name ?? '' },
    };
  }

  /** The app's half of a checkout: the signature proves Razorpay approved this payment for this order. */
  async confirm(userId: string, dto: { orderId: string; paymentId: string; signature: string }) {
    if (!this.razorpay.checkoutSignatureValid(dto.orderId, dto.paymentId, dto.signature)) {
      throw fail(400, 'bad_signature', "That payment couldn't be verified. If money left your account, write to us and we'll sort it out.");
    }
    const payment = await this.record(dto.paymentId);
    if (payment.userId !== userId) throw fail(403, 'not_yours', 'That payment belongs to another account.');
    const [course] = await this.db.select({ slug: courses.slug, title: courses.title }).from(courses).where(eq(courses.id, payment.courseId!));
    return { unlocked: true, course, invoiceNo: payment.invoiceNo };
  }

  /**
   * Records a captured Razorpay payment once, whichever arrives first: the app's confirmation or the webhook.
   * One transaction writes the payment, the member's entitlement and the instructor's split.
   */
  async record(razorpayPaymentId: string): Promise<Payment> {
    const existing = await this.find('razorpay', razorpayPaymentId);
    if (existing) return existing;
    const payment = await this.capturedPayment(razorpayPaymentId);
    const order = await this.razorpay.fetchOrder(payment.order_id);
    const notes = Array.isArray(order.notes) ? {} : order.notes;
    if (notes.kind !== 'course' || !notes.user_id || !notes.course_id) throw fail(400, 'unknown_order', 'That payment is not for an Embodha course.');
    if (payment.amount !== order.amount || payment.currency !== order.currency) {
      throw fail(409, 'amount_mismatch', "The amount paid doesn't match the order. Nothing was unlocked.");
    }
    const [course] = await this.db.select({ id: courses.id, instructorId: courses.instructorId }).from(courses).where(eq(courses.id, notes.course_id)).limit(1);
    if (!course) throw fail(404, 'not_found', 'The course on that order no longer exists.');
    return this.book({ charge: razorpayCharge(payment), userId: notes.user_id, instructorId: course.instructorId, courseId: course.id });
  }

  /** Fetches a Razorpay payment, capturing it if it's only authorised. Anything not captured is refused. */
  async capturedPayment(id: string): Promise<RazorpayPayment> {
    let payment = await this.razorpay.fetchPayment(id);
    if (payment.status === 'authorized') payment = await this.razorpay.capture(payment.id, payment.amount, payment.currency);
    if (payment.status !== 'captured') throw fail(409, 'not_captured', "That payment hasn't gone through.");
    return payment;
  }

  /**
   * Writes one captured charge in a single transaction: the payment, the instructor's split and, for a course, the
   * member's entitlement. Razorpay sales get an invoice number and the invoice by email; on the App Store and Google
   * Play the store is the seller and sends its own receipt. Calling it twice for one charge is harmless.
   */
  async book(input: { charge: Charge; userId: string; instructorId: string; courseId?: string; subscriptionId?: string }): Promise<Payment> {
    const { charge } = input;
    const [user] = await this.db.select({ country: users.country, state: users.state }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) throw fail(404, 'not_found', 'The member on that payment no longer exists.');
    const inr = charge.currency === 'INR';
    const [gstRateBps, usdInrRate, percentBps, refundDays, seller, note] = await Promise.all([
      readSetting(this.db, 'gst_rate_bps', 1800),
      readSetting(this.db, 'usd_inr_rate', 88),
      this.shareNow(input.instructorId),
      readSetting(this.db, 'refund_window_days', 7),
      readSetting(this.db, 'invoice_seller', DEFAULT_SELLER),
      readSetting(this.db, inr ? 'invoice_note_india' : 'invoice_note_abroad', ''),
    ]);
    // A dollar sale the channel converted itself: its rate, and its fee in rupees turned back into cents.
    const converted = !inr && charge.inr && charge.grossMinor > 0 ? charge.inr : null;
    const fxRate = inr ? 1 : converted ? converted.grossPaise / charge.grossMinor : usdInrRate;
    const feeMinor = converted ? Math.min(charge.grossMinor, Math.round(converted.feePaise / fxRate)) : charge.feeMinor;
    const money = computeSplit({
      grossMinor: charge.grossMinor,
      gstRateBps: inr ? gstRateBps : 0,
      ...(feeMinor !== undefined ? { feeMinor } : { feeRateBps: charge.feeRateBps, feeBase: charge.feeBase }),
      percentBps,
    });
    const netInrPaise = converted ? converted.grossPaise - converted.feePaise : Math.round(money.netMinor * fxRate);
    const instructorPaise = Math.round((netInrPaise * percentBps) / 10_000);
    const capturedAt = charge.capturedAt ?? new Date();
    const invoiced = charge.channel === 'razorpay' && !charge.test;
    // Only Embodha's own invoices carry a place of supply and a split; in the apps the store is the seller.
    const buyerState = invoiced && inr ? buyerStateOf(user) : null;
    const gst = invoiced
      ? splitGst({ currency: charge.currency, gstMinor: money.gstMinor, buyerState, sellerState: sellerStateOf(seller.gstin) })
      : { placeOfSupply: null, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };

    const recorded = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(payments)
        .values({
          userId: input.userId,
          channel: charge.channel,
          externalId: charge.externalId,
          kind: input.courseId ? 'course' : 'subscription',
          courseId: input.courseId ?? null,
          subscriptionId: input.subscriptionId ?? null,
          instructorId: input.instructorId,
          country: user.country,
          currency: charge.currency,
          grossMinor: money.grossMinor,
          gstMinor: money.gstMinor,
          gstRateBps: inr ? gstRateBps : 0,
          buyerState,
          ...gst,
          invoiceSeller: invoiced ? { ...seller, note } : null,
          feeMinor: money.feeMinor,
          feeTaxPaise: charge.feeTaxPaise ?? 0,
          feeSource: feeMinor !== undefined ? 'channel' : 'estimate',
          netMinor: money.netMinor,
          netInrPaise,
          grossInrPaise: inr ? money.grossMinor : (converted?.grossPaise ?? null),
          fxRate: fxRate.toFixed(6),
          status: 'captured',
          isTest: Boolean(charge.test),
          capturedAt,
          productId: charge.productId ?? null,
          chargedCurrency: charge.charged?.currency ?? null,
          chargedPrice: charge.charged?.price ?? null,
        })
        .onConflictDoNothing({ target: [payments.channel, payments.externalId] })
        .returning();
      if (!row) return null; // the webhook and the app arrived together; the other one wrote it
      if (invoiced) {
        // Numbered only once the sale is certainly new, so a race between the webhook and the app can't waste one.
        row.invoiceNo = await nextDocumentNumber(tx, 'invoice', capturedAt);
        await tx.update(payments).set({ invoiceNo: row.invoiceNo }).where(eq(payments.id, row.id));
      }
      if (input.courseId) {
        await tx
          .insert(entitlements)
          .values({ userId: row.userId, courseId: input.courseId, source: 'purchase', paymentId: row.id })
          .onConflictDoUpdate({ target: [entitlements.userId, entitlements.courseId], set: { source: 'purchase', paymentId: row.id } });
      }
      if (!charge.test) {
        await tx.insert(splits).values({
          paymentId: row.id,
          instructorId: input.instructorId,
          netInrPaise,
          percentBps,
          instructorPaise,
          embodhaPaise: netInrPaise - instructorPaise,
          // Website shares wait out the refund window. A store's become payable once its monthly report includes the
          // sale, which is when the store has actually paid (see ReconciliationService).
          payableFrom: charge.channel === 'razorpay' ? new Date(capturedAt.getTime() + refundDays * 86_400_000) : null,
        });
      }
      return row;
    });
    if (!recorded) return (await this.find(charge.channel, charge.externalId))!;
    this.logger.log(`Recorded ${recorded.invoiceNo ?? `${charge.channel} ${charge.externalId}`}: ${charge.currency} ${charge.grossMinor} (${recorded.kind}${charge.test ? ', test' : ''})`);
    // A failed email must never undo a payment that's already recorded; the invoice can be downloaded any time.
    if (recorded.invoiceNo) {
      await this.invoices.sendReceipt(recorded.id).catch((error) => this.logger.warn(`Invoice email for ${recorded.invoiceNo} failed: ${error}`));
    }
    return recorded;
  }

  /* ------------------------------------------------------------ Refunds */

  /** Refunds a Razorpay payment in full. The course leaves the member's library and the instructor's share is reversed. */
  async refund(actorId: string, paymentId: string, reason: string) {
    const [payment] = await this.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!payment) throw fail(404, 'not_found', 'No such payment.');
    if (payment.status !== 'captured') throw fail(409, 'not_refundable', 'This payment has already been refunded.');
    if (payment.channel !== 'razorpay') throw fail(409, 'store_refund', 'App Store and Google Play refunds happen in their own consoles.');
    const refund = await this.razorpay.refund(payment.externalId, payment.grossMinor, { reason: reason.slice(0, 200) });
    await this.applyRefund(payment, refund.id, reason, actorId);
    return { id: payment.id, status: 'refunded', refundId: refund.id };
  }

  /** From the webhook: a refund made in the Razorpay dashboard gets the same bookkeeping. */
  async refundFromRazorpay(razorpayPaymentId: string, refundId: string) {
    const payment = await this.find('razorpay', razorpayPaymentId);
    if (!payment || payment.status !== 'captured') return;
    await this.applyRefund(payment, refundId, 'Refunded in the Razorpay dashboard', null);
  }

  /** Apple or Google refunded a charge (only they can). Same bookkeeping as a Razorpay refund. Null if it isn't ours. */
  async refundFromStore(channel: 'apple' | 'google', externalId: string, refundRef: string, reason: string) {
    const payment = await this.find(channel, externalId);
    if (!payment || payment.status !== 'captured') return null;
    await this.applyRefund(payment, refundRef, reason, null);
    return payment;
  }

  private async applyRefund(payment: Payment, refundId: string, reason: string, actorId: string | null) {
    const creditNote = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(payments)
        .set({ status: 'refunded' })
        .where(and(eq(payments.id, payment.id), eq(payments.status, 'captured')))
        .returning({ id: payments.id });
      if (!updated) return null; // refunded twice at once; the first one did the work
      // A refunded invoice gets a credit note, which takes its GST back off the books in the month it's issued.
      const [refund] = await tx
        .insert(refunds)
        .values({
          paymentId: payment.id,
          amountMinor: payment.grossMinor,
          reason,
          externalId: refundId,
          creditNoteNo: payment.invoiceNo ? await nextDocumentNumber(tx, 'credit_note', new Date()) : null,
          gstMinor: payment.gstMinor,
          cgstMinor: payment.cgstMinor,
          sgstMinor: payment.sgstMinor,
          igstMinor: payment.igstMinor,
        })
        .returning({ creditNoteNo: refunds.creditNoteNo });
      await tx.delete(entitlements).where(and(eq(entitlements.paymentId, payment.id), eq(entitlements.source, 'purchase')));
      const [split] = await tx.select().from(splits).where(eq(splits.paymentId, payment.id)).limit(1);
      if (split && split.state !== 'reversed') {
        // On a statement that's still open, the next "prepare" leaves it out. Once a statement is closed or paid,
        // the instructor owes it back, so it comes off their next payout as a negative adjustment.
        const [line] = split.payoutLineId
          ? await tx
              .select({ status: payoutStatements.status })
              .from(payoutLines)
              .innerJoin(payoutStatements, eq(payoutStatements.id, payoutLines.statementId))
              .where(eq(payoutLines.id, split.payoutLineId))
          : [];
        if (line && line.status !== 'open') {
          await tx.insert(adjustments).values({
            instructorId: split.instructorId,
            amountPaise: -split.instructorPaise,
            reason: `Refund of ${payment.invoiceNo ?? payment.id}`,
            createdBy: actorId,
          });
        }
        await tx.update(splits).set({ state: 'reversed', payoutLineId: line && line.status !== 'open' ? split.payoutLineId : null }).where(eq(splits.id, split.id));
      }
      await audit(tx, {
        actorId,
        action: 'payment.refund',
        entityType: 'payment',
        entityId: payment.id,
        before: { status: 'captured' },
        after: { status: 'refunded', refundId, reason, creditNote: refund.creditNoteNo },
      });
      return refund.creditNoteNo;
    });
    // Like the invoice, a failed email never undoes the refund; the credit note can be downloaded any time.
    if (creditNote) {
      await this.invoices.sendCreditNote(payment.id).catch((error) => this.logger.warn(`Credit note email for ${creditNote} failed: ${error}`));
    }
  }

  /* ------------------------------------------------------------ Lists */

  /** A member's purchases, newest first, with invoice numbers for their records. */
  async purchases(userId: string) {
    const rows = await this.db
      .select({ payment: payments, course: { slug: courses.slug, title: courses.title }, instructor: instructors.displayName })
      .from(payments)
      .innerJoin(instructors, eq(instructors.id, payments.instructorId))
      .leftJoin(courses, eq(courses.id, payments.courseId))
      .where(eq(payments.userId, userId))
      .orderBy(newestSaleFirst, desc(payments.createdAt));
    return rows.map(({ payment, course, instructor }) => ({
      id: payment.id,
      course,
      item: describeItem(course?.title ?? null, instructor),
      amount: money(payment.grossMinor, payment.currency),
      channel: payment.channel,
      test: payment.isTest,
      invoiceNo: payment.invoiceNo,
      at: payment.capturedAt,
      status: payment.status,
    }));
  }

  /** Admin: the latest payments, each with its split. */
  async list() {
    const rows = await this.db
      .select({ payment: payments, email: users.email, course: courses.title, instructor: instructors.displayName, split: splits, creditNoteNo: refunds.creditNoteNo })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.userId))
      .innerJoin(instructors, eq(instructors.id, payments.instructorId))
      .leftJoin(courses, eq(courses.id, payments.courseId))
      .leftJoin(splits, eq(splits.paymentId, payments.id))
      .leftJoin(refunds, eq(refunds.paymentId, payments.id))
      .orderBy(newestSaleFirst, desc(payments.createdAt))
      .limit(200);
    return rows.map(({ payment, email, course, instructor, split, creditNoteNo }) => ({
      id: payment.id,
      invoiceNo: payment.invoiceNo,
      creditNoteNo,
      placeOfSupply: placeLabel(payment.placeOfSupply),
      tax: payment.igstMinor ? 'IGST' : payment.cgstMinor || payment.sgstMinor ? `CGST + ${stateTaxName(sellerStateOf(payment.invoiceSeller?.gstin))}` : null,
      at: payment.capturedAt,
      channel: payment.channel,
      member: email,
      kind: payment.kind,
      course: describeItem(course, instructor),
      instructor,
      gross: money(payment.grossMinor, payment.currency),
      gstMinor: payment.gstMinor,
      feeMinor: payment.feeMinor,
      /** channel: the gateway said at the time; estimate: the usual rate; report: a settlement or store report said. */
      feeSource: payment.feeSource,
      currency: payment.currency,
      netInrPaise: payment.netInrPaise,
      /** What the channel actually paid out for it, once a settlement or report has said. */
      settledInrPaise: payment.settledInrPaise,
      reconciledAt: payment.reconciledAt,
      test: payment.isTest,
      split: split ? { percentBps: split.percentBps, instructorPaise: split.instructorPaise, embodhaPaise: split.embodhaPaise, state: split.state, payableFrom: split.payableFrom } : null,
      status: payment.status,
    }));
  }

  /** Studio: what the instructor has earned, what's waiting to be paid, and their recent sales and payouts. */
  async earnings(instructorId: string) {
    const { start, end } = monthRange(currentMonth());
    const [month, [owed], sales, paid, percentBps] = await Promise.all([
      this.db
        .select({ sales: sql<number>`count(*)`.mapWith(Number), paise: sql<number>`coalesce(sum(${splits.instructorPaise}), 0)`.mapWith(Number) })
        .from(splits)
        .innerJoin(payments, eq(payments.id, splits.paymentId))
        .where(and(eq(splits.instructorId, instructorId), ne(splits.state, 'reversed'), gte(payments.capturedAt, start), lte(payments.capturedAt, end))),
      this.db
        .select({ paise: sql<number>`coalesce(sum(${splits.instructorPaise}), 0)`.mapWith(Number) })
        .from(splits)
        .where(and(eq(splits.instructorId, instructorId), inArray(splits.state, ['pending', 'payable']))),
      this.db
        .select({ at: payments.capturedAt, course: courses.title, currency: payments.currency, grossMinor: payments.grossMinor, split: splits, status: payments.status })
        .from(splits)
        .innerJoin(payments, eq(payments.id, splits.paymentId))
        .leftJoin(courses, eq(courses.id, payments.courseId))
        .where(eq(splits.instructorId, instructorId))
        .orderBy(desc(payments.capturedAt))
        .limit(20),
      this.db
        .select({ month: payoutStatements.month, netPaise: payoutLines.netPaise, tdsPaise: payoutLines.tdsPaise, paidAt: payoutLines.paidAt, bankReference: payoutLines.bankReference })
        .from(payoutLines)
        .innerJoin(payoutStatements, eq(payoutStatements.id, payoutLines.statementId))
        .where(and(eq(payoutLines.instructorId, instructorId), ne(payoutStatements.status, 'open')))
        .orderBy(desc(payoutStatements.month))
        .limit(12),
      this.shareNow(instructorId),
    ]);
    return {
      sharePercentBps: percentBps,
      thisMonth: { sales: month[0]?.sales ?? 0, earnedPaise: month[0]?.paise ?? 0 },
      unpaidPaise: owed.paise,
      sales: sales.map((row) => ({
        at: row.at,
        course: row.course ?? 'Monthly subscription',
        price: money(row.grossMinor, row.currency),
        yourSharePaise: row.split.instructorPaise,
        refunded: row.status !== 'captured',
      })),
      payouts: paid,
    };
  }

  async find(channel: Channel, externalId: string) {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.channel, channel), eq(payments.externalId, externalId)))
      .limit(1);
    return row ?? null;
  }

  /** The instructor's percentage right now. With no history, the default from settings. */
  private async shareNow(instructorId: string) {
    const [row] = await this.db
      .select({ percentBps: revenueShareHistory.percentBps })
      .from(revenueShareHistory)
      .where(and(eq(revenueShareHistory.instructorId, instructorId), lte(revenueShareHistory.effectiveFrom, new Date())))
      .orderBy(desc(revenueShareHistory.effectiveFrom), desc(revenueShareHistory.createdAt))
      .limit(1);
    return row?.percentBps ?? (await readSetting(this.db, 'default_revenue_share_bps', 6000));
  }
}

const money = (amountMinor: number, currency: string) => priceIn({ inrPaise: amountMinor, usdCents: amountMinor }, currency === 'USD' ? 'USD' : 'INR')!;
