import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { markActive } from '../analytics/rollup';
import { AccessService } from '../catalogue/access.service';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import { breathingPatterns, breathingSessions, chapterProgress, chapters, courses, playbackEvents, users, watchDaily } from '../db/schema';
import { BreathingSessionDto, HeartbeatEventDto } from './practice.dto';
import { localDay, streakDays } from './streak';

/** A chapter counts as finished once the player passes 95% of it; nobody sits through the closing credits. */
const COMPLETE_AT = 0.95;
const FUTURE_SLACK_MS = 10 * 60_000;
const OLDEST_HEARTBEAT_MS = 30 * 86_400_000;

/**
 * Saves where the member is in a chapter, as of `at`, when the device recorded it. A phone that played a download
 * offline sends its heartbeats days later, after newer ones from other devices may have arrived, so a position
 * only replaces one recorded earlier. Reaching the end counts whenever it arrives.
 */
function upsertProgress(executor: Pick<Db, 'insert'>, userId: string, chapterId: string, positionS: number, completed: boolean, at = new Date()) {
  const now = new Date();
  const when = at > now ? now : at; // a phone whose clock runs fast
  return executor
    .insert(chapterProgress)
    .values({ userId, chapterId, positionS, completedAt: completed ? now : null, updatedAt: when })
    .onConflictDoUpdate({
      target: [chapterProgress.userId, chapterProgress.chapterId],
      set: {
        positionS: sql`case when excluded.updated_at >= ${chapterProgress.updatedAt} then excluded.position_s else ${chapterProgress.positionS} end`,
        updatedAt: sql`greatest(excluded.updated_at, ${chapterProgress.updatedAt})`,
        ...(completed ? { completedAt: sql`coalesce(${chapterProgress.completedAt}, now())` } : {}),
      },
    });
}

@Injectable()
export class PracticeService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  patterns() {
    return this.db
      .select({
        id: breathingPatterns.id,
        slug: breathingPatterns.slug,
        name: breathingPatterns.name,
        description: breathingPatterns.description,
        inhaleS: breathingPatterns.inhaleS,
        holdInS: breathingPatterns.holdInS,
        exhaleS: breathingPatterns.exhaleS,
        holdOutS: breathingPatterns.holdOutS,
        rounds: breathingPatterns.rounds,
      })
      .from(breathingPatterns)
      .where(eq(breathingPatterns.active, true))
      .orderBy(asc(breathingPatterns.sort));
  }

  async logBreathing(userId: string, dto: BreathingSessionDto) {
    if (dto.patternId) {
      const [pattern] = await this.db.select({ id: breathingPatterns.id }).from(breathingPatterns).where(eq(breathingPatterns.id, dto.patternId)).limit(1);
      if (!pattern) throw fail(400, 'unknown_pattern', 'That breathing pattern no longer exists.');
    }
    await this.db.transaction(async (tx) => {
      await tx.insert(breathingSessions).values({ userId, patternId: dto.patternId ?? null, seconds: dto.seconds });
      await markActive(tx, userId, [new Date()], true);
    });
    return this.stats(userId);
  }

  /** Streak, minutes and sessions. Days are counted in the member's own time zone. */
  async stats(userId: string) {
    const timeZone = await this.timeZoneOf(userId);
    const since = new Date(Date.now() - 400 * 86_400_000);
    const [breaths, watchedDays, [breathTotals], [watchTotals]] = await Promise.all([
      this.db
        .select({ at: breathingSessions.completedAt })
        .from(breathingSessions)
        .where(and(eq(breathingSessions.userId, userId), gt(breathingSessions.completedAt, since))),
      this.db
        .selectDistinct({ date: watchDaily.date })
        .from(watchDaily)
        .where(and(eq(watchDaily.userId, userId), gt(watchDaily.date, localDay(since, timeZone)))),
      this.db
        .select({ seconds: sql<number>`coalesce(sum(${breathingSessions.seconds}), 0)`.mapWith(Number), sessions: count() })
        .from(breathingSessions)
        .where(eq(breathingSessions.userId, userId)),
      this.db
        .select({ seconds: sql<number>`coalesce(sum(${watchDaily.seconds}), 0)`.mapWith(Number) })
        .from(watchDaily)
        .where(eq(watchDaily.userId, userId)),
    ]);
    const today = localDay(new Date(), timeZone);
    const days = new Set([...breaths.map((b) => localDay(b.at, timeZone)), ...watchedDays.map((w) => w.date)]);
    return {
      streakDays: streakDays(days, today),
      practicedToday: days.has(today),
      totalMinutes: Math.floor((breathTotals.seconds + watchTotals.seconds) / 60),
      breathingSessions: breathTotals.sessions,
    };
  }

  /**
   * Heartbeats feed resume, completion, streaks and instructor analytics. Ones for chapters the member
   * can't play, or with clocks far off, are dropped rather than rejected, so a bad one never blocks a batch.
   */
  async heartbeats(userId: string, events: HeartbeatEventDto[]) {
    const now = Date.now();
    const timely = events.filter((e) => {
      const at = Date.parse(e.at);
      return at <= now + FUTURE_SLACK_MS && at >= now - OLDEST_HEARTBEAT_MS;
    });
    const playable = await this.playableChapters(userId, [...new Set(timely.map((e) => e.chapterId))]);
    const accepted = timely.filter((e) => playable.has(e.chapterId));

    if (accepted.length) {
      const timeZone = await this.timeZoneOf(userId);
      await this.db.transaction(async (tx) => {
        await tx
          .insert(playbackEvents)
          .values(accepted.map((e) => ({ userId, chapterId: e.chapterId, positionS: e.positionS, seconds: e.seconds, at: new Date(e.at) })));
        // A day counts as practised once something actually played, not for a paused player's heartbeat.
        await markActive(tx, userId, accepted.filter((e) => e.seconds > 0).map((e) => new Date(e.at)), true);

        for (const chapterId of new Set(accepted.map((e) => e.chapterId))) {
          const mine = accepted.filter((e) => e.chapterId === chapterId);
          const latest = mine.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
          const { durationS, instructorId } = playable.get(chapterId)!;
          const completed = durationS ? latest.positionS >= durationS * COMPLETE_AT : false;
          await upsertProgress(tx, userId, chapterId, latest.positionS, completed, new Date(latest.at));

          const secondsByDay = new Map<string, number>();
          for (const e of mine) {
            const day = localDay(new Date(e.at), timeZone);
            secondsByDay.set(day, (secondsByDay.get(day) ?? 0) + e.seconds);
          }
          for (const [date, seconds] of secondsByDay) {
            if (!seconds) continue;
            await tx
              .insert(watchDaily)
              .values({ userId, chapterId, instructorId, date, seconds })
              .onConflictDoUpdate({
                target: [watchDaily.userId, watchDaily.chapterId, watchDaily.date],
                set: { seconds: sql`${watchDaily.seconds} + ${seconds}` },
              });
          }
        }
      });
    }
    return { accepted: accepted.length, ignored: events.length - accepted.length };
  }

  async complete(userId: string, chapterId: string) {
    const playable = await this.playableChapters(userId, [chapterId]);
    const chapter = playable.get(chapterId);
    if (!chapter) throw fail(404, 'not_found', 'There is no chapter at that address that you can play.');
    await upsertProgress(this.db, userId, chapterId, chapter.durationS ?? 0, true);
    return { completed: true };
  }

  private async playableChapters(userId: string, chapterIds: string[]) {
    const playable = new Map<string, { durationS: number | null; instructorId: string }>();
    if (!chapterIds.length) return playable;
    const rows = await this.db
      .select({ chapter: chapters, course: courses })
      .from(chapters)
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .where(inArray(chapters.id, chapterIds));
    const access = await this.access.forCourses(userId, rows.map((r) => r.course));
    for (const { chapter, course } of rows) {
      const own = access.get(course.id) === 'instructor';
      if (course.status !== 'published' && !own) continue;
      if (chapter.isPreview || access.has(course.id)) {
        playable.set(chapter.id, { durationS: chapter.durationS, instructorId: course.instructorId });
      }
    }
    return playable;
  }

  private async timeZoneOf(userId: string) {
    const [row] = await this.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.timezone ?? 'UTC';
  }
}
