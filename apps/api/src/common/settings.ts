import { eq } from 'drizzle-orm';
import type { Db } from '../db/db.module';
import { settings } from '../db/schema';

/** A value admin can change (the settings table), with the default the code falls back to. */
export async function readSetting<T>(db: Pick<Db, 'select'>, key: string, fallback: T): Promise<T> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value === undefined || row.value === null ? fallback : (row.value as T);
}
