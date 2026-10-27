import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, API_URL, authHeader } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, day, percent, rupees } from '../../lib/format';
import type { AdminPayment } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, Stat } from '../../ui/kit';

const splitState: Record<string, string> = { pending: 'in refund window', payable: 'on a statement', paid: 'paid out', reversed: 'reversed' };
/** Where a share not yet on a statement stands: a website sale's refund window, or a store's report it waits for. */
function pendingFor(split: NonNullable<AdminPayment['split']>) {
  if (!split.payableFrom) return "until the store's report";
  return new Date(split.payableFrom).getTime() > Date.now() ? splitState.pending : 'for the next statement';
}
const channelName: Record<AdminPayment['channel'], string> = { razorpay: 'Razorpay', apple: 'App Store', google: 'Google Play' };

export function Payments() {
  const query = useQuery({ queryKey: ['admin', 'payments'], queryFn: () => api<AdminPayment[]>('/v1/admin/payments') });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const live = query.data.filter((p) => p.status === 'captured' && !p.test);
  const total = (pick: (p: AdminPayment) => number) => live.reduce((sum, p) => sum + pick(p), 0);

  return (
    <div className="stack">
      <PageHeader
        title="Payments"
        lead="Every sale, newest first. Net is what's left after GST and the fee, in rupees: Razorpay's own fee on website sales (dollar sales at the rate Razorpay converted them at), and an estimated 15% commission on sales in the apps until the store's monthly report gives the real proceeds (see Reconciliation). A refund returns the full amount, takes the course out of the member's library, reverses the instructor's share, and emails the member a credit note. App Store and Google Play refunds happen in those stores and show up here on their own."
      />
      <div className="stats">
        <Stat label="Sales (last 200)" value={count(live.length)} />
        <Stat label="Net, in rupees" value={rupees(total((p) => p.netInrPaise))} />
        <Stat label="Instructors' shares" value={rupees(total((p) => p.split?.instructorPaise ?? 0))} />
        <Stat label="Embodha's share" value={rupees(total((p) => p.split?.embodhaPaise ?? 0))} />
      </div>
      {query.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Course</th>
                <th>Member</th>
                <th className="num">Paid</th>
                <th className="num">Net</th>
                <th className="num">Instructor</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((payment) => (
                <Row key={payment.id} payment={payment} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No sales yet.</Empty>
      )}
    </div>
  );
}

function Row({ payment }: { payment: AdminPayment }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  const refundable = payment.status === 'captured' && payment.channel === 'razorpay' && can('finance');

  return (
    <tr>
      <td>
        {day(payment.at)}
        <div className="small muted" style={{ whiteSpace: 'nowrap' }}>
          {payment.invoiceNo ?? channelName[payment.channel]}
        </div>
        {payment.placeOfSupply ? (
          <div className="small muted">
            {payment.placeOfSupply}
            {payment.tax ? `, ${payment.tax}` : ''}
          </div>
        ) : null}
      </td>
      <td>
        {payment.course}
        <div className="small muted">{payment.instructor}</div>
      </td>
      <td>{payment.member}</td>
      <td className="num">{payment.gross.display}</td>
      <td className="num">
        {rupees(payment.netInrPaise)}
        {!payment.test ? (
          <div className="small muted">{payment.reconciledAt ? 'matches the report' : payment.feeSource === 'estimate' ? 'fee estimated' : 'not reported yet'}</div>
        ) : null}
      </td>
      <td className="num">
        {payment.split ? rupees(payment.split.instructorPaise) : '—'}
        {payment.split ? (
          <div className="small muted">
            {percent(payment.split.percentBps)} · {payment.split.state === 'pending' ? pendingFor(payment.split) : splitState[payment.split.state]}
          </div>
        ) : null}
      </td>
      <td>
        {payment.status !== 'captured' ? (
          <Badge tone="red">{payment.status.replace('_', ' ')}</Badge>
        ) : payment.test ? (
          <Badge>test, no money</Badge>
        ) : (
          <Badge tone="green">paid</Badge>
        )}
      </td>
      <td>
        {payment.invoiceNo ? (
          <Button variant="quiet" onClick={() => void openDocument(payment.id, 'invoice')}>
            Invoice
          </Button>
        ) : null}
        {payment.creditNoteNo ? (
          <Button variant="quiet" onClick={() => void openDocument(payment.id, 'credit-note')}>
            Credit note
          </Button>
        ) : null}
        {refundable && !refunding ? (
          <Button variant="quiet" onClick={() => setRefunding(true)}>
            Refund
          </Button>
        ) : null}
        {refunding ? (
          <div className="stack" style={{ gap: 6, minWidth: 220 }}>
            <input aria-label="Reason for the refund" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? The member doesn't see this." autoFocus />
            <p className="small muted">They get a credit note by email, and the money in 5 to 7 working days.</p>
            <div className="row">
              <Button
                variant="danger"
                busy={action.busy}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void action
                    .run(async () => {
                      await api(`/v1/admin/payments/${payment.id}/refund`, { method: 'POST', body: { reason: reason.trim() } });
                      await queryClient.invalidateQueries({ queryKey: ['admin'] });
                    })
                    .then((ok) => ok && setRefunding(false))
                }
              >
                Refund {payment.gross.display}
              </Button>
              <Button variant="quiet" onClick={() => setRefunding(false)}>
                Cancel
              </Button>
            </div>
            <ErrorNote error={action.error} />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/** The PDFs need the session's token, so fetch the file and open it rather than linking to it. */
async function openDocument(paymentId: string, kind: 'invoice' | 'credit-note') {
  await api('/v1/me'); // refreshes the session first if it has expired
  const res = await fetch(`${API_URL}/v1/payments/${paymentId}/${kind}`, { headers: authHeader() });
  if (!res.ok) return window.alert(`Couldn't open that ${kind === 'invoice' ? 'invoice' : 'credit note'}.`);
  window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
}
