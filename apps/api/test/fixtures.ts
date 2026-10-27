import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db/db.module';
import { categories, chapters, courses, instructorPlans, instructors, mediaAssets, pricePoints, topics, users } from '../src/db/schema';

/**
 * One instructor (Asha, monthly subscription switched on) with a free course, a ₹999 course
 * (preview, locked and still-processing chapters) and a draft.
 */
export async function seedFixtures(db: Db) {
  const [category] = await db.insert(categories).values({ name: 'Yoga', slug: 'yoga', sort: 1 }).returning();
  const [topic] = await db.insert(topics).values({ categoryId: category.id, name: 'Back care', slug: 'back-care' }).returning();
  const [coursePrice] = await db.insert(pricePoints).values({ code: 'C999', kind: 'course', inrPaise: 99_900, usdCents: 1_200 }).returning();
  const [monthly] = await db.insert(pricePoints).values({ code: 'S499', kind: 'subscription', inrPaise: 49_900, usdCents: 600 }).returning();
  const [ashaUser] = await db.insert(users).values({ email: 'asha@embodha.test', name: 'Asha Rao' }).returning();
  const [asha] = await db
    .insert(instructors)
    .values({ userId: ashaUser.id, displayName: 'Asha Rao', slug: 'asha-rao', status: 'approved' })
    .returning();
  await db.insert(instructorPlans).values({ instructorId: asha.id, enabled: true, pricePointId: monthly.id });

  const video = async (status: 'ready' | 'processing' = 'ready') =>
    (
      await db
        .insert(mediaAssets)
        .values({ kind: 'video', provider: 'bunny_stream', hostAssetId: randomUUID(), status, durationS: 600 })
        .returning()
    )[0];
  const course = async (slug: string, extra: Partial<typeof courses.$inferInsert> = {}) =>
    (
      await db
        .insert(courses)
        .values({ topicId: topic.id, instructorId: asha.id, title: slug, slug, status: 'published', publishedAt: new Date(), ...extra })
        .returning()
    )[0];
  const chapter = async (courseId: string, title: string, sort: number, extra: Partial<typeof chapters.$inferInsert> = {}) =>
    (await db.insert(chapters).values({ courseId, title, type: 'video', sort, durationS: 600, ...extra }).returning())[0];

  const free = await course('morning-breath', { isFree: true });
  const paid = await course('gentle-spine', { pricePointId: coursePrice.id });
  const draft = await course('draft-course', { status: 'draft', publishedAt: null, pricePointId: coursePrice.id });
  return {
    topic,
    asha,
    free,
    paid,
    draft,
    freeChapter: await chapter(free.id, 'Arrive', 1, { mediaAssetId: (await video()).id }),
    preview: await chapter(paid.id, 'Day 1', 1, { isPreview: true, mediaAssetId: (await video()).id }),
    locked: await chapter(paid.id, 'Day 2', 2, { mediaAssetId: (await video()).id }),
    processing: await chapter(paid.id, 'Day 3', 3, { mediaAssetId: (await video('processing')).id }),
    draftChapter: await chapter(draft.id, 'Draft day', 1, { mediaAssetId: (await video()).id }),
  };
}

export type Fixtures = Awaited<ReturnType<typeof seedFixtures>>;
