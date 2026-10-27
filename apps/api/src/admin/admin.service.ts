import { Injectable } from '@nestjs/common';
import { and, asc, count, countDistinct, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, max, ne, notInArray, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { normalizeEmail } from '../auth/auth.service';
import { UsersService } from '../auth/users.service';
import { priceIn } from '../catalogue/price';
import { fail, stripUndefined } from '../common/errors';
import { BUSINESS_TIME_ZONE, currentMonth, monthRange } from '../common/month';
import { localDay } from '../practice/streak';
import { slugify } from '../common/slug';
import { Db, InjectDb } from '../db/db.module';
import {
  auditLog,
  breathingSessions,
  categories,
  chapters,
  dailyContent,
  courseRevisions,
  courses,
  entitlements,
  instructorPlans,
  instructors,
  mediaAssets,
  pricePoints,
  revenueShareHistory,
  sessions,
  settings,
  staffRoles,
  topics,
  userPreferences,
  users,
  watchDaily,
} from '../db/schema';
import { placeLabel } from '../money/gst';
import { assertReadyForReview } from '../studio/readiness';
import { CreateCategoryDto, CreateInstructorDto, CreateTopicDto, CreateUserDto, DailyMediaDto, DailyQuoteDto, ReviewChangesDto, ReviewCourseDto, ShareDto, UpdateCategoryDto, UpdateTopicDto } from './admin.dto';
import { BunnyService } from '../media/bunny.service';
import { ImageService } from '../media/image.service';
import { MediaService } from '../media/media.service';
import { StoreSyncService } from '../money/store-sync.service';
import { ChangesService } from '../studio/changes.service';
import { SubscriptionsService } from '../money/subscriptions.service';

type CourseStatus = (typeof courses.$inferSelect)['status'];
const PAGE_SIZE = 25;
const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);
const minutes = (seconds: number) => Math.floor(seconds / 60);
const watchedSeconds = sql<number>`coalesce(sum(${watchDaily.seconds}), 0)`.mapWith(Number);

const erasedNote = 'This account was erased. Only its payment records are kept, for the tax records.';

@Injectable()
export class AdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly accounts: UsersService,
    private readonly storeSync: StoreSyncService,
    private readonly subscriptions: SubscriptionsService,
    private readonly changes: ChangesService,
    private readonly bunny: BunnyService,
    private readonly media: MediaService,
    private readonly images: ImageService,
  ) {}

  /* ------------------------------------------------------------ Overview */

  async overview() {
    const month = currentMonth();
    const { from, to, start } = monthRange(month);
    const [[members], [joined], instructorRows, courseRows, [watch], [breaths], queue] = await Promise.all([
      this.db.select({ n: count() }).from(users).where(notInArray(users.status, ['deleting', 'erased'])),
      this.db.select({ n: count() }).from(users).where(gte(users.createdAt, new Date(Date.now() - 7 * 86_400_000))),
      this.db.select({ status: instructors.status, n: count() }).from(instructors).groupBy(instructors.status),
      this.db.select({ status: courses.status, n: count() }).from(courses).groupBy(courses.status),
      this.db
        .select({ seconds: watchedSeconds, members: countDistinct(watchDaily.userId) })
        .from(watchDaily)
        .where(and(gte(watchDaily.date, from), lt(watchDaily.date, to))),
      this.db.select({ n: count() }).from(breathingSessions).where(gte(breathingSessions.completedAt, start)),
      this.db
        .select({ id: courses.id, title: courses.title, instructor: instructors.displayName, submittedAt: max(courseRevisions.submittedAt) })
        .from(courses)
        .innerJoin(instructors, eq(instructors.id, courses.instructorId))
        .leftJoin(courseRevisions, eq(courseRevisions.courseId, courses.id))
        .where(and(eq(courses.status, 'in_review'), eq(courseRevisions.kind, 'first')))
        .groupBy(courses.id, instructors.displayName)
        .orderBy(asc(max(courseRevisions.submittedAt))),
    ]);
    const changeQueue = await this.db
      .select({ id: courses.id, title: courses.title, instructor: instructors.displayName, submittedAt: courseRevisions.submittedAt })
      .from(courseRevisions)
      .innerJoin(courses, eq(courses.id, courseRevisions.courseId))
      .innerJoin(instructors, eq(instructors.id, courses.instructorId))
      .where(and(eq(courseRevisions.kind, 'change'), isNull(courseRevisions.decision), isNotNull(courseRevisions.submittedAt)))
      .orderBy(asc(courseRevisions.submittedAt));
    const of = (rows: { status: string; n: number }[], status: string) => rows.find((row) => row.status === status)?.n ?? 0;
    return {
      members: { total: members.n, last7Days: joined.n },
      instructors: { approved: of(instructorRows, 'approved'), applied: of(instructorRows, 'applied') },
      courses: { published: of(courseRows, 'published'), inReview: of(courseRows, 'in_review'), draft: of(courseRows, 'draft') },
      thisMonth: { month, minutes: minutes(watch.seconds), members: watch.members, breathingSessions: breaths.n },
      reviewQueue: [...queue.map((row) => ({ ...row, kind: 'new' as const })), ...changeQueue.map((row) => ({ ...row, kind: 'changes' as const }))],
    };
  }

  /* ------------------------------------------------------------ Courses */

  async courses(status?: CourseStatus) {
    const rows = await this.db
      .select({ course: courses, instructor: { id: instructors.id, displayName: instructors.displayName }, topic: topics.name, price: pricePoints })
      .from(courses)
      .innerJoin(instructors, eq(instructors.id, courses.instructorId))
      .innerJoin(topics, eq(topics.id, courses.topicId))
      .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
      .where(status ? eq(courses.status, status) : undefined)
      .orderBy(desc(courses.updatedAt));
    if (!rows.length) return [];
    const ids = rows.map((row) => row.course.id);
    const [chapterStats, revisions] = await Promise.all([
      this.db
        .select({
          courseId: chapters.courseId,
          total: count(),
          ready: sql<number>`count(*) filter (where ${mediaAssets.status} = 'ready')`.mapWith(Number),
        })
        .from(chapters)
        .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
        .where(inArray(chapters.courseId, ids))
        .groupBy(chapters.courseId),
      this.db.select().from(courseRevisions).where(inArray(courseRevisions.courseId, ids)).orderBy(desc(courseRevisions.submittedAt)),
    ]);
    const waiting = new Map(
      revisions.filter((r) => r.kind === 'change' && !r.decision && r.submittedAt).map((r) => [r.courseId, r.submittedAt]),
    );
    const stats = new Map(chapterStats.map((row) => [row.courseId, row]));
    const latest = new Map<string, (typeof revisions)[number]>();
    for (const revision of revisions) if (revision.kind === 'first' && !latest.has(revision.courseId)) latest.set(revision.courseId, revision);
    // Waiting for review first; within a status, most recently changed first.
    const order: Record<CourseStatus, number> = { in_review: 0, draft: 1, published: 2, archived: 3 };
    return rows
      .map(({ course, instructor, topic, price }) => {
        const review = latest.get(course.id);
        return {
          id: course.id,
          slug: course.slug,
          title: course.title,
          status: course.status,
          isFree: course.isFree,
          instructor,
          topic,
          price: course.isFree ? null : (priceIn(price, 'INR')?.display ?? null),
          chapters: stats.get(course.id)?.total ?? 0,
          readyChapters: stats.get(course.id)?.ready ?? 0,
          updatedAt: course.updatedAt,
          review: review ? { submittedAt: review.submittedAt, decision: review.decision, comments: review.comments } : null,
          changesWaitingSince: waiting.get(course.id) ?? null,
        };
      })
      // Anything waiting for admin first: new courses and changes to live ones.
      .sort((a, b) => Number(Boolean(b.changesWaitingSince)) - Number(Boolean(a.changesWaitingSince)) || order[a.status] - order[b.status]);
  }

  async reviewCourse(actorId: string, courseId: string, dto: ReviewCourseDto) {
    const course = await this.findCourse(courseId);
    if (course.status !== 'in_review') throw fail(409, 'not_in_review', 'Only courses waiting for review can be published or sent back.');
    const comments = dto.comments?.trim() || null;
    if (dto.decision === 'return' && !comments) throw fail(400, 'comments_required', 'Say what the instructor should change.');
    if (dto.decision === 'publish') await assertReadyForReview(this.db, course);
    const status = dto.decision === 'publish' ? 'published' : 'draft';

    const updated = await this.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: courseRevisions.id })
        .from(courseRevisions)
        .where(and(eq(courseRevisions.courseId, course.id), isNull(courseRevisions.decision)))
        .orderBy(desc(courseRevisions.submittedAt))
        .limit(1);
      if (open) {
        await tx
          .update(courseRevisions)
          .set({ decision: dto.decision === 'publish' ? 'approved' : 'rejected', reviewedBy: actorId, reviewedAt: new Date(), comments })
          .where(eq(courseRevisions.id, open.id));
      }
      const [updated] = await tx
        .update(courses)
        .set({ status, publishedAt: status === 'published' ? (course.publishedAt ?? new Date()) : course.publishedAt })
        .where(eq(courses.id, course.id))
        .returning();
      await this.audit(tx, actorId, `course.${dto.decision}`, 'course', course.id, { status: course.status }, { status, comments });
      return updated;
    });
    // A newly published paid course gets its App Store and Google Play products, in the background.
    if (status === 'published') this.storeSync.request({ type: 'course', id: course.id });
    return updated;
  }

  async courseChanges(courseId: string) {
    const course = await this.findCourse(courseId);
    return { course: { id: course.id, title: course.title, slug: course.slug }, ...(await this.changes.forReview(course)) };
  }

  async decideChanges(actorId: string, courseId: string, dto: ReviewChangesDto) {
    const course = await this.findCourse(courseId);
    if (dto.decision === 'return') {
      const comments = dto.comments?.trim();
      if (!comments) throw fail(400, 'comments_required', 'Say what the instructor should change.');
      await this.changes.sendBack(actorId, course, comments);
      return { decision: 'returned' };
    }
    const { titleChanged } = await this.changes.approve(actorId, course);
    // The stores show the course's name, so a new title goes to them too.
    if (titleChanged) this.storeSync.request({ type: 'course', id: course.id });
    return { decision: 'approved' };
  }

  async archiveCourse(actorId: string, courseId: string) {
    const course = await this.findCourse(courseId);
    if (course.status !== 'published') throw fail(409, 'not_published', 'Only live courses can be archived.');
    if (course.isFree) throw fail(409, 'free_course', 'Make another course the free one first.');
    // Archiving hides a course from everyone, so it waits until owners can be looked after (with payments).
    const [owners] = await this.db.select({ n: count() }).from(entitlements).where(eq(entitlements.courseId, course.id));
    if (owners.n) throw fail(409, 'has_owners', `${owners.n} ${owners.n === 1 ? 'member owns' : 'members own'} this course, so it stays up.`);
    const archived = await this.db.transaction(async (tx) => {
      const [updated] = await tx.update(courses).set({ status: 'archived' }).where(eq(courses.id, course.id)).returning();
      await this.audit(tx, actorId, 'course.archive', 'course', course.id, { status: course.status }, { status: 'archived' });
      return updated;
    });
    this.storeSync.request({ type: 'course', id: course.id }); // off sale in both stores
    return archived;
  }

  /** There is exactly one free course. Moving it keeps the old one's price for when it's paid again. */
  async setFreeCourse(actorId: string, courseId: string) {
    const course = await this.findCourse(courseId);
    if (course.status !== 'published') throw fail(409, 'not_published', 'The free course has to be live.');
    if (course.isFree) return course;
    const { updated, previous } = await this.db.transaction(async (tx) => {
      const [previous] = await tx.update(courses).set({ isFree: false }).where(eq(courses.isFree, true)).returning({ id: courses.id });
      const [updated] = await tx.update(courses).set({ isFree: true }).where(eq(courses.id, course.id)).returning();
      await this.audit(tx, actorId, 'course.set_free', 'course', course.id, { freeCourse: previous?.id ?? null }, { freeCourse: course.id });
      return { updated, previous };
    });
    // The new free course comes off sale in the stores; the old one goes back on sale at its price.
    this.storeSync.request({ type: 'course', id: course.id });
    if (previous) this.storeSync.request({ type: 'course', id: previous.id });
    return updated;
  }

  /* ------------------------------------------------------------ Instructors */

  async instructors() {
    const { from, to } = monthRange(currentMonth());
    const [rows, shares, courseCounts, watch] = await Promise.all([
      this.db
        .select({ instructor: instructors, email: users.email, plan: instructorPlans, price: pricePoints })
        .from(instructors)
        .leftJoin(users, eq(users.id, instructors.userId))
        .leftJoin(instructorPlans, eq(instructorPlans.instructorId, instructors.id))
        .leftJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
        .orderBy(asc(instructors.displayName)),
      this.sharesAt(new Date()),
      this.db
        .select({
          instructorId: courses.instructorId,
          total: count(),
          published: sql<number>`count(*) filter (where ${courses.status} = 'published')`.mapWith(Number),
        })
        .from(courses)
        .groupBy(courses.instructorId),
      this.db
        .select({ instructorId: watchDaily.instructorId, seconds: watchedSeconds })
        .from(watchDaily)
        .where(and(gte(watchDaily.date, from), lt(watchDaily.date, to)))
        .groupBy(watchDaily.instructorId),
    ]);
    return rows.map(({ instructor, email, plan, price }) => {
      const counts = courseCounts.find((row) => row.instructorId === instructor.id);
      return {
        id: instructor.id,
        slug: instructor.slug,
        displayName: instructor.displayName,
        email,
        status: instructor.status,
        sharePercentBps: shares.get(instructor.id) ?? null,
        tdsRateBps: instructor.tdsRateBps,
        plan: { enabled: plan?.enabled ?? false, price: priceIn(price, 'INR')?.display ?? null },
        courses: { published: counts?.published ?? 0, total: counts?.total ?? 0 },
        minutesThisMonth: minutes(watch.find((row) => row.instructorId === instructor.id)?.seconds ?? 0),
      };
    });
  }

  /** Adds an instructor by email. If the person has no account yet, one is made; they sign in with that address. */
  async createInstructor(actorId: string, dto: CreateInstructorDto) {
    const email = normalizeEmail(dto.email);
    const percentBps = dto.percentBps ?? (await this.defaultShare());
    return this.db.transaction(async (tx) => {
      await tx.insert(users).values({ email }).onConflictDoNothing({ target: users.email });
      const [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      await tx.insert(userPreferences).values({ userId: user.id }).onConflictDoNothing();
      const [existing] = await tx.select({ id: instructors.id }).from(instructors).where(eq(instructors.userId, user.id)).limit(1);
      if (existing) throw fail(409, 'already_instructor', 'That person already has an instructor profile.');
      const slug = await this.uniqueSlug(dto.displayName, async (candidate) =>
        Boolean((await tx.select({ id: instructors.id }).from(instructors).where(eq(instructors.slug, candidate)).limit(1)).length),
      );
      const [created] = await tx.insert(instructors).values({ userId: user.id, displayName: dto.displayName.trim(), slug, status: 'approved' }).returning();
      await tx
        .insert(revenueShareHistory)
        .values({ instructorId: created.id, percentBps, effectiveFrom: new Date(), setBy: actorId, reason: 'Set when the instructor was added' });
      await tx.insert(instructorPlans).values({ instructorId: created.id, enabled: false });
      await this.audit(tx, actorId, 'instructor.create', 'instructor', created.id, null, { email, percentBps });
      return { id: created.id, slug: created.slug, displayName: created.displayName, email, status: created.status, sharePercentBps: percentBps };
    });
  }

  async setInstructorStatus(actorId: string, instructorId: string, status: 'approved' | 'suspended') {
    const instructor = await this.findInstructor(instructorId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(instructors).set({ status }).where(eq(instructors.id, instructor.id)).returning();
      await this.audit(tx, actorId, 'instructor.status', 'instructor', instructor.id, { status: instructor.status }, { status });
      return { id: updated.id, status: updated.status };
    });
  }

  /** A new percentage applies from now on. Earlier sales keep the percentage they were made under. */
  async setShare(actorId: string, instructorId: string, dto: ShareDto) {
    const instructor = await this.findInstructor(instructorId);
    const before = (await this.sharesAt(new Date())).get(instructor.id) ?? null;
    await this.db.transaction(async (tx) => {
      await tx
        .insert(revenueShareHistory)
        .values({ instructorId: instructor.id, percentBps: dto.percentBps, effectiveFrom: new Date(), setBy: actorId, reason: dto.reason?.trim() || null });
      await this.audit(tx, actorId, 'instructor.share', 'instructor', instructor.id, { percentBps: before }, { percentBps: dto.percentBps });
    });
    return { id: instructor.id, sharePercentBps: dto.percentBps };
  }

  /* ------------------------------------------------------------ Members */

  async users(q?: string, page = 1) {
    const term = q?.trim();
    const where = term ? or(ilike(users.email, `%${escapeLike(term)}%`), ilike(users.name, `%${escapeLike(term)}%`)) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      this.db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
      this.db.select({ n: count() }).from(users).where(where),
    ]);
    const ids = rows.map((user) => user.id);
    const [staff, teaching] = ids.length
      ? await Promise.all([
          this.db.select().from(staffRoles).where(inArray(staffRoles.userId, ids)),
          this.db.select({ userId: instructors.userId }).from(instructors).where(inArray(instructors.userId, ids)),
        ])
      : [[], []];
    return {
      items: rows.map((user) => ({
        ...this.publicUser(user),
        staff: staff.filter((row) => row.userId === user.id).map((row) => row.role),
        instructor: teaching.some((row) => row.userId === user.id),
      })),
      total: n,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  async user(userId: string) {
    const user = await this.findUser(userId);
    const [owned, [watch], [seen]] = await Promise.all([
      this.db
        .select({ courseId: courses.id, title: courses.title, slug: courses.slug, source: entitlements.source, since: entitlements.createdAt })
        .from(entitlements)
        .innerJoin(courses, eq(courses.id, entitlements.courseId))
        .where(eq(entitlements.userId, user.id))
        .orderBy(desc(entitlements.createdAt)),
      this.db.select({ seconds: watchedSeconds }).from(watchDaily).where(eq(watchDaily.userId, user.id)),
      this.db
        .select({ at: sql<string | null>`greatest(max(${sessions.lastUsedAt}), max(${sessions.createdAt}))` })
        .from(sessions)
        .where(eq(sessions.userId, user.id)),
    ]);
    return { user: this.publicUser(user), courses: owned, minutesWatched: minutes(watch.seconds), lastSignedIn: seen?.at ?? null };
  }

  /** Makes an account before the person signs in, e.g. to add a course to their library ahead of time. */
  async createUser(actorId: string, dto: CreateUserDto) {
    const email = normalizeEmail(dto.email);
    const [taken] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (taken) throw fail(409, 'exists', 'There is already an account with that email.', { id: taken.id });
    return this.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, name: dto.name?.trim() || null }).returning();
      await tx.insert(userPreferences).values({ userId: user.id });
      await this.audit(tx, actorId, 'user.create', 'user', user.id, null, { email });
      return this.publicUser(user);
    });
  }

  async setUserStatus(actorId: string, userId: string, status: 'active' | 'suspended') {
    if (userId === actorId) throw fail(400, 'own_account', "You can't change your own account here.");
    const user = await this.findUser(userId);
    if (user.status === 'deleting') throw fail(409, 'deleting', 'This account is being deleted. Signing back in cancels that.');
    if (user.status === 'erased') throw fail(409, 'erased', erasedNote);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(users).set({ status }).where(eq(users.id, user.id)).returning();
      // Suspension takes effect on the next request anyway; revoking also stops silent refreshes.
      if (status === 'suspended') {
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      }
      await this.audit(tx, actorId, 'user.status', 'user', user.id, { status: user.status }, { status });
      return this.publicUser(updated);
    });
  }

  async deleteUser(actorId: string, userId: string) {
    if (userId === actorId) throw fail(400, 'own_account', "You can't delete your own account here.");
    const user = await this.findUser(userId);
    if (user.status === 'erased') throw fail(409, 'erased', erasedNote);
    const { appStore } = await this.subscriptions.stopRenewalsFor(user.id);
    const result = { ...(await this.accounts.requestDeletion(user.id)), appStoreSubscriptions: appStore };
    await this.audit(this.db, actorId, 'user.delete', 'user', user.id, { status: user.status }, { status: 'deleting' });
    return result;
  }

  async grant(actorId: string, userId: string, courseId: string) {
    const user = await this.findUser(userId);
    if (user.status === 'erased') throw fail(409, 'erased', erasedNote);
    const course = await this.findCourse(courseId);
    if (course.status !== 'published') throw fail(409, 'not_published', 'Only live courses can be added to a library.');
    if (course.isFree) throw fail(409, 'free_course', 'Everyone already has the free course.');
    await this.db.insert(entitlements).values({ userId: user.id, courseId: course.id, source: 'grant' }).onConflictDoNothing();
    await this.audit(this.db, actorId, 'user.grant', 'user', user.id, null, { courseId: course.id });
    return { courseId: course.id, title: course.title, source: 'grant' };
  }

  /** Takes back a granted course. Bought courses aren't touched here; refunds handle those. */
  async revoke(actorId: string, userId: string, courseId: string) {
    const removed = await this.db
      .delete(entitlements)
      .where(and(eq(entitlements.userId, userId), eq(entitlements.courseId, courseId), eq(entitlements.source, 'grant')))
      .returning();
    if (!removed.length) throw fail(404, 'not_found', 'That course was not granted to this member.');
    await this.audit(this.db, actorId, 'user.revoke', 'user', userId, { courseId }, null);
  }

  /* ------------------------------------------------------------ Catalogue */

  async catalogue() {
    const [categoryRows, topicRows, counts] = await Promise.all([
      this.db.select().from(categories).orderBy(asc(categories.sort), asc(categories.name)),
      this.db.select().from(topics).orderBy(asc(topics.sort), asc(topics.name)),
      this.db.select({ topicId: courses.topicId, n: count() }).from(courses).groupBy(courses.topicId),
    ]);
    const coursesIn = new Map(counts.map((row) => [row.topicId, row.n]));
    return categoryRows.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      active: category.active,
      topics: topicRows
        .filter((topic) => topic.categoryId === category.id)
        .map((topic) => ({ id: topic.id, slug: topic.slug, name: topic.name, active: topic.active, courses: coursesIn.get(topic.id) ?? 0 })),
    }));
  }

  /** New categories start hidden, so members never see an empty one. */
  async createCategory(actorId: string, dto: CreateCategoryDto) {
    const slug = await this.uniqueSlug(dto.name, async (candidate) =>
      Boolean((await this.db.select({ id: categories.id }).from(categories).where(eq(categories.slug, candidate)).limit(1)).length),
    );
    const [last] = await this.db.select({ sort: max(categories.sort) }).from(categories);
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(categories)
        .values({ name: dto.name.trim(), slug, sort: (last?.sort ?? 0) + 1, active: false })
        .returning();
      await this.audit(tx, actorId, 'category.create', 'category', created.id, null, created);
      return created;
    });
  }

  async updateCategory(actorId: string, categoryId: string, dto: UpdateCategoryDto) {
    const [category] = await this.db.select().from(categories).where(eq(categories.id, categoryId)).limit(1);
    if (!category) throw fail(404, 'not_found', 'No such category.');
    const patch = stripUndefined({ ...dto, name: dto.name?.trim() });
    if (!Object.keys(patch).length) return category;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(categories).set(patch).where(eq(categories.id, category.id)).returning();
      await this.audit(tx, actorId, 'category.update', 'category', category.id, category, updated);
      return updated;
    });
  }

  async createTopic(actorId: string, dto: CreateTopicDto) {
    const [category] = await this.db.select({ id: categories.id }).from(categories).where(eq(categories.id, dto.categoryId)).limit(1);
    if (!category) throw fail(400, 'unknown_category', 'Pick a category from the list.');
    const slug = await this.uniqueSlug(dto.name, async (candidate) =>
      Boolean((await this.db.select({ id: topics.id }).from(topics).where(eq(topics.slug, candidate)).limit(1)).length),
    );
    const [last] = await this.db.select({ sort: max(topics.sort) }).from(topics).where(eq(topics.categoryId, category.id));
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(topics)
        .values({ categoryId: category.id, name: dto.name.trim(), slug, sort: (last?.sort ?? 0) + 1 })
        .returning();
      await this.audit(tx, actorId, 'topic.create', 'topic', created.id, null, created);
      return created;
    });
  }

  async updateTopic(actorId: string, topicId: string, dto: UpdateTopicDto) {
    const [topic] = await this.db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    if (!topic) throw fail(404, 'not_found', 'No such topic.');
    const patch = stripUndefined({ ...dto, name: dto.name?.trim() });
    if (!Object.keys(patch).length) return topic;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx.update(topics).set(patch).where(eq(topics.id, topic.id)).returning();
      await this.audit(tx, actorId, 'topic.update', 'topic', topic.id, topic, updated);
      return updated;
    });
  }

  /* ------------------------------------------------------------ Reports */

  /**
   * Minutes watched per instructor in a month, with the percentage that applied at month end. Sales and payouts
   * join this report when payments land. (Subscriptions are per instructor, so watch time never decides who gets
   * paid; it shows what members actually use.)
   */
  async watchReport(month = currentMonth()) {
    const { from, to, end } = monthRange(month);
    const inMonth = and(gte(watchDaily.date, from), lt(watchDaily.date, to));
    const [rows, [totals], shares] = await Promise.all([
      this.db
        .select({ id: instructors.id, displayName: instructors.displayName, seconds: watchedSeconds, members: countDistinct(watchDaily.userId) })
        .from(watchDaily)
        .innerJoin(instructors, eq(instructors.id, watchDaily.instructorId))
        .where(inMonth)
        .groupBy(instructors.id, instructors.displayName),
      this.db.select({ seconds: watchedSeconds, members: countDistinct(watchDaily.userId) }).from(watchDaily).where(inMonth),
      this.sharesAt(end),
    ]);
    return {
      month,
      rows: rows
        .sort((a, b) => b.seconds - a.seconds)
        .map((row) => ({
          instructor: { id: row.id, displayName: row.displayName },
          minutes: minutes(row.seconds),
          members: row.members,
          sharePercentBps: shares.get(row.id) ?? null,
        })),
      totals: { minutes: minutes(totals.seconds), members: totals.members },
    };
  }

  /* ------------------------------------------------------------ The Today screen: quote, photo, video */

  /** The next 30 days from `from` (default: today in India): each day's quote, photo and video, where set. */
  async daily(from = localDay(new Date(), BUSINESS_TIME_ZONE)) {
    const until = new Date(Date.parse(`${from}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db
      .select({ item: dailyContent, media: mediaAssets })
      .from(dailyContent)
      .leftJoin(mediaAssets, eq(mediaAssets.id, dailyContent.mediaAssetId))
      .where(and(gte(dailyContent.date, from), lt(dailyContent.date, until)))
      .orderBy(asc(dailyContent.date), asc(dailyContent.type));
    return Promise.all(
      rows.map(async ({ item, media }) => {
        // A video still at Bunny: ask how it's doing, so the page can show it becoming ready.
        if (media?.provider === 'bunny_stream' && (media.status === 'uploading' || media.status === 'processing')) {
          media = (await this.media.syncFromBunny(media.hostAssetId).catch(() => null)) ?? media;
        }
        const preview =
          media?.provider === 'dev_sample' && media.kind === 'image'
            ? media.hostAssetId
            : media?.kind === 'image'
              ? this.bunny.signedAudio(media.hostAssetId, 3600).url
              : media?.provider === 'bunny_stream'
                ? this.bunny.thumbnailUrl(media.hostAssetId)
                : null;
        return {
          date: item.date,
          type: item.type,
          text: item.text,
          author: item.author,
          width: item.width,
          height: item.height,
          media: media ? { id: media.id, status: media.status, durationS: media.durationS, preview } : null,
        };
      }),
    );
  }

  /** The app shows each member the day's items for their own local date, so a date means that day everywhere. */
  async setDaily(actorId: string, date: string, dto: DailyQuoteDto) {
    const values = { text: dto.text.trim(), author: dto.author?.trim() || null, mediaAssetId: null };
    const [row] = await this.db
      .insert(dailyContent)
      .values({ date, type: 'quote', ...values })
      .onConflictDoUpdate({ target: [dailyContent.date, dailyContent.type], set: values })
      .returning({ date: dailyContent.date, type: dailyContent.type, text: dailyContent.text, author: dailyContent.author });
    await this.audit(this.db, actorId, 'daily.set', 'daily', date, null, row);
    return row;
  }

  async setDailyImage(actorId: string, date: string, dto: DailyMediaDto, file?: { path: string }) {
    try {
      if (!file) throw fail(400, 'no_file', 'Attach the photo in a field called "file".');
      if (!this.images.ready) throw fail(503, 'storage_not_configured', 'Bunny Storage keys are not set on this server.');
      const path = `daily/${date}-${randomBytes(4).toString('hex')}.jpg`;
      const { width, height } = await this.images.store(file.path, path);
      const row = await this.db.transaction(async (tx) => {
        const [media] = await tx.insert(mediaAssets).values({ kind: 'image', provider: 'bunny_storage', hostAssetId: path, status: 'ready', uploadedBy: actorId }).returning();
        const values = { text: dto.caption?.trim() || null, author: dto.credit?.trim() || null, mediaAssetId: media.id, width, height };
        const [saved] = await tx.insert(dailyContent).values({ date, type: 'image', ...values }).onConflictDoUpdate({ target: [dailyContent.date, dailyContent.type], set: values }).returning();
        await this.audit(tx, actorId, 'daily.image', 'daily', date, null, { caption: values.text, credit: values.author });
        return saved;
      });
      return row;
    } finally {
      if (file) await rm(file.path, { force: true });
    }
  }

  /** A short video goes from the browser straight to Bunny, like a chapter. It shows in the app once Bunny has finished it. */
  async startDailyClip(actorId: string, date: string, dto: DailyMediaDto) {
    if (!this.bunny.streamReady) throw fail(503, 'video_host_not_configured', 'Bunny Stream keys are not set on this server.');
    const { guid } = await this.bunny.createVideo(`Today ${date}`);
    const media = await this.db.transaction(async (tx) => {
      const [row] = await tx.insert(mediaAssets).values({ kind: 'video', provider: 'bunny_stream', hostAssetId: guid, status: 'uploading', uploadedBy: actorId }).returning();
      const values = { text: dto.caption?.trim() || null, author: null, mediaAssetId: row.id, width: null, height: null };
      await tx.insert(dailyContent).values({ date, type: 'clip', ...values }).onConflictDoUpdate({ target: [dailyContent.date, dailyContent.type], set: values });
      await this.audit(tx, actorId, 'daily.clip', 'daily', date, null, { caption: values.text });
      return row;
    });
    return { mediaId: media.id, status: media.status, tus: this.bunny.tusUpload(guid) };
  }

  async removeDaily(actorId: string, date: string, type: 'quote' | 'image' | 'clip' = 'quote') {
    const removed = await this.db.delete(dailyContent).where(and(eq(dailyContent.date, date), eq(dailyContent.type, type))).returning();
    if (!removed.length) throw fail(404, 'not_found', 'Nothing of that kind is set for that day.');
    await this.audit(this.db, actorId, 'daily.remove', 'daily', date, removed[0], null);
  }

  /* ------------------------------------------------------------ Helpers */

  private publicUser(user: typeof users.$inferSelect) {
    const { id, email, name, country, state, birthYear, gender, status, createdAt } = user;
    return { id, email, name, country, state: placeLabel(state), birthYear, gender, status, createdAt };
  }

  private async sharesAt(at: Date) {
    const rows = await this.db
      .select()
      .from(revenueShareHistory)
      .where(lte(revenueShareHistory.effectiveFrom, at))
      .orderBy(asc(revenueShareHistory.effectiveFrom), asc(revenueShareHistory.createdAt));
    const current = new Map<string, number>();
    for (const row of rows) current.set(row.instructorId, row.percentBps);
    return current;
  }

  private async defaultShare() {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, 'default_revenue_share_bps')).limit(1);
    return typeof row?.value === 'number' ? row.value : 6000;
  }

  private async uniqueSlug(name: string, taken: (slug: string) => Promise<boolean>) {
    const base = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      if (!(await taken(slug))) return slug;
    }
    throw fail(409, 'slug_taken', 'Try a slightly different name.');
  }

  private async findCourse(courseId: string) {
    const [course] = await this.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
    if (!course) throw fail(404, 'not_found', 'No such course.');
    return course;
  }

  private async findInstructor(instructorId: string) {
    const [instructor] = await this.db.select().from(instructors).where(eq(instructors.id, instructorId)).limit(1);
    if (!instructor) throw fail(404, 'not_found', 'No such instructor.');
    return instructor;
  }

  private async findUser(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw fail(404, 'not_found', 'No such account.');
    return user;
  }

  private async audit(db: Pick<Db, 'insert'>, actorId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    await db.insert(auditLog).values({ actorId, action, entityType, entityId, before: before ?? null, after: after ?? null });
  }
}
