import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { day, monthName, rupees, toCsv } from '../../lib/format';
import type { PayoutStatement, PayoutSummary } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

const lastMonth = () => {
  const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const tone = { open: 'amber', closed: 'neutral', paid: 'green' } as const;

export function Payouts() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const selected = params.get('month');
  const [month, setMonth] = useState(lastMonth);
  const action = useAction();
  const list = useQuery({ queryKey: ['admin', 'payouts'], queryFn: () => api<PayoutSummary[]>('/v1/admin/payouts') });

  const prepare = (target: string) =>
    action.run(async () => {
      await api(`/v1/admin/payouts/${target}/prepare`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'payout', target] });
      setParams({ month: target });
    });

  return (
    <div className="stack">
      <PageHeader
        title="Payouts"
        lead="Once a month ends, prepare its statement. It holds every instructor share that's past the refund window and not yet paid, plus any adjustments. Balances under the minimum roll over to next month. Check it, close it, pay each line by bank transfer, then record the reference."
      />
      <Card title="Prepare a statement">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void prepare(month);
          }}
        >
          <Field label="Month">
            <input type="month" value={month} max={lastMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ maxWidth: 220 }} />
          </Field>
          <Button type="submit" busy={action.busy}>
            Prepare
          </Button>
          <ErrorNote error={action.error} />
        </form>
      </Card>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorNote error={list.error} />
      ) : list.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>Status</th>
                <th className="num">Instructors</th>
                <th className="num">To pay</th>
                <th className="num">Paid</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.month} className="clickable" onClick={() => setParams({ month: s.month })}>
                  <td>{monthName(s.month)}</td>
                  <td>
                    <Badge tone={tone[s.status]}>{s.status}</Badge>
                  </td>
                  <td className="num">{s.lines}</td>
                  <td className="num">{rupees(s.netPaise)}</td>
                  <td className="num">
                    {s.paidLines} of {s.lines}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No statements yet. The first one can be prepared once a month with sales has ended.</Empty>
      )}
      {selected ? <Statement month={selected} onRebuild={() => void prepare(selected)} /> : null}
    </div>
  );
}

function Statement({ month, onRebuild }: { month: string; onRebuild: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'payout', month], queryFn: () => api<PayoutStatement>(`/v1/admin/payouts/${month}`) });
  const action = useAction();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const statement = query.data;

  const download = () => {
    const csv = toCsv([
      ['Instructor', 'Email', 'GSTIN', 'Payable (INR)', 'TDS (INR)', 'Net (INR)', 'Paid on', 'Bank reference'],
      ...statement.lines.map((l) => [l.instructor.displayName, l.instructor.email, l.instructor.gstin, l.payablePaise / 100, l.tdsPaise / 100, l.netPaise / 100, l.paidAt ? day(l.paidAt) : null, l.bankReference]),
    ]);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `embodha-payouts-${month}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <Card
      title={`${monthName(month)} statement`}
      actions={
        <div className="row">
          <Badge tone={tone[statement.status]}>{statement.status}</Badge>
          {statement.lines.length ? (
            <Button variant="secondary" onClick={download}>
              Download CSV
            </Button>
          ) : null}
          {statement.status === 'open' ? (
            <>
              <Button variant="secondary" onClick={onRebuild}>
                Rebuild
              </Button>
              <Button
                busy={action.busy}
                onClick={() =>
                  window.confirm('Close this statement? The amounts are fixed from here; later corrections go on next month as adjustments.') &&
                  void action.run(async () => {
                    await api(`/v1/admin/payouts/${month}/close`, { method: 'POST' });
                    await refresh();
                  })
                }
              >
                Close statement
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      <ErrorNote error={action.error} />
      {statement.lines.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instructor</th>
                <th className="num">Payable</th>
                <th className="num">TDS</th>
                <th className="num">To transfer</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map((line) => (
                <Line key={line.id} line={line} canPay={statement.status !== 'open'} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nobody is owed anything for this month yet: no shares past the refund window, or every balance is under the minimum.</Empty>
      )}
    </Card>
  );
}

function Line({ line, canPay }: { line: PayoutStatement['lines'][number]; canPay: boolean }) {
  const queryClient = useQueryClient();
  const [reference, setReference] = useState('');
  const action = useAction();
  return (
    <tr>
      <td>
        {line.instructor.displayName}
        <div className="small muted">
          {line.instructor.email}
          {line.instructor.gstin ? ` · GSTIN ${line.instructor.gstin}` : ''}
        </div>
      </td>
      <td className="num">{rupees(line.payablePaise)}</td>
      <td className="num">{rupees(line.tdsPaise)}</td>
      <td className="num">
        <strong>{rupees(line.netPaise)}</strong>
      </td>
      <td>
        {line.paidAt ? (
          <span>
            {day(line.paidAt)} <span className="small muted">· {line.bankReference}</span>
          </span>
        ) : canPay ? (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input aria-label={`Bank reference for ${line.instructor.displayName}`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or reference" style={{ width: 170 }} />
            <Button
              variant="secondary"
              busy={action.busy}
              disabled={reference.trim().length < 2}
              onClick={() =>
                void action.run(async () => {
                  await api(`/v1/admin/payout-lines/${line.id}/paid`, { method: 'POST', body: { bankReference: reference.trim() } });
                  await queryClient.invalidateQueries({ queryKey: ['admin'] });
                })
              }
            >
              Mark paid
            </Button>
          </div>
        ) : (
          <span className="small muted">Close the statement to pay</span>
        )}
        <ErrorNote error={action.error} />
      </td>
    </tr>
  );
}
