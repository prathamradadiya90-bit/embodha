import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import { chapters, courseRevisions, courses, mediaAssets } from '../db/schema';

type Course = typeof courses.$inferSelect;
type Writer = Pick<Db, 'select' | 'update' | 'insert'>;

export interface DraftChapter {
  id: string;
  /** Made in these changes; it joins the course when they're approved. */
  isNew: boolean;
  title: string;
  type: 'video' | 'audio';
  isPreview: boolean;
  notes: string | null;
  mediaAssetId: string | null;
}
export interface Draft {
  course: { title: string; description: string | null; level: Course['level']; language: string; equipment: string[]; cautions: string | null };
  chapters: DraftChapter[];
}
export interface ChangeItem {
  what: string;
  before?: string | null;
  after?: string | null;
}

const FIELDS = { title: 'Title', description: 'Description', level: 'Level', language: 'Language', equipment: 'Equipment', cautions: 'Cautions' } as const;
type Field = keyof typeof FIELDS;
const show = (value: unknown) => (Array.isArray(value) ? value.join(', ') || null : ((value as string | null) ?? null));
const openChange = (courseId: string) => and(eq(courseRevisions.courseId, courseId), eq(courseRevisions.kind, 'change'), isNull(courseRevisions.decision));

/**
 * Changes to a live course. Members keep seeing the course as it is; the instructor edits a copy (an open 'change'
 * revision) through the same studio screens, sends it to admin, and it's applied in one go when approved.
 * Chapters can be added, renamed, reordered, given new media or notes, and switched to free previews; a live
 * chapter can't be removed, because members may have bought the course for it. The price and the address stay.
 */
@Injectable()
export class ChangesService {
  constructor(@InjectDb() private readonly db: Db) {}

  async open(courseId: string) {
    const [revision] = await this.db.select().from(courseRevisions).where(openChange(courseId)).limit(1);
    return revision ?? null;
  }

  /** Runs an edit on the copy, starting one from the live course if there isn't one. Locked, so edits can't overwrite each other. */
  async edit<T>(course: Course, change: (draft: Draft) => T): Promise<T> {
    if (!(await this.open(course.id))) {
      // Two first edits at once: the unique index lets one in, and the other uses it.
      await this.db.insert(courseRevisions).values({ courseId: course.id, kind: 'change', snapshot: await this.fromLive(this.db, course), submittedAt: null }).onConflictDoNothing();
    }
    return this.db.transaction(async (tx) => {
      const [revision] = await tx.select().from(courseRevisions).where(openChange(course.id)).for('update');
      if (revision.submittedAt) throw fail(409, 'changes_in_review', 'Your changes are with the Embodha team. Take them back to keep editing.');
      const draft = revision.snapshot as Draft;
      const result = change(draft);
      await tx.update(courseRevisions).set({ snapshot: draft }).where(eq(courseRevisions.id, revision.id));
      return result;
    });
  }

  updateCourse(course: Course, patch: Partial<Record<Field, unknown>>) {
    return this.edit(course, (draft) => {
      for (const field of Object.keys(FIELDS) as Field[]) if (patch[field] !== undefined) (draft.course as Record<Field, unknown>)[field] = patch[field];
    });
  }

  addChapter(course: Course, input: { title: string; type: 'video' | 'audio'; isPreview?: boolean }) {
    return this.edit(course, (draft) => {
      const chapter: DraftChapter = { id: randomUUID(), isNew: true, title: input.title, type: input.type, isPreview: input.isPreview ?? false, notes: null, mediaAssetId: null };
      draft.chapters.push(chapter);
      return { ...chapter, sort: draft.chapters.length };
    });
  }

  updateChapter(course: Course, chapterId: string, patch: { title?: string; isPreview?: boolean; notes?: string; mediaAssetId?: string }) {
    return this.edit(course, (draft) => {
      const chapter = this.chapterIn(draft, chapterId);
      for (const key of ['title', 'isPreview', 'notes', 'mediaAssetId'] as const) if (patch[key] !== undefined) (chapter as unknown as Record<string, unknown>)[key] = patch[key];
      return chapter;
    });
  }

  removeChapter(course: Course, chapterId: string) {
    return this.edit(course, (draft) => {
      if (!this.chapterIn(draft, chapterId).isNew) {
        throw fail(409, 'live_chapter', 'Members may have bought this course for this chapter, so it stays. Rename it or give it a new video instead.');
      }
      draft.chapters = draft.chapters.filter((c) => c.id !== chapterId);
    });
  }

  reorder(course: Course, ids: string[]) {
    return this.edit(course, (draft) => {
      const byId = new Map(draft.chapters.map((c) => [c.id, c]));
      if (ids.length !== byId.size || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
        throw fail(400, 'chapter_mismatch', 'Send every chapter of the course exactly once.');
      }
      draft.chapters = ids.map((id) => byId.get(id)!);
    });
  }

  /** A chapter so far only in an instructor's changes, found by its id alone (the studio's chapter routes have no course). */
  async findNewChapter(instructorId: string, chapterId: string) {
    const [row] = await this.db
      .select({ course: courses })
      .from(courseRevisions)
      .innerJoin(courses, eq(courses.id, courseRevisions.courseId))
      .where(and(eq(courses.instructorId, instructorId), eq(courseRevisions.kind, 'change'), isNull(courseRevisions.decision), sql`${courseRevisions.snapshot}->'chapters' @> ${JSON.stringify([{ id: chapterId }])}::jsonb`))
      .limit(1);
    return row?.course ?? null;
  }

  /** Whether an upload belongs to one of this instructor's open changes (it isn't on any live chapter yet). */
  async ownsPendingMedia(instructorId: string, mediaId: string) {
    const [row] = await this.db
      .select({ id: courseRevisions.id })
      .from(courseRevisions)
      .innerJoin(courses, eq(courses.id, courseRevisions.courseId))
      .where(and(eq(courses.instructorId, instructorId), eq(courseRevisions.kind, 'change'), isNull(courseRevisions.decision), sql`${courseRevisions.snapshot}->'chapters' @> ${JSON.stringify([{ mediaAssetId: mediaId }])}::jsonb`))
      .limit(1);
    return Boolean(row);
  }

  /** What the studio shows for a live course: the copy if there is one, with where it stands and admin's last word. */
  async view(course: Course) {
    const [open, [last]] = await Promise.all([
      this.open(course.id),
      this.db
        .select({ decision: courseRevisions.decision, comments: courseRevisions.comments, reviewedAt: courseRevisions.reviewedAt })
        .from(courseRevisions)
        .where(and(eq(courseRevisions.courseId, course.id), eq(courseRevisions.kind, 'change'), isNotNull(courseRevisions.decision)))
        .orderBy(desc(courseRevisions.reviewedAt))
        .limit(1),
    ]);
    const draft = (open?.snapshot as Draft | undefined) ?? (await this.fromLive(this.db, course));
    const media = await this.media(this.db, draft);
    return {
      ...course,
      ...draft.course,
      chapters: draft.chapters.map((c, i) => {
        const m = c.mediaAssetId ? media.get(c.mediaAssetId) : undefined;
        return { ...c, sort: i + 1, durationS: m?.durationS ?? null, media: m ? { id: m.id, status: m.status, error: m.error } : null };
      }),
      changes: {
        state: open ? (open.submittedAt ? ('in_review' as const) : ('editing' as const)) : null,
        submittedAt: open?.submittedAt ?? null,
        lastDecision: last ?? null,
      },
    };
  }

  async submit(course: Course) {
    const open = await this.open(course.id);
    if (!open) throw fail(409, 'no_changes', 'There are no changes to send.');
    if (open.submittedAt) return;
    const draft = open.snapshot as Draft;
    if (!(await this.diff(course, draft)).length) throw fail(409, 'no_changes', "Nothing differs from the live course yet.");
    await this.assertReady(this.db, draft);
    await this.db.update(courseRevisions).set({ submittedAt: new Date() }).where(and(eq(courseRevisions.id, open.id), isNull(courseRevisions.submittedAt)));
  }

  async withdraw(course: Course) {
    await this.db.update(courseRevisions).set({ submittedAt: null }).where(openChange(course.id));
  }

  async discard(course: Course) {
    const open = await this.open(course.id);
    if (open?.submittedAt) throw fail(409, 'changes_in_review', 'Take your changes back from review before throwing them away.');
    if (open) await this.db.delete(courseRevisions).where(eq(courseRevisions.id, open.id));
  }

  /* ------------------------------------------------------------ Admin */

  /** The changes waiting for admin, as a list a person can read: what it was, what it would be. */
  async forReview(course: Course) {
    const open = await this.open(course.id);
    if (!open?.submittedAt) throw fail(404, 'no_changes', 'No changes to this course are waiting for review.');
    return { submittedAt: open.submittedAt, items: await this.diff(course, open.snapshot as Draft) };
  }

  async approve(actorId: string, course: Course) {
    return this.db.transaction(async (tx) => {
      const [open] = await tx.select().from(courseRevisions).where(openChange(course.id)).for('update');
      if (!open?.submittedAt) throw fail(409, 'no_changes', 'No changes to this course are waiting for review.');
      const draft = open.snapshot as Draft;
      await this.assertReady(tx, draft);
      const media = await this.media(tx, draft);
      await tx.update(courses).set(draft.course).where(eq(courses.id, course.id));
      for (const [i, c] of draft.chapters.entries()) {
        const values = { title: c.title, isPreview: c.isPreview, notes: c.notes, sort: i + 1, mediaAssetId: c.mediaAssetId, durationS: media.get(c.mediaAssetId!)?.durationS ?? undefined };
        if (c.isNew) await tx.insert(chapters).values({ id: c.id, courseId: course.id, type: c.type, ...values });
        else await tx.update(chapters).set(values).where(and(eq(chapters.id, c.id), eq(chapters.courseId, course.id)));
      }
      await tx.update(courseRevisions).set({ decision: 'approved', reviewedBy: actorId, reviewedAt: new Date() }).where(eq(courseRevisions.id, open.id));
      await audit(tx, { actorId, action: 'course.changes_approved', entityType: 'course', entityId: course.id, before: (await this.fromLive(tx, course)).course, after: draft.course });
      return { titleChanged: draft.course.title !== course.title };
    });
  }

  /** Sent back with a note. The instructor's copy stays, so they carry on from where they were. */
  async sendBack(actorId: string, course: Course, comments: string) {
    await this.db.transaction(async (tx) => {
      const [open] = await tx.select().from(courseRevisions).where(openChange(course.id)).for('update');
      if (!open?.submittedAt) throw fail(409, 'no_changes', 'No changes to this course are waiting for review.');
      await tx.update(courseRevisions).set({ decision: 'rejected', comments, reviewedBy: actorId, reviewedAt: new Date() }).where(eq(courseRevisions.id, open.id));
      await tx.insert(courseRevisions).values({ courseId: course.id, kind: 'change', snapshot: open.snapshot, submittedAt: null });
      await audit(tx, { actorId, action: 'course.changes_returned', entityType: 'course', entityId: course.id, after: { comments } });
    });
  }

  /* ------------------------------------------------------------ Helpers */

  private chapterIn(draft: Draft, chapterId: string) {
    const chapter = draft.chapters.find((c) => c.id === chapterId);
    if (!chapter) throw fail(404, 'not_found', 'No such chapter in this course.');
    return chapter;
  }

  private async fromLive(db: Writer, course: Course): Promise<Draft> {
    const rows = await db.select().from(chapters).where(eq(chapters.courseId, course.id)).orderBy(asc(chapters.sort));
    return {
      course: { title: course.title, description: course.description, level: course.level, language: course.language, equipment: course.equipment, cautions: course.cautions },
      chapters: rows.map((c) => ({ id: c.id, isNew: false, title: c.title, type: c.type, isPreview: c.isPreview, notes: c.notes, mediaAssetId: c.mediaAssetId })),
    };
  }

  private async media(db: Writer, draft: Draft) {
    const ids = draft.chapters.map((c) => c.mediaAssetId).filter((id): id is string => Boolean(id));
    const rows = ids.length ? await db.select().from(mediaAssets).where(inArray(mediaAssets.id, ids)) : [];
    return new Map(rows.map((m) => [m.id, m]));
  }

  private async assertReady(db: Writer, draft: Draft) {
    if (!draft.chapters.length) throw fail(409, 'no_chapters', 'A course needs at least one chapter.');
    const media = await this.media(db, draft);
    const waiting = draft.chapters.filter((c) => media.get(c.mediaAssetId ?? '')?.status !== 'ready').map((c) => c.title);
    if (waiting.length) {
      throw fail(409, 'chapters_not_ready', `${waiting.length === 1 ? 'One chapter is' : `${waiting.length} chapters are`} still missing a finished video.`, { chapters: waiting });
    }
  }

  private async diff(course: Course, draft: Draft): Promise<ChangeItem[]> {
    const live = await this.fromLive(this.db, course);
    const items: ChangeItem[] = [];
    for (const field of Object.keys(FIELDS) as Field[]) {
      if (JSON.stringify(live.course[field]) !== JSON.stringify(draft.course[field])) items.push({ what: FIELDS[field], before: show(live.course[field]), after: show(draft.course[field]) });
    }
    const was = new Map(live.chapters.map((c) => [c.id, c]));
    for (const [i, c] of draft.chapters.entries()) {
      const before = was.get(c.id);
      if (!before) {
        items.push({ what: 'New chapter', after: `${c.title} (${c.type}), as chapter ${i + 1}` });
        continue;
      }
      if (before.title !== c.title) items.push({ what: 'Chapter renamed', before: before.title, after: c.title });
      if (before.mediaAssetId !== c.mediaAssetId) items.push({ what: c.type === 'audio' ? 'New audio' : 'New video', after: c.title });
      if (before.isPreview !== c.isPreview) items.push({ what: 'Free preview', after: `${c.title}: ${c.isPreview ? 'now free to preview' : 'no longer free to preview'}` });
      if ((before.notes ?? '') !== (c.notes ?? '')) items.push({ what: 'Chapter notes', before: before.notes, after: c.notes });
    }
    const kept = draft.chapters.filter((c) => was.has(c.id)).map((c) => c.id);
    if (kept.join() !== live.chapters.map((c) => c.id).join()) items.push({ what: 'Chapter order', after: draft.chapters.map((c, i) => `${i + 1}. ${c.title}`).join('\n') });
    return items;
  }
}
