import { asc, count, eq } from 'drizzle-orm';
import { categories, chapters, courses, dailyContent, mediaAssets, revenueShareHistory, topics } from '../src/db/schema';
import { DEFAULT_DEV_SAMPLE_VIDEO_URL, seedDevData, seedReferenceData } from '../src/db/seed-data';
import { freshDb } from './helpers';

describe('Seed data', () => {
  it('loads reference and dev data, and runs again without duplicating anything', async () => {
    const { client, db } = await freshDb();
    for (let run = 0; run < 2; run++) {
      await seedReferenceData(db);
      await seedDevData(db);
    }

    const live = await db.select({ slug: categories.slug }).from(categories).where(eq(categories.active, true)).orderBy(asc(categories.sort));
    expect(live.map((c) => c.slug)).toEqual(['yoga', 'pranayam', 'meditation', 'strength-training', 'cardio', 'healing']);
    const [{ n: topicCount }] = await db.select({ n: count() }).from(topics);
    expect(topicCount).toBe(36);
    const [{ n: courseCount }] = await db.select({ n: count() }).from(courses);
    expect(courseCount).toBe(2);
    expect(await db.select().from(courses).where(eq(courses.isFree, true))).toHaveLength(1);
    const [{ n: shareRows }] = await db.select({ n: count() }).from(revenueShareHistory);
    expect(shareRows).toBe(2);

    // Every dev chapter plays the one sample stream, and has a length to show.
    const media = await db.select().from(mediaAssets);
    expect(media).toEqual([expect.objectContaining({ provider: 'dev_sample', hostAssetId: DEFAULT_DEV_SAMPLE_VIDEO_URL, status: 'ready' })]);
    const chapterRows = await db.select().from(chapters);
    expect(chapterRows).toHaveLength(12);
    expect(chapterRows.every((c) => c.mediaAssetId === media[0].id && (c.durationS ?? 0) > 0)).toBe(true);
    const [{ n: quoteDays }] = await db.select({ n: count() }).from(dailyContent);
    expect(quoteDays).toBe(14);
    await client.close();
  });
});
