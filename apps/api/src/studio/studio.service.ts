import { Injectable } from '@nestjs/common';
import { and, asc, countDistinct, desc, eq, gte, lt, lte, max, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { priceIn } from '../catalogue/price';
import { audit } from '../common/audit';
import { fail, stripUndefined } from '../common/errors';
import { currentMonth, monthRange } from '../common/month';
import { slugify } from '../common/slug';
import { Db, InjectDb } from '../db/db.module';
import {
  categories,
  chapters,
  courseRevisions,
  courses,
  instructorPlans,
  instructors,
  mediaAssets,
  pricePoints,
  revenueShareHistory,
  topics,
  watchDaily,
} from '../db/schema';
import { AudioService } from '../media/audio.service';
import { BunnyService } from '../media/bunny.service';
import { MediaService } from '../media/media.service';
import { SubscriptionsService } from '../money/subscriptions.service';
import { assertReadyForReview } from './readiness';
import { CreateChapterDto, CreateCourseDto, PlanDto, UpdateChapterDto, UpdateCourseDto } from './studio.dto';
import { StoreSyncService } from '../money/store-sync.service';
import { ChangesService } from './changes.service';

/** An upload that hasn't finished within a day starts over with a new video at Bunny. */
const RESUME_WINDOW_MS = 24 * 3_600_000;

@Injectable()
export class StudioService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly bunny: BunnyService,
    private readonly media: MediaService,
    private readonly audio: AudioService,
    private readonly subscriptions: SubscriptionsService,
    private readonly storeSync: StoreSyncService,
    private readonly changes: ChangesService,
  ) {}

  /** The studio's front page: who you are, your percentage, your subscription switch and this month so far. */
  async profile(instructorId: string) {
    const month = currentMonth();
    const { from, to } = monthRange(month);
    const [[instructor], [plan], [share], [watch]] = await Promise.all([
      this.db
        .select({ id: instructors.id, slug: instructors.slug, displayName: instructors.displayName, bio: instructors.bio, photoUrl: instructors.photoUrl })
        .from(instructors)
        .where(eq(instructors.id, instructorId)),
      this.db.select().from(instructorPlans).where(eq(instructorPlans.instructorId, instructorId)),
      this.db
        .select({ percentBps: revenueShareHistory.percentBps })
        .from(revenueShareHistory)
        .where(and(eq(revenueShareHistory.instructorId, instructorId), lte(revenueShareHistory.effectiveFrom, new Date())))
        .orderBy(desc(revenueShareHistory.effectiveFrom), desc(revenueShareHistory.createdAt))
        .limit(1),
      this.db
        .select({ seconds: sql<number>`coalesce(sum(${watchDaily.seconds}), 0)`.mapWith(Number), members: countDistinct(watchDaily.userId) })
        .from(watchDaily)
        .where(and(eq(watchDaily.instructorId, instructorId), gte(watchDaily.date, from), lt(watchDaily.date, to))),
    ]);
    return {
      instructor,
      sharePercentBps: share?.percentBps ?? null,
      plan: { enabled: plan?.enabled ?? false, pricePointId: plan?.pricePointId ?? null },
      thisMonth: { month, minutes: Math.floor(watch.seconds / 60), members: watch.members },
    };
  }

  /** Topics and admin's price lists, for the course form and the subscription switch. */
  async options() {
    const [topicRows, prices] = await Promise.all([
      this.db
        .select({ id: topics.id, name: topics.name, category: categories.name })
        .from(topics)
        .innerJoin(categories, eq(categories.id, topics.categoryId))
        .where(eq(topics.active, true))
        .orderBy(asc(categories.sort), asc(topics.sort)),
      this.db.select().from(pricePoints).where(eq(pricePoints.active, true)).orderBy(asc(pricePoints.sort)),
    ]);
    const option = (point: (typeof prices)[number]) => ({
      id: point.id,
      code: point.code,
      inr: priceIn(point, 'INR')!.display,
      usd: priceIn(point, 'USD')!.display,
    });
    return {
      topics: topicRows,
      coursePrices: prices.filter((p) => p.kind === 'course').map(option),
      planPrices: prices.filter((p) => p.kind === 'subscription').map(option),
    };
  }

  /** The instructor's own on/off switch for the monthly subscription. Switching on needs a monthly price. */
  async setPlan(instructorId: string, dto: PlanDto, actorId: string | null = null) {
    if (dto.pricePointId) {
      const [point] = await this.db
        .select({ id: pricePoints.id })
        .from(pricePoints)
        .where(and(eq(pricePoints.id, dto.pricePointId), eq(pricePoints.kind, 'subscription'), eq(pricePoints.active, true)))
        .limit(1);
      if (!point) throw fail(400, 'unknown_price', 'Pick one of the listed monthly prices.');
    }
    const [current] = await this.db.select().from(instructorPlans).where(eq(instructorPlans.instructorId, instructorId)).limit(1);
    const pricePointId = dto.pricePointId ?? current?.pricePointId ?? null;
    if (dto.enabled && !pricePointId) throw fail(400, 'no_price', 'Pick a monthly price first.');
    await this.db
      .insert(instructorPlans)
      .values({ instructorId, enabled: dto.enabled, pricePointId })
      .onConflictDoUpdate({ target: instructorPlans.instructorId, set: { enabled: dto.enabled, pricePointId } });
    // Kept in the audit log: the beta checks that nobody is charged again after a switch-off.
    if (current?.enabled !== dto.enabled || current?.pricePointId !== pricePointId) {
      await audit(this.db, {
        actorId,
        action: 'studio.plan',
        entityType: 'instructor',
        entityId: instructorId,
        before: { enabled: current?.enabled ?? false, pricePointId: current?.pricePointId ?? null },
        after: { enabled: dto.enabled, pricePointId },
      });
    }
    // Switching off stops every renewal it can; subscribers keep the month they've paid for.
    const wound = !dto.enabled && current?.enabled ? await this.subscriptions.windDown(instructorId) : { stopped: 0, appStore: 0 };
    // The store products follow: made or re-priced, or taken off sale. Off sale on the App Store means its
    // subscribers stop at their next renewal, which is the one thing windDown can't do itself.
    if (current?.enabled !== dto.enabled || current?.pricePointId !== pricePointId) this.storeSync.request({ type: 'instructor_plan', id: instructorId });
    const appStoreOffSale = !dto.enabled && (await this.storeSync.managesApple({ type: 'instructor_plan', id: instructorId }));
    return { enabled: dto.enabled, pricePointId, stoppedRenewals: wound.stopped, appStoreRenewals: wound.appStore, appStoreOffSale };
  }

  listCourses(instructorId: string) {
    return this.db
      .select({ id: courses.id, slug: courses.slug, title: courses.title, status: courses.status, isFree: courses.isFree, updatedAt: courses.updatedAt })
      .from(courses)
      .where(eq(courses.instructorId, instructorId))
      .orderBy(desc(courses.updatedAt));
  }

  async createCourse(instructorId: string, dto: CreateCourseDto) {
    const [topic] = await this.db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.id, dto.topicId), eq(topics.active, true)))
      .limit(1);
    if (!topic) throw fail(400, 'unknown_topic', 'Pick a topic from the list, or ask admin for a new one.');
    const [course] = await this.db
      .insert(courses)
      .values({ ...stripUndefined(dto), topicId: dto.topicId, title: dto.title, instructorId, slug: await this.freeSlug(dto.title) })
      .returning();
    return course;
  }

  async getCourse(instructorId: string, courseId: string) {
    const course = await this.ownCourse(instructorId, courseId);
    if (course.status === 'published') return { ...(await this.changes.view(course)), review: null };
    const list = await this.db
      .select({ chapter: chapters, media: { id: mediaAssets.id, status: mediaAssets.status, error: mediaAssets.error } })
      .from(chapters)
      .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
      .where(eq(chapters.courseId, course.id))
      .orderBy(asc(chapters.sort));
    const [review] = await this.db
      .select({ submittedAt: courseRevisions.submittedAt, decision: courseRevisions.decision, comments: courseRevisions.comments })
      .from(courseRevisions)
      .where(and(eq(courseRevisions.courseId, course.id), eq(courseRevisions.kind, 'first')))
      .orderBy(desc(courseRevisions.submittedAt))
      .limit(1);
    return { ...course, chapters: list.map(({ chapter, media }) => ({ ...chapter, media })), review: review ?? null, changes: null };
  }

  /** Sends a draft to admin. The snapshot records exactly what was reviewed. */
  async submit(instructorId: string, courseId: string) {
    const course = await this.ownCourse(instructorId, courseId);
    if (course.status !== 'draft') throw fail(409, 'not_draft', 'This course is already with admin, or live.');
    await assertReadyForReview(this.db, course);
    const chapterRows = await this.db.select().from(chapters).where(eq(chapters.courseId, course.id)).orderBy(asc(chapters.sort));
    return this.db.transaction(async (tx) => {
      await tx.insert(courseRevisions).values({ courseId: course.id, snapshot: { course, chapters: chapterRows } });
      const [updated] = await tx.update(courses).set({ status: 'in_review' }).where(eq(courses.id, course.id)).returning();
      return updated;
    });
  }

  /** `ids` is every chapter of the course, in the new order. */
  async reorderChapters(instructorId: string, courseId: string, ids: string[]) {
    const course = await this.ownCourse(instructorId, courseId);
    if (course.status === 'published') {
      await this.changes.reorder(course, ids);
      return this.getCourse(instructorId, courseId);
    }
    this.assertDraft(course);
    const existing = await this.db.select({ id: chapters.id }).from(chapters).where(eq(chapters.courseId, course.id));
    const known = new Set(existing.map((row) => row.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw fail(400, 'chapter_mismatch', 'Send every chapter of the course exactly once.');
    }
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(chapters).set({ sort: i + 1 }).where(eq(chapters.id, id));
    });
    return this.getCourse(instructorId, courseId);
  }

  async deleteChapter(instructorId: string, chapterId: string) {
    const target = await this.chapterTarget(instructorId, chapterId);
    if (!target.chapter) return this.changes.removeChapter(target.course, chapterId);
    await this.db.delete(chapters).where(eq(chapters.id, target.chapter.id));
  }

  async updateCourse(instructorId: string, courseId: string, dto: UpdateCourseDto) {
    const course = await this.ownCourse(instructorId, courseId);
    if (course.status === 'published') {
      if (dto.pricePointId && dto.pricePointId !== course.pricePointId) {
        throw fail(409, 'price_locked', "A live course keeps its price, because members have bought it at that one. Write to the Embodha team if it has to change.");
      }
      await this.changes.updateCourse(course, dto);
      return this.changes.view(course);
    }
    this.assertDraft(course);
    if (dto.pricePointId) {
      const [point] = await this.db
        .select({ id: pricePoints.id })
        .from(pricePoints)
        .where(and(eq(pricePoints.id, dto.pricePointId), eq(pricePoints.kind, 'course'), eq(pricePoints.active, true)))
        .limit(1);
      if (!point) throw fail(400, 'unknown_price', 'Pick one of the listed course prices.');
    }
    const patch = stripUndefined(dto);
    if (!Object.keys(patch).length) return course;
    const [updated] = await this.db.update(courses).set(patch).where(eq(courses.id, course.id)).returning();
    return updated;
  }

  async addChapter(instructorId: string, courseId: string, dto: CreateChapterDto) {
    const course = await this.ownCourse(instructorId, courseId);
    if (course.status === 'published') return this.changes.addChapter(course, dto);
    this.assertDraft(course);
    const [last] = await this.db.select({ sort: max(chapters.sort) }).from(chapters).where(eq(chapters.courseId, course.id));
    const [chapter] = await this.db
      .insert(chapters)
      .values({ courseId: course.id, title: dto.title, type: dto.type, isPreview: dto.isPreview ?? false, sort: (last?.sort ?? 0) + 1 })
      .returning();
    return chapter;
  }

  async updateChapter(instructorId: string, chapterId: string, dto: UpdateChapterDto) {
    const target = await this.chapterTarget(instructorId, chapterId);
    if (!target.chapter) return this.changes.updateChapter(target.course, chapterId, dto);
    const chapter = target.chapter;
    const patch = stripUndefined(dto);
    if (!Object.keys(patch).length) return chapter;
    const [updated] = await this.db.update(chapters).set(patch).where(eq(chapters.id, chapter.id)).returning();
    return updated;
  }

  /** Creates the video at Bunny and returns a signed TUS upload. The browser then uploads straight to Bunny. */
  async startUpload(instructorId: string, userId: string, chapterId: string) {
    const target = await this.chapterTarget(instructorId, chapterId);
    const { course } = target;
    const chapter = target.chapter ?? (await this.chapterInChanges(course, chapterId));
    if (chapter.type === 'audio') throw fail(400, 'audio_chapter', 'This is an audio chapter: send the file to the audio upload instead.');
    if (!this.bunny.streamReady) throw fail(503, 'video_host_not_configured', 'Bunny Stream keys are not set on this server.');

    // Same chapter, upload not finished: hand out a fresh signature for the same video, so the browser can resume
    // from where it stopped (after a dropped connection, a closed laptop or a reload) instead of starting again.
    const [current] = chapter.mediaAssetId
      ? await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, chapter.mediaAssetId)).limit(1)
      : [];
    if (current?.provider === 'bunny_stream' && current.status === 'uploading' && Date.now() - current.createdAt.getTime() < RESUME_WINDOW_MS) {
      return { mediaId: current.id, status: current.status, tus: this.bunny.tusUpload(current.hostAssetId) };
    }

    const { guid } = await this.bunny.createVideo(`${course.slug} / ${chapter.title}`);
    const media = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(mediaAssets)
        .values({ kind: 'video', provider: 'bunny_stream', hostAssetId: guid, status: 'uploading', uploadedBy: userId })
        .returning();
      if (target.chapter) await tx.update(chapters).set({ mediaAssetId: row.id, durationS: null }).where(eq(chapters.id, chapter.id));
      return row;
    });
    // On a live course the new video waits in the changes; members keep the old one until they're approved.
    if (!target.chapter) await this.changes.updateChapter(course, chapterId, { mediaAssetId: media.id });
    return { mediaId: media.id, status: media.status, tus: this.bunny.tusUpload(guid) };
  }

  /**
   * Takes an audio file through the API (audio is small next to video), answers straight away, then normalises and
   * stores it in the background. The studio polls the media status as it does for video.
   */
  async startAudio(instructorId: string, userId: string, chapterId: string, file?: { path: string; mimetype: string; originalname: string }) {
    try {
      const target = await this.chapterTarget(instructorId, chapterId);
      const chapter = target.chapter ?? (await this.chapterInChanges(target.course, chapterId));
      if (chapter.type !== 'audio') throw fail(400, 'video_chapter', 'This is a video chapter: use the video upload.');
      if (!file) throw fail(400, 'no_file', 'Attach the audio file in a field called "file".');
      if (!file.mimetype.startsWith('audio/') && !/\.(mp3|m4a|wav|aac|flac|ogg|opus)$/i.test(file.originalname)) {
        throw fail(400, 'not_audio', 'That doesn\'t look like audio. Upload MP3, M4A, WAV, AAC, FLAC or OGG.');
      }
      if (!this.audio.ready) throw fail(503, 'audio_host_not_configured', 'Bunny Storage keys are not set on this server.');
      const media = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(mediaAssets)
          .values({ kind: 'audio', provider: 'bunny_storage', hostAssetId: `pending/${randomUUID()}`, status: 'processing', uploadedBy: userId })
          .returning();
        if (target.chapter) await tx.update(chapters).set({ mediaAssetId: row.id, durationS: null }).where(eq(chapters.id, chapter.id));
        return row;
      });
      if (!target.chapter) await this.changes.updateChapter(target.course, chapterId, { mediaAssetId: media.id });
      void this.audio.process(media.id, chapter.id, file.path);
      return { mediaId: media.id, status: media.status };
    } catch (error) {
      if (file) await rm(file.path, { force: true });
      throw error;
    }
  }

  async mediaStatus(instructorId: string, mediaId: string) {
    const [row] = await this.db
      .select({ media: mediaAssets })
      .from(mediaAssets)
      .innerJoin(chapters, eq(chapters.mediaAssetId, mediaAssets.id))
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .where(and(eq(mediaAssets.id, mediaId), eq(courses.instructorId, instructorId)))
      .limit(1);
    let media = row?.media;
    if (!media && (await this.changes.ownsPendingMedia(instructorId, mediaId))) {
      [media] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId));
    }
    if (!media) throw fail(404, 'not_found', 'No such upload in your courses.');
    if (media.provider === 'bunny_stream' && (media.status === 'uploading' || media.status === 'processing')) {
      // Webhooks can go missing; a studio poll asks Bunny directly.
      media = (await this.media.syncFromBunny(media.hostAssetId).catch(() => null)) ?? media;
    }
    return { id: media.id, status: media.status, durationS: media.durationS, thumbnailUrl: media.thumbnailUrl, error: media.error };
  }

  /* ------------------------------------------------------------ Changes to a live course */

  async submitChanges(instructorId: string, courseId: string) {
    const course = await this.ownCourse(instructorId, courseId);
    await this.changes.submit(course);
    return this.getCourse(instructorId, courseId);
  }

  async withdrawChanges(instructorId: string, courseId: string) {
    const course = await this.ownCourse(instructorId, courseId);
    await this.changes.withdraw(course);
    return this.getCourse(instructorId, courseId);
  }

  async discardChanges(instructorId: string, courseId: string) {
    const course = await this.ownCourse(instructorId, courseId);
    await this.changes.discard(course);
  }

  private assertDraft(course: { status: string }) {
    if (course.status !== 'draft') throw fail(409, 'not_draft', 'This course is with the Embodha team or archived, so it can\'t change right now.');
  }

  /**
   * Where a chapter edit goes: the chapter itself while its course is a draft, or the course's open changes while
   * it's live (including chapters that so far only exist there). Nowhere while it's with admin or archived.
   */
  private async chapterTarget(instructorId: string, chapterId: string) {
    const [row] = await this.db
      .select({ chapter: chapters, course: courses })
      .from(chapters)
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .where(and(eq(chapters.id, chapterId), eq(courses.instructorId, instructorId)))
      .limit(1);
    const course = row?.course ?? (await this.changes.findNewChapter(instructorId, chapterId));
    if (!course) throw fail(404, 'not_found', 'No such chapter in your studio.');
    if (course.status === 'published') return { course, chapter: null };
    this.assertDraft(course);
    return { course, chapter: row!.chapter };
  }

  private async chapterInChanges(course: typeof courses.$inferSelect, chapterId: string) {
    const chapter = (await this.changes.view(course)).chapters.find((c) => c.id === chapterId);
    if (!chapter) throw fail(404, 'not_found', 'No such chapter in your studio.');
    return chapter;
  }

  private async ownCourse(instructorId: string, courseId: string) {
    const [course] = await this.db
      .select()
      .from(courses)
      .where(and(eq(courses.id, courseId), eq(courses.instructorId, instructorId)))
      .limit(1);
    if (!course) throw fail(404, 'not_found', 'No such course in your studio.');
    return course;
  }

  private async freeSlug(title: string) {
    const base = slugify(title);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      const [taken] = await this.db.select({ id: courses.id }).from(courses).where(eq(courses.slug, slug)).limit(1);
      if (!taken) return slug;
    }
    throw fail(409, 'slug_taken', 'Try a slightly different title.');
  }
}
