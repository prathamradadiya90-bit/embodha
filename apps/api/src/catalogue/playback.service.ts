import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { chapterProgress, chapters, courses, mediaAssets, pricePoints } from '../db/schema';
import { BunnyService } from '../media/bunny.service';
import { AccessService } from './access.service';
import { Viewer, priceIn } from './price';

@Injectable()
export class PlaybackService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly access: AccessService,
    private readonly bunny: BunnyService,
  ) {}

  /**
   * Checks access, then hands out a short-lived signed URL. A locked chapter answers 402 with
   * everything the buy screen needs, so the app doesn't make a second call.
   */
  async forChapter(chapterId: string, viewer: Viewer) {
    const [row] = await this.db
      .select({ chapter: chapters, course: courses, media: mediaAssets, price: pricePoints })
      .from(chapters)
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
      .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
      .where(eq(chapters.id, chapterId))
      .limit(1);
    if (!row) throw fail(404, 'not_found', 'There is no chapter at that address.');
    const { chapter, course, media } = row;

    // Instructors can play their own drafts from the studio; nobody else sees a draft exists.
    const isOwner = viewer.userId ? await this.access.isInstructorOf(viewer.userId, course.instructorId) : false;
    if (course.status !== 'published' && !isOwner) throw fail(404, 'not_found', 'There is no chapter at that address.');

    let allowed = isOwner || chapter.isPreview || course.isFree;
    if (!allowed && viewer.userId) allowed = (await this.access.forCourses(viewer.userId, [course])).has(course.id);
    if (!allowed) {
      const offer = await this.access.subscriptionOffer(course.instructorId);
      throw new HttpException(
        {
          code: 'locked',
          message: 'Unlock this course to play this chapter.',
          requiresAccount: !viewer.userId,
          course: { id: course.id, slug: course.slug, title: course.title },
          instructor: { id: course.instructorId },
          price: priceIn(row.price, viewer.currency),
          instructorSubscription: offer ? { price: priceIn(offer, viewer.currency) } : null,
        },
        402,
      );
    }

    const devSample = media?.provider === 'dev_sample';
    if (!media || media.status !== 'ready' || (devSample && this.env.NODE_ENV === 'production')) {
      throw fail(409, 'not_ready', 'This chapter is still processing. Try again in a few minutes.');
    }
    const signed = devSample
      ? { url: media.hostAssetId, expiresAt: null }
      : media.provider === 'bunny_stream'
        ? this.bunny.signedHls(media.hostAssetId, this.env.PLAYBACK_URL_TTL_S)
        : this.bunny.signedAudio(media.hostAssetId, this.env.PLAYBACK_URL_TTL_S);

    const [[progress], siblings] = await Promise.all([
      viewer.userId
        ? this.db
            .select({ positionS: chapterProgress.positionS })
            .from(chapterProgress)
            .where(and(eq(chapterProgress.userId, viewer.userId), eq(chapterProgress.chapterId, chapter.id)))
            .limit(1)
        : Promise.resolve([]),
      this.db
        .select({ id: chapters.id, title: chapters.title })
        .from(chapters)
        .where(eq(chapters.courseId, course.id))
        .orderBy(asc(chapters.sort), asc(chapters.createdAt)),
    ]);
    // The app offers the next chapter even when it's locked: tapping it shows the unlock options.
    const next = siblings[siblings.findIndex((c) => c.id === chapter.id) + 1] ?? null;

    return {
      chapterId: chapter.id,
      type: chapter.type,
      title: chapter.title,
      course: { slug: course.slug, title: course.title },
      next,
      url: signed.url,
      expiresAt: signed.expiresAt,
      durationS: chapter.durationS ?? media.durationS,
      resumePositionS: progress?.positionS ?? 0,
      thumbnailUrl: media.thumbnailUrl,
    };
  }
}
