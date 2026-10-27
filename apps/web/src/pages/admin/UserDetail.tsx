import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, day } from '../../lib/format';
import type { AdminCourse, MemberDetail } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader, Stat } from '../../ui/kit';
import { statusBadge } from './Users';

export function UserDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api<MemberDetail>(`/v1/admin/users/${id}`) });
  const live = useQuery({ queryKey: ['admin', 'courses', 'published'], queryFn: () => api<AdminCourse[]>('/v1/admin/courses?status=published') });
  const [courseId, setCourseId] = useState('');
  const action = useAction();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });
  const run = (method: string, path: string, body?: object) =>
    action.run(async () => {
      await api(`/v1/admin/users/${id}${path}`, { method, body });
      await refresh();
    });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { user, courses, minutesWatched, lastSignedIn } = query.data;
  const owned = new Set(courses.map((c) => c.courseId));
  const giftable = (live.data ?? []).filter((c) => !c.isFree && !owned.has(c.id));
  const self = me?.id === user.id;

  return (
    <div className="stack">
      <p className="small">
        <Link to="/admin/users">← Members</Link>
      </p>
      <PageHeader
        title={user.name ?? user.email}
        lead={
          <>
            {user.email} · {statusBadge(user.status)}
          </>
        }
        actions={
          self || user.status === 'deleting' || user.status === 'erased' ? null : (
            <>
              {user.status === 'active' ? (
                <Button
                  variant="secondary"
                  busy={action.busy}
                  onClick={() => window.confirm(`Suspend ${user.email}? They're signed out everywhere and can't sign back in until restored.`) && void run('PATCH', '', { status: 'suspended' })}
                >
                  Suspend
                </Button>
              ) : (
                <Button variant="secondary" busy={action.busy} onClick={() => void run('PATCH', '', { status: 'active' })}>
                  Restore
                </Button>
              )}
              <Button
                variant="danger"
                busy={action.busy}
                onClick={() =>
                  window.confirm(`Delete ${user.email}? They're signed out now and their data is erased after 30 days. Signing in before then cancels it.`) &&
                  void run('DELETE', '')
                }
              >
                Delete account
              </Button>
            </>
          )
        }
      />
      <ErrorNote error={action.error} />
      <div className="stats">
        <Stat label="Joined" value={day(user.createdAt)} />
        <Stat label="Last signed in" value={day(lastSignedIn)} />
        <Stat label="Minutes watched" value={count(minutesWatched)} />
        <Stat label="Country" value={user.country ?? '—'} note={[user.state, user.birthYear ? `born ${user.birthYear}` : null].filter(Boolean).join(' · ') || undefined} />
      </div>
      <Card title="Courses in their library">
        {courses.length ? (
          <div className="table-wrap">
            <table>
              <tbody>
                {courses.map((course) => (
                  <tr key={course.courseId}>
                    <td>{course.title}</td>
                    <td>{course.source === 'grant' ? <Badge tone="maroon">added by Embodha</Badge> : <Badge tone="green">bought</Badge>}</td>
                    <td className="muted">{day(course.since)}</td>
                    <td>
                      {course.source === 'grant' ? (
                        <Button variant="quiet" busy={action.busy} onClick={() => void run('DELETE', `/grants/${course.courseId}`)}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing bought or added yet. The free course doesn't need adding.</Empty>
        )}
        {user.status !== 'deleting' && user.status !== 'erased' ? (
          <form
            className="inline-form"
            style={{ marginTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              void run('POST', '/grants', { courseId }).then((ok) => ok && setCourseId(''));
            }}
          >
            <Field label="Add a course to their library" hint="For a prize, a refund-in-kind or a team member. It shows up in their app straight away.">
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">Choose a live course…</option>
                {giftable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.instructor.displayName})
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="secondary" busy={action.busy} disabled={!courseId}>
              Add course
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
