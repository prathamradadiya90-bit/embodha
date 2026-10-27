import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { priceIn } from '../catalogue/price';
import { fail } from '../common/errors';
import { BUSINESS_TIME_ZONE } from '../common/month';
import { readSetting } from '../common/settings';
import { Db, InjectDb } from '../db/db.module';
import { courses, instructors, payments, refunds, staffRoles, users } from '../db/schema';
import { MailService } from '../mail/mail.service';
import { DEFAULT_SELLER, placeLabel, sellerStateOf, stateTaxName } from './gst';
import { InvoiceData, renderInvoice, TaxLine } from './invoice-pdf';

export type DocumentKind = 'invoice' | 'credit_note';

export const describeItem = (course: string | null, instructor: string) => (course ? `Course: ${course}` : `Monthly subscription: ${instructor}`);
const fileName = (kind: DocumentKind, number: string) => `embodha-${kind === 'invoice' ? 'invoice' : 'credit-note'}-${number.replace(/\//g, '-')}.pdf`;
const longDate = (at: Date) => at.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: BUSINESS_TIME_ZONE });

/**
 * An invoice for every website sale, emailed as a PDF when the payment is recorded and downloadable afterwards, and a
 * credit note for every refund of one. Each prints the seller, rate and footnote it was booked with, so changing
 * Money settings later never rewrites a document that's already gone out.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly mail: MailService,
  ) {}

  /** Members can download their own invoices and credit notes; finance and support staff can download any. */
  async pdfFor(paymentId: string, userId: string, kind: DocumentKind = 'invoice') {
    const data = await this.document(paymentId, kind);
    if (!data) throw fail(404, 'not_found', kind === 'invoice' ? 'No such invoice.' : 'No such credit note.');
    if (data.userId !== userId) {
      const [staff] = await this.db
        .select({ role: staffRoles.role })
        .from(staffRoles)
        .where(and(eq(staffRoles.userId, userId), inArray(staffRoles.role, ['super_admin', 'finance', 'support'])))
        .limit(1);
      if (!staff) throw fail(404, 'not_found', kind === 'invoice' ? 'No such invoice.' : 'No such credit note.');
    }
    return { filename: fileName(kind, data.document.number), pdf: await renderInvoice(data.document) };
  }

  async sendReceipt(paymentId: string) {
    const data = await this.document(paymentId, 'invoice');
    if (!data) return;
    const { document } = data;
    await this.mail.send({
      to: data.email,
      subject: `Your Embodha invoice ${document.number}`,
      text: [`Thank you for your purchase.`, ``, document.item, `Invoice ${document.number}, attached as a PDF.`, ``, `Questions about this payment? Reply to this email.`].join('\n'),
      attachments: [{ filename: fileName('invoice', document.number), content: await renderInvoice(document), contentType: 'application/pdf' }],
    });
  }

  /** Tells the member their money is on its way back, with the credit note for their records. */
  async sendCreditNote(paymentId: string) {
    const data = await this.document(paymentId, 'credit_note');
    if (!data) return;
    const { document } = data;
    const refunded = priceIn({ inrPaise: document.grossMinor, usdCents: document.grossMinor }, document.currency)!.display;
    await this.mail.send({
      to: data.email,
      subject: `Your Embodha refund: credit note ${document.number}`,
      text: [
        `We've refunded ${refunded} for this purchase:`,
        document.item,
        ``,
        `It goes back to the card, UPI account or bank account you paid with. Banks usually take 5 to 7 working days to show it.`,
        `Credit note ${document.number}, against invoice ${document.against!.number}, is attached for your records.`,
        ``,
        `Questions? Reply to this email.`,
      ].join('\n'),
      attachments: [{ filename: fileName('credit_note', document.number), content: await renderInvoice(document), contentType: 'application/pdf' }],
    });
  }

  /** Everything an invoice, or the credit note for its refund, prints. Null if the payment has none. */
  async document(paymentId: string, kind: DocumentKind): Promise<{ userId: string; email: string; document: InvoiceData } | null> {
    const [row] = await this.db
      .select({ payment: payments, user: users, course: courses.title, instructor: instructors.displayName })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.userId))
      .innerJoin(instructors, eq(instructors.id, payments.instructorId))
      .leftJoin(courses, eq(courses.id, payments.courseId))
      .where(eq(payments.id, paymentId))
      .limit(1);
    const payment = row?.payment;
    if (!payment?.invoiceNo) return null;
    const [refund] =
      kind === 'credit_note'
        ? await this.db
            .select()
            .from(refunds)
            .where(and(eq(refunds.paymentId, paymentId), isNotNull(refunds.creditNoteNo)))
            .limit(1)
        : [];
    if (kind === 'credit_note' && !refund) return null;

    const india = payment.currency === 'INR';
    // Sales booked before sellers were kept with them fall back to today's settings.
    const seller = payment.invoiceSeller ?? (await readSetting(this.db, 'invoice_seller', DEFAULT_SELLER));
    const note = seller.note ?? (await readSetting(this.db, india ? 'invoice_note_india' : 'invoice_note_abroad', ''));
    const sellerState = sellerStateOf(seller.gstin);
    const amounts = refund ?? payment;
    const half = payment.gstRateBps / 2;
    const taxes: TaxLine[] = [];
    if (amounts.cgstMinor || amounts.sgstMinor) {
      taxes.push({ name: 'CGST', rateBps: half, minor: amounts.cgstMinor }, { name: stateTaxName(sellerState), rateBps: half, minor: amounts.sgstMinor });
    }
    if (amounts.igstMinor) taxes.push({ name: 'IGST', rateBps: payment.gstRateBps, minor: amounts.igstMinor });
    const invoiceDate = longDate(payment.capturedAt ?? payment.createdAt);

    return {
      userId: payment.userId,
      email: row.user.email,
      document: {
        kind,
        number: refund ? refund.creditNoteNo! : payment.invoiceNo,
        date: refund ? longDate(refund.at) : invoiceDate,
        against: refund ? { number: payment.invoiceNo, date: invoiceDate } : undefined,
        seller: { name: seller.name, address: seller.address, gstin: seller.gstin, sac: seller.sac ?? '', state: placeLabel(sellerState) },
        // GST rules want the buyer's state on every invoice to someone in India, so a missing one shows.
        buyer: { name: row.user.name, email: row.user.email, where: india ? (placeLabel(payment.buyerState) ?? 'Not given') : payment.country },
        placeOfSupply: payment.placeOfSupply ? { code: payment.placeOfSupply, label: placeLabel(payment.placeOfSupply) ?? payment.placeOfSupply } : null,
        item: describeItem(row.course, row.instructor),
        currency: india ? 'INR' : 'USD',
        grossMinor: refund ? refund.amountMinor : payment.grossMinor,
        gstMinor: amounts.gstMinor,
        gstRateBps: payment.gstRateBps,
        taxes,
        note,
      },
    };
  }
}
