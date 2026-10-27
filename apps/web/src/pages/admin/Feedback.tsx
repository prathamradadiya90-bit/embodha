import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { FeedbackItem, FeedbackList } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader } from '../../ui/kit';

const SYSTEM = { ios: 'iOS', android: 'Android' } as const;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** What members sent from You, Feedback in the app. Answer by email; mark a message handled once it's dealt with. */
export function Feedback() {
  const [all, setAll] = useState(false);
  const query = useQuery({ queryKey: ['admin', 'feedback', all], queryFn: () => api<FeedbackList>(`/v1/admin/feedback${all ? '?all=1' : ''}`) });

  return (
    <div className="stack">
      <PageHeader
        title="Feedback"
        lead="Messages members sent from You, Feedback in the app, with the phone and app version they were on. Reply by email; mark a message handled once it's dealt with, so the open list stays a to-do list."
      />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={!all} className={`tab${all ? '' : ' on'}`} onClick={() => setAll(false)}>
          Open{query.data ? ` (${query.data.open})` : ''}
        </button>
        <button role="tab" aria-selected={all} className={`tab${all ? ' on' : ''}`} onClick={() => setAll(true)}>
          All
        </button>
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : query.data.items.length ? (
        <div className="stack">
          {query.data.items.map((item) => (
            <Message key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <Empty>{all ? 'No feedback yet.' : 'Nothing open. Everything members sent has been dealt with.'}</Empty>
      )}
    </div>
  );
}

function Message({ item }: { item: FeedbackItem }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const handled = Boolean(item.handledAt);
  const mark = (next: boolean) =>
    action.run(async () => {
      await api(`/v1/admin/feedback/${item.id}/handled`, { method: 'POST', body: { handled: next } });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'feedback'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'beta'] });
    });
  const where =
    item.platform === 'web'
      ? `Web app ${item.appVersion ?? '?'}${item.device ? ` on ${item.device}` : ''}`
      : `App ${item.appVersion ?? '?'} on ${[item.device, `${SYSTEM[item.platform]} ${item.osVersion ?? ''}`.trim()].filter(Boolean).join(', ')}`;
  const reply = `mailto:${encodeURIComponent(item.member.email)}?subject=${encodeURIComponent('Your Embodha feedback')}&body=${encodeURIComponent(`\n\n> ${item.message.split('\n').join('\n> ')}`)}`;

  return (
    <article className={`card feedback${handled ? ' handled' : ''}`}>
      <p className="feedback-message">{item.message}</p>
      <div className="feedback-meta small muted">
        <span>
          {item.member.name ? `${item.member.name}, ` : ''}
          {item.member.email}
        </span>
        <span>{when(item.at)}</span>
        <span>
          {where}
          {item.screen ? `, from ${item.screen}` : ''}
        </span>
        {handled ? <Badge tone="green">Handled {when(item.handledAt!)}</Badge> : null}
      </div>
      <div className="feedback-actions">
        <a className="btn btn-secondary" href={reply}>
          Reply by email
        </a>
        <Button variant={handled ? 'quiet' : 'primary'} busy={action.busy} onClick={() => void mark(!handled)}>
          {handled ? 'Reopen' : 'Mark handled'}
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </article>
  );
}
