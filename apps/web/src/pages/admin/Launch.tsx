import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, day } from '../../lib/format';
import type { AppleTestResult, Launch as LaunchData, LaunchCheck } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, Empty, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

const MARK = { done: ['✓', 'Done'], todo: ['!', 'To do'], waiting: ['…', 'Waiting'] } as const;
const QUERY = ['admin', 'launch'] as const;

/** "10:42", or "22 Oct, 10:42" on another day. */
function checkedAt(iso: string) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return at.toDateString() === new Date().toDateString() ? time : `${day(iso)}, ${time}`;
}

/**
 * One page that says whether Embodha can launch: everything the server can check for itself, and the few gates only a
 * person can sign off. The server looks at the website and DNS at most every two minutes; "Check again" looks now.
 */
export function Launch() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const onlyLeft = params.get('show') === 'left';
  const query = useQuery({ queryKey: QUERY, queryFn: () => api<LaunchData>('/v1/admin/launch') });
  const recheck = useAction();

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const data = query.data;
  const sections = data.sections
    .map((section) => ({ ...section, shown: onlyLeft ? section.checks.filter((check) => check.status !== 'done') : section.checks }))
    .filter((section) => section.shown.length);

  return (
    <div className="stack">
      <PageHeader
        title="Launch checklist"
        lead="Everything the server can check for itself before launch, and the few gates only a person can sign off. Anything open says what's missing and where to put it right."
        actions={
          <Button
            variant="secondary"
            busy={recheck.busy}
            onClick={() => void recheck.run(async () => queryClient.setQueryData(QUERY, await api<LaunchData>('/v1/admin/launch?fresh=1')))}
          >
            Check again
          </Button>
        }
      />
      <ErrorNote error={recheck.error} />

      <section className={`card launch-verdict${data.ready ? ' ready' : ''}`} aria-live="polite">
        <span className="stat-label">{data.ready ? 'Launch' : 'Before launch'}</span>
        <h2 className="launch-left">{data.ready ? 'Ready to launch' : `${count(data.left)} ${data.left === 1 ? 'thing' : 'things'} to go`}</h2>
        <div className="launch-meter" role="img" aria-label={`${data.counts.done} of ${data.total} done`}>
          <span style={{ width: `${Math.round((data.counts.done / Math.max(1, data.total)) * 100)}%` }} />
        </div>
        <p className="small">
          {count(data.counts.done)} of {count(data.total)} done
          {data.counts.waiting ? `; ${count(data.counts.waiting)} waiting on time or a store` : ''}. Checked {checkedAt(data.checkedAt)}.
        </p>
      </section>

      <div className="tabs" role="group" aria-label="Show">
        {(
          [
            ['all', 'Everything'],
            ['left', "What's left"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`tab${(value === 'left') === onlyLeft ? ' on' : ''}`}
            aria-pressed={(value === 'left') === onlyLeft}
            onClick={() => setParams(value === 'left' ? { show: 'left' } : {}, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>

      {sections.length ? (
        sections.map((section) => {
          const open = section.checks.filter((check) => check.status !== 'done').length;
          return (
            <Card key={section.key} title={section.title} actions={<span className="small muted">{open ? `${count(open)} open` : 'All done'}</span>}>
              <ul className="launch-list">
                {section.shown.map((check) => (
                  <CheckRow key={check.key} check={check} />
                ))}
              </ul>
            </Card>
          );
        })
      ) : (
        <Empty>Nothing left. Everything the checklist knows about is done.</Empty>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: LaunchCheck }) {
  const { can } = useAuth();
  const [mark, label] = MARK[check.status];
  const open = check.status !== 'done';
  return (
    <li className={`launch-check ${check.status}`}>
      <span className="launch-mark" aria-hidden="true">
        {mark}
      </span>
      <div>
        <div className="launch-title">
          <strong>{check.title}</strong>
          <span className="sr-only">: {label}.</span>
          {check.status === 'waiting' ? <Badge tone="amber">Waiting</Badge> : null}
          {!check.blocking ? <Badge>Doesn't hold up launch</Badge> : null}
        </div>
        <p className="launch-detail">{check.detail}</p>
        {check.signoff !== undefined ? <Signoff check={check} /> : null}
        {open && (check.page || check.env?.length || check.action) ? (
          <div className="launch-meta">
            {check.page ? <Link to={check.page.to}>{check.page.label}</Link> : null}
            {check.env?.length ? (
              <span className="launch-env muted">
                On the server:
                {check.env.map((name) => (
                  <code key={name}>{name}</code>
                ))}
              </span>
            ) : null}
            {check.action === 'apple_test' && can('finance') ? <AppleTest /> : null}
            {check.action === 'video_downloads' && can('content') ? <VideoDownloads /> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The gates only a person can confirm. Super admins sign them off, with a note saying who did it and where the proof is. */
function Signoff({ check }: { check: LaunchCheck }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const action = useAction();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState('');
  const owner = can('super_admin');
  const save = (work: () => Promise<unknown>) =>
    action.run(async () => {
      await work();
      setWriting(false);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: QUERY });
    });

  if (check.signoff) {
    return (
      <div className="launch-signoff">
        <span className="small">
          Signed off by {check.signoff.by ?? 'someone no longer on staff'} on {day(check.signoff.at)}
          {check.signoff.note ? `: "${check.signoff.note}"` : '.'}
        </span>
        {owner ? (
          <Button variant="quiet" busy={action.busy} onClick={() => void save(() => api(`/v1/admin/launch/signoffs/${check.key}`, { method: 'DELETE' }))}>
            Take it back
          </Button>
        ) : null}
        <ErrorNote error={action.error} />
      </div>
    );
  }
  if (!owner) return <p className="small muted launch-signoff">A super admin signs this one off.</p>;
  if (!writing) {
    return (
      <div className="launch-signoff">
        <Button variant="secondary" onClick={() => setWriting(true)}>
          Sign off
        </Button>
      </div>
    );
  }
  return (
    <div className="launch-signoff-form">
      <Field label="A note, if you like" hint="Who did it, and where the proof is.">
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
      <div className="row">
        <Button busy={action.busy} onClick={() => void save(() => api(`/v1/admin/launch/signoffs/${check.key}`, { method: 'POST', body: { note: note.trim() || undefined } }))}>
          Sign it off
        </Button>
        <Button variant="quiet" onClick={() => setWriting(false)}>
          Cancel
        </Button>
      </div>
      <ErrorNote error={action.error} />
    </div>
  );
}

/**
 * Reads the finished videos that have no downloadable copy from Bunny again: once MP4 fallback is on and older videos
 * have been re-encoded in Bunny's dashboard. Bunny's webhook does this by itself for new uploads.
 */
function VideoDownloads() {
  const queryClient = useQueryClient();
  const action = useAction();
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        busy={action.busy}
        onClick={() =>
          void action.run(async () => {
            const result = await api<{ looked: number; saveable: number; problem: string | null }>('/v1/admin/launch/video-downloads', { method: 'POST' });
            setSaid(
              `Looked at ${result.looked} ${result.looked === 1 ? 'video' : 'videos'}: ${result.saveable ? `${result.saveable} ${result.saveable === 1 ? 'has' : 'have'} a copy to save now.` : 'none has a copy to save yet.'}` +
                (result.problem ? ` Bunny said: ${result.problem}` : ''),
            );
            await queryClient.invalidateQueries({ queryKey: QUERY });
          })
        }
      >
        Look at Bunny again
      </Button>
      {said ? <span className="small">{said}</span> : null}
      <ErrorNote error={action.error} />
    </>
  );
}

/** Asks Apple's production and sandbox servers for a TEST notification, then looks again once it should have landed. */
function AppleTest() {
  const queryClient = useQueryClient();
  const action = useAction();
  const [said, setSaid] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        busy={action.busy}
        onClick={() =>
          void action.run(async () => {
            const result = await api<AppleTestResult>('/v1/admin/launch/apple-test', { method: 'POST' });
            const failed = result.results.filter((r) => !r.asked);
            setSaid(
              failed.length
                ? `Asked ${result.results.filter((r) => r.asked).map((r) => r.environment.toLowerCase()).join(' and ')}; ${failed.map((r) => `${r.environment.toLowerCase()} said: ${r.problem}`).join(' ')}`
                : "Asked Apple's production and sandbox servers. Their tests usually land within seconds; this looks again shortly.",
            );
            window.setTimeout(() => void api<LaunchData>('/v1/admin/launch?fresh=1').then((data) => queryClient.setQueryData(QUERY, data)), 8000);
          })
        }
      >
        Ask Apple for a test
      </Button>
      {said ? <span className="small">{said}</span> : null}
      <ErrorNote error={action.error} />
    </>
  );
}
