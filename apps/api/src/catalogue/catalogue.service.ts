import { Inject, Injectable } from '@nestjs/common';
import { SQL, and, asc, count, desc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { escapeLike } from '../common/audit';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { BunnyService } from '../media/bunny.service';
import {
  breathingPatterns,
  categories,
  chapterProgress,
  chapters,
  courses,
  dailyContent,
  entitlements,
  instructors,
  instructorSubscriptions,
  mediaAssets,
  pricePoints,
  searchLog,
  topics,
} from '../db/schema';
import { downloadable, downloadSizes } from '../downloads/files';
import { AccessService } from './access.service';
import { Viewer, priceIn } from './price';

const rating = (course: { ratingAvg: string | null; ratingCount: number }) => ({
  average: course.ratingAvg === null ? null : Number(course.ratingAvg),
  count: course.ratingCount,
});

@Injectable()
export class CatalogueService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly access: AccessService,
    private readonly bunny: BunnyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async categories() {
    const [categoryRows, topicRows, counts] = await Promise.all([
      this.db.select().from(categories).where(eq(categories.active, true)).orderBy(asc(categories.sort), asc(categories.name)),
      this.db.select().from(topics).where(eq(topics.active, true)).orderBy(asc(topics.sort), asc(topics.name)),
      this.db
        .select({ topicId: courses.topicId, n: count() })
        .from(courses)
        .where(eq(courses.status, 'published'))
        .groupBy(courses.topicId),
    ]);
    const coursesIn = new Map(counts.map((row) => [row.topicId, row.n]));
    return categoryRows.map((category) => ({
      slug: category.slug,
      name: category.name,
      icon: category.icon,
      topics: topicRows
        .filter((topic) => topic.categoryId === category.id)
        .map((topic) => ({ slug: topic.slug, name: topic.name, coverUrl: topic.coverUrl, courseCount: coursesIn.get(topic.id) ?? 0 })),
    }));
  }

  /** The photo of the day. Its link is signed for a day and changes only on the hour, so phones can cache the picture. */
  private dailyImage(row?: { item: typeof dailyContent.$inferSelect; media: typeof mediaAssets.$inferSelect | null }) {
    if (!row?.media || row.media.status !== 'ready') return null;
    if (row.media.provider === 'dev_sample' && this.env.NODE_ENV === 'production') return null; // local stand-ins never reach members
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const url = row.media.provider === 'dev_sample' ? row.media.hostAssetId : this.bunny.signedAudio(row.media.hostAssetId, 26 * 3600, hour).url;
    return { url, caption: row.item.text, credit: row.item.author, width: row.item.width, height: row.item.height };
  }

  /** The video of the day, once Bunny has finished it. Free to everyone, like a preview chapter. */
  private dailyClip(row?: { item: typeof dailyContent.$inferSelect; media: typeof mediaAssets.$inferSelect | null }) {
    const media = row?.media;
    if (!media || media.status !== 'ready' || (media.provider === 'dev_sample' && this.env.NODE_ENV === 'production')) return null;
    const stream = media.provider === 'bunny_stream';
    return {
      url: stream ? this.bunny.signedHls(media.hostAssetId, this.env.PLAYBACK_URL_TTL_S).url : media.hostAssetId,
      thumbnailUrl: stream ? this.bunny.thumbnailUrl(media.hostAssetId) : null,
      durationS: media.durationS,
      caption: row!.item.text,
    };
  }

  /** Everything the home screen shows, in one round trip. `today` is the device's local date. */
  async home(viewer: Viewer, today: string) {
    const [categoryList, free, newest, daily, breath, continueWatching] = await Promise.all([
      this.categories(),
      this.cards(eq(courses.isFree, true), viewer, 1),
      this.cards(eq(courses.isFree, false), viewer, 10),
      this.db.select({ item: dailyContent, media: mediaAssets }).from(dailyContent).leftJoin(mediaAssets, eq(mediaAssets.id, dailyContent.mediaAssetId)).where(eq(dailyContent.date, today)),
      this.db
        .select({ id: breathingPatterns.id, slug: breathingPatterns.slug, name: breathingPatterns.name })
        .from(breathingPatterns)
        .where(eq(breathingPatterns.active, true))
        .orderBy(asc(breathingPatterns.sort))
        .limit(1),
      viewer.userId ? this.continueWatching(viewer.userId) : Promise.resolve([]),
    ]);
    const quote = daily.find((d) => d.item.type === 'quote');
    return {
      breathing: breath[0] ?? null,
      daily: quote ? { type: 'quote' as const, text: quote.item.text, author: quote.item.author } : null,
      dailyImage: this.dailyImage(daily.find((d) => d.item.type === 'image')),
      dailyClip: this.dailyClip(daily.find((d) => d.item.type === 'clip')),
      continueWatching,
      freeCourse: free[0] ?? null,
      newCourses: newest,
      categories: categoryList,
    };
  }

  /**
   * Live courses whose title, description, instructor or topic matches, plus matching topics. Every search is
   * logged, so the team can see what members look for and don't find.
   */
  async search(q: string, viewer: Viewer) {
    const query = q.trim().slice(0, 100);
    if (query.length < 2) return { query, courses: [], topics: [] };
    const pattern = `%${escapeLike(query)}%`;
    const topicIds = this.db.select({ id: topics.id }).from(topics).where(ilike(topics.name, pattern));
    const [found, topicRows] = await Promise.all([
      this.cards(
        or(ilike(courses.title, pattern), ilike(courses.description, pattern), ilike(instructors.displayName, pattern), inArray(courses.topicId, topicIds))!,
        viewer,
        20,
      ),
      this.db
        .select({ slug: topics.slug, name: topics.name, category: categories.name })
        .from(topics)
        .innerJoin(categories, eq(categories.id, topics.categoryId))
        .where(and(ilike(topics.name, pattern), eq(topics.active, true), eq(categories.active, true)))
        .orderBy(asc(topics.name))
        .limit(10),
    ]);
    await this.db
      .insert(searchLog)
      .values({ userId: viewer.userId, query, resultsCount: found.length + topicRows.length })
      .catch(() => undefined);
    return { query, courses: found, topics: topicRows };
  }

  async topic(slug: string, viewer: Viewer) {
    const [row] = await this.db
      .select({ topic: topics, category: categories })
      .from(topics)
      .innerJoin(categories, eq(categories.id, topics.categoryId))
      .where(and(eq(topics.slug, slug), eq(topics.active, true), eq(categories.active, true)))
      .limit(1);
    if (!row) throw fail(404, 'not_found', 'There is no topic at that address.');
    return {
      slug: row.topic.slug,
      name: row.topic.name,
      coverUrl: row.topic.coverUrl,
      category: { slug: row.category.slug, name: row.category.name },
      courses: await this.cards(eq(courses.topicId, row.topic.id), viewer),
    };
  }

  async course(slug: string, viewer: Viewer) {
    const [found] = await this.publishedCourses(eq(courses.slug, slug));
    if (!found) throw fail(404, 'not_found', 'There is no course at that address.');
    const { course, instructor, price } = found;

    const [place] = await this.db
      .select({ topicSlug: topics.slug, topicName: topics.name, categorySlug: categories.slug, categoryName: categories.name })
      .from(topics)
      .innerJoin(categories, eq(categories.id, topics.categoryId))
      .where(eq(topics.id, course.topicId))
      .limit(1);
    const chapterRows = await this.db
      .select({ chapter: chapters, media: mediaAssets })
      .from(chapters)
      .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
      .where(eq(chapters.courseId, course.id))
      .orderBy(asc(chapters.sort), asc(chapters.createdAt));
    const chapterIds = chapterRows.map((row) => row.chapter.id);

    const [access, offer, progress] = await Promise.all([
      this.access.forCourses(viewer.userId, [course]),
      this.access.subscriptionOffer(course.instructorId),
      viewer.userId && chapterIds.length
        ? this.db
            .select()
            .from(chapterProgress)
            .where(and(eq(chapterProgress.userId, viewer.userId), inArray(chapterProgress.chapterId, chapterIds)))
        : Promise.resolve([]),
    ]);
    const via = access.get(course.id) ?? null;
    const progressByChapter = new Map(progress.map((p) => [p.chapterId, p]));

    return {
      id: course.id,
      slug: course.slug,
      title: course.title,
      description: course.description,
      level: course.level,
      language: course.language,
      equipment: course.equipment,
      cautions: course.cautions,
      coverUrl: course.coverUrl,
      topic: { slug: place.topicSlug, name: place.topicName },
      category: { slug: place.categorySlug, name: place.categoryName },
      instructor,
      isFree: course.isFree,
      price: course.isFree ? null : priceIn(price, viewer.currency),
      access: { unlocked: via !== null, via },
      instructorSubscription: offer ? { price: priceIn(offer, viewer.currency) } : null,
      rating: rating(course),
      totalDurationS: chapterRows.reduce((sum, row) => sum + (row.chapter.durationS ?? 0), 0),
      chapters: chapterRows.map(({ chapter, media }) => {
        const seen = progressByChapter.get(chapter.id);
        return {
          id: chapter.id,
          title: chapter.title,
          type: chapter.type,
          durationS: chapter.durationS,
          isPreview: chapter.isPreview,
          playable: via !== null || chapter.isPreview,
          ready: media?.status === 'ready',
          progress: seen ? { positionS: seen.positionS, completed: seen.completedAt !== null } : null,
          // Roughly how big it is to save to a phone, in each quality; null when there's no file to save yet.
          downloadBytes: downloadSizes(downloadable(media, this.env), chapter.durationS ?? media?.durationS ?? null),
        };
      }),
    };
  }

  /** Courses bought or granted, courses started, and everything by instructors the member subscribes to. */
  async library(userId: string, viewer: Viewer) {
    const [owned, started, subscriptions] = await Promise.all([
      this.db.select({ courseId: entitlements.courseId }).from(entitlements).where(eq(entitlements.userId, userId)),
      this.db
        .selectDistinct({ courseId: chapters.courseId })
        .from(chapterProgress)
        .innerJoin(chapters, eq(chapters.id, chapterProgress.chapterId))
        .where(eq(chapterProgress.userId, userId)),
      this.db
        .select({
          id: instructorSubscriptions.id,
          channel: instructorSubscriptions.channel,
          instructorId: instructorSubscriptions.instructorId,
          status: instructorSubscriptions.status,
          currentPeriodEnd: instructorSubscriptions.currentPeriodEnd,
          autoRenew: instructorSubscriptions.autoRenew,
          slug: instructors.slug,
          displayName: instructors.displayName,
        })
        .from(instructorSubscriptions)
        .innerJoin(instructors, eq(instructors.id, instructorSubscriptions.instructorId))
        .where(
          and(
            eq(instructorSubscriptions.userId, userId),
            ne(instructorSubscriptions.status, 'expired'),
            gt(instructorSubscriptions.currentPeriodEnd, new Date()),
          ),
        ),
    ]);
    const courseIds = [...new Set([...owned, ...started].map((row) => row.courseId))];
    const instructorIds = subscriptions.map((s) => s.instructorId);
    const conditions = [
      ...(courseIds.length ? [inArray(courses.id, courseIds)] : []),
      ...(instructorIds.length ? [inArray(courses.instructorId, instructorIds)] : []),
    ];
    return {
      courses: conditions.length ? await this.cards(or(...conditions)!, viewer) : [],
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        channel: s.channel,
        instructor: { slug: s.slug, displayName: s.displayName },
        status: s.status,
        renews: s.autoRenew && s.status === 'active',
        accessUntil: s.currentPeriodEnd,
      })),
    };
  }

  private async continueWatching(userId: string) {
    const rows = await this.db
      .select({
        positionS: chapterProgress.positionS,
        chapter: { id: chapters.id, title: chapters.title, type: chapters.type, durationS: chapters.durationS },
        course: { slug: courses.slug, title: courses.title, coverUrl: courses.coverUrl },
      })
      .from(chapterProgress)
      .innerJoin(chapters, eq(chapters.id, chapterProgress.chapterId))
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .where(and(eq(chapterProgress.userId, userId), isNull(chapterProgress.completedAt), eq(courses.status, 'published')))
      .orderBy(desc(chapterProgress.updatedAt))
      .limit(5);
    return rows;
  }

  /** Course cards for lists and rails, with the viewer's price and whether it's unlocked for them. */
  private async cards(where: SQL, viewer: Viewer, limit?: number) {
    const list = await this.publishedCourses(where, limit);
    const [stats, access] = await Promise.all([
      this.chapterStats(list.map((r) => r.course.id)),
      this.access.forCourses(viewer.userId, list.map((r) => r.course)),
    ]);
    return list.map(({ course, instructor, price }) => ({
      id: course.id,
      slug: course.slug,
      title: course.title,
      coverUrl: course.coverUrl,
      level: course.level,
      instructor,
      isFree: course.isFree,
      price: course.isFree ? null : priceIn(price, viewer.currency),
      unlocked: access.has(course.id),
      chapterCount: stats.get(course.id)?.chapters ?? 0,
      totalDurationS: stats.get(course.id)?.seconds ?? 0,
      rating: rating(course),
    }));
  }

  private publishedCourses(where: SQL, limit?: number) {
    const query = this.db
      .select({
        course: courses,
        instructor: { id: instructors.id, slug: instructors.slug, displayName: instructors.displayName, photoUrl: instructors.photoUrl },
        price: pricePoints,
      })
      .from(courses)
      .innerJoin(instructors, eq(instructors.id, courses.instructorId))
      .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
      .where(and(where, eq(courses.status, 'published')))
      .orderBy(desc(courses.publishedAt))
      .$dynamic();
    return limit ? query.limit(limit) : query;
  }

  private async chapterStats(courseIds: string[]) {
    if (!courseIds.length) return new Map<string, { chapters: number; seconds: number }>();
    const rows = await this.db
      .select({
        courseId: chapters.courseId,
        chapters: count(),
        seconds: sql<number>`coalesce(sum(${chapters.durationS}), 0)`.mapWith(Number),
      })
      .from(chapters)
      .where(inArray(chapters.courseId, courseIds))
      .groupBy(chapters.courseId);
    return new Map(rows.map((row) => [row.courseId, { chapters: row.chapters, seconds: row.seconds }]));
  }
}
