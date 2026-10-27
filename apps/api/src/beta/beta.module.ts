import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { count, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { clientTime } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { audit } from '../common/audit';
import { AuthGuard, AuthUser, CurrentUser, OptionalAuthGuard, Roles, StaffGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { appErrors, feedback, users } from '../db/schema';
import { MailService } from '../mail/mail.service';
import { INDIAN_STATES } from '../money/gst';
import { MoneyModule } from '../money/money.module';
import { ReconciliationService } from '../money/reconciliation.service';

type Platform = 'ios' | 'android' | 'web';
const PLATFORMS = new Set(['ios', 'android', 'web']);
const MAX_REPORTS = 10;
/** Crash reports are for fixing the app, not a history of anyone's phone: they go after this long. */
export const KEEP_ERRORS_DAYS = 90;

/** A trimmed string, cut to length, or null if there's nothing there. */
const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * Error messages sometimes quote what was being worked on, an email address included. Those never reach the table.
 * Stack frames like render@https://… don't look like addresses to this, so stacks keep their file names.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const scrub = (value: string | null) => value && value.replace(EMAIL, '[email]');

/** The start of a message on one line, cut at a word, for an email subject. */
function gist(message: string, max: number) {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/** Which phone and app a report came from. The app sends the same four things with every report and every message. */
function source(body: Record<string, unknown>) {
  if (typeof body.platform !== 'string' || !PLATFORMS.has(body.platform)) throw fail(400, 'invalid_request', 'platform should be ios, android or web.');
  return {
    platform: body.platform as Platform,
    appVersion: text(body.appVersion, 32),
    osVersion: text(body.osVersion, 32),
    device: text(body.device, 80),
  };
}

/**
 * What makes two reports the same problem: the kind, the message with its numbers and IDs taken out (any word with
 * a digit in it), and the function at the top of the stack. Line numbers are left out, because they move with every
 * build.
 */
export function fingerprint(kind: string, message: string, stack: string | null) {
  const words = message.replace(/[\w-]*\d[\w-]*/g, '#').slice(0, 200);
  const frame = (stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^at\s+\S/.test(line) || /^[^\s@]+@/.test(line));
  const name = frame ? (/^at\s+([^\s(]+)/.exec(frame)?.[1] ?? /^([^@]+)@/.exec(frame)?.[1] ?? '') : '';
  return createHash('sha1').update(`${kind}|${words}|${name}`).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ Crash and error reports */

@Injectable()
export class AppErrorsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AppErrors');
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    const run = () => void this.prune().catch((error) => this.logger.warn(`Clearing old crash reports failed: ${error}`));
    this.timer = setInterval(run, 6 * 60 * 60_000);
    this.timer.unref();
    setTimeout(run, 120_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Deletes reports older than 90 days. Returns how many. */
  async prune(now = new Date()) {
    const gone = await this.db
      .delete(appErrors)
      .where(lt(appErrors.at, new Date(now.getTime() - KEEP_ERRORS_DAYS * 86_400_000)))
      .returning({ id: appErrors.id });
    return gone.length;
  }

  /** Reports from one phone. A crash was saved as it happened and arrives with the next launch. */
  async record(userId: string | null, raw: unknown) {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.anonId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.anonId)) throw fail(400, 'invalid_request', 'anonId should be the random ID the app made.');
    if (!Array.isArray(body.reports) || body.reports.length > MAX_REPORTS) throw fail(400, 'invalid_request', `Send between 0 and ${MAX_REPORTS} reports at a time.`);
    const from = source(body);
    const anonId = body.anonId;
    const rows = (body.reports as Record<string, unknown>[])
      .filter((report) => report && (report.kind === 'crash' || report.kind === 'error'))
      .map((report) => {
        const kind = report.kind as 'crash' | 'error';
        const message = scrub(text(report.message, 1000)) ?? 'An error with no message';
        const stack = scrub(text(report.stack, 8000));
        return {
          kind,
          fingerprint: fingerprint(kind, message, stack),
          message,
          stack,
          screen: text(report.screen, 200),
          ...from,
          // A crash is sent on the next launch, which may be after an update: it carries the version it happened on.
          appVersion: text(report.appVersion, 32) ?? from.appVersion,
          anonId,
          userId,
          clientAt: clientTime(report.at),
        };
      });
    if (rows.length) await this.db.insert(appErrors).values(rows);
    return { accepted: rows.length };
  }
}

/* ------------------------------------------------------------------ Feedback */

@Injectable()
export class FeedbackService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** A message from You, Feedback in the app. It lands on admin's Feedback page and, if set, in an inbox. */
  async send(userId: string, raw: unknown) {
    const body = (raw ?? {}) as Record<string, unknown>;
    const message = text(body.message, 2000);
    if (!message || message.length < 3) throw fail(400, 'invalid_request', 'Write a few words first.');
    const from = source(body);
    const [row] = await this.db
      .insert(feedback)
      .values({ userId, message, screen: text(body.screen, 200), ...from })
      .returning();
    if (this.env.FEEDBACK_EMAIL) {
      const [member] = await this.db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
      const system = from.platform === 'ios' ? `iOS ${from.osVersion ?? ''}`.trim() : from.platform === 'android' ? `Android ${from.osVersion ?? ''}`.trim() : null;
      const where =
        from.platform === 'web'
          ? `Web app ${from.appVersion ?? '?'}${from.device ? ` on ${from.device}` : ''}`
          : `App ${from.appVersion ?? '?'} on ${[from.device, system].filter(Boolean).join(', ')}`;
      // A failed email never loses the message: it's on the Feedback page either way.
      await this.mail
        .send({
          to: this.env.FEEDBACK_EMAIL,
          replyTo: member.email,
          subject: `Feedback from ${member.name ?? member.email}: ${gist(message, 60)}`,
          text: [message, '', `From ${member.name ? `${member.name}, ` : ''}${member.email}`, `${where}${row.screen ? `, on ${row.screen}` : ''}`, '', 'Reply to this email to answer them.'].join('\n'),
        })
        .catch(() => undefined);
    }
    return { id: row.id, received: true };
  }

  /** Newest first, open ones only unless asked for everything. */
  async list(all: boolean) {
    const rows = await this.db
      .select({ feedback, email: users.email, name: users.name })
      .from(feedback)
      .innerJoin(users, eq(users.id, feedback.userId))
      .where(all ? undefined : isNull(feedback.handledAt))
      .orderBy(desc(feedback.createdAt))
      .limit(200);
    const [open] = await this.db.select({ n: count() }).from(feedback).where(isNull(feedback.handledAt));
    return {
      open: open.n,
      items: rows.map(({ feedback: f, email, name }) => ({
        id: f.id,
        message: f.message,
        member: { email, name },
        screen: f.screen,
        platform: f.platform,
        appVersion: f.appVersion,
        osVersion: f.osVersion,
        device: f.device,
        at: f.createdAt,
        handledAt: f.handledAt,
      })),
    };
  }

  async setHandled(actorId: string, id: string, handled: boolean) {
    const [row] = await this.db
      .update(feedback)
      .set(handled ? { handledAt: new Date(), handledBy: actorId } : { handledAt: null, handledBy: null })
      .where(eq(feedback.id, id))
      .returning({ id: feedback.id, handledAt: feedback.handledAt });
    if (!row) throw fail(404, 'not_found', 'No such message.');
    await audit(this.db, { actorId, action: handled ? 'feedback.handled' : 'feedback.reopened', entityType: 'feedback', entityId: id });
    return row;
  }
}

/* ------------------------------------------------------------------ The launch bars */

/** The spec's launch bars, and how much data each needs before it says anything. */
export const BARS = {
  crashFreeBps: 9950,
  minSessions: 100,
  videoStartMs: 2000,
  minStarts: 30,
} as const;

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * How the beta is going against the launch bars, measured from what the apps send:
 * - crash-free sessions: app opens (each launch, and each return after the app was in the background) against
 *   crashes, on iOS and Android;
 * - video start: how long a chapter took to show its first frame, at the 90th percentile, on 4G in the phone apps;
 * - a switched-off teacher subscription: nobody charged again after the teacher switched it off. This one looks at
 *   every switch-off so far, not just the window, because a renewal can be a month away;
 * - reconciliation: every real sale reported by its channel and matching the books (ReconciliationService.launchBar).
 * Everyone's counted, staff included: this is about the app, not the audience.
 */
@Injectable()
export class BetaHealthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async report(days: number) {
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = async <T>(query: SQL) => (await this.db.execute(query)).rows as T[];
    const percentiles = sql`count(*) as n, percentile_cont(0.5) within group (order by ms) as p50, percentile_cont(0.9) within group (order by ms) as p90`;
    // One row per video start, with the connection it was on and where the member lives. A browser can't tell
    // mobile data from Wi-Fi reliably, so the web is a group of its own. Anyone can send events, so a time that isn't
    // a number, or is below zero or over ten minutes, is left out rather than allowed to break the page. A chapter
    // played from a download never touched the network, so it says nothing about streaming and is left out too.
    const ms = (prop: string) => sql.raw(`case when jsonb_typeof(e.props->'${prop}') = 'number' then (e.props->>'${prop}')::numeric end`);
    const starts = sql`starts as (
      select * from (
      select ${ms('ms')} as ms, ${ms('apiMs')} as api_ms, coalesce(e.props->>'abandoned', 'false') = 'true' as abandoned,
        case
          when e.platform = 'web' then 'Web browser'
          when e.props->>'network' = 'wifi' then 'Wi-Fi'
          when e.props->>'generation' = '4g' then '4G'
          when e.props->>'generation' = '5g' then '5G'
          when e.props->>'network' = 'cellular' then 'Other mobile data'
          else 'Not known'
        end as connection,
        case when u.country = 'IN' and u.state is not null then u.state when u.country is not null and u.country <> 'IN' then 'abroad' else null end as place
      from events e left join installs i on i.anon_id = e.anon_id left join users u on u.id = coalesce(e.user_id, i.user_id)
      where e.name = 'video_start' and e.at >= ${from}::timestamptz and coalesce(e.props->>'saved', 'false') <> 'true'
      ) s where ms between 0 and 600000
    )`;
    // Someone who gave up after waiting longer than the bar had a slow start, whatever it would have been; someone
    // who left sooner tells us nothing about speed.
    const counted = sql`(not abandoned or ms > ${BARS.videoStartMs})`;

    const [sessions, crashes, problems, videoAll, videoByConnection, videoByPlace, [videoMisc], switchOffs, [feedbackOpen], reconciliation] = await Promise.all([
      rows<{ platform: string; version: string; n: unknown }>(sql`
        select platform, coalesce(app_version, '') as version, count(*) as n from events
        where name = 'app_open' and platform in ('ios', 'android') and at >= ${from}::timestamptz group by 1, 2`),
      rows<{ platform: string; version: string; n: unknown }>(sql`
        select platform, coalesce(app_version, '') as version, count(*) as n from app_errors
        where kind = 'crash' and platform in ('ios', 'android') and at >= ${from}::timestamptz group by 1, 2`),
      rows<{
        fingerprint: string;
        kind: 'crash' | 'error';
        reports: unknown;
        installs: unknown;
        first_seen: string;
        last_seen: string;
        platforms: string[];
        versions: (string | null)[];
        message: string;
        stack: string | null;
        screen: string | null;
      }>(sql`
        select fingerprint, min(kind) as kind, count(*) as reports, count(distinct anon_id) as installs, min(at) as first_seen, max(at) as last_seen,
          array_agg(distinct platform) as platforms, array_agg(distinct app_version) as versions,
          (array_agg(message order by at desc))[1] as message, (array_agg(stack order by at desc))[1] as stack, (array_agg(screen order by at desc))[1] as screen
        from app_errors where at >= ${from}::timestamptz
        group by fingerprint order by min(kind) = 'crash' desc, count(*) desc limit 30`),
      rows<{ n: unknown; p50: unknown; p90: unknown; api_p50: unknown }>(sql`
        with ${starts} select ${percentiles}, percentile_cont(0.5) within group (order by api_ms) as api_p50 from starts where ${counted}`),
      rows<{ connection: string; n: unknown; p50: unknown; p90: unknown }>(sql`
        with ${starts} select connection, ${percentiles} from starts where ${counted} group by connection order by count(*) desc, connection`),
      rows<{ place: string; n: unknown; p50: unknown; p90: unknown }>(sql`
        with ${starts} select place, ${percentiles} from starts where ${counted} and place is not null group by place order by count(*) desc, place limit 12`),
      rows<{ abandoned: unknown; gave_up_slow: unknown; errors: unknown; casts: unknown; cast_errors: unknown }>(sql`
        with ${starts} select (select count(*) from starts where abandoned) as abandoned,
          (select count(*) from starts where abandoned and ms > ${BARS.videoStartMs}) as gave_up_slow,
          (select count(*) from events where name = 'video_error' and at >= ${from}::timestamptz) as errors,
          (select count(*) from events where name = 'cast_start' and at >= ${from}::timestamptz) as casts,
          (select count(*) from events where name = 'cast_error' and at >= ${from}::timestamptz) as cast_errors`),
      rows<{ name: string; off_at: string; on_again: string | null; due: Record<string, unknown>; charged: Record<string, unknown>; tests: unknown }>(sql`
        with offs as (
          select a.id as off_id, a.entity_id as instructor_id, a.at as off_at,
            (select min(b.at) from audit_log b where b.action = 'studio.plan' and b.entity_id = a.entity_id and b.at > a.at and b.after->>'enabled' = 'true') as on_again
          from audit_log a
          where a.action = 'studio.plan' and a.after->>'enabled' = 'false' and a.before->>'enabled' = 'true'
          order by a.at desc limit 20
        ),
        -- Subscriptions that were paid up at the switch-off and whose paid month has ended since: each one is a
        -- renewal that would have been charged if the switch-off hadn't worked.
        due as (
          select o.off_id, s.channel from offs o join instructor_subscriptions s on s.instructor_id::text = o.instructor_id
          where s.created_at < o.off_at and s.current_period_end > o.off_at and s.current_period_end <= coalesce(o.on_again, now()) and s.current_period_end <= now()
        ),
        charged as (
          select o.off_id, p.channel, p.is_test from offs o join payments p on p.instructor_id::text = o.instructor_id
          where p.kind = 'subscription' and p.captured_at > o.off_at and (o.on_again is null or p.captured_at < o.on_again)
        )
        select ins.display_name as name, o.off_at, o.on_again,
          (select coalesce(json_object_agg(channel, n), '{}') from (select channel, count(*) as n from due d where d.off_id = o.off_id group by channel) x) as due,
          (select coalesce(json_object_agg(channel, n), '{}') from (select channel, count(*) as n from charged c where c.off_id = o.off_id group by channel) x) as charged,
          (select count(*) from charged c where c.off_id = o.off_id and c.is_test) as tests
        from offs o join instructors ins on ins.id::text = o.instructor_id
        order by o.off_at desc`),
      rows<{ n: unknown }>(sql`select count(*) as n from feedback where handled_at is null`),
      this.reconciliation.launchBar(days),
    ]);

    // Crash-free sessions, overall and by platform and version.
    const key = (r: { platform: string; version: string }) => `${r.platform}|${r.version}`;
    const crashCount = new Map(crashes.map((r) => [key(r), Number(r.n)]));
    const versions = new Map<string, { platform: string; version: string; sessions: number; crashes: number }>();
    for (const r of sessions) versions.set(key(r), { platform: r.platform, version: r.version, sessions: Number(r.n), crashes: crashCount.get(key(r)) ?? 0 });
    for (const r of crashes) if (!versions.has(key(r))) versions.set(key(r), { platform: r.platform, version: r.version, sessions: 0, crashes: Number(r.n) });
    const crashFree = (s: number, c: number) => (s ? Math.max(0, Math.round((1 - c / s) * 10_000)) : null);
    const byVersion = [...versions.values()].sort((a, b) => b.sessions - a.sessions).map((v) => ({ ...v, crashFreeBps: crashFree(v.sessions, v.crashes) }));
    const byPlatform = ['ios', 'android'].map((platform) => {
      const mine = byVersion.filter((v) => v.platform === platform);
      const s = mine.reduce((sum, v) => sum + v.sessions, 0);
      const c = mine.reduce((sum, v) => sum + v.crashes, 0);
      return { platform, sessions: s, crashes: c, crashFreeBps: crashFree(s, c) };
    });
    const totalSessions = byPlatform.reduce((sum, p) => sum + p.sessions, 0);
    const totalCrashes = byPlatform.reduce((sum, p) => sum + p.crashes, 0);
    const crashFreeBps = crashFree(totalSessions, totalCrashes);

    // Video starts: the bar is the 90th percentile on 4G.
    const group = (r: { n: unknown; p50: unknown; p90: unknown }) => ({ starts: Number(r.n), p50Ms: num(r.p50) === null ? null : Math.round(num(r.p50)!), p90Ms: num(r.p90) === null ? null : Math.round(num(r.p90)!) });
    const connections = videoByConnection.map((r) => ({ connection: r.connection, ...group(r) }));
    const fourG = connections.find((c) => c.connection === '4G');

    // The beta runs on test purchases (TestFlight's sandbox, Play's license testers), which renew every few minutes,
    // so those count here: they're how the switch-off gets tested before real money does.
    const byChannel = (counts: Record<string, unknown>) => ({ website: Number(counts.razorpay ?? 0), appStore: Number(counts.apple ?? 0), googlePlay: Number(counts.google ?? 0) });
    const total = (c: ReturnType<typeof byChannel>) => c.website + c.appStore + c.googlePlay;
    const offs = switchOffs.map((o) => ({
      instructor: o.name,
      offAt: o.off_at,
      onAgainAt: o.on_again,
      renewalsDue: byChannel(o.due),
      chargedAfter: byChannel(o.charged),
      testCharges: Number(o.tests),
    }));
    const chargedAfter = offs.reduce((sum, o) => sum + total(o.chargedAfter), 0);
    const renewalsTested = offs.reduce((sum, o) => sum + total(o.renewalsDue) + total(o.chargedAfter), 0);

    return {
      days,
      bars: {
        crashFree: {
          valueBps: crashFreeBps,
          targetBps: BARS.crashFreeBps,
          minSessions: BARS.minSessions,
          sessions: totalSessions,
          crashes: totalCrashes,
          enough: totalSessions >= BARS.minSessions,
          met: totalSessions >= BARS.minSessions && crashFreeBps !== null && crashFreeBps >= BARS.crashFreeBps,
        },
        videoStart: {
          p90Ms: fourG?.p90Ms ?? null,
          targetMs: BARS.videoStartMs,
          minStarts: BARS.minStarts,
          starts: fourG?.starts ?? 0,
          enough: (fourG?.starts ?? 0) >= BARS.minStarts,
          met: (fourG?.starts ?? 0) >= BARS.minStarts && fourG!.p90Ms !== null && fourG!.p90Ms <= BARS.videoStartMs,
        },
        switchOff: { switchOffs: offs.length, renewalsTested, chargedAfter, enough: renewalsTested > 0, met: renewalsTested > 0 && chargedAfter === 0 },
        reconciliation,
      },
      crashes: { byPlatform, byVersion },
      problems: problems.map((p) => ({
        fingerprint: p.fingerprint,
        kind: p.kind,
        reports: Number(p.reports),
        installs: Number(p.installs),
        firstSeen: p.first_seen,
        lastSeen: p.last_seen,
        platforms: p.platforms,
        versions: p.versions.filter(Boolean),
        message: p.message,
        stack: p.stack,
        screen: p.screen,
      })),
      video: {
        overall: { ...group(videoAll[0] ?? { n: 0, p50: null, p90: null }), apiP50Ms: num(videoAll[0]?.api_p50) === null ? null : Math.round(num(videoAll[0]?.api_p50)!) },
        byConnection: connections,
        byPlace: videoByPlace.map((r) => ({ place: r.place === 'abroad' ? 'Outside India' : (INDIAN_STATES[r.place] ?? r.place), ...group(r) })),
        abandoned: Number(videoMisc?.abandoned ?? 0),
        gaveUpSlow: Number(videoMisc?.gave_up_slow ?? 0),
        errors: Number(videoMisc?.errors ?? 0),
        // Chapters sent to a TV, and the times a TV couldn't play one: many of those at once usually means Bunny turning
        // the TV away (CORS, or an allowed-domains list).
        casts: Number(videoMisc?.casts ?? 0),
        castErrors: Number(videoMisc?.cast_errors ?? 0),
      },
      switchOffs: offs,
      feedbackOpen: Number(feedbackOpen?.n ?? 0),
    };
  }
}

/* ------------------------------------------------------------------ Routes */

@ApiTags('beta')
@Controller('v1')
export class BetaController {
  constructor(
    private readonly errors: AppErrorsService,
    private readonly feedbackService: FeedbackService,
  ) {}

  /** Crash and error reports from the apps, signed in or not. */
  @Post('app-errors')
  @HttpCode(200)
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  report(@CurrentUser() me: AuthUser | undefined, @Body() body: unknown) {
    return this.errors.record(me?.id ?? null, body);
  }

  @Post('feedback')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  feedback(@CurrentUser() me: AuthUser, @Body() body: unknown) {
    return this.feedbackService.send(me.id, body);
  }
}

@ApiTags('admin')
@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class BetaAdminController {
  constructor(
    private readonly health: BetaHealthService,
    private readonly feedbackService: FeedbackService,
  ) {}

  /** Every staff role: the whole team watches the beta. */
  @Get('beta')
  report(@Query('days') days?: string) {
    const window = Number(days ?? 14);
    if (![7, 14, 30].includes(window)) throw fail(400, 'invalid_days', 'Look at 7, 14 or 30 days.');
    return this.health.report(window);
  }

  @Get('feedback')
  @Roles('support', 'content')
  feedback(@Query('all') all?: string) {
    return this.feedbackService.list(all === '1' || all === 'true');
  }

  @Post('feedback/:id/handled')
  @HttpCode(200)
  @Roles('support', 'content')
  handled(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() body: { handled?: unknown }) {
    return this.feedbackService.setHandled(me.id, id, body?.handled !== false);
  }
}

@Module({
  imports: [AuthModule, MoneyModule],
  controllers: [BetaController, BetaAdminController],
  providers: [AppErrorsService, FeedbackService, BetaHealthService],
  exports: [BetaHealthService],
})
export class BetaModule {}
