import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { day } from '../../lib/format';
import type { AdminReview } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader } from '../../ui/kit';

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

export function Reviews() {
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const query = useQuery({
    queryKey: ['admin', 'reviews', hiddenOnly],
    queryFn: () => api<AdminReview[]>(`/v1/admin/reviews${hiddenOnly ? '?status=hidden' : ''}`),
  });

  return (
    <div className="stack">
      <PageHeader
        title="Reviews"
        lead="Reviews come only from members who've played the course; nobody can post one on a member's behalf. Hide anything abusive or off-topic: hidden reviews stop counting towards the stars. A reply appears under the review, signed Embodha."
      />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={!hiddenOnly} className={`tab${hiddenOnly ? '' : ' on'}`} onClick={() => setHiddenOnly(false)}>
          All
        </button>
        <button role="tab" aria-selected={hiddenOnly} className={`tab${hiddenOnly ? ' on' : ''}`} onClick={() => setHiddenOnly(true)}>
          Hidden
        </button>
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
                <th>Rating</th>
                <th>Review</th>
                <th>Written</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((review) => (
                <Row key={review.id} review={review} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{hiddenOnly ? 'No hidden reviews.' : 'No reviews yet.'}</Empty>
      )}
    </div>
  );
}

function Row({ review }: { review: AdminReview }) {
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState(review.teamReply ?? '');
  const action = useAction();
  const run = (method: string, path: string, body?: object) =>
    action.run(async () => {
      await api(`/v1/admin/reviews/${review.id}${path}`, { method, body });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'reviews'] });
    });
  const hidden = review.status === 'hidden';

  return (
    <tr>
      <td style={{ color: 'var(--maroon)', whiteSpace: 'nowrap' }}>{stars(review.rating)}</td>
      <td>
        {review.body ? <p>{review.body}</p> : <span className="muted">No text, just stars.</span>}
        <div className="small muted">
          {review.member.name ?? review.member.email} ({review.member.email}) on {review.course.title} {hidden ? <Badge tone="red">hidden</Badge> : null}
        </div>
        {review.teamReply && !replying ? <p className="small" style={{ marginTop: 6 }}>Embodha replied: “{review.teamReply}”</p> : null}
        {replying ? (
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Thank them, answer a question, or point to a better course." maxLength={2000} autoFocus />
            <div className="row">
              <Button variant="secondary" busy={action.busy} onClick={() => void run('PUT', '/reply', { reply }).then((ok) => ok && setReplying(false))}>
                {reply.trim() ? 'Post reply' : 'Remove reply'}
              </Button>
              <Button variant="quiet" onClick={() => setReplying(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <ErrorNote error={action.error} />
      </td>
      <td className="muted">{day(review.createdAt)}</td>
      <td>
        <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
          {!replying ? (
            <Button variant="quiet" onClick={() => setReplying(true)}>
              {review.teamReply ? 'Edit reply' : 'Reply'}
            </Button>
          ) : null}
          <Button variant="secondary" busy={action.busy} onClick={() => void run('PATCH', '', { status: hidden ? 'visible' : 'hidden' })}>
            {hidden ? 'Show' : 'Hide'}
          </Button>
          <Button variant="danger" busy={action.busy} onClick={() => window.confirm('Delete this review for good? Hiding it keeps a record.') && void run('DELETE', '')}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}
