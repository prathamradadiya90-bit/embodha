import { and, eq, inArray, isNull } from 'drizzle-orm';
import { slugify } from '../common/slug';
import type { Db } from './db.module';
import * as s from './schema';

/** The client's six categories are live; the five suggested in the spec stay off until they're approved. */
const CATEGORIES: { slug: string; name: string; active?: boolean; topics: string[] }[] = [
  { slug: 'yoga', name: 'Yoga', topics: ['Hatha', 'Vinyasa', 'Yoga for beginners', 'Back care', 'Chair yoga'] },
  { slug: 'pranayam', name: 'Pranayam', topics: ['Anulom vilom', 'Kapalbhati', 'Bhramari', 'Ujjayi', 'Breath for focus'] },
  { slug: 'meditation', name: 'Meditation', topics: ['Guided meditation', 'Mindfulness', 'Mantra', 'Yoga nidra'] },
  { slug: 'strength-training', name: 'Strength training', topics: ['Bodyweight', 'Dumbbells', 'Core', 'Strength after 50'] },
  { slug: 'cardio', name: 'Cardio', topics: ['Low-impact cardio', 'HIIT', 'Walking workouts', 'Dance cardio'] },
  { slug: 'healing', name: 'Healing', topics: ['Sound healing', 'Mudras', 'Chakra meditation', 'Emotional release'] },
  { slug: 'sleep', name: 'Sleep', active: false, topics: ['Sleep meditations', 'Bedtime stretches'] },
  { slug: 'mobility', name: 'Mobility and stretching', active: false, topics: ['Desk stretches', 'Hip and shoulder mobility'] },
  { slug: 'pilates', name: 'Pilates', active: false, topics: ['Mat Pilates', 'Core control'] },
  { slug: 'kickboxing', name: 'Kickboxing', active: false, topics: ['Kickboxing basics', 'Cardio kickboxing'] },
  { slug: 'pre-and-postnatal', name: 'Pre- and postnatal', active: false, topics: ['Prenatal yoga', 'Postnatal core recovery'] },
];

const BREATHING = [
  { slug: 'box', name: 'Box breathing', description: 'Four counts in, hold, out, hold. Steadies you before a busy day.', inhaleS: 4, holdInS: 4, exhaleS: 4, holdOutS: 4, rounds: 6 },
  { slug: '4-7-8', name: '4-7-8 breathing', description: 'A long exhale for winding down.', inhaleS: 4, holdInS: 7, exhaleS: 8, holdOutS: 0, rounds: 4 },
  { slug: 'slow', name: 'Slow breathing', description: 'About six breaths a minute.', inhaleS: 5, holdInS: 0, exhaleS: 5, holdOutS: 0, rounds: 12 },
  { slug: 'long-sigh', name: 'Long sigh', description: 'A full breath in, a slow sigh out.', inhaleS: 3, holdInS: 0, exhaleS: 6, holdOutS: 0, rounds: 5 },
];

/** Placeholders until admin sets real prices. INR includes 18% GST; USD has none. */
const PRICE_POINTS: (typeof s.pricePoints.$inferInsert)[] = [
  { code: 'C199', kind: 'course', inrPaise: 19_900, usdCents: 300 },
  { code: 'C499', kind: 'course', inrPaise: 49_900, usdCents: 600 },
  { code: 'C999', kind: 'course', inrPaise: 99_900, usdCents: 1_200 },
  { code: 'C1499', kind: 'course', inrPaise: 149_900, usdCents: 1_800 },
  { code: 'C1999', kind: 'course', inrPaise: 199_900, usdCents: 2_400 },
  { code: 'C2999', kind: 'course', inrPaise: 299_900, usdCents: 3_600 },
  { code: 'S299', kind: 'subscription', inrPaise: 29_900, usdCents: 400 },
  { code: 'S499', kind: 'subscription', inrPaise: 49_900, usdCents: 600 },
  { code: 'S799', kind: 'subscription', inrPaise: 79_900, usdCents: 1_000 },
];

/** Defaults for the decisions still open in the spec. Admin changes these in settings. */
const SETTINGS: Record<string, unknown> = {
  default_revenue_share_bps: 6000,
  split_base: 'net',
  gst_rate_bps: 1800,
  refund_window_days: 7,
  min_payout_paise: 50_000,
  payout_lag_months: 1,
  // Estimates dollar sales until the channel's own figure replaces it (Razorpay's conversion, or a store's report).
  usd_inr_rate: 88,
  // Apple's and Google's cut of in-app sales, on the price before GST (both small-business programmes).
  store_commission_bps: 1500,
};

async function instructorBySlug(db: Db, slug: string) {
  const [row] = await db.select().from(s.instructors).where(eq(s.instructors.slug, slug)).limit(1);
  return row;
}

async function pricePointByCode(db: Db, code: string) {
  const [row] = await db.select().from(s.pricePoints).where(eq(s.pricePoints.code, code)).limit(1);
  return row;
}

async function ensureShare(db: Db, instructorId: string, percentBps: number, reason: string) {
  const [existing] = await db
    .select({ id: s.revenueShareHistory.id })
    .from(s.revenueShareHistory)
    .where(eq(s.revenueShareHistory.instructorId, instructorId))
    .limit(1);
  if (!existing) {
    await db.insert(s.revenueShareHistory).values({ instructorId, percentBps, effectiveFrom: new Date('2026-01-01T00:00:00Z'), reason });
  }
}

async function ensureUser(db: Db, email: string, name: string) {
  await db.insert(s.users).values({ email, name, country: 'IN', state: '29', birthYear: 1990 }).onConflictDoNothing({ target: s.users.email });
  const [user] = await db.select().from(s.users).where(eq(s.users.email, email)).limit(1);
  await db.insert(s.userPreferences).values({ userId: user.id }).onConflictDoNothing();
  return user;
}

type DevChapter = [title: string, minutes: number];

async function ensureCourse(
  db: Db,
  course: Omit<typeof s.courses.$inferInsert, 'topicId'> & { topicSlug: string; chapters: DevChapter[] },
) {
  const [existing] = await db.select({ id: s.courses.id }).from(s.courses).where(eq(s.courses.slug, course.slug)).limit(1);
  if (existing) return existing.id;
  const { topicSlug, chapters, ...values } = course;
  const [topic] = await db.select({ id: s.topics.id }).from(s.topics).where(eq(s.topics.slug, topicSlug)).limit(1);
  const [created] = await db
    .insert(s.courses)
    .values({ ...values, topicId: topic.id, status: 'published', publishedAt: new Date() })
    .returning({ id: s.courses.id });
  await db.insert(s.chapters).values(
    chapters.map(([title, minutes], i) => ({
      courseId: created.id,
      title,
      type: 'video' as const,
      durationS: minutes * 60,
      sort: i + 1,
      isPreview: i === 0,
    })),
  );
  return created.id;
}

/** Mux's public Big Buck Bunny test stream. Override with DEV_SAMPLE_VIDEO_URL. */
export const DEFAULT_DEV_SAMPLE_VIDEO_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

/** Points every dev chapter that has no video yet at one sample stream, so the app can play something locally. */
async function attachSampleVideo(db: Db, courseIds: string[], url: string) {
  await db
    .insert(s.mediaAssets)
    .values({ kind: 'video', provider: 'dev_sample', hostAssetId: url, status: 'ready' })
    .onConflictDoNothing({ target: [s.mediaAssets.provider, s.mediaAssets.hostAssetId] });
  const [sample] = await db
    .select({ id: s.mediaAssets.id })
    .from(s.mediaAssets)
    .where(and(eq(s.mediaAssets.provider, 'dev_sample'), eq(s.mediaAssets.hostAssetId, url)))
    .limit(1);
  await db
    .update(s.chapters)
    .set({ mediaAssetId: sample.id })
    .where(and(inArray(s.chapters.courseId, courseIds), isNull(s.chapters.mediaAssetId)));
}

/** Dev quotes for the next two weeks, so the home screen has something in the quote slot. */
async function ensureDevQuotes(db: Db) {
  const lines: [string, string | null][] = [
    ['Breathe in for four, out for six. Most worries can wait one breath.', null],
    ['A short practice you keep beats a long one you skip.', null],
    ['Stiff today is not stiff forever.', null],
    ['Notice the out-breath. It is where the body lets go.', null],
    ['Start where you are. Use the mat you have.', null],
    ['Ten minutes of attention is a good day’s practice.', null],
    ['Rest is part of the training.', null],
  ];
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const rows = Array.from({ length: 14 }, (_, i) => {
    const [text, author] = lines[i % lines.length];
    return { date: new Date(today + i * 86_400_000).toISOString().slice(0, 10), type: 'quote' as const, text, author };
  });
  await db.insert(s.dailyContent).values(rows).onConflictDoNothing({ target: [s.dailyContent.date, s.dailyContent.type] });
}

/** Safe to run on every deploy: it only adds what's missing. */
export async function seedReferenceData(db: Db) {
  for (const [i, category] of CATEGORIES.entries()) {
    await db
      .insert(s.categories)
      .values({ slug: category.slug, name: category.name, sort: i + 1, active: category.active ?? true })
      .onConflictDoNothing({ target: s.categories.slug });
    const [row] = await db.select({ id: s.categories.id }).from(s.categories).where(eq(s.categories.slug, category.slug)).limit(1);
    await db
      .insert(s.topics)
      .values(category.topics.map((name, j) => ({ categoryId: row.id, name, slug: slugify(name), sort: j + 1 })))
      .onConflictDoNothing({ target: s.topics.slug });
  }
  await db
    .insert(s.breathingPatterns)
    .values(BREATHING.map((pattern, i) => ({ ...pattern, sort: i + 1 })))
    .onConflictDoNothing({ target: s.breathingPatterns.slug });
  await db
    .insert(s.pricePoints)
    .values(PRICE_POINTS.map((point, i) => ({ ...point, sort: i + 1 })))
    .onConflictDoNothing({ target: s.pricePoints.code });
  await db
    .insert(s.settings)
    .values(Object.entries(SETTINGS).map(([key, value]) => ({ key, value })))
    .onConflictDoNothing({ target: s.settings.key });

  // Courses Embodha publishes itself. The house keeps the whole net, so its share is 0%.
  await db.insert(s.instructors).values({ slug: 'embodha', displayName: 'Embodha', status: 'approved' }).onConflictDoNothing({ target: s.instructors.slug });
  const house = await instructorBySlug(db, 'embodha');
  await ensureShare(db, house.id, 0, 'House courses: Embodha keeps the full net');
}

/**
 * Local development only: an admin, a member, one instructor, two courses whose chapters play a sample stream,
 * and two weeks of quotes.
 */
export async function seedDevData(db: Db, options: { sampleVideoUrl?: string } = {}) {
  const admin = await ensureUser(db, 'admin@embodha.local', 'Dev Admin');
  await db.insert(s.staffRoles).values({ userId: admin.id, role: 'super_admin' }).onConflictDoNothing();
  await ensureUser(db, 'member@embodha.local', 'Dev Member');

  const ashaUser = await ensureUser(db, 'asha@embodha.local', 'Asha Rao');
  await db
    .insert(s.instructors)
    .values({ userId: ashaUser.id, slug: 'asha-rao', displayName: 'Asha Rao', status: 'approved', specialties: ['yoga', 'pranayam'], bio: 'Placeholder profile for local development.' })
    .onConflictDoNothing({ target: s.instructors.slug });
  const asha = await instructorBySlug(db, 'asha-rao');
  await ensureShare(db, asha.id, 6000, 'Placeholder until the client sets percentages');
  const monthly = await pricePointByCode(db, 'S499');
  await db.insert(s.instructorPlans).values({ instructorId: asha.id, enabled: true, pricePointId: monthly.id }).onConflictDoNothing();

  const freeCourse = await ensureCourse(db, {
    slug: 'morning-breath-5-days',
    title: 'Morning Breath, 5 Days',
    description: 'Five short morning sessions that slow the breath down and set up the day. No experience needed.',
    topicSlug: 'breath-for-focus',
    instructorId: asha.id,
    isFree: true,
    level: 'beginner',
    chapters: [
      ['Arrive and settle', 6],
      ['Longer exhales', 8],
      ['Box breathing', 8],
      ['Alternate nostril', 10],
      ['Your own rhythm', 10],
    ],
  });
  const price = await pricePointByCode(db, 'C999');
  const paidCourse = await ensureCourse(db, {
    slug: '7-day-gentle-spine',
    title: '7-Day Gentle Spine',
    description: 'A week of slow, supported movement for a stiff back. Each day builds on the last.',
    topicSlug: 'back-care',
    instructorId: asha.id,
    pricePointId: price.id,
    level: 'beginner',
    equipment: ['Mat', 'Cushion'],
    cautions: 'Skip the twists if you have a recent back injury.',
    chapters: [
      ['Wake the spine', 12],
      ['Cat and cow', 14],
      ['Gentle twists', 15],
      ['Side bends', 15],
      ['Hip release', 18],
      ['Supported backbends', 18],
      ['Putting it together', 20],
    ],
  });
  await attachSampleVideo(db, [freeCourse, paidCourse], options.sampleVideoUrl || DEFAULT_DEV_SAMPLE_VIDEO_URL);
  await ensureDevQuotes(db);
}
