import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { count, percent } from '../../lib/format';
import type { BetaReport, ByChannel, ReconBar, StartTimes } from '../../lib/types';
import { Badge, Card, Empty, ErrorNote, Loading, PageHeader } from '../../ui/kit';

const WINDOWS = [7, 14, 30] as const;
const PLATFORM = { ios: 'iOS', android: 'Android', web: 'Web' } as const;
const CHANNEL = { razorpay: 'Website', google: 'Play', apple: 'App Store' } as const;

/** 840 → "840 ms", 1980 → "1.98 s". */
const time = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} s`);
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const plural = (n: number, word: string, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`;
const STORE_NAME = { razorpay: 'the website', google: 'Google Play', apple: 'the App Store' } as const;

/** What stands between the money bar and met, in words: late sales, lines that don't match, a channel or currency with nothing matched yet. */
function stillToGo(recon: ReconBar) {
  const late = recon.due - recon.reconciled;
  const quiet = (['razorpay', 'google', 'apple'] as const).filter((c) => !recon.channels[c].reconciled).map((c) => STORE_NAME[c]);
  const currencies = (['INR', 'USD'] as const).filter((c) => !recon.currencies.includes(c)).map((c) => (c === 'INR' ? 'rupee' : 'dollar'));
  const join = (items: string[], last: string) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`);
  return [
    late ? `${plural(late, 'sale')} the reports should have had` : null,
    recon.problems ? `${plural(recon.problems, 'report line')} that ${recon.problems === 1 ? "doesn't" : "don't"} match the books` : null,
    quiet.length ? `a matched sale from ${join(quiet, 'and')}` : null,
    currencies.length ? `a matched ${join(currencies, 'or')} sale` : null,
  ].filter(Boolean);
}
const channels = (c: ByChannel) =>
  [c.website && `${c.website} website`, c.appStore && `${c.appStore} App Store`, c.googlePlay && `${c.googlePlay} Google Play`].filter(Boolean).join(', ') || 'none';

type Verdict = 'met' | 'missed' | 'waiting';
const VERDICT: Record<Verdict, [string, 'green' | 'red' | 'neutral']> = { met: ['Met', 'green'], missed: ['Not met', 'red'], waiting: ['Needs more data', 'neutral'] };

function Bar({ title, value, target, verdict, label, children }: { title: string; value: ReactNode; target: string; verdict: Verdict; label?: string; children: ReactNode }) {
  const [text, tone] = VERDICT[verdict];
  return (
    <section className={`bar-card ${verdict}`} aria-label={title}>
      <div className="bar-head">
        <span className="stat-label">{title}</span>
        <Badge tone={tone}>{label ?? text}</Badge>
      </div>
      <span className="bar-value">{value}</span>
      <span className="bar-target">{target}</span>
      <span className="bar-note">{children}</span>
    </section>
  );
}

/**
 * The beta against the launch bars in the spec. Everything here comes from what the apps send to Embodha's own server
 * (app opens, crash reports, video start times) and from the payments and audit records.
 */
export function Beta() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const days = WINDOWS.find((w) => String(w) === params.get('days')) ?? 14;
  const query = useQuery({
    queryKey: ['admin', 'beta', days],
    queryFn: () => api<BetaReport>(`/v1/admin/beta?days=${days}`),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { bars, crashes, problems, video, switchOffs, feedbackOpen } = query.data;
  const { crashFree, videoStart, switchOff, reconciliation: recon } = bars;

  return (
    <div className="stack">
      <PageHeader
        title="Beta health"
        lead="The launch bars from the spec, measured from what the apps send to Embodha's own server. Each one waits for enough data before it calls met or not met."
      />
      <div className="tabs" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button key={w} type="button" className={`tab${w === days ? ' on' : ''}`} aria-pressed={w === days} onClick={() => setParams({ days: String(w) }, { replace: true })}>
            Last {w} days
          </button>
        ))}
      </div>

      <div className="stack" style={{ opacity: query.isPlaceholderData ? 0.55 : 1, transition: 'opacity 0.15s' }}>
        <div className="bars">
          <Bar
            title="Crash-free sessions"
            value={percent(crashFree.valueBps)}
            target={`Bar: ${percent(crashFree.targetBps)} or better`}
            verdict={!crashFree.enough ? 'waiting' : crashFree.met ? 'met' : 'missed'}
          >
            {plural(crashFree.crashes, 'crash', 'crashes')} in {plural(crashFree.sessions, 'session')} on iOS and Android.
            {!crashFree.enough ? ` It calls it at ${count(crashFree.minSessions)}.` : ''}
          </Bar>
          <Bar
            title="Video start on 4G"
            value={time(videoStart.p90Ms)}
            target={`Bar: ${time(videoStart.targetMs)} or less, for 9 in 10 starts`}
            verdict={!videoStart.enough ? 'waiting' : videoStart.met ? 'met' : 'missed'}
          >
            {plural(videoStart.starts, 'start')} on 4G in the phone apps.{!videoStart.enough ? ` It calls it at ${count(videoStart.minStarts)}.` : ''}
          </Bar>
          <Bar
            title="Teacher switch-off"
            value={plural(switchOff.chargedAfter, 'charge')}
            target="Bar: nobody charged after a teacher switches their subscription off"
            verdict={switchOff.chargedAfter > 0 ? 'missed' : switchOff.enough ? 'met' : 'waiting'}
            label={switchOff.chargedAfter === 0 && !switchOff.enough ? 'Not tested yet' : undefined}
          >
            {switchOff.switchOffs
              ? `${plural(switchOff.switchOffs, 'switch-off')}, ${plural(switchOff.renewalsTested, 'renewal')} that would have been charged since.`
              : 'No teacher has switched a subscription off yet.'}
          </Bar>
          <Bar
            title="Reconciliation"
            value={recon.due ? `${count(recon.reconciled)} of ${count(recon.due)}` : '—'}
            target="Bar: two weeks of payments match the reports to the rupee, on all three channels, in INR and USD"
            verdict={recon.met ? 'met' : recon.problems || (recon.due && recon.reconciled < recon.due) ? 'missed' : 'waiting'}
            label={!recon.met && !recon.problems && !(recon.due && recon.reconciled < recon.due) ? (recon.due ? 'Not every channel yet' : 'Nothing due yet') : undefined}
          >
            {(['razorpay', 'google', 'apple'] as const).map((c) => `${CHANNEL[c]} ${recon.channels[c].reconciled}/${recon.channels[c].due}`).join(' · ')}
            {recon.currencies.length ? `, in ${recon.currencies.join(' and ')}` : ''}.{' '}
            {!recon.met && stillToGo(recon).length ? `Still to go: ${stillToGo(recon).join('; ')}. ` : ''}
            {recon.waiting ? `${plural(recon.waiting, 'sale')} not reported yet. ` : ''}
            {can('finance') ? <Link to="/admin/reconciliation">Reconciliation</Link> : null}
          </Bar>
        </div>

        {feedbackOpen && can('support', 'content') ? (
          <p className="notice">
            {plural(feedbackOpen, 'feedback message is', 'feedback messages are')} waiting. <Link to="/admin/feedback">Read them</Link>
          </p>
        ) : null}

        <Card title="Problems in the apps">
          {problems.length ? (
            <div className="table-wrap flat">
              <table>
                <thead>
                  <tr>
                    <th>What happened</th>
                    <th className="num">Reports</th>
                    <th className="num">Installs</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((p) => (
                    <tr key={p.fingerprint}>
                      <td>
                        <div className="problem-head">
                          <Badge tone={p.kind === 'crash' ? 'red' : 'amber'}>{p.kind === 'crash' ? 'Crash' : 'Error'}</Badge>
                          <span className="problem-message">{p.message}</span>
                        </div>
                        <div className="small muted">
                          {p.platforms.map((x) => PLATFORM[x]).join(', ')}
                          {p.versions.length ? `, version ${p.versions.join(', ')}` : ''}
                          {p.screen ? `, on ${p.screen}` : ''}. First seen {when(p.firstSeen)}.
                        </div>
                        {p.stack ? (
                          <details className="small">
                            <summary>Stack</summary>
                            <pre className="stack-trace">{p.stack}</pre>
                          </details>
                        ) : null}
                      </td>
                      <td className="num">{count(p.reports)}</td>
                      <td className="num">{count(p.installs)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{when(p.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No crashes or errors reported in the last {days} days.</Empty>
          )}
          <p className="muted small chart-note">
            The same problem from different phones and builds is grouped into one row. A crash is the app closing, or a screen that failed and showed
            &ldquo;This screen didn&rsquo;t load&rdquo;. Each different error is reported once per launch. Members who switched off &ldquo;Share how you use
            the app&rdquo; send nothing, and reports are deleted after 90 days.
          </p>
        </Card>

        <div className="grid-2">
          <Card title="Crash-free by platform">
            <SessionTable rows={crashes.byPlatform.map((r) => ({ ...r, key: r.platform, label: PLATFORM[r.platform] }))} empty={`No app opens from iOS or Android in the last ${days} days.`} />
          </Card>
          <Card title="By app version">
            <SessionTable
              rows={crashes.byVersion.map((r) => ({ ...r, key: `${r.platform}-${r.version}`, label: `${PLATFORM[r.platform]} ${r.version || '(unknown)'}` }))}
              empty="No versions to compare yet."
            />
          </Card>
        </div>

        <div className="grid-2">
          <Card title="Video start, by connection">
            <StartTable rows={video.byConnection.map((r) => ({ ...r, key: r.connection, label: r.connection, bar: r.connection === '4G' }))} empty={`No chapters started in the last ${days} days.`} />
            <p className="muted small chart-note">
              From opening the player to the first frame, or the first sound of an audio chapter. Someone who gave up after waiting more than{' '}
              {time(videoStart.targetMs)} counts as a slow start ({count(video.gaveUpSlow)} so far); someone who left sooner isn&rsquo;t counted (
              {count(video.abandoned - video.gaveUpSlow)}). Asking the server for the stream took {time(video.overall.apiP50Ms)} at the median.{' '}
              {plural(video.errors, 'chapter')} wouldn&rsquo;t play at all.
              {video.casts || video.castErrors ? (
                <>
                  {' '}
                  {plural(video.casts, 'chapter')} went to a TV with Chromecast, and TVs couldn&rsquo;t play {plural(video.castErrors, 'chapter')}.
                  {video.castErrors >= 3 && video.castErrors > video.casts
                    ? ' More failed than played: check CORS and the allowed domains on the video library in Bunny (the Chromecast check in the README).'
                    : ''}
                </>
              ) : null}
            </p>
          </Card>
          <Card title="Video start, by where members live">
            <StartTable rows={video.byPlace.map((r) => ({ ...r, key: r.place, label: r.place }))} empty="No starts from signed-in members with a state on their account." />
            <p className="muted small chart-note">Signed-in members only, by the state on their account. All connections together.</p>
          </Card>
        </div>

        <Card title="Teacher switch-offs">
          {switchOffs.length ? (
            <div className="table-wrap flat">
              <table>
                <thead>
                  <tr>
                    <th>Teacher</th>
                    <th>Switched off</th>
                    <th>Renewals due since</th>
                    <th>Charged anyway</th>
                  </tr>
                </thead>
                <tbody>
                  {switchOffs.map((o) => {
                    const charged = o.chargedAfter.website + o.chargedAfter.appStore + o.chargedAfter.googlePlay;
                    return (
                      <tr key={`${o.instructor}-${o.offAt}`}>
                        <td>{o.instructor}</td>
                        <td>
                          {when(o.offAt)}
                          {o.onAgainAt ? <div className="small muted">On again {when(o.onAgainAt)}</div> : null}
                        </td>
                        <td>{channels(o.renewalsDue)}</td>
                        <td>
                          {charged ? <Badge tone="red">{channels(o.chargedAfter)}</Badge> : 'none'}
                          {o.testCharges ? <div className="small muted">{plural(o.testCharges, 'test purchase')}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No switch-offs yet. To test one: subscribe to a teacher from a test account on each channel, then switch the teacher&rsquo;s plan off in their studio.</Empty>
          )}
          <p className="muted small chart-note">
            Every switch-off so far, not just the last {days} days, because a renewal can be a month away. A renewal is due when a subscriber&rsquo;s paid month
            ended after the switch-off. Test purchases count: TestFlight and Play&rsquo;s test accounts renew every few minutes, which is how this gets
            tested before real money does.
          </p>
        </Card>
      </div>
    </div>
  );
}

function SessionTable({ rows, empty }: { rows: { key: string; label: string; sessions: number; crashes: number; crashFreeBps: number | null }[]; empty: string }) {
  if (!rows.some((r) => r.sessions || r.crashes)) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap flat">
      <table>
        <thead>
          <tr>
            <th />
            <th className="num">Sessions</th>
            <th className="num">Crashes</th>
            <th className="num">Crash-free</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{count(r.sessions)}</td>
              <td className="num">{count(r.crashes)}</td>
              <td className="num">{percent(r.crashFreeBps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StartTable({ rows, empty }: { rows: (StartTimes & { key: string; label: string; bar?: boolean })[]; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap flat">
      <table>
        <thead>
          <tr>
            <th />
            <th className="num">Starts</th>
            <th className="num">Median</th>
            <th className="num">9 in 10 within</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.bar ? 'bar-row' : undefined}>
              <td>
                {r.label} {r.bar ? <Badge>the bar</Badge> : null}
              </td>
              <td className="num">{count(r.starts)}</td>
              <td className="num">{time(r.p50Ms)}</td>
              <td className="num">{time(r.p90Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
