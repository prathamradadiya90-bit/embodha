import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { count, monthName, percent, toCsv } from '../../lib/format';
import type { WatchReport } from '../../lib/types';
import { Button, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);

export function Reports() {
  const [month, setMonth] = useState(thisMonth);
  const query = useQuery({ queryKey: ['admin', 'report', month], queryFn: () => api<WatchReport>(`/v1/admin/reports/watch?month=${month}`) });

  const download = (report: WatchReport) => {
    const csv = toCsv([
      ['Instructor', 'Minutes watched', 'Members', 'Share at month end'],
      ...report.rows.map((row) => [row.instructor.displayName, row.minutes, row.members, percent(row.sharePercentBps)]),
      ['Total', report.totals.minutes, report.totals.members, null],
    ]);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `embodha-watch-time-${report.month}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="stack">
      <PageHeader
        title="Watch time"
        lead="Minutes members spent in each instructor's courses, counted from actual playback, not from seeking. Sales and payouts join this page when payments go live."
        actions={query.data?.rows.length ? <Button variant="secondary" onClick={() => download(query.data)}>Download CSV</Button> : null}
      />
      <Field label="Month">
        <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ maxWidth: 220 }} />
      </Field>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : query.data.rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instructor</th>
                <th className="num">Minutes</th>
                <th className="num">Members</th>
                <th className="num">Share at month end</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row) => (
                <tr key={row.instructor.id}>
                  <td>{row.instructor.displayName}</td>
                  <td className="num">{count(row.minutes)}</td>
                  <td className="num">{count(row.members)}</td>
                  <td className="num">{percent(row.sharePercentBps)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>All instructors</strong>
                </td>
                <td className="num">
                  <strong>{count(query.data.totals.minutes)}</strong>
                </td>
                <td className="num">
                  <strong>{count(query.data.totals.members)}</strong>
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No one watched anything in {monthName(month)}.</Empty>
      )}
    </div>
  );
}
