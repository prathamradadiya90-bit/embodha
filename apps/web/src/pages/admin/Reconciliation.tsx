import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, API_URL, ApiError, authHeader } from '../../lib/api';
import { count, day, monthName, rupees } from '../../lib/format';
import type { ReconAttention, ReconChannel, ReconChannelSummary, ReconImport, ReconImportResult, ReconLine, ReconOverview, ReconStatus } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

const CHANNEL: Record<ReconChannel, string> = { razorpay: 'Website (Razorpay)', google: 'Google Play', apple: 'App Store' };
const SHORT: Record<ReconChannel, string> = { razorpay: 'Razorpay', google: 'Google Play', apple: 'App Store' };
const STATUS: Record<ReconStatus, [string, 'green' | 'amber' | 'red' | 'neutral' | 'maroon']> = {
  matched: ['Matches', 'green'],
  corrected: ['Corrected', 'green'],
  booked: ['Booked from the report', 'maroon'],
  unbooked: ['Not in the books', 'red'],
  differs: ['Different', 'red'],
  other: ['Not a sale', 'amber'],
  needs_rate: ['Needs a rate', 'amber'],
  explained: ['Explained', 'neutral'],
};
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
/** How a fetch or an upload went, line by line: "2 match the books", "1 not in the books". */
const OUTCOME: [ReconStatus, (n: number) => string][] = [
  ['matched', (n) => `${count(n)} ${n === 1 ? 'matches' : 'match'} the books`],
  ['corrected', (n) => `${count(n)} corrected to the report`],
  ['booked', (n) => `${count(n)} booked from the report`],
  ['unbooked', (n) => `${count(n)} not in the books`],
  ['differs', (n) => `${count(n)} different from the books`],
  ['other', (n) => `${count(n)} not ${n === 1 ? 'a sale' : 'sales'}`],
  ['needs_rate', (n) => `${count(n)} waiting for a rate`],
  ['explained', (n) => `${count(n)} explained`],
];

/**
 * A report line as finance would name it: the sale's invoice number when there is one, an App Store line as the
 * product and price it counts (Apple's report doesn't name purchases), Play's other money by what it was.
 */
function refLabel(line: { ref: string; payment: { invoiceNo: string | null } | null }) {
  if (line.payment?.invoiceNo) return line.payment.invoiceNo;
  const parts = line.ref.split('|');
  if (parts.length === 6) return `${parts[1]} at ${parts[2]}${parts[3] ? `, ${parts[3]}` : ''}`;
  if (parts.length === 3) return `${parts[0]}, ${parts[1]}`;
  return line.ref;
}

/** "2026-10" and the eleven months before it. */
function months() {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * Finance's check that what Razorpay, Google Play and the App Store paid matches the books, sale by sale. Razorpay is
 * fetched every night; the stores' monthly reports are uploaded here as they're downloaded.
 */
export function Reconciliation() {
  const [params, setParams] = useSearchParams();
  const options = months();
  const month = options.includes(params.get('month') ?? '') ? params.get('month')! : options[0];
  const query = useQuery({
    queryKey: ['admin', 'reconciliation', month],
    queryFn: () => api<ReconOverview>(`/v1/admin/reconciliation?month=${month}`),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const data = query.data;

  return (
    <div className="stack">
      <PageHeader
        title="Reconciliation"
        lead="What Razorpay, Google Play and the App Store say they paid, against the books, sale by sale. A report's real fee replaces the estimate, and the instructor's share follows it. A store sale's share becomes payable once that store's report includes it."
        actions={
          <label className="month-pick">
            <span className="sr-only">Month</span>
            <select value={month} onChange={(e) => setParams({ month: e.target.value }, { replace: true })}>
              {options.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="grid-3" style={{ opacity: query.isPlaceholderData ? 0.55 : 1, transition: 'opacity 0.15s' }}>
        {data.channels.map((summary) => (
          <ChannelCard key={summary.channel} summary={summary} month={month} lastNightly={data.lastNightly} razorpayReady={data.razorpayReady} />
        ))}
      </div>

      <Upload />

      <Card title="Needs a look">
        {data.attention.length ? (
          <div className="table-wrap flat recon-table">
            <table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>What the report says</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.attention.map((line) => (
                  <AttentionRow key={line.id} line={line} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing to look into. Every line from every report matches the books, or someone has written down why it doesn't.</Empty>
        )}
      </Card>

      {data.overdue.length ? (
        <Card title="Sales the reports should have had by now">
          <div className="table-wrap flat">
            <table>
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Channel</th>
                  <th className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {data.overdue.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      {sale.invoiceNo ?? <span className="mono">{sale.externalId}</span>}
                      <div className="small muted">{day(sale.capturedAt)}</div>
                    </td>
                    <td>{SHORT[sale.channel]}</td>
                    <td className="num">{sale.gross}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small chart-note">
            A website sale is late after 4 days, or 11 for a payment from abroad: Razorpay settles Indian payments in two working days, and payments from
            abroad on a longer cycle (its dashboard shows yours). For the stores, a sale is late once a report covering its date is in and the sale isn't
            on it. A sale that stays here may have been refunded or charged back outside Embodha.
          </p>
        </Card>
      ) : null}

      <Card title="Reports">
        {data.imports.length ? (
          <div className="table-wrap flat recon-table">
            <table>
              <thead>
                <tr>
                  <th>Report</th>
                  <th className="num">Lines</th>
                  <th className="num">Corrected</th>
                  <th className="num">To look at</th>
                  <th className="num">Paid out</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.imports.map((item) => (
                  <ImportRow key={item.id} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No reports yet. Razorpay's arrive by themselves each night once its keys are set; upload the stores' above.</Empty>
        )}
      </Card>
    </div>
  );
}

function ChannelCard({ summary, month, lastNightly, razorpayReady }: { summary: ReconChannelSummary; month: string; lastNightly: string | null; razorpayReady: boolean }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [fetched, setFetched] = useState<ReconImportResult | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: weekAgo, to: today });
  const all = summary.sales;
  // Nothing matched and nothing late: the money simply hasn't been reported yet, which is no one's problem.
  const early = !summary.reconciled && !summary.late;
  const tone = !all || early ? 'neutral' : summary.reconciled === all ? 'green' : summary.late ? 'red' : 'amber';
  const badge =
    summary.reconciled === all ? 'All matched' : summary.late ? `${summary.late} late` : early ? (summary.channel === 'razorpay' ? 'Not settled yet' : 'Report not out yet') : 'In progress';

  return (
    <section className={`card recon-card ${tone}`} aria-label={CHANNEL[summary.channel]}>
      <div className="bar-head">
        <span className="stat-label">{CHANNEL[summary.channel]}</span>
        {all ? <Badge tone={tone}>{badge}</Badge> : null}
      </div>
      <span className="bar-value">{all ? `${count(summary.reconciled)} of ${count(all)}` : '—'}</span>
      <span className="bar-target">{all ? `sales in ${monthName(month)} matched to a report` : `No sales in ${monthName(month)}`}</span>
      {all ? (
        <dl className="facts small">
          <dt>Sales</dt>
          <dd>{rupees(summary.grossInrPaise)}</dd>
          <dt>Net in the books</dt>
          <dd>{rupees(summary.netInrPaise)}</dd>
          <dt>Paid out, so far</dt>
          <dd>{rupees(summary.settledInrPaise)}</dd>
        </dl>
      ) : null}
      <span className="bar-note">
        {[
          summary.waiting ? `${plural(summary.waiting, 'sale')} not reported yet` : null,
          summary.corrected ? `${plural(summary.corrected, 'sale')} corrected to the report` : null,
          summary.estimated ? `${plural(summary.estimated, 'fee')} still estimated` : null,
          summary.tests ? `${plural(summary.tests, 'test purchase')} left out` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="bar-note">
        {summary.channel === 'razorpay'
          ? razorpayReady
            ? `Fetched every night${lastNightly ? `; last ${day(lastNightly)}` : ''}.`
            : 'Razorpay keys are not set on the server, so nothing is fetched.'
          : summary.reportedTo
            ? `Reports cover sales up to ${day(summary.reportedTo)}.`
            : summary.channel === 'google'
              ? 'Upload the monthly earnings report from Play Console: Download reports, Financial. Google makes it near the start of the next month.'
              : "Upload the monthly financial report from App Store Connect: Payments and Financial Reports, Create Reports, All Countries or Regions (Single File). It's out by the first Friday of Apple's next fiscal month."}
      </span>
      {summary.channel === 'razorpay' && razorpayReady ? (
        <div className="recon-fetch">
          <div className="row">
            <Field label="From">
              <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="To">
              <input type="date" value={range.to} min={range.from} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </Field>
          </div>
          <Button
            variant="secondary"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                setFetched(await api<ReconImportResult>('/v1/admin/reconciliation/razorpay', { method: 'POST', body: range }));
                await queryClient.invalidateQueries({ queryKey: ['admin', 'reconciliation'] });
              })
            }
          >
            Fetch settlements now
          </Button>
          <ErrorNote error={action.error} />
          {fetched ? <p className="small">{summarise(fetched, 'fetched')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/** "Razorpay settlements, 9–22 Oct 2026: 4 new lines; 2 match the books, 2 with the fee corrected. 9 were already here." */
function summarise(result: ReconImportResult, how: 'fetched' | 'uploaded') {
  const parts = OUTCOME.filter(([status]) => result.counts[status]).map(([status, say]) => say(result.counts[status]!));
  const total = Object.values(result.counts).reduce((sum, n) => sum + (n ?? 0), 0);
  const already = result.repeated ? `${plural(result.repeated, 'line')} ${result.repeated === 1 ? 'was' : 'were'} already here.` : '';
  if (!total) return already ? `${result.label}: nothing new. ${already}` : `${result.label}: ${how === 'fetched' ? 'nothing was settled on those days' : 'nothing in it to match'}.`;
  const rates = result.needsRates.length ? ` Enter the rupee rate for ${result.needsRates.join(' and ')} under Reports.` : '';
  return `${result.label}: ${plural(total, 'new line')}; ${parts.join(', ')}.${already ? ` ${already}` : ''}${rates}`;
}

/** One file, any of the three reports: the server works out which. */
function Upload() {
  const queryClient = useQueryClient();
  const action = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<ReconImportResult[]>([]);

  const send = (file: File) =>
    action.run(async () => {
      await api('/v1/me'); // a fresh session before the upload
      const body = new FormData();
      body.append('file', file);
      const res = await fetch(`${API_URL}/v1/admin/reconciliation/upload`, { method: 'POST', headers: authHeader(), body });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new ApiError(res.status, String(data.code ?? 'error'), String(data.message ?? `The upload failed (${res.status}).`), data);
      setResults(data as unknown as ReconImportResult[]);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'reconciliation'] });
    });

  return (
    <Card title="Upload a report">
      <p className="muted" style={{ marginTop: -6 }}>
        Google Play's earnings report (the .csv, or the .zip it comes in from Cloud Storage), the App Store's financial report (the .txt, or the .zip or .gz it comes in), or Razorpay's
        settlement report saved as CSV, if the nightly fetch missed something. Uploading the same report twice changes nothing.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <input
          ref={input}
          type="file"
          accept=".csv,.zip,.txt,.gz,.tsv"
          aria-label="Report file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file).finally(() => input.current && (input.current.value = ''));
          }}
          disabled={action.busy}
        />
        {action.busy ? <span className="muted">Reading the report…</span> : null}
      </div>
      <ErrorNote error={action.error} />
      {results.map((result) => (
        <p key={`${result.label}-${result.id}`} className={`notice ${Object.keys(result.counts).some((s) => ['unbooked', 'differs'].includes(s)) ? 'red' : 'green'}`} style={{ marginTop: 12 }}>
          {summarise(result, 'uploaded')}
        </p>
      ))}
    </Card>
  );
}

function AttentionRow({ line }: { line: ReconAttention }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [label, tone] = STATUS[line.status];

  return (
    <tr>
      <td>
        <Badge tone={tone}>{label}</Badge>
        <div className="mono small recon-ref" style={{ marginTop: 6 }}>
          {refLabel(line)}
        </div>
        <div className="small muted">
          {SHORT[line.channel]} · {line.report}
          {line.settlementRef ? ` · ${line.settlementRef}` : ''}
        </div>
      </td>
      <td style={{ minWidth: 260 }}>{line.note}</td>
      <td className="num recon-amount">{line.amountInrPaise === null ? '—' : rupees(line.amountInrPaise)}</td>
      <td>
        {line.status === 'needs_rate' ? (
          <span className="small muted">Enter the rate under Reports</span>
        ) : open ? (
          <div className="stack" style={{ gap: 6, minWidth: 240 }}>
            <textarea aria-label="What you found" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What it was, or what you did about it" autoFocus />
            <div className="row">
              <Button
                busy={action.busy}
                disabled={text.trim().length < 3}
                onClick={() =>
                  void action.run(async () => {
                    await api(`/v1/admin/reconciliation/lines/${line.id}/explain`, { method: 'POST', body: { explanation: text.trim() } });
                    await queryClient.invalidateQueries({ queryKey: ['admin', 'reconciliation'] });
                  })
                }
              >
                Save
              </Button>
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            <ErrorNote error={action.error} />
          </div>
        ) : (
          <Button variant="quiet" onClick={() => setOpen(true)}>
            Explain
          </Button>
        )}
      </td>
    </tr>
  );
}

function ImportRow({ item }: { item: ReconImport }) {
  const [showing, setShowing] = useState(false);
  const source = item.source === 'api' ? 'Fetched from Razorpay' : item.fileName ? `Uploaded: ${item.fileName}` : 'Uploaded';
  return (
    <>
      <tr>
        <td>
          {item.label}
          <div className="small muted">
            {source} · {day(item.at)}
          </div>
          {item.needsRates.length ? <Rates item={item} /> : null}
        </td>
        <td className="num">{count(item.lines)}</td>
        <td className="num">{count(item.corrected)}</td>
        <td className="num">{item.open ? <Badge tone="amber">{count(item.open)}</Badge> : '0'}</td>
        <td className="num">{rupees(item.inrPaise)}</td>
        <td>
          <Button variant="quiet" onClick={() => setShowing(!showing)} aria-expanded={showing}>
            {showing ? 'Hide lines' : 'Lines'}
          </Button>
        </td>
      </tr>
      {showing ? (
        <tr className="recon-lines">
          <td colSpan={6}>
            <Lines id={item.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** App Store proceeds in dollars (or any currency but rupees) wait for the rate Apple paid them at. */
function Rates({ item }: { item: ReconImport }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [rates, setRates] = useState<Record<string, string>>(Object.fromEntries(item.needsRates.map((currency) => [currency, item.rates[currency] ?? ''])));
  return (
    <div className="recon-rates">
      <p className="small">
        Apple paid part of this in {item.needsRates.join(' and ')}. From that month's payment in App Store Connect (Payments and Financial Reports), enter the rupees
        Apple paid for one unit of each:
      </p>
      <div className="row">
        {item.needsRates.map((currency) => (
          <Field key={currency} label={`₹ for 1 ${currency}`}>
            <input inputMode="decimal" value={rates[currency] ?? ''} onChange={(e) => setRates({ ...rates, [currency]: e.target.value.trim() })} placeholder="84.12" style={{ width: 110 }} />
          </Field>
        ))}
        <Button
          variant="secondary"
          busy={action.busy}
          disabled={item.needsRates.some((currency) => !/^\d+(\.\d+)?$/.test(rates[currency] ?? ''))}
          onClick={() =>
            void action.run(async () => {
              await api(`/v1/admin/reconciliation/imports/${item.id}/rates`, { method: 'POST', body: { rates } });
              await queryClient.invalidateQueries({ queryKey: ['admin', 'reconciliation'] });
            })
          }
        >
          Check them
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </div>
  );
}

function Lines({ id }: { id: string }) {
  const query = useQuery({ queryKey: ['admin', 'reconciliation', 'import', id], queryFn: () => api<{ lines: ReconLine[] }>(`/v1/admin/reconciliation/imports/${id}`) });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return (
    <div className="table-wrap flat recon-line-table recon-table">
      <table>
        <thead>
          <tr>
            <th>Line</th>
            <th>Outcome</th>
            <th className="num">Paid out</th>
          </tr>
        </thead>
        <tbody>
          {query.data.lines.map((line) => (
            <tr key={line.id}>
              <td>
                <span className="mono small recon-ref">{refLabel(line)}</span>
                <div className="small muted">
                  {line.kind === 'sale' ? (line.quantity > 1 ? `${line.quantity} sales` : 'Sale') : line.kind === 'refund' ? 'Refund' : 'Other'}
                </div>
              </td>
              <td>
                <Badge tone={STATUS[line.status][1]}>{STATUS[line.status][0]}</Badge>
                {line.note ? <div className="small" style={{ marginTop: 4 }}>{line.note}</div> : null}
                {line.explanation ? <div className="small muted">Finance: {line.explanation}</div> : null}
              </td>
              <td className="num recon-amount">{line.amountInrPaise === null ? '—' : rupees(line.amountInrPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
