import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { count, monthName, rupees, toCsv } from '../../lib/format';
import type { GstAmounts, GstReport } from '../../lib/types';
import { Button, Card, Empty, ErrorNote, Field, Loading, PageHeader, Stat } from '../../ui/kit';

const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
/** Plain rupees for spreadsheets: 84661 → "846.61". */
const plain = (minor: number) => (minor / 100).toFixed(2);
const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** How many register lines the page shows; the CSV always has them all. */
const SHOWN = 100;

function download(name: string, rows: (string | number | null)[][]) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

const amountColumns = (a: GstAmounts) => [plain(a.taxableMinor), plain(a.cgstMinor), plain(a.sgstMinor), plain(a.igstMinor)];

/** One row per place of supply, then exports: the numbers for GSTR-1's tables 7 and 6A, and GSTR-3B. */
function summaryCsv(report: GstReport) {
  const { totals } = report.india;
  const e = report.exports;
  download(`embodha-gst-summary-${report.month}.csv`, [
    ['Place of supply', 'State code', 'Invoices', 'Taxable value', 'CGST', 'SGST/UTGST', 'IGST', 'Credit notes', 'Credited taxable value', 'Credited CGST', 'Credited SGST/UTGST', 'Credited IGST', 'Net taxable value', 'Net CGST', 'Net SGST/UTGST', 'Net IGST'],
    ...report.india.byPlace.map((p) => [p.place, p.code, p.invoices, ...amountColumns(p.sales), p.creditNotes, ...amountColumns(p.credited), ...amountColumns(p.net)]),
    ['Total in India', null, totals.invoices, ...amountColumns(totals.sales), totals.creditNotes, ...amountColumns(totals.credited), ...amountColumns(totals.net)],
    [
      'Outside India, in rupees at the rate booked',
      '96',
      e.invoices,
      plain(e.salesInrPaise),
      '0.00',
      '0.00',
      '0.00',
      e.creditNotes,
      plain(e.creditedInrPaise),
      '0.00',
      '0.00',
      '0.00',
      plain(e.salesInrPaise - e.creditedInrPaise),
      '0.00',
      '0.00',
      '0.00',
    ],
  ]);
}

/** Every invoice and credit note issued in the month, for the books and for GSTR-1's document details. */
function registerCsv(report: GstReport) {
  download(`embodha-gst-register-${report.month}.csv`, [
    ['Type', 'Number', 'Date', 'Against invoice', "Buyer's state", 'Place of supply', 'State code', 'Currency', 'Taxable value', 'CGST', 'SGST/UTGST', 'IGST', 'Total', 'Value in rupees', 'Refunded since'],
    ...report.register.map((r) => [
      r.type,
      r.number,
      r.date,
      r.against,
      r.currency === 'INR' ? (r.buyerState ?? 'not given') : null,
      r.place,
      r.placeOfSupply,
      r.currency,
      plain(r.taxableMinor),
      plain(r.cgstMinor),
      plain(r.sgstMinor),
      plain(r.igstMinor),
      plain(r.totalMinor),
      plain(r.inrPaise),
      r.refunded ? 'yes' : null,
    ]),
  ]);
}

/** A month of Embodha's invoices and credit notes, set out for the GST returns. */
export function Gst() {
  const [month, setMonth] = useState(thisMonth);
  const query = useQuery({ queryKey: ['admin', 'gst', month], queryFn: () => api<GstReport>(`/v1/admin/reports/gst/${month}`) });
  const report = query.data;

  return (
    <div className="stack">
      <PageHeader
        title="GST"
        lead="Embodha's own invoices for a month, set out for the returns. A buyer in the same state as the seller pays CGST and SGST, and a buyer anywhere else in India pays IGST. Credit notes for refunds come off in the month they're issued. App Store and Google Play sales aren't here, because Apple and Google are the sellers there and account for the tax."
        actions={
          report?.register.length ? (
            <div className="row">
              <Button variant="secondary" onClick={() => summaryCsv(report)}>
                Summary CSV
              </Button>
              <Button variant="secondary" onClick={() => registerCsv(report)}>
                Register CSV
              </Button>
            </div>
          ) : null
        }
      />
      <Field label="Month">
        <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ maxWidth: 220 }} />
      </Field>
      {query.isPending ? <Loading /> : query.isError ? <ErrorNote error={query.error} /> : report ? <Body report={report} /> : null}
    </div>
  );
}

function Body({ report }: { report: GstReport }) {
  const { byPlace, totals } = report.india;
  const e = report.exports;
  const sac = report.seller.sac;
  return (
    <>
      {!report.seller.gstin ? (
        <p className="notice">
          There's no GSTIN in <Link to="/admin/money-settings">Money settings</Link> yet, so sales are booked with their GST in one piece and no place of supply. Once it's there, every sale from then on is split.
        </p>
      ) : null}
      {report.stateMissing ? (
        <p className="notice">
          {count(report.stateMissing)} {report.stateMissing === 1 ? 'invoice was' : 'invoices were'} taxed in the seller's state because the buyer hadn't given theirs. That
          only happens on a renewal for someone who signed up before the app asked. GST rules want the buyer's state on these invoices, so the register CSV marks them
          "not given" for your accountant.
        </p>
      ) : null}
      {report.unsplit.invoices || report.unsplit.creditNotes ? (
        <p className="notice">
          {count(report.unsplit.invoices)} {report.unsplit.invoices === 1 ? 'invoice' : 'invoices'} this month, with {rupees(report.unsplit.gstMinor)} of GST, {report.unsplit.invoices === 1 ? 'was' : 'were'} booked before the GSTIN was
          set, so {report.unsplit.invoices === 1 ? "it isn't" : "they aren't"} in the table below. Your accountant can treat them as sales in the seller's own state.
        </p>
      ) : null}

      <div className="stats">
        <Stat label={`Taxable value in ${monthName(report.month)}`} value={rupees(totals.net.taxableMinor)} note={`${count(totals.invoices)} ${totals.invoices === 1 ? 'invoice' : 'invoices'}, ${count(totals.creditNotes)} ${totals.creditNotes === 1 ? 'credit note' : 'credit notes'}`} />
        <Stat label="CGST" value={rupees(totals.net.cgstMinor)} />
        <Stat label="SGST / UTGST" value={rupees(totals.net.sgstMinor)} />
        <Stat label="IGST" value={rupees(totals.net.igstMinor)} />
      </div>

      <Card title="Sales in India, by place of supply">
        {byPlace.length ? (
          <div className="table-wrap flat">
            <table>
              <thead>
                <tr>
                  <th>Place of supply</th>
                  <th className="num">Invoices</th>
                  <th className="num">Taxable value</th>
                  <th className="num">CGST</th>
                  <th className="num">SGST</th>
                  <th className="num">IGST</th>
                  <th className="num">Credit notes</th>
                  <th className="num">Net taxable value</th>
                </tr>
              </thead>
              <tbody>
                {byPlace.map((p) => (
                  <tr key={p.code}>
                    <td>{p.place}</td>
                    <td className="num">{count(p.invoices)}</td>
                    <td className="num">{rupees(p.sales.taxableMinor)}</td>
                    <td className="num">{rupees(p.sales.cgstMinor)}</td>
                    <td className="num">{rupees(p.sales.sgstMinor)}</td>
                    <td className="num">{rupees(p.sales.igstMinor)}</td>
                    <td className="num">{p.creditNotes ? `${count(p.creditNotes)} · −${rupees(p.credited.taxableMinor)}` : '—'}</td>
                    <td className="num">{rupees(p.net.taxableMinor)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="num">{count(totals.invoices)}</td>
                  <td className="num">{rupees(totals.sales.taxableMinor)}</td>
                  <td className="num">{rupees(totals.sales.cgstMinor)}</td>
                  <td className="num">{rupees(totals.sales.sgstMinor)}</td>
                  <td className="num">{rupees(totals.sales.igstMinor)}</td>
                  <td className="num">{totals.creditNotes ? `${count(totals.creditNotes)} · −${rupees(totals.credited.taxableMinor)}` : '—'}</td>
                  <td className="num">{rupees(totals.net.taxableMinor)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No invoices to buyers in India this month.</Empty>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Exports">
          {e.invoices || e.creditNotes ? (
            <p>
              {count(e.invoices)} {e.invoices === 1 ? 'invoice' : 'invoices'} to buyers outside India, {dollars(e.sales.totalMinor)} ({rupees(e.salesInrPaise)} at the rate booked), with no
              GST. Place of supply 96.
              {e.creditNotes ? ` ${count(e.creditNotes)} refunded, ${dollars(e.credited.totalMinor)}.` : ''}
            </p>
          ) : (
            <Empty>No sales abroad this month.</Empty>
          )}
        </Card>
        <Card title="Documents issued">
          <dl className="facts">
            <dt>Invoices</dt>
            <dd>{report.documents.invoices ? `${report.documents.invoices.from} to ${report.documents.invoices.to} (${count(report.documents.invoices.count)})` : 'None'}</dd>
            <dt>Credit notes</dt>
            <dd>{report.documents.creditNotes ? `${report.documents.creditNotes.from} to ${report.documents.creditNotes.to} (${count(report.documents.creditNotes.count)})` : 'None'}</dd>
            <dt>SAC</dt>
            <dd>{sac ? `${sac}, on every sale` : <>Not set (optional below ₹5 crore turnover; it's in Money settings)</>}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Register">
        {report.register.length ? (
          <>
            <div className="table-wrap flat">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Date</th>
                    <th>Place of supply</th>
                    <th className="num">Taxable value</th>
                    <th className="num">Tax</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.register.slice(0, SHOWN).map((r) => {
                    const money = (minor: number) => (r.currency === 'INR' ? rupees(minor) : dollars(minor));
                    const tax = r.cgstMinor + r.sgstMinor + r.igstMinor;
                    return (
                      <tr key={r.number}>
                        <td>
                          {r.number}
                          <div className="small muted">{r.type === 'Credit note' ? `Credit note for ${r.against}` : r.refunded ? 'Invoice, refunded since' : 'Invoice'}</div>
                        </td>
                        <td>{r.date}</td>
                        <td>{r.place ?? '—'}</td>
                        <td className="num">{money(r.taxableMinor)}</td>
                        <td className="num">
                          {tax ? money(tax) : '—'}
                          {tax ? <div className="small muted">{r.igstMinor ? 'IGST' : 'CGST + SGST'}</div> : null}
                        </td>
                        <td className="num">{money(r.totalMinor)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {report.register.length > SHOWN ? <p className="small muted">The first {SHOWN} of {count(report.register.length)}. The register CSV has every one.</p> : null}
          </>
        ) : (
          <Empty>No invoices or credit notes this month.</Empty>
        )}
      </Card>
    </>
  );
}
