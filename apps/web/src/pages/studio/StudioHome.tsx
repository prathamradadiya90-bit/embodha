import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { count, day, monthName, percent, rupees } from '../../lib/format';
import type { Earnings as EarningsData, StudioCourse, StudioCourseRow, StudioMe, StudioOptions } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Button, Card, CourseStatusBadge, Empty, ErrorNote, Field, Loading, PageHeader, Stat, Toggle } from '../../ui/kit';

export function StudioHome() {
  const me = useQuery({ queryKey: ['studio', 'me'], queryFn: () => api<StudioMe>('/v1/studio/me') });
  const courses = useQuery({ queryKey: ['studio', 'courses'], queryFn: () => api<StudioCourseRow[]>('/v1/studio/courses') });
  const options = useQuery({ queryKey: ['studio', 'options'], queryFn: () => api<StudioOptions>('/v1/studio/options') });

  if (me.isPending || courses.isPending || options.isPending) return <Loading />;
  if (me.isError || courses.isError || options.isError) return <ErrorNote error={me.error ?? courses.error ?? options.error} />;
  const { instructor, sharePercentBps, thisMonth } = me.data;

  return (
    <div className="stack">
      <PageHeader title={`${instructor.displayName}'s studio`} lead="Build a course as a draft, upload a video for each chapter, then send it to the Embodha team to review." />
      <div className="stats">
        <Stat label={`Watched in ${monthName(thisMonth.month)}`} value={`${count(thisMonth.minutes)} min`} note={`by ${count(thisMonth.members)} ${thisMonth.members === 1 ? 'member' : 'members'}`} />
        <Stat label="Your share of each sale" value={percent(sharePercentBps)} note="after GST and store or payment fees" />
        <Stat label="Courses" value={courses.data.length} note={`${courses.data.filter((c) => c.status === 'published').length} live`} />
      </div>
      <Earnings />
      <div className="grid-2">
        <NewCourse options={options.data} />
        <Subscription me={me.data} options={options.data} />
      </div>
      <Card title="Your courses">
        {courses.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Status</th>
                  <th>Last changed</th>
                </tr>
              </thead>
              <tbody>
                {courses.data.map((course) => (
                  <CourseRow key={course.id} course={course} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No courses yet. Start one above; it stays a draft until you send it for review.</Empty>
        )}
      </Card>
    </div>
  );
}

function CourseRow({ course }: { course: StudioCourseRow }) {
  const navigate = useNavigate();
  return (
    <tr className="clickable" onClick={() => navigate(`/studio/courses/${course.id}`)}>
      <td>
        <a href={`/studio/courses/${course.id}`} onClick={(e) => e.preventDefault()}>
          {course.title}
        </a>
        {course.isFree ? <span className="muted small"> · the free course</span> : null}
      </td>
      <td>
        <CourseStatusBadge status={course.status} />
      </td>
      <td className="muted">{day(course.updatedAt)}</td>
    </tr>
  );
}

function NewCourse({ options }: { options: StudioOptions }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [topicId, setTopicId] = useState('');
  const action = useAction();
  const categories = [...new Set(options.topics.map((t) => t.category))];

  const create = () =>
    action.run(async () => {
      const course = await api<StudioCourse>('/v1/studio/courses', { method: 'POST', body: { title: title.trim(), topicId } });
      await queryClient.invalidateQueries({ queryKey: ['studio', 'courses'] });
      navigate(`/studio/courses/${course.id}`);
    });

  return (
    <Card title="Start a course">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Title" hint="Say what it is and how long, e.g. “7-Day Gentle Spine”.">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Topic" hint="Need a topic that isn't here? Ask the Embodha team.">
          <select value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((category) => (
              <optgroup key={category} label={category}>
                {options.topics
                  .filter((t) => t.category === category)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <ErrorNote error={action.error} />
        <div>
          <Button type="submit" busy={action.busy} disabled={title.trim().length < 3 || !topicId}>
            Create draft
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Subscription({ me, options }: { me: StudioMe; options: StudioOptions }) {
  const queryClient = useQueryClient();
  const [priceId, setPriceId] = useState(me.plan.pricePointId ?? options.planPrices[0]?.id ?? '');
  const [stopped, setStopped] = useState<string | null>(null);
  const action = useAction();
  const save = (enabled: boolean) =>
    action.run(async () => {
      const done = await api<{ stoppedRenewals: number; appStoreRenewals: number; appStoreOffSale: boolean }>('/v1/studio/plan', {
        method: 'PUT',
        body: { enabled, pricePointId: priceId || undefined },
      });
      setStopped(enabled ? null : stoppedNote(done.stoppedRenewals, done.appStoreRenewals, done.appStoreOffSale));
      await queryClient.invalidateQueries({ queryKey: ['studio', 'me'] });
    });

  return (
    <Card title="Monthly subscription">
      <div className="stack">
        <p className="muted">
          Members pay one monthly price for all your courses, including new ones. Each payment is split at your share, the same as a course sale. Switch it
          off and current subscribers keep access until their month ends.
        </p>
        <p className="small muted">
          In the iPhone and Android apps, Apple and Google take the payments, so a new price reaches the apps once the Embodha team has changed it in both
          stores. That usually takes a few days. Switching off stops new subscriptions everywhere straight away.
        </p>
        <Field label="Monthly price">
          <select value={priceId} onChange={(e) => setPriceId(e.target.value)} disabled={action.busy}>
            {options.planPrices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.inr} in India · {p.usd} elsewhere
              </option>
            ))}
          </select>
        </Field>
        <div className="row">
          <Toggle checked={me.plan.enabled} disabled={action.busy} onChange={(next) => void save(next)} label={me.plan.enabled ? 'Members can subscribe' : 'Switched off'} />
          {me.plan.enabled && priceId !== me.plan.pricePointId ? (
            <Button variant="secondary" busy={action.busy} onClick={() => void save(true)}>
              Save new price
            </Button>
          ) : null}
        </div>
        {stopped ? <p className="small">{stopped}</p> : null}
        <ErrorNote error={action.error} />
      </div>
    </Card>
  );
}

/** What switching off did to people already subscribed. */
function stoppedNote(stopped: number, appStore: number, appStoreOffSale: boolean) {
  const people = (n: number) => (n === 1 ? '1 member' : `${n} members`);
  const parts: string[] = [];
  if (stopped) parts.push(`Renewals stopped for ${people(stopped)}; they keep access to the end of the month they paid for.`);
  if (appStore) {
    parts.push(
      appStoreOffSale
        ? `${people(appStore)} subscribed through the App Store. Your subscription is off sale there now, so they stop at their next renewal date.`
        : `${people(appStore)} subscribed through the App Store, which only Apple can stop: they renew until the Embodha team takes your subscription off sale there.`,
    );
  }
  return parts.length ? parts.join(' ') : 'Nobody was subscribed, so nothing else changes.';
}

function Earnings() {
  const query = useQuery({ queryKey: ['studio', 'earnings'], queryFn: () => api<EarningsData>('/v1/studio/earnings') });
  if (query.isPending || query.isError) return null;
  const { thisMonth, unpaidPaise, sales, payouts } = query.data;
  return (
    <Card title="Earnings">
      <div className="stats">
        <Stat label="Earned this month" value={rupees(thisMonth.earnedPaise)} note={`${count(thisMonth.sales)} ${thisMonth.sales === 1 ? 'sale' : 'sales'}`} />
        <Stat label="Waiting to be paid" value={rupees(unpaidPaise)} note="paid after each month ends: website sales once the refund window has passed, app sales once Apple or Google has reported them" />
        <Stat label="Last payout" value={payouts[0] ? rupees(payouts[0].netPaise) : '—'} note={payouts[0]?.paidAt ? `paid ${day(payouts[0].paidAt)}` : payouts[0] ? 'being paid' : 'none yet'} />
      </div>
      {sales.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Course</th>
                <th className="num">Price</th>
                <th className="num">Your share</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale, i) => (
                <tr key={i}>
                  <td className="muted">{day(sale.at)}</td>
                  <td>
                    {sale.course}
                    {sale.refunded ? <span className="small muted"> · refunded</span> : null}
                  </td>
                  <td className="num">{sale.price.display}</td>
                  <td className="num">{sale.refunded ? <s>{rupees(sale.yourSharePaise)}</s> : rupees(sale.yourSharePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No sales yet. They show here the moment they happen.</Empty>
      )}
    </Card>
  );
}
