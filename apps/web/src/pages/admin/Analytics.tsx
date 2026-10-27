import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../../lib/api';
import { count, rupees } from '../../lib/format';
import type { AnalyticsReport } from '../../lib/types';
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, Stat } from '../../ui/kit';

const WINDOWS = [7, 30, 90] as const;
type Window = (typeof WINDOWS)[number];
type Day = AnalyticsReport['active']['daily'][number];

/** 3333 → "33%". Under one percent keeps a decimal, so a small rate doesn't read as nothing. */
const share = (bps: number) => (bps > 0 && bps < 100 ? `${(bps / 100).toFixed(1)}%` : `${Math.round(bps / 100)}%`);
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}K` : String(n));
const dayLabel = (day: string, withWeekday = false) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-IN', withWeekday ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
const people = (n: number) => `${count(n)} ${n === 1 ? 'person' : 'people'}`;
const plural = (n: number, word: string) => `${count(n)} ${n === 1 ? word : `${word}s`}`;

/** A clean top for the axis: 4, 10, 20, 50, 100, 200, 500… so the halfway tick is a whole number too. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].map((step) => step * power).find((top) => top >= value) ?? 10 * power) as number;
}

export function Analytics() {
  const [params, setParams] = useSearchParams();
  const days = (WINDOWS.find((w) => String(w) === params.get('days')) ?? 30) as Window;
  const query = useQuery({
    queryKey: ['admin', 'analytics', days],
    queryFn: () => api<AnalyticsReport>(`/v1/admin/analytics?days=${days}`),
    placeholderData: keepPreviousData, // switching windows keeps the page in place while the new numbers load
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const report = query.data;
  const { active } = report;
  const oneIn = active.stickinessBps ? Math.max(1, Math.round(10_000 / active.stickinessBps)) : 0;

  return (
    <div className="stack">
      <PageHeader
        title="Analytics"
        lead="How the app is being used, counted by Embodha's own server from the apps and from practice. Nothing goes to an outside tracker. Days run on Indian time."
      />
      <div className="stats">
        <Stat label="Active today" value={count(active.today)} note="members who opened the app or practised" />
        <Stat label="This week" value={count(active.week)} note="active in the last 7 days" />
        <Stat label="This month" value={count(active.month)} note="active in the last 30 days" />
        <Stat label="Stickiness" value={share(active.stickinessBps)} note={oneIn ? `on an average day, about 1 in ${oneIn} of the month's members shows up` : 'no one this month yet'} />
      </div>

      <div className="tabs" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button key={w} type="button" className={`tab${w === days ? ' on' : ''}`} aria-pressed={w === days} onClick={() => setParams({ days: String(w) }, { replace: true })}>
            Last {w} days
          </button>
        ))}
      </div>

      <div className="stack" style={{ opacity: query.isPlaceholderData ? 0.55 : 1, transition: 'opacity 0.15s' }}>
        <DailyChart key={days} daily={active.daily} days={days} />

        <div className="grid-3">
          <Activation report={report} />
          <CourseConversion report={report} />
          <LockedFunnel funnel={report.lockedFunnel} />
        </div>

        <WeekOne cohorts={report.weekOne} />

        <Card title="Course pages and sales">
          {report.courses.top.length ? (
            <div className="table-wrap flat">
              <table>
                <thead>
                  <tr>
                    <th>Course</th>
                    <th className="num">Looked</th>
                    <th className="num">Bought</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {report.courses.top.map((c) => (
                    <tr key={c.slug}>
                      <td>{c.title}</td>
                      <td className="num">{count(c.viewers)}</td>
                      <td className="num">{count(c.buyers)}</td>
                      <td className="num">{c.viewers ? share(c.rateBps) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No one has opened a paid course's page in the last {days} days.</Empty>
          )}
          <p className="muted small chart-note">
            Looked: opened the course page without already having it. Bought: paid, in the app or on the web, test purchases left out.
          </p>
        </Card>

        <div className="grid-2">
          <Card title="Most practised courses">
            {report.topCourses.length ? (
              <div className="table-wrap flat">
                <table>
                  <thead>
                    <tr>
                      <th>Course</th>
                      <th className="num">Minutes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topCourses.map((c) => (
                      <tr key={c.slug}>
                        <td>{c.title}</td>
                        <td className="num">{count(c.minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Nothing played in the last {days} days.</Empty>
            )}
          </Card>
          <Card title="Teachers">
            {report.topTeachers.length ? (
              <div className="table-wrap flat">
                <table>
                  <thead>
                    <tr>
                      <th>Teacher</th>
                      <th className="num">Minutes</th>
                      <th className="num">Earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.topTeachers.map((t) => (
                      <tr key={t.name}>
                        <td>{t.name}</td>
                        <td className="num">{count(t.minutes)}</td>
                        <td className="num">{rupees(t.earnedPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No practice or sales in the last {days} days.</Empty>
            )}
            <p className="muted small chart-note">Earned is their share of sales in this window, before TDS. The same minutes their studio shows.</p>
          </Card>
        </div>

        <Card title="How these are counted" className="paper">
          <ul className="counted">
            <li>A member is active on a day they open the app or practise. Practising is playing a chapter or finishing a breath.</li>
            <li>Guests are phones and browsers that weren't signed in. Someone who looks around first and signs in later counts once, as the member.</li>
            <li>Staff accounts aren't counted as members. App Store and Play test purchases aren't sales.</li>
            <li>Members can turn off "Share how you use the app" in Profile. They still count on days they practise, just not on days they only browse.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** Members and guests each day, as stacked columns. Hover or arrow keys read a day; the table shows them all. */
function DailyChart({ daily, days }: { daily: Day[]; days: Window }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const total = (d: Day) => d.members + d.guests;
  const top = niceMax(Math.max(1, ...daily.map(total)));
  const ticks = [0, top / 2, top];
  const last = daily.length - 1;
  const busiest = daily.reduce((best, d, i) => (total(d) > total(daily[best]) ? i : best), 0);
  // The latest day and the busiest one get their number; the rest are in the tooltip and the table.
  const labelled = new Set([last, ...(Math.abs(busiest - last) > 2 && total(daily[busiest]) > total(daily[last]) ? [busiest] : [])]);
  const every = days === 7 ? 1 : days === 30 ? 7 : 14;
  const nobody = daily.every((d) => total(d) === 0);

  const move = (event: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(last);
    else if (keys[event.key]) setActive((i) => Math.min(last, Math.max(0, (i ?? last) + keys[event.key])));
    else return;
    event.preventDefault();
  };
  const reading = active === null ? '' : `${dayLabel(daily[active].day, true)}: ${plural(daily[active].members, 'member')}, ${plural(daily[active].guests, 'guest')}.`;

  return (
    <Card
      title="People using the app each day"
      actions={
        <Button variant="quiet" onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Show the chart' : 'Show as a table'}
        </Button>
      }
    >
      <div className="legend">
        <span className="legend-item">
          <span className="swatch swatch-members" /> Members
        </span>
        <span className="legend-item">
          <span className="swatch swatch-guests" /> Guests, not signed in
        </span>
      </div>
      {nobody ? (
        <Empty>No one has opened the app in the last {days} days.</Empty>
      ) : asTable ? (
        <div className="table-wrap flat daily-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Members</th>
                <th className="num">Guests</th>
              </tr>
            </thead>
            <tbody>
              {[...daily].reverse().map((d) => (
                <tr key={d.day}>
                  <td>{dayLabel(d.day, true)}</td>
                  <td className="num">{count(d.members)}</td>
                  <td className="num">{count(d.guests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="daily">
          <div className="daily-axis" aria-hidden>
            {ticks.map((tick) => (
              <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>
                {compact(tick)}
              </span>
            ))}
          </div>
          <div
            className="daily-plot"
            tabIndex={0}
            role="group"
            aria-label={`People using the app each day, the last ${days} days. Arrow keys read one day at a time.`}
            onKeyDown={move}
            onFocus={() => setActive((i) => i ?? last)}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
          >
            {ticks.slice(1).map((tick) => (
              <span key={tick} className="gridline" style={{ bottom: `${(tick / top) * 100}%` }} aria-hidden />
            ))}
            {daily.map((d, i) => (
              <div key={d.day} className={`daily-band${active === i ? ' on' : ''}`} onPointerEnter={() => setActive(i)} aria-hidden>
                <div className="daily-stack" style={{ height: `${(total(d) / top) * 100}%` }}>
                  {d.guests ? <span className="seg-guests" style={{ flexGrow: d.guests }} /> : null}
                  {d.members ? <span className="seg-members" style={{ flexGrow: d.members }} /> : null}
                </div>
                {labelled.has(i) ? (
                  <span className="daily-value" style={{ bottom: `calc(${(total(d) / top) * 100}% + 4px)` }}>
                    {count(total(d))}
                  </span>
                ) : null}
              </div>
            ))}
            {active !== null ? <DayTip day={daily[active]} index={active} of={daily.length} height={(total(daily[active]) / top) * 100} /> : null}
            <span className="sr-only" aria-live="polite">
              {reading}
            </span>
          </div>
          <div className="daily-x" aria-hidden>
            {daily.map((d, i) =>
              (last - i) % every === 0 ? (
                // Centred under their day. With 30 or 90 thin columns, "Today" sits flush right instead of hanging off the edge.
                <span key={d.day} style={i === last && days !== 7 ? { right: 0 } : { left: `${((i + 0.5) / daily.length) * 100}%`, transform: 'translateX(-50%)' }}>
                  {i === last ? 'Today' : dayLabel(d.day, days === 7)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function DayTip({ day, index, of, height }: { day: Day; index: number; of: number; height: number }) {
  // Kept inside the plot: pinned left near the start, right near the end, centred on the day otherwise.
  const centre = ((index + 0.5) / of) * 100;
  const side = index < of * 0.15 ? 'start' : index > of * 0.85 ? 'end' : 'middle';
  const left = side === 'start' ? `${(index / of) * 100}%` : side === 'end' ? undefined : `${centre}%`;
  const right = side === 'end' ? `${100 - ((index + 1) / of) * 100}%` : undefined;
  return (
    <div
      className={`chart-tip tip-${side}`}
      style={{ left, right, bottom: `min(calc(${height}% + 12px), calc(100% - 78px))` }}
      aria-hidden
    >
      <div className="tip-day">{dayLabel(day.day, true)}</div>
      <div className="tip-row">
        <span className="tip-key tip-members" />
        <strong>{count(day.members)}</strong> <span className="muted">{day.members === 1 ? 'member' : 'members'}</span>
      </div>
      <div className="tip-row">
        <span className="tip-key tip-guests" />
        <strong>{count(day.guests)}</strong> <span className="muted">{day.guests === 1 ? 'guest' : 'guests'}</span>
      </div>
    </div>
  );
}

function Meter({ part, whole, label }: { part: number; whole: number; label: string }) {
  const width = whole ? Math.min(100, (part / whole) * 100) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={whole} aria-valuenow={part} aria-label={label}>
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

function Activation({ report }: { report: AnalyticsReport }) {
  const { signups, practised, rateBps, waiting } = report.activation;
  return (
    <Card title="Joined, then practised">
      {signups ? (
        <>
          <p className="figure">{share(rateBps)}</p>
          <p>
            of the {people(signups)} who joined in the last {report.days} days practised in their first week.
          </p>
          <Meter part={practised} whole={signups} label="Practised in their first week" />
          {waiting ? (
            <p className="muted small">
              {count(waiting)} of the others joined less than a week ago, so this can still go up.
            </p>
          ) : null}
        </>
      ) : (
        <Empty>No one joined in the last {report.days} days.</Empty>
      )}
    </Card>
  );
}

function CourseConversion({ report }: { report: AnalyticsReport }) {
  const { viewers, buyers, rateBps } = report.courses;
  return (
    <Card title="Course page to purchase">
      {viewers || buyers ? (
        <>
          <p className="figure">{viewers ? share(rateBps) : '—'}</p>
          <p>
            of people who opened a paid course's page bought that course: {plural(buyers, 'sale')} from {plural(viewers, 'look')}, each person counted once per course.
          </p>
          <Meter part={buyers} whole={Math.max(viewers, buyers)} label="Bought the course" />
        </>
      ) : (
        <Empty>No one has looked at a paid course yet in this window.</Empty>
      )}
    </Card>
  );
}

/** Three ordered steps, so one hue from light to dark: the step that matters, "bought", is the darkest. */
function LockedFunnel({ funnel }: { funnel: AnalyticsReport['lockedFunnel'] }) {
  const steps = [
    { label: 'Reached a locked chapter', value: funnel.locked, tone: 'step-1' },
    { label: 'Started to pay', value: funnel.started, tone: 'step-2' },
    { label: 'Bought', value: funnel.done, tone: 'step-3' },
  ];
  return (
    <Card title="After a locked chapter">
      {funnel.locked ? (
        <div className="funnel">
          {steps.map((step, i) => (
            <div key={step.label} className="funnel-row">
              <span>{step.label}</span>
              <span className="funnel-value">
                <strong>{count(step.value)}</strong>
                {i > 0 && steps[i - 1].value ? <span className="muted"> · {share(Math.round((step.value / steps[i - 1].value) * 10_000))}</span> : null}
              </span>
              <span className="funnel-track">
                <span className={step.tone} style={{ width: `${(step.value / funnel.locked) * 100}%` }} />
              </span>
            </div>
          ))}
          <p className="muted small">Bought means the payment cleared with us, not just that the checkout closed.</p>
        </div>
      ) : (
        <Empty>No one has reached a locked chapter in this window.</Empty>
      )}
    </Card>
  );
}

function WeekOne({ cohorts }: { cohorts: AnalyticsReport['weekOne'] }) {
  return (
    <Card title="Coming back in the first week">
      {cohorts.length ? (
        <div className="table-wrap flat">
          <table>
            <thead>
              <tr>
                <th>Joined the week of</th>
                <th className="num">Joined</th>
                <th className="num">Came back</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.week}>
                  <td>
                    {dayLabel(c.week)} {c.final ? null : <Badge>Still counting</Badge>}
                  </td>
                  <td className="num">{count(c.signups)}</td>
                  <td className="num">{count(c.returned)}</td>
                  <td>
                    <span className="inline-meter">
                      <Meter part={c.returned} whole={c.signups} label={`Came back, week of ${dayLabel(c.week)}`} />
                      <span className="num-text">{share(c.rateBps)}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No one joined in this window.</Empty>
      )}
      <p className="muted small chart-note">
        Came back: opened the app or practised on any of the seven days after the day they joined. A week is still counting until its last joiner has had all seven.
      </p>
    </Card>
  );
}
