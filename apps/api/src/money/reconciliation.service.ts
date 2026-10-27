import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { BUSINESS_TIME_ZONE, monthRange } from '../common/month';
import { readSetting } from '../common/settings';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { adjustments, instructors, payments, payoutLines, payoutStatements, reconciliationLines, reconciliations, RECON_STATUSES, refunds, settings, splits } from '../db/schema';
import { MailService } from '../mail/mail.service';
import { localDay } from '../practice/streak';
import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';
import { appleFinancial, AppleRow, headerOf, inPaise, openReport, playEarnings, PlayOrder, PlayParts, razorpayFromApi, razorpayFromFile, RazorpayItem, ReportError, toMinor } from './reports';
import { SubscriptionsService } from './subscriptions.service';

type Payment = typeof payments.$inferSelect;
type Channel = Payment['channel'];
type Status = (typeof RECON_STATUSES)[number];
type Kind = 'sale' | 'refund' | 'other';
type Line = typeof reconciliationLines.$inferInsert;
type Tx = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

const DAY = 86_400_000;
/** Lines that want a person: something missing, different, unexplained, or waiting for an exchange rate. */
export const OPEN: Status[] = ['unbooked', 'differs', 'other', 'needs_rate'];
const NAME: Record<Channel, string> = { razorpay: 'Razorpay', apple: 'the App Store', google: 'Google Play' };
/**
 * When a website sale's settlement is overdue. Razorpay settles Indian payments in two working days (T+2), and
 * payments from abroad on a longer cycle that its dashboard shows per account; eleven days covers the usual one. A
 * store's sale is due once its monthly report for that date is in.
 */
const RAZORPAY_DAYS = { INR: 4, USD: 11 } as const;
/** Apple's fiscal month ends on a Saturday, Pacific time; a sale on its last evening may be dated the next day here. */
const APPLE_GRACE = 2 * DAY;
/** The nightly fetch looks back this far, because settlements land days after the sale. */
const NIGHTLY_DAYS = 7;

/** 106440, 'INR' → "₹1,064.40". Any currency the reports use. */
export function amount(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
const rupees = (paise: number) => amount(paise, 'INR');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-21" → "21 Oct 2026". Spelled out here rather than by the locale, which changes its mind about "Sept". */
const shortDate = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
/** "15–21 Oct 2026", or "28 Sep – 4 Oct 2026" across a month. */
function dateRange(from: string, to: string) {
  if (from === to) return shortDate(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))}–${shortDate(to)}`;
  const start = from.slice(0, 4) === to.slice(0, 4) ? shortDate(from).replace(/ \d{4}$/, '') : shortDate(from);
  return `${start} – ${shortDate(to)}`;
}
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Play's earnings report is a calendar month's, so one whose transactions all fall in a month covers the whole of
 * it: a sale on the 28th that isn't there is missing, even if the last transaction was on the 24th.
 */
function playPeriod(period: { start: string; end: string } | null) {
  if (!period) return null;
  if (period.start.slice(0, 7) !== period.end.slice(0, 7)) return { ...period, label: dateRange(period.start, period.end) };
  const [year, month] = period.start.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${period.start.slice(0, 7)}-01`, end: `${period.start.slice(0, 7)}-${String(last).padStart(2, '0')}`, label: `${MONTH_NAMES[month - 1]} ${year}` };
}

/** What a settlement or report says a sale really came to, in the shape of the payment's own columns. */
interface Reported {
  feeMinor: number;
  feeTaxPaise: number;
  netMinor: number;
  netInrPaise: number;
  grossInrPaise: number | null;
  fxRate: string | null;
  /** What the channel actually paid out for it, in paise, when the report says. */
  settledInrPaise: number | null;
  /** In words, for the line's note, when something changed or is worth knowing. */
  note: string | null;
}

export interface ImportResult {
  id: string | null;
  label: string;
  channel: Channel;
  counts: Partial<Record<Status, number>>;
  /** Items an earlier import already had. */
  repeated: number;
  /** App Store proceeds currencies without a rupee rate yet. */
  needsRates: string[];
}

/**
 * Matching what the channels say they paid against Embodha's own books, to the rupee (spec: Launch, "Two weeks of
 * beta payments reconcile to the rupee across all three channels, in INR and USD").
 *
 * - Razorpay: its settlement recon, line by line: each payment with its real fee and the GST on it, each refund,
 *   and anything else that moved money (adjustments, disputes). Fetched every night, or uploaded from the dashboard.
 * - Google Play: the monthly earnings report, order by order: the charge, Google's fee, any tax Google kept.
 * - The App Store: the monthly financial report, which counts units per product and price rather than naming
 *   transactions. Each unit's proceeds go to the oldest matching sale in the books not yet reconciled.
 *
 * Where a report has the real figure, it replaces the estimate in the books, and the instructor's share follows:
 * on an open statement the line changes, on a closed one the difference goes on the next statement. A store sale's
 * share becomes payable once its store's report includes it. Sales the books never heard of are booked when the
 * channel can tell us whose they are (Razorpay), and refunds the books missed are applied.
 */
@Injectable()
export class ReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Reconciliation');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly razorpay: RazorpayService,
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly mail: MailService,
  ) {}

  /* ------------------------------------------------------------ The nightly check */

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    const tick = () => void this.nightly().catch((error) => this.logger.warn(`The nightly money check failed: ${error}`));
    this.timer = setInterval(tick, 60 * 60_000);
    this.timer.unref();
    setTimeout(tick, 5 * 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Once a day after 3 a.m. India time: the last week of Razorpay settlements, matched against the books, and an
   * email to finance if anything needs a look. Weeks overlap on purpose; anything already matched is skipped.
   */
  async nightly(now = new Date()) {
    if (!this.razorpay.ready || this.running) return null;
    const today = localDay(now, BUSINESS_TIME_ZONE);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: BUSINESS_TIME_ZONE }).format(now));
    if (hour < 3 || (await readSetting(this.db, 'reconciliation_last_night', '')) === today) return null;
    const to = isoDay(new Date(new Date(`${today}T12:00:00Z`).getTime() - DAY));
    const from = isoDay(new Date(new Date(`${to}T12:00:00Z`).getTime() - (NIGHTLY_DAYS - 1) * DAY));
    const result = await this.fetchRazorpay(null, from, to);
    await this.db
      .insert(settings)
      .values({ key: 'reconciliation_last_night', value: today })
      .onConflictDoUpdate({ target: settings.key, set: { value: today, updatedAt: new Date() } });
    const open = (['unbooked', 'differs', 'other'] as const).reduce((sum, status) => sum + (result.counts[status] ?? 0), 0);
    if (open && this.env.FINANCE_EMAIL) {
      const lines = await this.db
        .select({ ref: reconciliationLines.ref, note: reconciliationLines.note, status: reconciliationLines.status })
        .from(reconciliationLines)
        .where(and(eq(reconciliationLines.reconciliationId, result.id!), inArray(reconciliationLines.status, ['unbooked', 'differs', 'other'])))
        .limit(20);
      await this.mail
        .send({
          to: this.env.FINANCE_EMAIL,
          subject: `Money check: ${open} ${open === 1 ? 'thing' : 'things'} in Razorpay's settlements to look at`,
          text: [
            `The nightly check of Razorpay's settlements for ${dateRange(from, to)} found ${open} ${open === 1 ? 'line' : 'lines'} that don't match the books:`,
            '',
            ...lines.map((line) => `- ${line.ref}: ${line.note ?? line.status}`),
            '',
            'Each one is on the Reconciliation page in admin, where you can write down what you found.',
          ].join('\n'),
        })
        .catch((error) => this.logger.warn(`Couldn't email finance about the money check: ${error}`));
    }
    return result;
  }

  /* ------------------------------------------------------------ Imports */

  /** Razorpay's settlement recon for each day from `from` to `to` (YYYY-MM-DD, at most 31 days), from its API. */
  async fetchRazorpay(actorId: string | null, from: string, to: string): Promise<ImportResult> {
    if (!this.razorpay.ready) throw fail(503, 'payments_not_configured', 'Razorpay keys are not set on this server yet.');
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw fail(400, 'invalid_dates', 'Give a from and to date like 2026-10-01, from first.');
    if ((end.getTime() - start.getTime()) / DAY > 30) throw fail(400, 'too_many_days', 'Fetch at most 31 days at a time.');
    const raw: Record<string, unknown>[] = [];
    for (let at = start.getTime(); at <= end.getTime(); at += DAY) {
      const date = new Date(at);
      raw.push(...(await this.razorpay.settlementRecon({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() })));
    }
    return this.importRazorpay(razorpayFromApi(raw), { channel: 'razorpay', source: 'api', label: `Razorpay settlements, ${dateRange(from, to)}`, periodStart: from, periodEnd: to, importedBy: actorId });
  }

  /** An uploaded report: Razorpay's settlement report, Google Play's earnings report, or the App Store's financial report. */
  async upload(actorId: string, fileName: string, data: Buffer, rates: Record<string, string> = {}): Promise<ImportResult[]> {
    let files;
    try {
      files = openReport(fileName, data);
    } catch (error) {
      throw this.unreadable(error);
    }
    const results: ImportResult[] = [];
    for (const file of files) {
      const header = headerOf(file.text);
      const named = (...keys: string[]) => keys.every((key) => header.includes(key));
      try {
        if (named('entityid', 'type', 'amount')) {
          const { items, decimals } = razorpayFromFile(file.text);
          const settled = items.map((item) => item.settledAt).filter((date): date is Date => Boolean(date)).sort((a, b) => a.getTime() - b.getTime());
          const period = settled.length ? { periodStart: isoDay(settled[0]), periodEnd: isoDay(settled[settled.length - 1]) } : { periodStart: null, periodEnd: null };
          const label = `Razorpay settlement report${period.periodStart ? `, ${dateRange(period.periodStart, period.periodEnd!)}` : ''}`;
          results.push(await this.importRazorpay(decimals ? items : await this.inRupeesOrPaise(items), { channel: 'razorpay', source: 'file', label, fileName: file.name, ...period, importedBy: actorId }));
        } else if (named('description', 'transactiontype', 'amountmerchantcurrency')) {
          results.push(await this.importPlay(actorId, file.name, file.text));
        } else if (named('partnershare', 'customerprice')) {
          results.push(await this.importApple(actorId, file.name, file.text, rates));
        } else {
          throw new ReportError(
            `${file.name} isn't a report Embodha knows. Upload Razorpay's settlement report, Google Play's earnings report, or the App Store's financial report ("All Countries or Regions").`,
          );
        }
      } catch (error) {
        throw this.unreadable(error);
      }
    }
    return results;
  }

  private unreadable(error: unknown) {
    return error instanceof ReportError ? fail(422, 'unreadable_report', error.message) : error;
  }

  /**
   * The dashboard's CSV writes rupees, but a file whose amounts have no decimals at all may be in paise. Whichever
   * reading matches more of the payments in the books wins; with nothing to go on, rupees.
   */
  private async inRupeesOrPaise(items: RazorpayItem[]) {
    const sales = items.filter((item) => item.type === 'payment').slice(0, 50);
    if (!sales.length) return items;
    const booked = await this.db
      .select({ externalId: payments.externalId, grossMinor: payments.grossMinor, grossInrPaise: payments.grossInrPaise })
      .from(payments)
      .where(and(eq(payments.channel, 'razorpay'), inArray(payments.externalId, sales.map((item) => item.entityId))));
    const score = (scale: number) =>
      sales.filter((item) => booked.some((p) => p.externalId === item.entityId && (item.amount / scale === p.grossMinor || item.amount / scale === p.grossInrPaise))).length;
    return score(100) > score(1) ? inPaise(items) : items;
  }

  private async startImport(values: typeof reconciliations.$inferInsert) {
    const [row] = await this.db.insert(reconciliations).values(values).returning();
    return row;
  }

  /** An import whose every item had been imported before leaves nothing behind but the count. */
  private async finishImport(id: string, label: string, channel: Channel, counts: Partial<Record<Status, number>>, repeated: number, needsRates: string[] = []): Promise<ImportResult> {
    const lines = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    if (!lines) await this.db.delete(reconciliations).where(eq(reconciliations.id, id));
    return { id: lines ? id : null, label, channel, counts, repeated, needsRates };
  }

  private async seen(channel: Channel, ref: string, kind: Kind) {
    const [row] = await this.db
      .select({ id: reconciliationLines.id })
      .from(reconciliationLines)
      .where(and(eq(reconciliationLines.channel, channel), eq(reconciliationLines.ref, ref), eq(reconciliationLines.kind, kind)))
      .limit(1);
    return Boolean(row);
  }

  /** Writes a line, unless an earlier import already has it. Its ID, or null. */
  private async insertLine(tx: Tx, values: Line) {
    const [row] = await tx
      .insert(reconciliationLines)
      .values(values)
      .onConflictDoNothing({ target: [reconciliationLines.channel, reconciliationLines.ref, reconciliationLines.kind] })
      .returning({ id: reconciliationLines.id });
    return row?.id ?? null;
  }

  /* ------------------------------------------------------------ Razorpay */

  private async importRazorpay(items: RazorpayItem[], values: typeof reconciliations.$inferInsert): Promise<ImportResult> {
    const recon = await this.startImport(values);
    const counts: Partial<Record<Status, number>> = {};
    let repeated = 0;
    for (const item of items) {
      const status = await this.razorpayItem(recon.id, item);
      if (status) counts[status] = (counts[status] ?? 0) + 1;
      else repeated += 1;
    }
    return this.finishImport(recon.id, recon.label, 'razorpay', counts, repeated);
  }

  /** One settled transaction against the books. Null if an earlier import already had it. */
  private async razorpayItem(reconciliationId: string, item: RazorpayItem): Promise<Status | null> {
    const kind: Kind = item.type === 'payment' ? 'sale' : item.type === 'refund' ? 'refund' : 'other';
    if (await this.seen('razorpay', item.entityId, kind)) return null;
    const base: Line = {
      reconciliationId,
      channel: 'razorpay',
      ref: item.entityId,
      kind,
      currency: item.currency,
      grossMinor: item.amount,
      feeMinor: item.fee - item.tax,
      taxMinor: item.tax,
      amountInrPaise: item.currency === 'INR' ? item.credit - item.debit : null,
      settledAt: item.settledAt,
      settlementRef: [item.settlementId, item.utr ? `UTR ${item.utr}` : null].filter(Boolean).join(' · ') || null,
      raw: item as unknown as Record<string, unknown>,
      status: 'other',
    };

    if (kind === 'other') {
      const what = item.disputeId ? `a dispute (${item.disputeId})` : item.type === 'adjustment' ? 'an adjustment' : `a ${item.type || 'transaction'}`;
      const money = item.credit ? `${amount(item.credit, item.currency)} in` : `${amount(item.debit || item.amount, item.currency)} out`;
      return this.writeLine({ ...base, note: `Razorpay moved ${money} for ${what}${item.description ? `: ${item.description}` : ''}. It isn't a sale or refund in the books.` });
    }

    if (kind === 'refund') return this.razorpayRefund(base, item);

    let payment = await this.payments.find('razorpay', item.entityId);
    let booked = false;
    if (!payment) {
      try {
        payment = await this.bookMissing(item.entityId);
        booked = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return this.writeLine({
          ...base,
          status: 'unbooked',
          note: `Razorpay settled ${amount(item.amount, item.currency)} for this payment, but there's no sale for it in the books, and it couldn't be booked from Razorpay. ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`,
        });
      }
    }
    const reported = razorpayFigures(payment, item);
    if ('differs' in reported) return this.writeLine({ ...base, paymentId: payment.id, bookedInrPaise: payment.netInrPaise, status: 'differs', note: reported.differs });
    return this.settle(base, payment, reported, booked ? 'booked' : null);
  }

  /**
   * A payment Razorpay settled that the books never heard of: the app never came back and the webhook went astray.
   * Razorpay knows whose it was, so it's booked the usual way: a course order, or a subscription's charge.
   */
  private async bookMissing(paymentId: string): Promise<Payment> {
    try {
      return await this.payments.record(paymentId);
    } catch (error) {
      const payment = await this.razorpay.fetchPayment(paymentId);
      if (!payment.invoice_id) throw error;
      const invoice = await this.razorpay.fetchInvoice(payment.invoice_id);
      if (!invoice.subscription_id) throw error;
      return (await this.subscriptions.charge(invoice.subscription_id, paymentId)).payment;
    }
  }

  private async razorpayRefund(base: Line, item: RazorpayItem): Promise<Status | null> {
    const [row] = await this.db
      .select({ refund: refunds, payment: payments })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(eq(refunds.externalId, item.entityId))
      .limit(1);
    const taken = item.debit || item.amount;
    if (row) {
      const same = row.payment.currency !== item.currency || row.refund.amountMinor === taken;
      return this.writeLine({
        ...base,
        paymentId: row.payment.id,
        status: same ? 'matched' : 'differs',
        note: same ? null : `Razorpay took back ${amount(taken, item.currency)}; the books refunded ${amount(row.refund.amountMinor, row.payment.currency)}.`,
      });
    }
    // A refund made in the dashboard whose webhook never arrived: the books catch up now.
    const payment = item.paymentId ? await this.payments.find('razorpay', item.paymentId) : null;
    if (payment?.status === 'captured') {
      await this.payments.refundFromRazorpay(payment.externalId, item.entityId);
      return this.writeLine({ ...base, paymentId: payment.id, status: 'booked', note: `Refunded in Razorpay but not in the books; the refund is booked now, with its credit note.` });
    }
    return this.writeLine({
      ...base,
      paymentId: payment?.id ?? null,
      status: 'unbooked',
      note: payment ? `Razorpay refunded this, but the books have the sale as ${payment.status}.` : `Razorpay refunded ${amount(taken, item.currency)} on ${item.paymentId ?? 'a payment'} that isn't in the books.`,
    });
  }

  /** Writes a line with its outcome. Null if an earlier import already had it. */
  private async writeLine(values: Line): Promise<Status | null> {
    const id = await this.insertLine(this.db, values);
    return id ? values.status : null;
  }

  /* ------------------------------------------------------------ Google Play */

  private async importPlay(actorId: string, fileName: string, text: string): Promise<ImportResult> {
    const report = playEarnings(text);
    if (report.merchantCurrency !== 'INR') {
      throw new ReportError(`This earnings report is in ${report.merchantCurrency}. Embodha's Play account is paid in rupees, so the books can't be checked against it.`);
    }
    const period = playPeriod(report.period);
    const label = `Google Play earnings${period ? `, ${period.label}` : ''}`;
    const recon = await this.startImport({ channel: 'google', source: 'file', label, fileName, periodStart: period?.start ?? null, periodEnd: period?.end ?? null, importedBy: actorId });
    const counts: Partial<Record<Status, number>> = {};
    let repeated = 0;
    const tally = (status: Status | null) => (status ? (counts[status] = (counts[status] ?? 0) + 1) : (repeated += 1));
    for (const order of report.orders) {
      if (order.sale) tally(await this.playSale(recon.id, order, order.sale));
      if (order.refund) tally(await this.playRefund(recon.id, order, order.refund));
    }
    for (const other of report.others) {
      if (await this.seen('google', other.ref, 'other')) {
        repeated += 1;
        continue;
      }
      tally(
        await this.writeLine({
          reconciliationId: recon.id,
          channel: 'google',
          ref: other.ref,
          kind: 'other',
          currency: 'INR',
          amountInrPaise: other.merchant,
          settledAt: other.date,
          status: 'other',
          note: `Google ${other.merchant >= 0 ? 'paid' : 'took'} ${rupees(Math.abs(other.merchant))} for "${other.type}"${other.description ? ` (${other.description})` : ''}. It isn't a sale or refund in the books.`,
          raw: other as unknown as Record<string, unknown>,
        }),
      );
    }
    return this.finishImport(recon.id, label, 'google', counts, repeated);
  }

  private async playSale(reconciliationId: string, order: PlayOrder, sale: PlayParts): Promise<Status | null> {
    if (await this.seen('google', order.orderId, 'sale')) return null;
    const proceeds = sale.charge.merchant + sale.fee.merchant + sale.tax.merchant;
    const base: Line = {
      reconciliationId,
      channel: 'google',
      ref: order.orderId,
      kind: 'sale',
      currency: 'INR',
      grossMinor: sale.charge.merchant,
      feeMinor: -sale.fee.merchant,
      taxMinor: -sale.tax.merchant,
      amountInrPaise: proceeds,
      settledAt: order.date,
      raw: order as unknown as Record<string, unknown>,
      status: 'other',
    };
    const payment = await this.payments.find('google', order.orderId);
    if (!payment) {
      return this.writeLine({
        ...base,
        status: 'unbooked',
        note: `Google charged this order${order.skuId ? ` (${order.skuId})` : ''} and paid ${rupees(proceeds)} for it, but it isn't in the books: the purchase never reached Embodha, so the member may not have what they paid for.`,
      });
    }
    if (payment.isTest) {
      return this.writeLine({ ...base, paymentId: payment.id, status: 'differs', note: 'Booked as a test purchase, but Google paid for it.' });
    }
    // What the buyer paid, against what the store told us at the time (or our price, in the same currency).
    const charged = order.buyerCurrency && sale.charge.buyer ? { currency: order.buyerCurrency, minor: sale.charge.buyer } : null;
    const differs = chargedDiffers(payment, charged);
    if (differs) return this.writeLine({ ...base, paymentId: payment.id, bookedInrPaise: payment.netInrPaise, status: 'differs', note: differs });
    // Google's conversion, when the buyer paid in the sale's own currency: the merchant amount over the buyer's.
    const rate = payment.currency !== 'INR' && order.buyerCurrency === payment.currency && sale.charge.buyer ? sale.charge.merchant / sale.charge.buyer : null;
    return this.settle(base, payment, storeFigures(payment, proceeds, 'Google', rate), null);
  }

  private async playRefund(reconciliationId: string, order: PlayOrder, refund: PlayParts): Promise<Status | null> {
    if (await this.seen('google', order.orderId, 'refund')) return null;
    const back = refund.charge.merchant + refund.fee.merchant + refund.tax.merchant;
    const base: Line = {
      reconciliationId,
      channel: 'google',
      ref: order.orderId,
      kind: 'refund',
      currency: 'INR',
      grossMinor: refund.charge.merchant,
      feeMinor: -refund.fee.merchant,
      taxMinor: -refund.tax.merchant,
      amountInrPaise: back,
      settledAt: order.date,
      raw: order as unknown as Record<string, unknown>,
      status: 'matched',
    };
    const payment = await this.payments.find('google', order.orderId);
    if (!payment) return this.writeLine({ ...base, status: 'unbooked', note: `Google refunded this order (${rupees(Math.abs(back))} back), but its sale isn't in the books.` });
    if (payment.status === 'captured' && !payment.isTest) {
      // The cancellation notice never came: the course leaves the library and the share is reversed, as it would have then.
      await this.payments.refundFromStore('google', payment.externalId, order.orderId, 'Refunded by Google (earnings report)');
      return this.writeLine({ ...base, paymentId: payment.id, status: 'booked', note: 'Refunded by Google, but the books still had it as a sale; the refund is booked now.' });
    }
    return this.writeLine({ ...base, paymentId: payment.id });
  }

  /* ------------------------------------------------------------ App Store */

  private async importApple(actorId: string, fileName: string, text: string, rates: Record<string, string>): Promise<ImportResult> {
    const rows = appleFinancial(text);
    if (!rows.length) throw new ReportError('That financial report has no sales or returns in it.');
    const starts = rows.map((row) => row.periodStart).filter(Boolean).sort();
    const ends = rows.map((row) => row.periodEnd).filter(Boolean).sort();
    const period = starts.length && ends.length ? { start: starts[0], end: ends[ends.length - 1] } : null;
    const clean = cleanRates(rates);
    const label = `App Store financial report${period ? `, ${dateRange(period.start, period.end)}` : ''}`;
    const recon = await this.startImport({ channel: 'apple', source: 'file', label, fileName, periodStart: period?.start ?? null, periodEnd: period?.end ?? null, rates: clean, importedBy: actorId });
    const counts: Partial<Record<Status, number>> = {};
    let repeated = 0;
    for (const row of rows) {
      const ref = appleRef(row);
      const kind: Kind = row.sale ? 'sale' : 'refund';
      if (await this.seen('apple', ref, kind)) {
        repeated += 1;
        continue;
      }
      const id = await this.insertLine(this.db, {
        reconciliationId: recon.id,
        channel: 'apple',
        ref,
        kind,
        quantity: Math.abs(row.quantity),
        currency: row.partnerShareCurrency,
        grossMinor: (toMinor(row.customerPrice) ?? 0) * Math.abs(row.quantity),
        settledAt: row.periodEnd ? new Date(`${row.periodEnd}T00:00:00Z`) : null,
        status: 'needs_rate',
        raw: row as unknown as Record<string, unknown>,
      });
      if (!id) {
        repeated += 1;
        continue;
      }
      const status = await this.settleApple(id, row, clean);
      counts[status] = (counts[status] ?? 0) + 1;
    }
    const needsRates = [...new Set(rows.filter((row) => row.partnerShareCurrency !== 'INR' && !clean[row.partnerShareCurrency]).map((row) => row.partnerShareCurrency))];
    return this.finishImport(recon.id, label, 'apple', counts, repeated, needsRates);
  }

  /**
   * One row of Apple's report against the books. A sale row's units go to the oldest App Store sales of that product
   * at that price that no report has covered yet; each takes the row's proceeds for one unit. Returns are counted
   * against the refunds in the books.
   */
  private async settleApple(lineId: number, row: AppleRow, rates: Record<string, string>): Promise<Status> {
    const rate = row.partnerShareCurrency === 'INR' ? 1 : Number(rates[row.partnerShareCurrency] ?? NaN);
    const units = Math.abs(row.quantity);
    const end = row.periodEnd ? new Date(new Date(`${row.periodEnd}T00:00:00Z`).getTime() + DAY + APPLE_GRACE) : new Date();
    const priceMinor = toMinor(row.customerPrice) ?? 0;
    const atThatPrice = or(
      and(eq(payments.chargedCurrency, row.customerCurrency), sql`${payments.chargedPrice} = ${row.customerPrice}::numeric`),
      and(isNull(payments.chargedCurrency), sql`${payments.currency} = ${row.customerCurrency}`, eq(payments.grossMinor, priceMinor)),
    );
    const update = (values: Partial<Line>) => this.db.update(reconciliationLines).set(values).where(eq(reconciliationLines.id, lineId));

    if (!row.sale) {
      const start = row.periodStart ? new Date(`${row.periodStart}T00:00:00Z`) : new Date(0);
      const [books] = await this.db
        .select({ n: count() })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(and(eq(payments.channel, 'apple'), eq(payments.productId, row.productId), atThatPrice, gte(refunds.at, start), lt(refunds.at, end)));
      const status: Status = books.n === units ? 'matched' : 'differs';
      await update({
        status,
        amountInrPaise: Number.isFinite(rate) ? -Math.round(Math.abs(row.extendedPartnerShare) * rate) : null,
        note: status === 'matched' ? null : `Apple took back ${units} ${row.productId} at ${row.customerCurrency} ${row.customerPrice}; the books refunded ${books.n} in the same weeks.`,
      });
      return status;
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      await update({ status: 'needs_rate', note: `Apple paid these in ${row.partnerShareCurrency}. Enter the rupee rate from that month's payment in App Store Connect to check them.` });
      return 'needs_rate';
    }
    const perUnitInr = Math.round(row.partnerShare * rate);
    await update({ amountInrPaise: Math.round(row.extendedPartnerShare * rate) });
    const candidates = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.channel, 'apple'), eq(payments.isTest, false), isNull(payments.reconciliationLineId), eq(payments.productId, row.productId), atThatPrice, lt(payments.capturedAt, end)))
      .orderBy(asc(payments.capturedAt))
      .limit(units);
    let corrected = 0;
    for (const payment of candidates) {
      const outcome = await this.apply(payment, storeFigures(payment, perUnitInr, 'Apple', payment.currency === row.partnerShareCurrency ? rate : null), lineId, 'apple');
      if (outcome === 'corrected') corrected += 1;
    }
    const missing = units - candidates.length;
    const status: Status = missing > 0 ? 'unbooked' : corrected ? 'corrected' : 'matched';
    const each = `${rupees(perUnitInr)} a unit${row.partnerShareCurrency === 'INR' ? '' : ` (${amount(row.partnerShare, row.partnerShareCurrency)} at ${rates[row.partnerShareCurrency]})`}`;
    await update({
      status,
      note:
        missing > 0
          ? `Apple sold ${units} of ${row.productId} at ${row.customerCurrency} ${row.customerPrice}${row.country ? ` in ${row.country}` : ''}; ${candidates.length} ${candidates.length === 1 ? 'is' : 'are'} in the books. ${missing === 1 ? 'One purchase' : `${missing} purchases`} never reached Embodha.`
          : corrected
            ? `Apple paid ${each}; ${corrected} ${corrected === 1 ? 'sale was' : 'sales were'} booked at the estimate and now carry the real proceeds.`
            : `Apple paid ${each}, as booked.`,
    });
    return status;
  }

  /** Rupee rates for an App Store import's currencies, then the rows that were waiting for them. */
  async setRates(actorId: string, reconciliationId: string, rates: Record<string, string>) {
    const [recon] = await this.db.select().from(reconciliations).where(eq(reconciliations.id, reconciliationId)).limit(1);
    if (!recon) throw fail(404, 'not_found', 'No such import.');
    if (recon.channel !== 'apple') throw fail(409, 'not_apple', 'Exchange rates are only for App Store reports.');
    const merged = { ...recon.rates, ...cleanRates(rates) };
    await this.db.update(reconciliations).set({ rates: merged }).where(eq(reconciliations.id, recon.id));
    const waiting = await this.db
      .select({ id: reconciliationLines.id, raw: reconciliationLines.raw })
      .from(reconciliationLines)
      .where(and(eq(reconciliationLines.reconciliationId, recon.id), eq(reconciliationLines.status, 'needs_rate')));
    const counts: Partial<Record<Status, number>> = {};
    for (const line of waiting) {
      const status = await this.settleApple(line.id, line.raw as unknown as AppleRow, merged);
      counts[status] = (counts[status] ?? 0) + 1;
    }
    await audit(this.db, { actorId, action: 'reconciliation.rates', entityType: 'reconciliation', entityId: recon.id, before: recon.rates, after: merged });
    return { id: recon.id, rates: merged, counts };
  }

  /* ------------------------------------------------------------ Into the books */

  /** Writes a matched sale's line and brings its payment (and the instructor's share) in line with the report. */
  private async settle(base: Line, payment: Payment, reported: Reported, outcome: 'booked' | null): Promise<Status | null> {
    const id = await this.insertLine(this.db, { ...base, paymentId: payment.id, bookedInrPaise: payment.netInrPaise, status: outcome ?? 'matched', note: reported.note });
    if (!id) return null;
    const result = await this.apply(payment, reported, id, base.channel);
    const status: Status = outcome ?? result;
    if (status !== 'matched') await this.db.update(reconciliationLines).set({ status }).where(eq(reconciliationLines.id, id));
    return status;
  }

  /**
   * The report's figures into the payment, and the instructor's share after them. A share on an open statement
   * changes with it; on a closed or paid one, the difference goes on the next statement. A store sale's share
   * becomes payable now, because its store has reported it.
   */
  private async apply(payment: Payment, reported: Reported, lineId: number, channel: Channel): Promise<'matched' | 'corrected'> {
    const changed = payment.feeMinor !== reported.feeMinor || payment.netMinor !== reported.netMinor || payment.netInrPaise !== reported.netInrPaise;
    await this.db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          ...(changed
            ? {
                feeMinor: reported.feeMinor,
                feeTaxPaise: reported.feeTaxPaise,
                feeSource: 'report' as const,
                netMinor: reported.netMinor,
                netInrPaise: reported.netInrPaise,
                ...(reported.grossInrPaise !== null ? { grossInrPaise: reported.grossInrPaise } : {}),
                ...(reported.fxRate !== null ? { fxRate: reported.fxRate } : {}),
              }
            : {}),
          settledInrPaise: reported.settledInrPaise,
          reconciledAt: new Date(),
          reconciliationLineId: lineId,
        })
        .where(eq(payments.id, payment.id));
      const [split] = await tx.select().from(splits).where(eq(splits.paymentId, payment.id)).limit(1);
      if (split && split.state !== 'reversed') {
        const instructorPaise = Math.round((reported.netInrPaise * split.percentBps) / 10_000);
        const delta = changed ? instructorPaise - split.instructorPaise : 0;
        if (delta && split.payoutLineId) await this.moveLine(tx, split.instructorId, split.payoutLineId, delta, `${NAME[channel]}'s figures for ${payment.invoiceNo ?? payment.externalId}`);
        const values = {
          ...(changed ? { netInrPaise: reported.netInrPaise, instructorPaise, embodhaPaise: reported.netInrPaise - instructorPaise } : {}),
          ...(channel !== 'razorpay' && !split.payableFrom ? { payableFrom: new Date() } : {}),
        };
        if (Object.keys(values).length) await tx.update(splits).set(values).where(eq(splits.id, split.id));
      }
      if (changed) {
        await audit(tx, {
          actorId: null,
          action: 'payment.reconciled',
          entityType: 'payment',
          entityId: payment.id,
          before: { feeMinor: payment.feeMinor, netMinor: payment.netMinor, netInrPaise: payment.netInrPaise, feeSource: payment.feeSource },
          after: { feeMinor: reported.feeMinor, netMinor: reported.netMinor, netInrPaise: reported.netInrPaise, line: lineId },
        });
      }
    });
    return changed ? 'corrected' : 'matched';
  }

  /** A share that changed after its statement was prepared: the line moves with it, or the next statement does. */
  private async moveLine(tx: Tx, instructorId: string, lineId: string, delta: number, reason: string) {
    const [line] = await tx
      .select({ line: payoutLines, status: payoutStatements.status, tdsBps: instructors.tdsRateBps })
      .from(payoutLines)
      .innerJoin(payoutStatements, eq(payoutStatements.id, payoutLines.statementId))
      .innerJoin(instructors, eq(instructors.id, payoutLines.instructorId))
      .where(eq(payoutLines.id, lineId))
      .limit(1);
    if (!line) return;
    if (line.status === 'open') {
      const payablePaise = line.line.payablePaise + delta;
      const tdsPaise = Math.round((payablePaise * line.tdsBps) / 10_000);
      await tx.update(payoutLines).set({ payablePaise, tdsPaise, netPaise: payablePaise - tdsPaise }).where(eq(payoutLines.id, lineId));
    } else {
      await tx.insert(adjustments).values({ instructorId, amountPaise: delta, reason: `Correction from ${reason}` });
    }
  }

  /* ------------------------------------------------------------ Lines that need a person */

  /** Finance looked into a line and says why it's fine (or what they did about it). */
  async explain(actorId: string, lineId: number, explanation: string) {
    const text = explanation.trim();
    if (text.length < 3) throw fail(400, 'invalid_request', 'Write what you found.');
    const [line] = await this.db.select().from(reconciliationLines).where(eq(reconciliationLines.id, lineId)).limit(1);
    if (!line) throw fail(404, 'not_found', 'No such line.');
    if (!OPEN.includes(line.status)) throw fail(409, 'not_open', 'That line already matches the books.');
    if (line.status === 'needs_rate') throw fail(409, 'needs_rate', 'Enter the exchange rate instead; then this line checks itself.');
    await this.db
      .update(reconciliationLines)
      .set({ status: 'explained', explanation: text.slice(0, 1000), explainedBy: actorId, explainedAt: new Date() })
      .where(eq(reconciliationLines.id, lineId));
    await audit(this.db, { actorId, action: 'reconciliation.explain', entityType: 'reconciliation_line', entityId: String(lineId), before: { status: line.status }, after: { status: 'explained', explanation: text } });
    return { id: lineId, status: 'explained' as const };
  }

  /* ------------------------------------------------------------ The page */

  /** Finance's view of a month: each channel's sales against what has been reported, and what needs a look. */
  async overview(month: string) {
    const { start, end } = monthRange(month);
    const now = Date.now();
    const [totals, unreconciled, coverage, imports, attention] = await Promise.all([
      this.db
        .select({
          channel: payments.channel,
          currency: payments.currency,
          sales: sql<number>`count(*) filter (where not ${payments.isTest})`.mapWith(Number),
          tests: sql<number>`count(*) filter (where ${payments.isTest})`.mapWith(Number),
          reconciled: sql<number>`count(*) filter (where not ${payments.isTest} and ${payments.reconciledAt} is not null)`.mapWith(Number),
          corrected: sql<number>`count(*) filter (where not ${payments.isTest} and ${payments.feeSource} = 'report')`.mapWith(Number),
          // An estimate a report has borne out is no longer in doubt.
          estimated: sql<number>`count(*) filter (where not ${payments.isTest} and ${payments.feeSource} = 'estimate' and ${payments.reconciledAt} is null)`.mapWith(Number),
          grossInrPaise: sql<number>`coalesce(sum(coalesce(${payments.grossInrPaise}, round(${payments.grossMinor} * coalesce(${payments.fxRate}, 1)))) filter (where not ${payments.isTest}), 0)`.mapWith(Number),
          netInrPaise: sql<number>`coalesce(sum(${payments.netInrPaise}) filter (where not ${payments.isTest}), 0)`.mapWith(Number),
          settledInrPaise: sql<number>`coalesce(sum(${payments.settledInrPaise}) filter (where not ${payments.isTest}), 0)`.mapWith(Number),
        })
        .from(payments)
        .where(and(gte(payments.capturedAt, start), lt(payments.capturedAt, end)))
        .groupBy(payments.channel, payments.currency),
      this.db
        .select({ id: payments.id, channel: payments.channel, currency: payments.currency, capturedAt: payments.capturedAt })
        .from(payments)
        .where(and(isNull(payments.reconciledAt), eq(payments.isTest, false), isNotNull(payments.capturedAt), lt(payments.capturedAt, end))),
      this.coverage(),
      this.db
        .select({
          recon: reconciliations,
          lines: count(reconciliationLines.id),
          open: sql<number>`count(*) filter (where ${reconciliationLines.status} in ('unbooked', 'differs', 'other', 'needs_rate'))`.mapWith(Number),
          needsRates: sql<string[]>`coalesce(array_agg(distinct ${reconciliationLines.currency}) filter (where ${reconciliationLines.status} = 'needs_rate'), '{}')`,
          corrected: sql<number>`count(*) filter (where ${reconciliationLines.status} = 'corrected')`.mapWith(Number),
          inrPaise: sql<number>`coalesce(sum(${reconciliationLines.amountInrPaise}), 0)`.mapWith(Number),
        })
        .from(reconciliations)
        .leftJoin(reconciliationLines, eq(reconciliationLines.reconciliationId, reconciliations.id))
        .groupBy(reconciliations.id)
        .orderBy(desc(reconciliations.createdAt))
        .limit(12),
      this.attention(),
    ]);

    const late = (row: { channel: Channel; currency: string; capturedAt: Date | null }) => isLate(row, coverage, now);
    const channels = (['razorpay', 'google', 'apple'] as const).map((channel) => {
      const rows = totals.filter((row) => row.channel === channel);
      const add = (key: keyof (typeof rows)[number]) => rows.reduce((sum, row) => sum + (row[key] as number), 0);
      const waiting = unreconciled.filter((row) => row.channel === channel && row.capturedAt! >= start);
      return {
        channel,
        sales: add('sales'),
        tests: add('tests'),
        reconciled: add('reconciled'),
        corrected: add('corrected'),
        estimated: add('estimated'),
        late: waiting.filter(late).length,
        waiting: waiting.filter((row) => !late(row)).length,
        currencies: rows.filter((row) => row.sales).map((row) => row.currency),
        grossInrPaise: add('grossInrPaise'),
        netInrPaise: add('netInrPaise'),
        settledInrPaise: add('settledInrPaise'),
        reportedTo: coverage[channel],
      };
    });
    // Sales from any month that are past the point a report should have had them.
    const overdueIds = unreconciled.filter(late).map((row) => row.id).slice(0, 50);
    const overdue = overdueIds.length
      ? await this.db
          .select({ id: payments.id, channel: payments.channel, externalId: payments.externalId, invoiceNo: payments.invoiceNo, currency: payments.currency, grossMinor: payments.grossMinor, capturedAt: payments.capturedAt })
          .from(payments)
          .where(inArray(payments.id, overdueIds))
          .orderBy(asc(payments.capturedAt))
      : [];

    return {
      month,
      razorpayReady: this.razorpay.ready,
      lastNightly: await readSetting(this.db, 'reconciliation_last_night', null as string | null),
      channels,
      imports: imports.map(({ recon, ...rest }) => ({
        id: recon.id,
        channel: recon.channel,
        source: recon.source,
        label: recon.label,
        fileName: recon.fileName,
        periodStart: recon.periodStart,
        periodEnd: recon.periodEnd,
        rates: recon.rates,
        at: recon.createdAt,
        ...rest,
      })),
      attention,
      overdue: overdue.map((p) => ({ ...p, gross: amount(p.grossMinor, p.currency) })),
    };
  }

  /** The last day each channel has reported on: Razorpay settles continuously, the stores report by month. */
  private async coverage(): Promise<Record<Channel, string | null>> {
    const rows = await this.db
      .select({ channel: reconciliations.channel, end: sql<string | null>`max(${reconciliations.periodEnd})` })
      .from(reconciliations)
      .groupBy(reconciliations.channel);
    const of = (channel: Channel) => rows.find((row) => row.channel === channel)?.end ?? null;
    return { razorpay: of('razorpay'), google: of('google'), apple: of('apple') };
  }

  private async attention() {
    const rows = await this.db
      .select({
        line: reconciliationLines,
        label: reconciliations.label,
        payment: { id: payments.id, externalId: payments.externalId, invoiceNo: payments.invoiceNo, currency: payments.currency, grossMinor: payments.grossMinor, capturedAt: payments.capturedAt },
      })
      .from(reconciliationLines)
      .innerJoin(reconciliations, eq(reconciliations.id, reconciliationLines.reconciliationId))
      .leftJoin(payments, eq(payments.id, reconciliationLines.paymentId))
      .where(inArray(reconciliationLines.status, OPEN))
      .orderBy(desc(reconciliationLines.createdAt))
      .limit(100);
    return rows.map(({ line, label, payment }) => ({
      id: line.id,
      channel: line.channel,
      kind: line.kind,
      ref: line.ref,
      status: line.status,
      note: line.note,
      quantity: line.quantity,
      amountInrPaise: line.amountInrPaise,
      settledAt: line.settledAt,
      settlementRef: line.settlementRef,
      report: label,
      payment: payment?.id ? { ...payment, gross: amount(payment.grossMinor!, payment.currency!) } : null,
    }));
  }

  /** One import's lines, everything it held. */
  async lines(reconciliationId: string) {
    const [recon] = await this.db.select().from(reconciliations).where(eq(reconciliations.id, reconciliationId)).limit(1);
    if (!recon) throw fail(404, 'not_found', 'No such import.');
    const rows = await this.db
      .select({ line: reconciliationLines, invoiceNo: payments.invoiceNo, externalId: payments.externalId })
      .from(reconciliationLines)
      .leftJoin(payments, eq(payments.id, reconciliationLines.paymentId))
      .where(eq(reconciliationLines.reconciliationId, recon.id))
      .orderBy(asc(reconciliationLines.id))
      .limit(2000);
    return {
      id: recon.id,
      channel: recon.channel,
      label: recon.label,
      rates: recon.rates,
      lines: rows.map(({ line, invoiceNo, externalId }) => ({
        id: line.id,
        kind: line.kind,
        ref: line.ref,
        status: line.status,
        quantity: line.quantity,
        currency: line.currency,
        grossMinor: line.grossMinor,
        feeMinor: line.feeMinor,
        taxMinor: line.taxMinor,
        amountInrPaise: line.amountInrPaise,
        bookedInrPaise: line.bookedInrPaise,
        settlementRef: line.settlementRef,
        note: line.note,
        explanation: line.explanation,
        payment: externalId ? { invoiceNo, externalId } : null,
      })),
    };
  }

  /* ------------------------------------------------------------ The launch bar */

  /**
   * The spec's launch bar: two weeks of beta payments reconcile to the rupee across all three channels, in INR and
   * USD. Over the window, every real sale old enough to have been reported has been, with nothing left to explain;
   * and between them the reconciled sales cover the website, both stores, rupees and dollars.
   */
  async launchBar(days: number) {
    const since = new Date(Date.now() - days * DAY);
    const [sales, coverage, [problems]] = await Promise.all([
      this.db
        .select({ channel: payments.channel, currency: payments.currency, capturedAt: payments.capturedAt, reconciledAt: payments.reconciledAt })
        .from(payments)
        .where(and(eq(payments.isTest, false), gte(payments.capturedAt, since))),
      this.coverage(),
      this.db
        .select({ n: count() })
        .from(reconciliationLines)
        .where(and(inArray(reconciliationLines.status, ['unbooked', 'differs', 'needs_rate']), gte(reconciliationLines.createdAt, since))),
    ]);
    const now = Date.now();
    const due = sales.filter((sale) => sale.reconciledAt || isLate(sale, coverage, now));
    const reconciled = due.filter((sale) => sale.reconciledAt);
    const channels = Object.fromEntries(
      (['razorpay', 'google', 'apple'] as const).map((channel) => [
        channel,
        { sales: sales.filter((s) => s.channel === channel).length, due: due.filter((s) => s.channel === channel).length, reconciled: reconciled.filter((s) => s.channel === channel).length },
      ]),
    ) as Record<Channel, { sales: number; due: number; reconciled: number }>;
    const currencies = [...new Set(reconciled.map((sale) => sale.currency))].sort();
    const everyChannel = (['razorpay', 'google', 'apple'] as const).every((channel) => channels[channel].reconciled > 0);
    return {
      ready: true,
      sales: sales.length,
      due: due.length,
      reconciled: reconciled.length,
      waiting: sales.length - due.length,
      problems: problems.n,
      channels,
      currencies,
      enough: everyChannel && currencies.length === 2,
      met: reconciled.length === due.length && due.length > 0 && problems.n === 0 && everyChannel && currencies.length === 2,
    };
  }
}

/* ------------------------------------------------------------------ The arithmetic, kept apart to test on its own */

/** Has this sale been due in a report long enough that its absence means something? */
function isLate(sale: { channel: Channel; currency: string; capturedAt: Date | null }, coverage: Record<Channel, string | null>, now: number) {
  if (!sale.capturedAt) return false;
  if (sale.channel === 'razorpay') return now - sale.capturedAt.getTime() > RAZORPAY_DAYS[sale.currency === 'INR' ? 'INR' : 'USD'] * DAY;
  const reported = coverage[sale.channel];
  if (!reported) return false;
  const end = new Date(`${reported}T00:00:00Z`).getTime() + DAY - (sale.channel === 'apple' ? APPLE_GRACE : 0);
  return sale.capturedAt.getTime() < end;
}

const cleanRates = (rates: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(rates ?? {})
      .map(([currency, rate]) => [currency.trim().toUpperCase(), String(rate).trim()] as const)
      .filter(([currency, rate]) => /^[A-Z]{3}$/.test(currency) && /^\d+(\.\d+)?$/.test(rate) && Number(rate) > 0),
  );

/** One row's identity across imports: the fiscal period, product, price, storefront and proceeds currency. */
const appleRef = (row: AppleRow) =>
  [`${row.periodStart}..${row.periodEnd}`, row.productId, `${row.customerCurrency} ${row.customerPrice}`, row.country ?? '', row.partnerShareCurrency, row.sale ? 'S' : 'R'].join('|');

/**
 * Razorpay's settlement for one payment, in the payment's own columns. Its fee less the GST on it (which comes
 * back as input credit) is the fee; for a dollar payment settled in rupees, the rupee amounts set the rate.
 */
export function razorpayFigures(payment: Payment, item: RazorpayItem): Reported | { differs: string } {
  const feeExTax = item.fee - item.tax;
  if (item.currency === payment.currency) {
    if (item.amount !== payment.grossMinor) {
      return { differs: `Razorpay settled ${amount(item.amount, item.currency)} for this payment; the books have ${amount(payment.grossMinor, payment.currency)}.` };
    }
    const netMinor = payment.grossMinor - payment.gstMinor - feeExTax;
    const inr = payment.currency === 'INR';
    return {
      feeMinor: feeExTax,
      feeTaxPaise: inr ? item.tax : payment.feeTaxPaise,
      netMinor,
      netInrPaise: inr ? netMinor : Math.round(netMinor * Number(payment.fxRate ?? 1)),
      grossInrPaise: null,
      fxRate: null,
      settledInrPaise: inr ? item.credit : null,
      note: feeNote(payment, feeExTax, 'Razorpay'),
    };
  }
  if (item.currency === 'INR' && payment.currency === 'USD') {
    if (payment.grossInrPaise !== null && payment.grossInrPaise !== item.amount) {
      return { differs: `Razorpay settled ${rupees(item.amount)} for this ${amount(payment.grossMinor, 'USD')} payment; it converted it to ${rupees(payment.grossInrPaise)} at the time.` };
    }
    const fx = item.amount / payment.grossMinor;
    const feeMinor = Math.min(payment.grossMinor, Math.round(feeExTax / fx));
    return {
      feeMinor,
      feeTaxPaise: item.tax,
      netMinor: payment.grossMinor - feeMinor,
      netInrPaise: item.amount - feeExTax,
      grossInrPaise: item.amount,
      fxRate: fx.toFixed(6),
      settledInrPaise: item.credit,
      note: feeNote(payment, feeMinor, 'Razorpay'),
    };
  }
  return { differs: `Razorpay settled this in ${item.currency}, but the sale is in ${payment.currency}.` };
}

/** "Fee booked as an estimate of ₹19.98; Razorpay charged ₹20.40." Null when nothing changed. */
function feeNote(payment: Payment, feeMinor: number, who: string) {
  if (feeMinor === payment.feeMinor) return null;
  const was = payment.feeSource === 'estimate' ? 'an estimate of ' : '';
  return `${who === 'Razorpay' ? 'Fee' : 'Commission'} booked as ${was}${amount(payment.feeMinor, payment.currency)}; ${who} ${who === 'Razorpay' ? 'charged' : 'kept'} ${amount(feeMinor, payment.currency)}.`;
}

/**
 * A store's proceeds for one sale, in rupees, as the payment's fee and net (spec: "the ledger uses the proceeds
 * Apple actually reports"). Where the store passed the GST part on too (proceeds above the price less GST),
 * Embodha owes that GST itself, so it comes off before the split.
 *
 * `rate` is the store's own conversion for a sale in another currency: Google's, from its report, or the rate Apple
 * paid at. With it, a dollar sale's fee stays in dollars as the store took it, and the rate the books had is replaced;
 * without it, the books' rate turns the rupees back into dollars.
 */
export function storeFigures(payment: Payment, proceedsInr: number, who: 'Apple' | 'Google', rate: number | null = null): Reported {
  const inr = payment.currency === 'INR';
  const own = !inr && rate !== null && Number.isFinite(rate) && rate > 0;
  const fx = inr ? 1 : own ? rate! : Number(payment.fxRate ?? 1);
  const grossInr = inr ? payment.grossMinor : own ? Math.round(payment.grossMinor * fx) : (payment.grossInrPaise ?? Math.round(payment.grossMinor * fx));
  const gstInr = inr ? payment.gstMinor : 0;
  const keptGst = gstInr > 0 && proceedsInr > grossInr - gstInr;
  const netInr = keptGst ? proceedsInr - gstInr : proceedsInr;
  const netMinor = inr ? netInr : Math.round(netInr / fx);
  const feeMinor = Math.max(0, payment.grossMinor - payment.gstMinor - netMinor);
  const booked = Number(payment.fxRate ?? 0);
  const notes = [
    feeNote(payment, feeMinor, who),
    own && Math.abs(fx - booked) >= 0.0001
      ? `${who} converted at ${rupees(Math.round(fx * 100))} to the ${payment.currency === 'USD' ? 'dollar' : payment.currency}${booked ? `; the books had ${rupees(Math.round(booked * 100))}` : ''}.`
      : null,
    keptGst ? `${who} paid out the GST part as well (${rupees(proceedsInr)}), so the GST on this sale is Embodha's to pay.` : null,
  ].filter(Boolean);
  return {
    feeMinor,
    feeTaxPaise: 0,
    netMinor,
    netInrPaise: netInr,
    grossInrPaise: own ? grossInr : null,
    fxRate: own ? fx.toFixed(6) : null,
    settledInrPaise: proceedsInr,
    note: notes.join(' ') || null,
  };
}

/** Did the store charge what the books say? Compared in the currency the store charged, when we know it. */
function chargedDiffers(payment: Payment, charged: { currency: string; minor: number } | null) {
  if (!charged) return null;
  const booked =
    payment.chargedCurrency === charged.currency && payment.chargedPrice !== null
      ? toMinor(payment.chargedPrice)
      : payment.currency === charged.currency
        ? payment.grossMinor
        : null;
  if (booked === null || booked === charged.minor) return null;
  return `Google charged ${amount(charged.minor, charged.currency)}; the books have ${amount(booked, charged.currency)}.`;
}
