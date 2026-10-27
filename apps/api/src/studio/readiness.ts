import { eq } from 'drizzle-orm';
import { fail } from '../common/errors';
import type { Db } from '../db/db.module';
import { chapters, mediaAssets } from '../db/schema';

/**
 * What a course needs before admin sees it, and again before it goes live: chapters, a finished video for
 * every one of them, and a price unless it's the free course.
 */
export async function assertReadyForReview(db: Pick<Db, 'select'>, course: { id: string; isFree: boolean; pricePointId: string | null }) {
  const rows = await db
    .select({ title: chapters.title, status: mediaAssets.status })
    .from(chapters)
    .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
    .where(eq(chapters.courseId, course.id));
  if (!rows.length) throw fail(409, 'no_chapters', 'Add at least one chapter first.');
  const waiting = rows.filter((row) => row.status !== 'ready').map((row) => row.title);
  if (waiting.length) {
    throw fail(409, 'chapters_not_ready', `${waiting.length === 1 ? 'One chapter is' : `${waiting.length} chapters are`} still missing a finished video.`, {
      chapters: waiting,
    });
  }
  if (!course.isFree && !course.pricePointId) throw fail(409, 'no_price', 'Pick a price for the course first.');
}
