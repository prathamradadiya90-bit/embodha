import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, day, monthName } from '../../lib/format';
import type { Launch, Overview as OverviewData } from '../../lib/types';
import { Badge, Card, Empty, ErrorNote, Loading, PageHeader, Stat } from '../../ui/kit';

export function Overview() {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<OverviewData>('/v1/admin/overview') });
  // Shared with the Launch checklist page, so going there from here is instant.
  const launch = useQuery({ queryKey: ['admin', 'launch'], queryFn: () => api<Launch>('/v1/admin/launch') });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { members, instructors, courses, thisMonth, reviewQueue } = query.data;

  return (
    <div className="stack">
      <PageHeader title="Overview" lead={`${monthName(thisMonth.month)} so far, on Indian time.`} />
      {launch.data && !launch.data.ready ? (
        <p className="notice">
          {count(launch.data.left)} {launch.data.left === 1 ? 'thing' : 'things'} to go before launch. <Link to="/admin/launch?show=left">See what's left</Link>
        </p>
      ) : null}
      <div className="stats">
        <Stat label="Accounts" value={count(members.total)} note={`${count(members.last7Days)} new this week`} />
        <Stat label="Minutes watched" value={count(thisMonth.minutes)} note={`by ${count(thisMonth.members)} ${thisMonth.members === 1 ? 'member' : 'members'} this month`} />
        <Stat label="Breathing sessions" value={count(thisMonth.breathingSessions)} note="this month" />
        <Stat label="Live courses" value={courses.published} note={`${courses.draft} drafts in the studio`} />
        <Stat label="Instructors" value={instructors.approved} note={instructors.applied ? `${instructors.applied} waiting` : 'approved'} />
      </div>
      <Card title={`Waiting for review (${courses.inReview})`} actions={can('content') ? <Link to="/admin/courses">Review courses</Link> : null}>
        {reviewQueue.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Instructor</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.title} {row.kind === 'changes' ? <Badge tone="amber">Changes</Badge> : null}
                    </td>
                    <td>{row.instructor}</td>
                    <td className="muted">{day(row.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing waiting. New courses and changes to live ones appear here when an instructor sends them for review.</Empty>
        )}
      </Card>
    </div>
  );
}
