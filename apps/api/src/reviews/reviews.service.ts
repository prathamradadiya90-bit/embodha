import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { audit, shortName } from '../common/audit';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import { chapterProgress, chapters, courses, reviews, users } from '../db/schema';
import { ReviewDto } from './reviews.dto';

const PAGE_SIZE = 20;

@Injectable()
export class ReviewsService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Visible reviews, newest first. Signed-in members also get their own review and whether they can write one. */
  async list(slug: string, userId: string | null, page = 1) {
    const course = await this.liveCourse(slug);
    const [items, mine, started] = await Promise.all([
      this.db
        .select({
          id: reviews.id,
          rating: reviews.rating,
          body: reviews.body,
          createdAt: reviews.createdAt,
          teamReply: reviews.teamReply,
          repliedAt: reviews.repliedAt,
          name: users.name,
        })
        .from(reviews)
        .innerJoin(users, eq(users.id, reviews.userId))
        .where(and(eq(reviews.courseId, course.id), eq(reviews.status, 'visible')))
        .orderBy(desc(reviews.createdAt))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
      userId ? this.db.select().from(reviews).where(and(eq(reviews.courseId, course.id), eq(reviews.userId, userId))).limit(1) : Promise.resolve([]),
      userId ? this.hasStarted(userId, course.id) : Promise.resolve(false),
    ]);
    return {
      average: course.ratingAvg === null ? null : Number(course.ratingAvg),
      count: course.ratingCount,
      canReview: started,
      mine: mine[0] ? { rating: mine[0].rating, body: mine[0].body, hidden: mine[0].status === 'hidden' } : null,
      items: items.map(({ name, ...review }) => ({ ...review, author: shortName(name) })),
    };
  }

  /** One review per member per course; writing again replaces it. Only members who've played a chapter can review. */
  async write(slug: string, userId: string, dto: ReviewDto) {
    const course = await this.liveCourse(slug);
    if (!(await this.hasStarted(userId, course.id))) throw fail(403, 'not_started', 'Play at least one chapter before reviewing this course.');
    const body = dto.body?.trim() || null;
    await this.db
      .insert(reviews)
      .values({ userId, courseId: course.id, rating: dto.rating, body })
      .onConflictDoUpdate({ target: [reviews.userId, reviews.courseId], set: { rating: dto.rating, body } });
    await this.refreshRating(course.id);
    return { rating: dto.rating, body };
  }

  async remove(slug: string, userId: string) {
    const course = await this.liveCourse(slug);
    const removed = await this.db.delete(reviews).where(and(eq(reviews.courseId, course.id), eq(reviews.userId, userId))).returning();
    if (!removed.length) throw fail(404, 'not_found', "You haven't reviewed this course.");
    await this.refreshRating(course.id);
  }

  /* ------------------------------------------------------------ Moderation */

  adminList(status?: 'visible' | 'hidden') {
    return this.db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        body: reviews.body,
        status: reviews.status,
        teamReply: reviews.teamReply,
        createdAt: reviews.createdAt,
        course: { id: courses.id, slug: courses.slug, title: courses.title },
        member: { id: users.id, email: users.email, name: users.name },
      })
      .from(reviews)
      .innerJoin(courses, eq(courses.id, reviews.courseId))
      .innerJoin(users, eq(users.id, reviews.userId))
      .where(status ? eq(reviews.status, status) : undefined)
      .orderBy(desc(reviews.createdAt))
      .limit(200);
  }

  async setStatus(actorId: string, reviewId: string, status: 'visible' | 'hidden') {
    const review = await this.find(reviewId);
    await this.db.transaction(async (tx) => {
      await tx.update(reviews).set({ status }).where(eq(reviews.id, review.id));
      await audit(tx, { actorId, action: 'review.status', entityType: 'review', entityId: review.id, before: { status: review.status }, after: { status } });
    });
    await this.refreshRating(review.courseId);
    return { id: review.id, status };
  }

  async reply(actorId: string, reviewId: string, reply: string) {
    const review = await this.find(reviewId);
    const teamReply = reply.trim() || null;
    await this.db.transaction(async (tx) => {
      await tx.update(reviews).set({ teamReply, repliedAt: teamReply ? new Date() : null }).where(eq(reviews.id, review.id));
      await audit(tx, { actorId, action: 'review.reply', entityType: 'review', entityId: review.id, before: { teamReply: review.teamReply }, after: { teamReply } });
    });
    return { id: review.id, teamReply };
  }

  async adminDelete(actorId: string, reviewId: string) {
    const review = await this.find(reviewId);
    await this.db.transaction(async (tx) => {
      await tx.delete(reviews).where(eq(reviews.id, review.id));
      await audit(tx, { actorId, action: 'review.delete', entityType: 'review', entityId: review.id, before: review });
    });
    await this.refreshRating(review.courseId);
  }

  /* ------------------------------------------------------------ Helpers */

  /** The course card's stars come from visible reviews only. */
  private async refreshRating(courseId: string) {
    await this.db.execute(sql`
      update courses set rating_avg = s.average, rating_count = s.n
      from (select round(avg(rating)::numeric, 2) as average, count(*)::int as n from reviews where course_id = ${courseId} and status = 'visible') s
      where courses.id = ${courseId}`);
  }

  private async hasStarted(userId: string, courseId: string) {
    const [row] = await this.db
      .select({ chapterId: chapterProgress.chapterId })
      .from(chapterProgress)
      .innerJoin(chapters, eq(chapters.id, chapterProgress.chapterId))
      .where(and(eq(chapterProgress.userId, userId), eq(chapters.courseId, courseId)))
      .limit(1);
    return Boolean(row);
  }

  private async liveCourse(slug: string) {
    const [course] = await this.db
      .select()
      .from(courses)
      .where(and(eq(courses.slug, slug), eq(courses.status, 'published')))
      .limit(1);
    if (!course) throw fail(404, 'not_found', 'There is no course at that address.');
    return course;
  }

  private async find(reviewId: string) {
    const [review] = await this.db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    if (!review) throw fail(404, 'not_found', 'No such review.');
    return review;
  }
}
