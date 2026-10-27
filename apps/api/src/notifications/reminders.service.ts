import { Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { Db, InjectDb } from '../db/db.module';
import { devices, reminderLog } from '../db/schema';
import { localClock } from './local-time';
import { PushService } from './push.service';

const HOUR = 3_600_000;
/** A reminder more than two hours late (the server was down) is skipped, not sent at an odd hour. */
const LATE_LIMIT_MINUTES = 120;

/** What the daily reminder says. It changes with the day of the month, so it doesn't read the same every morning. */
const LINES = [
  { title: 'Two minutes for you', body: "Today's breath is ready. Eyes closed if you like." },
  { title: 'A pause before the day runs on', body: 'Box breathing takes two minutes. Start when you are ready.' },
  { title: 'Still time today', body: 'One slow breath, then another. Your practice is a tap away.' },
  { title: 'Your mat can be anywhere', body: 'Sit where you are. Today’s breath takes a couple of minutes.' },
];

@Injectable()
export class RemindersService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly push: PushService,
  ) {}

  /**
   * The daily practice reminder, at the time each member chose, on their own clock. Members who have already
   * practised that day (a breath, or a chapter that played) aren't reminded. Someone partway through a course is
   * pointed back to it; everyone else to today's breath.
   */
  async run(now: Date) {
    const since = new Date(now.getTime() - 20 * HOUR).toISOString();
    const candidates = (
      await this.db.execute(sql`
        select u.id, u.timezone, p.reminder_time from users u join user_preferences p on p.user_id = u.id
        where u.status = 'active' and p.reminder_time is not null
          and exists (select 1 from devices d where d.user_id = u.id)
          and not exists (select 1 from reminder_log r where r.user_id = u.id and r.at > ${since}::timestamptz)`)
    ).rows as { id: string; timezone: string | null; reminder_time: string }[];

    const due = candidates.flatMap((c) => {
      const clock = localClock(now, c.timezone);
      const [hour, minute] = c.reminder_time.split(':').map(Number);
      const late = clock.minutes - (hour * 60 + minute);
      if (late < 0 || late >= LATE_LIMIT_MINUTES) return [];
      return [{ userId: c.id, day: clock.day, since: new Date(now.getTime() - (clock.minutes * 60 + clock.seconds) * 1000).toISOString() }];
    });
    if (!due.length) return 0;

    const practised = new Set(
      (
        (
          await this.db.execute(sql`
            select d.user_id::text as user_id from jsonb_to_recordset(${JSON.stringify(due.map((d) => ({ user_id: d.userId, since: d.since })))}::jsonb) as d(user_id uuid, since timestamptz)
            where exists (select 1 from breathing_sessions b where b.user_id = d.user_id and b.completed_at >= d.since)
               or exists (select 1 from playback_events p where p.user_id = d.user_id and p.at >= d.since and p.seconds > 0)`)
        ).rows as { user_id: string }[]
      ).map((r) => r.user_id),
    );
    // Claiming the member's day first means two servers never remind anyone twice.
    const claimed = await this.db
      .insert(reminderLog)
      .values(due.map((d) => ({ userId: d.userId, day: d.day, sent: !practised.has(d.userId), at: now })))
      .onConflictDoNothing()
      .returning({ userId: reminderLog.userId, day: reminderLog.day, sent: reminderLog.sent });
    const toRemind = claimed.filter((c) => c.sent);
    if (!toRemind.length) return 0;

    const ids = toRemind.map((c) => c.userId);
    const [phones, courses] = await Promise.all([
      this.db.select({ userId: devices.userId, token: devices.pushToken }).from(devices).where(inArray(devices.userId, ids)),
      this.db.execute(sql`
        select distinct on (cp.user_id) cp.user_id::text as user_id, c.title, c.slug
        from chapter_progress cp join chapters ch on ch.id = cp.chapter_id join courses c on c.id = ch.course_id
        where cp.user_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and cp.completed_at is null and c.status = 'published'
          and cp.updated_at > ${new Date(now.getTime() - 14 * 24 * HOUR).toISOString()}::timestamptz
        order by cp.user_id, cp.updated_at desc`),
    ]);
    const course = new Map((courses.rows as { user_id: string; title: string; slug: string }[]).map((r) => [r.user_id, r]));
    const day = new Map(toRemind.map((c) => [c.userId, Number(c.day.slice(8, 10))]));
    return this.push.send(
      phones.map(({ userId, token }) => {
        const inCourse = course.get(userId);
        if (inCourse) return { to: token, title: 'Pick up where you left off', body: `${inCourse.title} is waiting for you.`, data: { url: `/course/${inCourse.slug}` } };
        const line = LINES[(day.get(userId) ?? 0) % LINES.length];
        return { to: token, title: line.title, body: line.body, data: { url: '/breathe' } };
      }),
    );
  }
}
