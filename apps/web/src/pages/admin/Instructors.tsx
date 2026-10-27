import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, percent } from '../../lib/format';
import type { AdminInstructor } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

const toBps = (text: string) => Math.round(Number(text) * 100);
const validPercent = (text: string) => text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 && Number(text) <= 100;

export function Instructors() {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['admin', 'instructors'], queryFn: () => api<AdminInstructor[]>('/v1/admin/instructors') });

  return (
    <div className="stack">
      <PageHeader
        title="Instructors"
        lead="An instructor's share applies to the net of each sale: what's left after GST and the store or payment fee. A new share counts from now on; earlier sales keep theirs."
      />
      {can('content') ? <AddInstructor /> : null}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : query.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instructor</th>
                <th>Status</th>
                <th>Share</th>
                <th>TDS</th>
                <th>Subscription</th>
                <th className="num">Courses live</th>
                <th className="num">Minutes this month</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((instructor) => (
                <Row key={instructor.id} instructor={instructor} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No instructors yet.</Empty>
      )}
    </div>
  );
}

function AddInstructor() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ email: '', displayName: '', share: '60' });
  const action = useAction();
  const add = () =>
    action
      .run(async () => {
        await api('/v1/admin/instructors', {
          method: 'POST',
          body: { email: form.email.trim(), displayName: form.displayName.trim(), percentBps: toBps(form.share) },
        });
        await queryClient.invalidateQueries({ queryKey: ['admin', 'instructors'] });
      })
      .then((ok) => ok && setForm({ email: '', displayName: '', share: form.share }));

  return (
    <Card title="Add an instructor">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Field label="Email they sign in with">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </Field>
        <Field label="Name members see">
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required minLength={2} />
        </Field>
        <Field label="Share %">
          <input inputMode="decimal" value={form.share} onChange={(e) => setForm({ ...form, share: e.target.value })} style={{ maxWidth: 100 }} />
        </Field>
        <Button type="submit" busy={action.busy} disabled={!validPercent(form.share)}>
          Add
        </Button>
      </form>
      <p className="small muted" style={{ marginTop: 10 }}>
        They can sign in to the studio straight away with that email. Nothing is sent to them yet, so let them know.
      </p>
      <ErrorNote error={action.error} />
    </Card>
  );
}

function Row({ instructor }: { instructor: AdminInstructor }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [share, setShare] = useState(instructor.sharePercentBps === null ? '' : String(instructor.sharePercentBps / 100));
  const action = useAction();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'instructors'] });
  const changed = validPercent(share) && toBps(share) !== instructor.sharePercentBps;
  const house = instructor.email === null;

  return (
    <tr>
      <td>
        <strong>{instructor.displayName}</strong>
        <div className="small muted">{house ? 'Embodha’s own courses' : instructor.email}</div>
        <ErrorNote error={action.error} />
      </td>
      <td>
        <Badge tone={instructor.status === 'approved' ? 'green' : instructor.status === 'suspended' ? 'red' : 'amber'}>{instructor.status}</Badge>
      </td>
      <td>
        {can('finance') ? (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input aria-label={`${instructor.displayName}'s share in percent`} inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} style={{ width: 72 }} />
            <span>%</span>
            {changed ? (
              <Button
                variant="secondary"
                busy={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api(`/v1/admin/instructors/${instructor.id}/share`, { method: 'POST', body: { percentBps: toBps(share) } });
                    await refresh();
                  })
                }
              >
                Save
              </Button>
            ) : null}
          </div>
        ) : (
          percent(instructor.sharePercentBps)
        )}
      </td>
      <td>{can('finance') && !house ? <Tds instructor={instructor} /> : percent(instructor.tdsRateBps)}</td>
      <td>{instructor.plan.enabled ? `On · ${instructor.plan.price ?? 'no price'}` : <span className="muted">Off</span>}</td>
      <td className="num">
        {instructor.courses.published} of {instructor.courses.total}
      </td>
      <td className="num">{count(instructor.minutesThisMonth)}</td>
      <td>
        {can('content') && !house ? (
          <Button
            variant={instructor.status === 'approved' ? 'quiet' : 'secondary'}
            busy={action.busy}
            onClick={() => {
              const status = instructor.status === 'approved' ? 'suspended' : 'approved';
              if (status === 'suspended' && !window.confirm(`Suspend ${instructor.displayName}? They lose the studio; their live courses stay up.`)) return;
              void action.run(async () => {
                await api(`/v1/admin/instructors/${instructor.id}`, { method: 'PATCH', body: { status } });
                await refresh();
              });
            }}
          >
            {instructor.status === 'approved' ? 'Suspend' : 'Approve'}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

/** Tax deducted at source from this instructor's payouts. It applies to statements prepared from now on. */
function Tds({ instructor }: { instructor: AdminInstructor }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(instructor.tdsRateBps / 100));
  const action = useAction();
  const changed = validPercent(value) && Number(value) <= 30 && toBps(value) !== instructor.tdsRateBps;
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input aria-label={`${instructor.displayName}'s TDS in percent`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 64 }} />
      <span>%</span>
      {changed ? (
        <Button
          variant="secondary"
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api(`/v1/admin/instructors/${instructor.id}/tds`, { method: 'PUT', body: { tdsRateBps: toBps(value) } });
              await queryClient.invalidateQueries({ queryKey: ['admin', 'instructors'] });
            })
          }
        >
          Save
        </Button>
      ) : null}
      <ErrorNote error={action.error} />
    </div>
  );
}
