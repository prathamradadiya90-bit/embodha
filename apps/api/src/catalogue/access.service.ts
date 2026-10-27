import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import { Db, InjectDb } from '../db/db.module';
import { entitlements, instructorPlans, instructors, instructorSubscriptions, pricePoints } from '../db/schema';

export type AccessVia = 'free' | 'subscription' | 'purchase' | 'grant' | 'instructor';

interface CourseRef {
  id: string;
  instructorId: string;
  isFree: boolean;
}

/**
 * The one place that decides who can play what. Preview chapters are handled by the caller,
 * since they are open per chapter rather than per course.
 */
@Injectable()
export class AccessService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** How the viewer can play each course. Courses missing from the map are locked. */
  async forCourses(userId: string | null, list: CourseRef[]): Promise<Map<string, AccessVia>> {
    const access = new Map<string, AccessVia>();
    for (const course of list) if (course.isFree) access.set(course.id, 'free');
    if (!userId || list.length === 0) return access;

    const courseIds = list.map((c) => c.id);
    const instructorIds = [...new Set(list.map((c) => c.instructorId))];
    const [owned, subscribed, own] = await Promise.all([
      this.db
        .select({ courseId: entitlements.courseId, source: entitlements.source })
        .from(entitlements)
        .where(and(eq(entitlements.userId, userId), inArray(entitlements.courseId, courseIds))),
      // A cancelled subscription still plays until the paid month runs out.
      this.db
        .select({ instructorId: instructorSubscriptions.instructorId })
        .from(instructorSubscriptions)
        .where(
          and(
            eq(instructorSubscriptions.userId, userId),
            inArray(instructorSubscriptions.instructorId, instructorIds),
            ne(instructorSubscriptions.status, 'expired'),
            gt(instructorSubscriptions.currentPeriodEnd, new Date()),
          ),
        ),
      this.db
        .select({ id: instructors.id })
        .from(instructors)
        .where(and(eq(instructors.userId, userId), inArray(instructors.id, instructorIds))),
    ]);

    const bought = new Map(owned.map((row) => [row.courseId, row.source]));
    const subscribedTo = new Set(subscribed.map((row) => row.instructorId));
    const ownInstructorIds = new Set(own.map((row) => row.id));
    for (const course of list) {
      // Strongest reason wins: your own course, then one bought for good, then a running subscription.
      const via: AccessVia | undefined = ownInstructorIds.has(course.instructorId)
        ? 'instructor'
        : (bought.get(course.id) ?? (subscribedTo.has(course.instructorId) ? 'subscription' : undefined));
      if (via) access.set(course.id, via);
    }
    return access;
  }

  async isInstructorOf(userId: string, instructorId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: instructors.id })
      .from(instructors)
      .where(and(eq(instructors.id, instructorId), eq(instructors.userId, userId)))
      .limit(1);
    return Boolean(row);
  }

  /** The instructor's monthly subscription price, if they have switched it on. */
  async subscriptionOffer(instructorId: string) {
    const [row] = await this.db
      .select({ inrPaise: pricePoints.inrPaise, usdCents: pricePoints.usdCents })
      .from(instructorPlans)
      .innerJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
      .where(and(eq(instructorPlans.instructorId, instructorId), eq(instructorPlans.enabled, true)))
      .limit(1);
    return row ?? null;
  }
}
