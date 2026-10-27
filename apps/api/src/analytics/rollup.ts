import { sql } from 'drizzle-orm';
import { BUSINESS_TIME_ZONE } from '../common/month';
import type { Db } from '../db/db.module';
import { activeDays } from '../db/schema';
import { localDay } from '../practice/streak';

/** The database, or a transaction on it. */
type Writer = Pick<Db, 'insert'>;

/** The Indian days these moments fall on, each once. */
export const indianDays = (moments: Date[]) => [...new Set(moments.map((at) => localDay(at, BUSINESS_TIME_ZONE)))];

/**
 * Marks a member active on the Indian days these moments fall on. Practice (a chapter played, a breath finished)
 * marks the day practised as well; opening the app never un-marks it.
 */
export async function markActive(db: Writer, userId: string, moments: Date[], practised: boolean) {
  const days = indianDays(moments);
  if (!days.length) return;
  await db
    .insert(activeDays)
    .values(days.map((day) => ({ userId, day, practised })))
    .onConflictDoUpdate({ target: [activeDays.userId, activeDays.day], set: { practised: sql`${activeDays.practised} or excluded.practised` } });
}
