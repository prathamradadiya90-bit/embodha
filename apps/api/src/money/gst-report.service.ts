import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, lt } from 'drizzle-orm';
import { BUSINESS_TIME_ZONE, monthRange } from '../common/month';
import { readSetting } from '../common/settings';
import { Db, InjectDb } from '../db/db.module';
import { payments, refunds } from '../db/schema';
import { localDay } from '../practice/streak';
import { DEFAULT_SELLER, OUTSIDE_INDIA, placeLabel, sellerStateOf } from './gst';

type Payment = typeof payments.$inferSelect;

/** Taxable value, each tax, and the total, in paise. */
export interface Amounts {
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
}

const zero = (): Amounts => ({ taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 0 });
const add = (into: Amounts, from: { grossMinor: number; gstMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }) => {
  into.taxableMinor += from.grossMinor - from.gstMinor;
  into.cgstMinor += from.cgstMinor;
  into.sgstMinor += from.sgstMinor;
  into.igstMinor += from.igstMinor;
  into.totalMinor += from.grossMinor;
};
const combine = (a: Amounts, b: Amounts, sign: 1 | -1): Amounts => ({
  taxableMinor: a.taxableMinor + sign * b.taxableMinor,
  cgstMinor: a.cgstMinor + sign * b.cgstMinor,
  sgstMinor: a.sgstMinor + sign * b.sgstMinor,
  igstMinor: a.igstMinor + sign * b.igstMinor,
  totalMinor: a.totalMinor + sign * b.totalMinor,
});
const inrValue = (minor: number, payment: Payment) => (payment.currency === 'INR' ? minor : Math.round(minor * Number(payment.fxRate ?? 0)));

/** The first and last number in a series, and how many were issued. */
const range = (numbers: string[]) => (numbers.length ? { from: numbers[0], to: numbers[numbers.length - 1], count: numbers.length } : null);

/**
 * A month of Embodha's own GST documents, the way the accountant files them: sales in India by place of supply with
 * CGST, SGST and IGST, exports, credit notes for refunds, the document ranges GSTR-1 asks for, and every document
 * line by line. Only website sales are here: in the apps, Apple and Google are the sellers.
 */
@Injectable()
export class GstReportService {
  constructor(@InjectDb() private readonly db: Db) {}

  async month(month: string) {
    const { start, end } = monthRange(month);
    const [invoices, notes, seller] = await Promise.all([
      this.db
        .select()
        .from(payments)
        .where(and(isNotNull(payments.invoiceNo), gte(payments.capturedAt, start), lt(payments.capturedAt, end)))
        .orderBy(asc(payments.invoiceNo)),
      this.db
        .select({ refund: refunds, payment: payments })
        .from(refunds)
        .innerJoin(payments, eq(payments.id, refunds.paymentId))
        .where(and(isNotNull(refunds.creditNoteNo), gte(refunds.at, start), lt(refunds.at, end)))
        .orderBy(asc(refunds.creditNoteNo)),
      readSetting(this.db, 'invoice_seller', DEFAULT_SELLER),
    ]);

    const places = new Map<string, { invoices: number; sales: Amounts; creditNotes: number; credited: Amounts }>();
    const place = (code: string) => {
      if (!places.has(code)) places.set(code, { invoices: 0, sales: zero(), creditNotes: 0, credited: zero() });
      return places.get(code)!;
    };
    const exports = { invoices: 0, sales: zero(), salesInrPaise: 0, creditNotes: 0, credited: zero(), creditedInrPaise: 0 };
    // Sales booked before the seller's GSTIN was set carry one GST figure with no place of supply.
    const unsplit = { invoices: 0, gstMinor: 0, creditNotes: 0, creditedGstMinor: 0 };
    // Renewals for someone who never gave a state were taxed in the seller's state; the rules want theirs.
    let stateMissing = 0;

    for (const sale of invoices) {
      if (sale.placeOfSupply === OUTSIDE_INDIA) {
        exports.invoices += 1;
        add(exports.sales, sale);
        exports.salesInrPaise += inrValue(sale.grossMinor, sale);
      } else if (sale.placeOfSupply && sale.currency === 'INR') {
        const p = place(sale.placeOfSupply);
        p.invoices += 1;
        add(p.sales, sale);
        if (!sale.buyerState) stateMissing += 1;
      } else {
        unsplit.invoices += 1;
        unsplit.gstMinor += sale.gstMinor;
      }
    }
    for (const { refund, payment } of notes) {
      const credited = { grossMinor: refund.amountMinor, gstMinor: refund.gstMinor, cgstMinor: refund.cgstMinor, sgstMinor: refund.sgstMinor, igstMinor: refund.igstMinor };
      if (payment.placeOfSupply === OUTSIDE_INDIA) {
        exports.creditNotes += 1;
        add(exports.credited, credited);
        exports.creditedInrPaise += inrValue(refund.amountMinor, payment);
      } else if (payment.placeOfSupply && payment.currency === 'INR') {
        const p = place(payment.placeOfSupply);
        p.creditNotes += 1;
        add(p.credited, credited);
      } else {
        unsplit.creditNotes += 1;
        unsplit.creditedGstMinor += refund.gstMinor;
      }
    }

    const byPlace = [...places.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      // What GSTR-1 takes for sales to consumers: each place's sales, less its credit notes this month.
      .map(([code, p]) => ({ code, place: placeLabel(code), ...p, net: combine(p.sales, p.credited, -1) }));
    const totals = byPlace.reduce(
      (sum, p) => ({
        invoices: sum.invoices + p.invoices,
        sales: combine(sum.sales, p.sales, 1),
        creditNotes: sum.creditNotes + p.creditNotes,
        credited: combine(sum.credited, p.credited, 1),
        net: combine(sum.net, p.net, 1),
      }),
      { invoices: 0, sales: zero(), creditNotes: 0, credited: zero(), net: zero() },
    );

    const day = (at: Date) => localDay(at, BUSINESS_TIME_ZONE);
    const register = [
      ...invoices.map((sale) => ({
        type: 'Invoice' as const,
        number: sale.invoiceNo!,
        date: day(sale.capturedAt ?? sale.createdAt),
        against: null,
        buyerState: placeLabel(sale.buyerState),
        placeOfSupply: sale.placeOfSupply,
        place: placeLabel(sale.placeOfSupply),
        currency: sale.currency,
        taxableMinor: sale.grossMinor - sale.gstMinor,
        cgstMinor: sale.cgstMinor,
        sgstMinor: sale.sgstMinor,
        igstMinor: sale.igstMinor,
        totalMinor: sale.grossMinor,
        inrPaise: inrValue(sale.grossMinor, sale),
        refunded: sale.status !== 'captured',
      })),
      ...notes.map(({ refund, payment }) => ({
        type: 'Credit note' as const,
        number: refund.creditNoteNo!,
        date: day(refund.at),
        against: payment.invoiceNo,
        buyerState: placeLabel(payment.buyerState),
        placeOfSupply: payment.placeOfSupply,
        place: placeLabel(payment.placeOfSupply),
        currency: payment.currency,
        taxableMinor: refund.amountMinor - refund.gstMinor,
        cgstMinor: refund.cgstMinor,
        sgstMinor: refund.sgstMinor,
        igstMinor: refund.igstMinor,
        totalMinor: refund.amountMinor,
        inrPaise: inrValue(refund.amountMinor, payment),
        refunded: false,
      })),
    ];

    return {
      month,
      seller: { gstin: seller.gstin || null, state: placeLabel(sellerStateOf(seller.gstin)), sac: seller.sac || null },
      india: { byPlace, totals },
      exports,
      unsplit,
      stateMissing,
      documents: { invoices: range(invoices.map((s) => s.invoiceNo!)), creditNotes: range(notes.map((n) => n.refund.creditNoteNo!)) },
      register,
    };
  }
}
