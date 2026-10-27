import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { day } from '../../lib/format';
import type { AdminCourse, CourseChanges, CourseStatus } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, CourseStatusBadge, Empty, ErrorNote, Loading, PageHeader } from '../../ui/kit';

const filters: [CourseStatus | '', string][] = [
  ['', 'All'],
  ['in_review', 'In review'],
  ['published', 'Live'],
  ['draft', 'Drafts'],
  ['archived', 'Archived'],
];

export function AdminCourses() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as CourseStatus | '';
  const query = useQuery({
    queryKey: ['admin', 'courses', status],
    queryFn: () => api<AdminCourse[]>(`/v1/admin/courses${status ? `?status=${status}` : ''}`),
  });

  return (
    <div className="stack">
      <PageHeader
        title="Courses"
        lead="Publish what instructors send in, or send it back with a note they'll see in the studio. One live course is the free one everyone gets."
      />
      <div className="tabs" role="tablist">
        {filters.map(([value, label]) => (
          <button key={label} role="tab" aria-selected={status === value} className={`tab${status === value ? ' on' : ''}`} onClick={() => setParams(value ? { status: value } : {})}>
            {label}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : query.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Course</th>
                <th>Status</th>
                <th>Price</th>
                <th className="num">Videos ready</th>
                <th>Changed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((course) => (
                <CourseRow key={course.id} course={course} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No courses here.</Empty>
      )}
    </div>
  );
}

function CourseRow({ course }: { course: AdminCourse }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const action = useAction();
  const post = (path: string, body?: object) =>
    action.run(async () => {
      await api(`/v1/admin/courses/${course.id}/${path}`, { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    });
  const missing = action.error instanceof ApiError && Array.isArray(action.error.body.chapters) ? (action.error.body.chapters as string[]) : [];
  const allReady = course.chapters > 0 && course.readyChapters === course.chapters;

  return (
    <tr>
      <td>
        <strong>{course.title}</strong>
        <div className="small muted">
          {course.instructor.displayName} · {course.topic}
        </div>
        {course.review?.decision === 'rejected' && course.status === 'draft' ? <div className="small muted">Sent back: “{course.review.comments}”</div> : null}
        {course.changesWaitingSince ? <ChangesReview course={course} /> : null}
        {returning ? (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the instructor change?" autoFocus />
            <div className="row">
              <Button variant="secondary" busy={action.busy} disabled={!note.trim()} onClick={() => void post('review', { decision: 'return', comments: note.trim() })}>
                Send back
              </Button>
              <Button variant="quiet" onClick={() => setReturning(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <ErrorNote error={action.error} />
        {missing.length ? <div className="small muted">Missing video: {missing.join(', ')}</div> : null}
      </td>
      <td>
        <CourseStatusBadge status={course.status} /> {course.isFree ? <Badge tone="maroon">Free course</Badge> : null}
      </td>
      <td>{course.isFree ? '—' : (course.price ?? <span className="muted">No price</span>)}</td>
      <td className="num">
        {course.readyChapters} of {course.chapters}
      </td>
      <td className="muted">{day(course.review?.submittedAt ?? course.updatedAt)}</td>
      <td>
        {can('content') ? (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {course.status === 'in_review' && !returning ? (
              <>
                <Button busy={action.busy} disabled={!allReady} title={allReady ? '' : 'Every chapter needs a finished video first'} onClick={() => void post('review', { decision: 'publish' })}>
                  Publish
                </Button>
                <Button variant="secondary" onClick={() => setReturning(true)}>
                  Send back
                </Button>
              </>
            ) : null}
            {course.status === 'published' && !course.isFree ? (
              <>
                <Button
                  variant="secondary"
                  busy={action.busy}
                  onClick={() => window.confirm(`Make “${course.title}” the free course? The current free course goes back to its price.`) && void post('free')}
                >
                  Make free
                </Button>
                <Button variant="quiet" busy={action.busy} onClick={() => window.confirm(`Archive “${course.title}”? It disappears from the app.`) && void post('archive')}>
                  Archive
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/** Changes an instructor made to a live course: what each thing was and would be, then approve or send back. */
function ChangesReview({ course }: { course: AdminCourse }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const action = useAction();
  const changes = useQuery({ queryKey: ['admin', 'changes', course.id], queryFn: () => api<CourseChanges>(`/v1/admin/courses/${course.id}/changes`), enabled: open });
  const decide = (body: object) =>
    void action.run(async () => {
      await api(`/v1/admin/courses/${course.id}/changes`, { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    });

  return (
    <div className="stack" style={{ gap: 8, marginTop: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <Badge tone="amber">Changes waiting</Badge>
        <span className="small muted">since {day(course.changesWaitingSince)}</span>
        <Button variant="quiet" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Review changes'}
        </Button>
      </div>
      {!open ? null : changes.isPending ? (
        <Loading />
      ) : changes.isError ? (
        <ErrorNote error={changes.error} />
      ) : (
        <>
          <ul className="change-list">
            {changes.data.items.map((item, i) => (
              <li key={i}>
                <strong>{item.what}</strong>
                {'before' in item ? (
                  <div className="small">
                    <span className="muted">Was:</span> {item.before ?? '(empty)'}
                  </div>
                ) : null}
                <div className="small" style={{ whiteSpace: 'pre-line' }}>
                  {'before' in item ? <span className="muted">Now: </span> : null}
                  {item.after ?? '(empty)'}
                </div>
              </li>
            ))}
          </ul>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="To send it back: what should the instructor change?" />
          <div className="row">
            <Button busy={action.busy} onClick={() => window.confirm(`Put these changes live on “${course.title}”? Members see them straight away.`) && decide({ decision: 'approve' })}>
              Approve and go live
            </Button>
            <Button variant="secondary" busy={action.busy} disabled={!note.trim()} onClick={() => decide({ decision: 'return', comments: note.trim() })}>
              Send back
            </Button>
          </div>
          <ErrorNote error={action.error} />
        </>
      )}
    </div>
  );
}
