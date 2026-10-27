import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { count, day } from '../../lib/format';
import type { Member, MemberRow } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

interface Page {
  items: MemberRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const statusBadge = (status: Member['status']) => (
  <Badge tone={status === 'active' ? 'green' : status === 'suspended' ? 'red' : 'neutral'}>{status === 'deleting' ? 'being deleted' : status === 'erased' ? 'erased, payments kept' : status}</Badge>
);

export function Users() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;
  const [search, setSearch] = useState(q);

  // Search as you type, a moment after the last keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== q) setParams(search ? { q: search } : {});
    }, 300);
    return () => clearTimeout(timer);
  }, [search, q, setParams]);

  const query = useQuery({
    queryKey: ['admin', 'users', q, page],
    queryFn: () => api<Page>(`/v1/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page) })}`),
  });

  return (
    <div className="stack">
      <PageHeader title="Members" lead="Everyone with an account: members, instructors and staff." />
      <AddMember />
      <Field label="Search by email or name">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. meera or @gmail.com" />
      </Field>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : query.data.items.length ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Joined</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((user) => (
                  <tr key={user.id} className="clickable" onClick={() => navigate(`/admin/users/${user.id}`)}>
                    <td>
                      {user.email} {user.instructor ? <Badge tone="maroon">instructor</Badge> : null}{' '}
                      {user.staff.length ? <Badge>{user.staff.join(', ').replace('_', ' ')}</Badge> : null}
                    </td>
                    <td>{user.name ?? <span className="muted">—</span>}</td>
                    <td>{user.country ?? <span className="muted">—</span>}</td>
                    <td className="muted">{day(user.createdAt)}</td>
                    <td>{statusBadge(user.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <span className="small muted">
              {count(query.data.total)} {query.data.total === 1 ? 'account' : 'accounts'}
            </span>
            {page > 1 ? (
              <Button variant="secondary" onClick={() => setParams({ ...(q ? { q } : {}), page: String(page - 1) })}>
                Previous
              </Button>
            ) : null}
            {page * query.data.pageSize < query.data.total ? (
              <Button variant="secondary" onClick={() => setParams({ ...(q ? { q } : {}), page: String(page + 1) })}>
                Next
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <Empty>{q ? `No one matches “${q}”.` : 'No accounts yet.'}</Empty>
      )}
    </div>
  );
}

function AddMember() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const action = useAction();
  return (
    <Card title="Add a member">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const user = await api<Member>('/v1/admin/users', { method: 'POST', body: { email: email.trim(), name: name.trim() || undefined } });
            await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
            navigate(`/admin/users/${user.id}`);
          });
        }}
      >
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="secondary" busy={action.busy}>
          Add
        </Button>
      </form>
      <p className="small muted" style={{ marginTop: 10 }}>
        For adding a course to someone's library before they've signed in. They sign in with this email as usual.
      </p>
      <ErrorNote error={action.error} />
    </Card>
  );
}
