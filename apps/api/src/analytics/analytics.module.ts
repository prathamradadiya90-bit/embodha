import { Body, Controller, Get, HttpCode, Injectable, Module, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { sql, type SQL } from 'drizzle-orm';
import { AuthModule } from '../auth/auth.module';
import { AuthGuard, AuthUser, CurrentUser, OptionalAuthGuard, Roles, StaffGuard } from '../common/auth';
import { fail } from '../common/errors';
import { BUSINESS_TIME_ZONE } from '../common/month';
import { Db, InjectDb } from '../db/db.module';
import { events, installDays, installs } from '../db/schema';
import { localDay } from '../practice/streak';
import { indianDays, markActive } from './rollup';

/**
 * The events the apps may send. Anything else is dropped, so an old app version can't fill the table with noise.
 * video_start carries how long a chapter took to show its first frame (or start its audio), and on what connection;
 * video_error, a chapter that wouldn't play. cast_start is a chapter sent to a TV, cast_error one the TV couldn't play.
 */
export const EVENT_NAMES = new Set([
  'app_open',
  'screen_view',
  'course_view',
  'locked_view',
  'purchase_start',
  'purchase_done',
  'purchase_cancel',
  'breath_start',
  'video_start',
  'video_error',
  'cast_start',
  'cast_error',
]);
const PLATFORMS = new Set(['ios', 'android', 'web']);
const MAX_BATCH = 50;

type Props = Record<string, string | number | boolean>;

/** Up to ten short, flat properties: IDs, slugs, screen names, prices. Never anything personal. */
function cleanProps(raw: unknown): Props {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Props = {};
  for (const [key, value] of Object.entries(raw).slice(0, 10)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** The device's clock, if it's believable: within a week of ours. Events queue up offline, so it can lag. */
export function clientTime(raw: unknown) {
  const at = typeof raw === 'string' ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) && Math.abs(at.getTime() - Date.now()) < 7 * 86_400_000 ? at : null;
}

const n = (value: unknown) => Number(value ?? 0);
const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 10_000) : 0);

@Injectable()
export class AnalyticsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async record(userId: string | null, body: unknown) {
    const batch = (body ?? {}) as { anonId?: unknown; platform?: unknown; appVersion?: unknown; events?: unknown };
    if (typeof batch.anonId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(batch.anonId)) throw fail(400, 'invalid_request', 'anonId should be the random ID the app made.');
    if (typeof batch.platform !== 'string' || !PLATFORMS.has(batch.platform)) throw fail(400, 'invalid_request', 'platform should be ios, android or web.');
    if (!Array.isArray(batch.events) || batch.events.length > MAX_BATCH) throw fail(400, 'invalid_request', `Send between 0 and ${MAX_BATCH} events at a time.`);
    const anonId = batch.anonId;
    const platform = batch.platform as 'ios' | 'android' | 'web';
    const appVersion = typeof batch.appVersion === 'string' ? batch.appVersion.slice(0, 32) : null;
    const received = new Date();
    const rows = (batch.events as { name?: unknown; at?: unknown; props?: unknown }[])
      .filter((event) => event && typeof event.name === 'string' && EVENT_NAMES.has(event.name))
      .map((event) => ({ name: event.name as string, userId, anonId, platform, appVersion, props: cleanProps(event.props), clientAt: clientTime(event.at) }));

    if (rows.length) {
      // The day an event belongs to is the day it happened on the phone, when the phone's clock is believable.
      const moments = rows.map((row) => row.clientAt ?? received);
      await this.db.transaction(async (tx) => {
        await tx.insert(events).values(rows);
        await tx
          .insert(installs)
          .values({ anonId, userId, platform, lastSeen: received })
          .onConflictDoUpdate({ target: installs.anonId, set: { platform, lastSeen: received, ...(userId ? { userId } : {}) } });
        await tx
          .insert(installDays)
          .values(indianDays(moments).map((day) => ({ anonId, day, signedIn: Boolean(userId) })))
          .onConflictDoUpdate({ target: [installDays.anonId, installDays.day], set: { signedIn: sql`${installDays.signedIn} or excluded.signed_in` } });
        if (userId) await markActive(tx, userId, moments, false);
      });
    }
    return { accepted: rows.length, dropped: batch.events.length - rows.length };
  }

  /**
   * The admin's Analytics page. "Active" means a member opened the app or practised that day; "practice" means
   * playing a chapter or finishing a breath. Days are Indian days. Staff accounts aren't counted as members, and test
   * purchases aren't counted as purchases. Activity is read from the daily rollups (active_days, install_days), so
   * the page stays quick however many heartbeats there are.
   */
  async report(days: number) {
    const now = new Date();
    const today = localDay(now, BUSINESS_TIME_ZONE);
    const from = new Date(now.getTime() - days * 86_400_000).toISOString();
    // The series covers at least 30 days, because stickiness is always read over the last 30.
    const span = Math.max(days, 30);
    const tz = sql.raw(`'${BUSINESS_TIME_ZONE}'`);
    const rows = async <T>(query: SQL) => (await this.db.execute(query)).rows as T[];

    const joinedDay = sql`(u.created_at at time zone ${tz})::date`;
    const member = (column: string) => sql`not exists (select 1 from staff_roles s where s.user_id = ${sql.raw(column)})`;
    // The week-one table takes whole weeks, so it starts on the Monday on or before the window's first day.
    const weekStart = sql`date_trunc('week', ${from}::timestamptz at time zone ${tz}) at time zone ${tz}`;
    // One person per event: the member if signed in, or if the install was signed in on later; else the install.
    const people = (names: string[]) => sql`people as (
      select e.name, e.props, coalesce(e.user_id, i.user_id) as member, coalesce(e.user_id::text, i.user_id::text, e.anon_id) as person
      from events e left join installs i on i.anon_id = e.anon_id
      where e.name in (${sql.join(names.map((name) => sql`${name}`), sql`, `)}) and e.at >= ${from}::timestamptz
        and not exists (select 1 from staff_roles s where s.user_id = coalesce(e.user_id, i.user_id))
    )`;
    const sold = sql`select user_id, course_id from payments
      where kind = 'course' and not is_test and status in ('captured', 'partially_refunded') and captured_at >= ${from}::timestamptz`;

    const [daily, [totals], [activation], courseRows, [funnel], cohorts, topCourses, topTeachers] = await Promise.all([
      rows<{ day: string; members: unknown; guests: unknown }>(sql`
        with members as (
          select day, count(*) as n from active_days a where day > ${today}::date - ${span}::int and ${member('a.user_id')} group by day
        ), guests as (
          select day, count(*) as n from install_days where day > ${today}::date - ${span}::int and not signed_in group by day
        )
        select to_char(series.day, 'YYYY-MM-DD') as day, coalesce(m.n, 0) as members, coalesce(g.n, 0) as guests
        from generate_series(${today}::date - ${span - 1}::int, ${today}::date, interval '1 day') as series(day)
        left join members m on m.day = series.day::date left join guests g on g.day = series.day::date
        order by series.day`),
      rows<{ today: unknown; week: unknown; month: unknown }>(sql`
        select count(*) filter (where last = ${today}::date) as today, count(*) filter (where last > ${today}::date - 7) as week, count(*) as month
        from (select user_id, max(day) as last from active_days a where day > ${today}::date - 30 and ${member('a.user_id')} group by user_id) x`),
      rows<{ signups: unknown; practised: unknown; waiting: unknown }>(sql`
        with joined as (
          select ${joinedDay} as joined, exists (
            select 1 from active_days a where a.user_id = u.id and a.practised and a.day between ${joinedDay} and ${joinedDay} + 6
          ) as practised
          from users u where u.created_at >= ${from}::timestamptz and ${member('u.id')}
        )
        select count(*) as signups, count(*) filter (where practised) as practised,
          count(*) filter (where not practised and joined > ${today}::date - 7) as waiting
        from joined`),
      rows<{ title: string; slug: string; viewers: unknown; buyers: unknown }>(sql`
        with ${people(['course_view'])}, viewed as (
          select props->>'courseId' as course_id, count(distinct person) as viewers from people
          where coalesce(props->>'owned', 'false') <> 'true' group by 1
        ), bought as (
          select course_id::text as course_id, count(distinct user_id) as buyers from (${sold}) s group by 1
        )
        select c.title, c.slug, coalesce(v.viewers, 0) as viewers, coalesce(b.buyers, 0) as buyers
        from courses c left join viewed v on v.course_id = c.id::text left join bought b on b.course_id = c.id::text
        where c.price_point_id is not null and not c.is_free and (coalesce(v.viewers, 0) > 0 or coalesce(b.buyers, 0) > 0)
        order by viewers desc, buyers desc, c.title limit 10`),
      rows<{ locked: unknown; started: unknown; done: unknown }>(sql`
        with ${people(['locked_view', 'purchase_start'])}, locked as (select distinct person, member from people where name = 'locked_view')
        select (select count(*) from locked) as locked,
          (select count(distinct p.person) from people p join locked l on l.person = p.person where p.name = 'purchase_start') as started,
          (select count(*) from locked l where exists (select 1 from (${sold}) s where s.user_id = l.member)) as done`),
      rows<{ week: string; final: boolean; signups: unknown; returned: unknown }>(sql`
        select to_char(date_trunc('week', u.created_at at time zone ${tz}), 'YYYY-MM-DD') as week,
          (date_trunc('week', u.created_at at time zone ${tz}))::date + 14 <= ${today}::date as final,
          count(*) as signups,
          count(*) filter (where exists (
            select 1 from active_days a where a.user_id = u.id and a.day between ${joinedDay} + 1 and ${joinedDay} + 7
          )) as returned
        from users u where u.created_at >= ${weekStart} and ${member('u.id')}
        group by 1, 2 order by 1 desc`),
      rows<{ title: string; slug: string; seconds: unknown }>(sql`
        select c.title, c.slug, sum(w.seconds) as seconds
        from watch_daily w join chapters ch on ch.id = w.chapter_id join courses c on c.id = ch.course_id
        where w.date > ${today}::date - ${days}::int group by c.id, c.title, c.slug order by seconds desc, c.title limit 5`),
      rows<{ name: string; seconds: unknown; paise: unknown }>(sql`
        select i.display_name as name, coalesce(m.seconds, 0) as seconds, coalesce(e.paise, 0) as paise
        from instructors i
        left join (select instructor_id, sum(seconds) as seconds from watch_daily where date > ${today}::date - ${days}::int group by 1) m on m.instructor_id = i.id
        left join (
          select s.instructor_id, sum(s.instructor_paise) as paise from splits s join payments p on p.id = s.payment_id
          where s.state <> 'reversed' and p.captured_at >= ${from}::timestamptz group by 1
        ) e on e.instructor_id = i.id
        where coalesce(m.seconds, 0) > 0 or coalesce(e.paise, 0) > 0
        order by seconds desc, paise desc, i.display_name limit 5`),
    ]);

    const series = daily.map((d) => ({ day: d.day, members: n(d.members), guests: n(d.guests) }));
    const month = n(totals.month);
    const lastThirty = series.slice(-30);
    const averageDaily = lastThirty.reduce((sum, d) => sum + d.members, 0) / lastThirty.length;
    const viewers = courseRows.reduce((sum, c) => sum + n(c.viewers), 0);
    const buyers = courseRows.reduce((sum, c) => sum + n(c.buyers), 0);
    const signups = n(activation.signups);
    const practised = n(activation.practised);
    return {
      days,
      active: { today: n(totals.today), week: n(totals.week), month, stickinessBps: month ? Math.round((averageDaily / month) * 10_000) : 0, daily: series.slice(-days) },
      activation: { signups, practised, rateBps: rate(practised, signups), waiting: n(activation.waiting) },
      courses: {
        viewers,
        buyers,
        rateBps: rate(buyers, viewers),
        top: courseRows.map((c) => ({ title: c.title, slug: c.slug, viewers: n(c.viewers), buyers: n(c.buyers), rateBps: rate(n(c.buyers), n(c.viewers)) })),
      },
      lockedFunnel: { locked: n(funnel.locked), started: n(funnel.started), done: n(funnel.done) },
      weekOne: cohorts.map((c) => ({ week: c.week, final: Boolean(c.final), signups: n(c.signups), returned: n(c.returned), rateBps: rate(n(c.returned), n(c.signups)) })),
      topCourses: topCourses.map((c) => ({ title: c.title, slug: c.slug, minutes: Math.round(n(c.seconds) / 60) })),
      topTeachers: topTeachers.map((t) => ({ name: t.name, minutes: Math.round(n(t.seconds) / 60), earnedPaise: n(t.paise) })),
    };
  }
}

@ApiTags('analytics')
@Controller('v1')
export class EventsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Batches of events from the apps, signed in or not. Unknown event names are dropped, not refused. */
  @Post('events')
  @HttpCode(200)
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  record(@CurrentUser() me: AuthUser | undefined, @Body() body: unknown) {
    return this.analytics.record(me?.id ?? null, body);
  }
}

@ApiTags('admin')
@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class AnalyticsAdminController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('analytics')
  @Roles('finance', 'content')
  report(@Query('days') days?: string) {
    const window = Number(days ?? 30);
    if (![7, 30, 90].includes(window)) throw fail(400, 'invalid_days', 'Look at 7, 30 or 90 days.');
    return this.analytics.report(window);
  }
}

@Module({ imports: [AuthModule], controllers: [EventsController, AnalyticsAdminController], providers: [AnalyticsService] })
export class AnalyticsModule {}
