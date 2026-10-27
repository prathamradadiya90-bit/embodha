/**
 * The whole data model from the product spec (section "Data model"), in one place.
 * Money is stored in minor units (paise, cents) as integers; percentages in basis points (6000 = 60%).
 * Status columns are text with a fixed list of values, so adding a value doesn't need ALTER TYPE.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const GENDERS = ['female', 'male', 'non_binary', 'prefer_not_to_say'] as const;
/** 'erased': the account row kept, empty, because payments point at it (see ErasureService). */
export const USER_STATUSES = ['active', 'suspended', 'deleting', 'erased'] as const;
export const STAFF_ROLES = ['super_admin', 'content', 'finance', 'support'] as const;
export const INSTRUCTOR_STATUSES = ['applied', 'approved', 'rejected', 'suspended'] as const;
export const LEVELS = ['beginner', 'intermediate', 'advanced', 'all'] as const;
export const COURSE_STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;
export const MEDIA_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export const CHANNELS = ['razorpay', 'apple', 'google'] as const;
export const CURRENCIES = ['INR', 'USD'] as const;
export const PAYMENT_STATUSES = ['captured', 'refunded', 'partially_refunded', 'failed'] as const;
/**
 * Where a payment's fee and net came from: the channel at the time (Razorpay's own fee on the payment), an estimate
 * at the usual rate (the stores' commission, or a fee Razorpay hadn't given), or a settlement or store report.
 */
export const FEE_SOURCES = ['channel', 'estimate', 'report'] as const;
/**
 * What a line of a settlement or store report came to:
 * - matched: our books already said the same;
 * - corrected: the report's real fee, rate or proceeds replaced our estimate;
 * - booked: missing from our books (a notification that never came), and booked from the report;
 * - unbooked: missing from our books, and it couldn't be booked automatically;
 * - differs: the same sale, but a different amount;
 * - other: money in or out that isn't a sale or refund, like an adjustment or a dispute;
 * - needs_rate: App Store proceeds in a currency whose rupee rate hasn't been entered yet;
 * - explained: finance looked into an unbooked, differs or other line and wrote down why.
 */
export const RECON_STATUSES = ['matched', 'corrected', 'booked', 'unbooked', 'differs', 'other', 'needs_rate', 'explained'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'cancelled', 'expired'] as const;
export const SPLIT_STATES = ['pending', 'payable', 'paid', 'reversed'] as const;
export const NOTIFICATION_TYPES = ['campaign', 'new_from_instructor', 'new_in_category', 'daily_quote', 'account'] as const;

export type MediaStatus = (typeof MEDIA_STATUSES)[number];

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const emptyTextArray = sql`'{}'::text[]`;

/* ---------------------------------------------------------------- People and access */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(), // stored lower-case; the only sign-in identity
  name: text('name'),
  country: text('country'), // ISO 3166-1 alpha-2, upper case; decides INR or USD and GST
  /** In India, the state or union territory by its GST code ('29' is Karnataka). Decides CGST and SGST or IGST. */
  state: text('state'),
  birthYear: smallint('birth_year'),
  gender: text('gender', { enum: GENDERS }),
  timezone: text('timezone'), // IANA name; quiet hours and reminders run on it
  status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: tstz('deleted_at'),
});

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  goals: text('goals').array().notNull().default(emptyTextArray),
  reminderTime: text('reminder_time'), // "07:30" in the member's own time zone
  breathOnLaunch: boolean('breath_on_launch').notNull().default(true),
  sceneId: uuid('scene_id'),
  language: text('language').notNull().default('en'),
  updatedAt: updatedAt(),
});

export const emailCodes = pgTable(
  'email_codes',
  {
    id: id(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    linkHash: text('link_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    ip: text('ip'),
    deviceId: text('device_id'),
    consumedAt: tstz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('email_codes_email_idx').on(t.email, t.createdAt), index('email_codes_ip_idx').on(t.ip, t.createdAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    previousTokenHash: text('previous_token_hash'), // a replay of this one revokes the session
    deviceId: text('device_id'),
    userAgent: text('user_agent'),
    expiresAt: tstz('expires_at').notNull(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    pushToken: text('push_token').notNull().unique(),
    appVersion: text('app_version'),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

export const staffRoles = pgTable(
  'staff_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: STAFF_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/**
 * What the apps report as people use them: app opens, screens, course pages, the locked screen, purchases started,
 * finished or dropped. First-party only, no third-party tracker. Guests are a random ID made on the device; a member's
 * events carry their account, which the data download includes and deletion detaches.
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    anonId: text('anon_id').notNull(),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    appVersion: text('app_version'),
    props: jsonb('props').$type<Record<string, string | number | boolean>>().notNull().default({}),
    clientAt: tstz('client_at'),
    at: tstz('at').notNull().defaultNow(),
  },
  // By name for the report; by member for their data download and for detaching rows when an account is deleted.
  (t) => [index('events_name_at_idx').on(t.name, t.at), index('events_user_at_idx').on(t.userId, t.at)],
);

/**
 * Crash and error reports from the apps, first-party like the events: what went wrong in the code, where, and on
 * what phone. A crash is saved on the phone as it happens and sent on the next launch. Same-looking problems share a
 * fingerprint, so the beta's list counts each once.
 */
export const appErrors = pgTable(
  'app_errors',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind', { enum: ['crash', 'error'] }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    screen: text('screen'),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    appVersion: text('app_version'),
    osVersion: text('os_version'),
    device: text('device'),
    anonId: text('anon_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    clientAt: tstz('client_at'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('app_errors_at_idx').on(t.at), index('app_errors_fingerprint_idx').on(t.fingerprint, t.at), index('app_errors_user_idx').on(t.userId)],
);

/** What members tell the team from "Send feedback" under You, with the app version and phone it came from. */
export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    screen: text('screen'),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    appVersion: text('app_version'),
    osVersion: text('os_version'),
    device: text('device'),
    handledAt: tstz('handled_at'),
    handledBy: uuid('handled_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('feedback_created_idx').on(t.createdAt)],
);

/**
 * Each install of the app, by the random ID it made for itself, and the member last signed in on it. Lets a guest
 * who signs in later count once, as the member. The app makes a new ID when someone signs out.
 */
export const installs = pgTable(
  'installs',
  {
    anonId: text('anon_id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
    firstSeen: tstz('first_seen').notNull().defaultNow(),
    lastSeen: tstz('last_seen').notNull().defaultNow(),
  },
  (t) => [index('installs_user_idx').on(t.userId)],
);

/** Each install on each Indian day it was used, and whether anyone was signed in on it that day. Guests are the rest. */
export const installDays = pgTable(
  'install_days',
  {
    anonId: text('anon_id').notNull(),
    day: date('day').notNull(),
    signedIn: boolean('signed_in').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.anonId, t.day] }), index('install_days_day_idx').on(t.day)],
);

/**
 * One row per member per Indian day they opened the app or practised, written as it happens. Analytics counts these
 * rather than every heartbeat, which keeps the page quick however much people practise.
 */
export const activeDays = pgTable(
  'active_days',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    /** Played a chapter or finished a breath that day, not just opened the app. */
    practised: boolean('practised').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] }), index('active_days_day_idx').on(t.day)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entityType, t.entityId)],
);

/* ---------------------------------------------------------------- Instructors */

export const instructors = pgTable('instructors', {
  id: id(),
  userId: uuid('user_id')
    .unique()
    .references(() => users.id, { onDelete: 'set null' }), // null for the house "Embodha" instructor
  displayName: text('display_name').notNull(),
  slug: text('slug').notNull().unique(),
  bio: text('bio'),
  photoUrl: text('photo_url'),
  specialties: text('specialties').array().notNull().default(emptyTextArray),
  status: text('status', { enum: INSTRUCTOR_STATUSES }).notNull().default('applied'),
  bankDetailsEnc: text('bank_details_enc'), // encrypted in the app; finance sees it only on statements
  gstin: text('gstin'),
  tdsRateBps: integer('tds_rate_bps').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const revenueShareHistory = pgTable(
  'revenue_share_history',
  {
    id: id(),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id, { onDelete: 'cascade' }),
    percentBps: integer('percent_bps').notNull(),
    effectiveFrom: tstz('effective_from').notNull(),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('revenue_share_instructor_idx').on(t.instructorId, t.effectiveFrom),
    check('revenue_share_percent_range', sql`${t.percentBps} between 0 and 10000`),
  ],
);

export const instructorPlans = pgTable('instructor_plans', {
  instructorId: uuid('instructor_id')
    .primaryKey()
    .references(() => instructors.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false), // the instructor's on/off switch
  pricePointId: uuid('price_point_id').references(() => pricePoints.id),
  razorpayPlanId: text('razorpay_plan_id'),
  appleProductId: text('apple_product_id'),
  googleProductId: text('google_product_id'),
  updatedAt: updatedAt(),
});

/** Razorpay plans can't change once made, so each instructor price and currency gets its own, made the first time someone subscribes. */
export const razorpayPlans = pgTable(
  'razorpay_plans',
  {
    id: id(),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id, { onDelete: 'cascade' }),
    pricePointId: uuid('price_point_id')
      .notNull()
      .references(() => pricePoints.id),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    planId: text('plan_id').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('razorpay_plans_lookup_idx').on(t.instructorId, t.pricePointId, t.currency)],
);

export const topicRequests = pgTable('topic_requests', {
  id: id(),
  instructorId: uuid('instructor_id')
    .notNull()
    .references(() => instructors.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  reason: text('reason'),
  status: text('status', { enum: ['open', 'approved', 'declined'] })
    .notNull()
    .default('open'),
  createdAt: createdAt(),
});

/* ---------------------------------------------------------------- Catalogue */

export const categories = pgTable('categories', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  icon: text('icon'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const topics = pgTable(
  'topics',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    coverUrl: text('cover_url'),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('topics_category_idx').on(t.categoryId)],
);

/** One list of prices for every channel, matched to Apple and Google price tiers. */
export const pricePoints = pgTable('price_points', {
  id: id(),
  code: text('code').notNull().unique(),
  kind: text('kind', { enum: ['course', 'subscription'] }).notNull(),
  inrPaise: integer('inr_paise').notNull(), // what Indian buyers pay, 18% GST included
  usdCents: integer('usd_cents').notNull(), // what everyone else pays, no GST
  appleTier: text('apple_tier'),
  googleTier: text('google_tier'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    kind: text('kind', { enum: ['video', 'audio', 'image'] }).notNull(),
    // dev_sample: a public test stream the dev seed attaches so local builds can play something. Never served in production.
    provider: text('provider', { enum: ['bunny_stream', 'bunny_storage', 'dev_sample'] }).notNull(),
    hostAssetId: text('host_asset_id').notNull(), // Bunny video GUID, the storage path for audio, or the dev sample's URL
    status: text('status', { enum: MEDIA_STATUSES }).notNull().default('uploading'),
    durationS: integer('duration_s'),
    thumbnailUrl: text('thumbnail_url'),
    /**
     * The heights of the single-file MP4 copies Bunny has made of a video (its "MP4 fallback"), which is what the apps
     * download for offline viewing. Empty when there are none: the library had MP4 fallback off when the video was
     * uploaded, or Bunny hasn't finished them yet.
     */
    downloadHeights: smallint('download_heights').array().notNull().default(sql`'{}'::smallint[]`),
    error: text('error'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('media_host_asset_idx').on(t.provider, t.hostAssetId)],
);

export const courses = pgTable(
  'courses',
  {
    id: id(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    level: text('level', { enum: LEVELS }).notNull().default('all'),
    language: text('language').notNull().default('en'),
    equipment: text('equipment').array().notNull().default(emptyTextArray),
    cautions: text('cautions'),
    coverUrl: text('cover_url'),
    trailerAssetId: uuid('trailer_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    pricePointId: uuid('price_point_id').references(() => pricePoints.id),
    isFree: boolean('is_free').notNull().default(false),
    status: text('status', { enum: COURSE_STATUSES }).notNull().default('draft'),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    publishedAt: tstz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('courses_topic_idx').on(t.topicId),
    index('courses_instructor_idx').on(t.instructorId),
    // The spec has exactly one free course, picked by admin. The database holds that line.
    uniqueIndex('courses_single_free_idx')
      .on(t.isFree)
      .where(sql`${t.isFree}`),
  ],
);

export const courseRevisions = pgTable(
  'course_revisions',
  {
    id: id(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /** 'first': a new course sent for review. 'change': edits to a live course, applied to it when approved. */
    kind: text('kind', { enum: ['first', 'change'] })
      .notNull()
      .default('first'),
    snapshot: jsonb('snapshot').notNull(),
    /** Null while an instructor is still making changes to a live course. */
    submittedAt: tstz('submitted_at').defaultNow(),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tstz('reviewed_at'),
    decision: text('decision', { enum: ['approved', 'rejected'] }),
    comments: text('comments'),
  },
  (t) => [
    index('course_revisions_course_idx').on(t.courseId),
    // One open set of changes per live course at a time.
    uniqueIndex('course_revisions_open_change_idx')
      .on(t.courseId)
      .where(sql`${t.kind} = 'change' and ${t.decision} is null`),
  ],
);

export const chapters = pgTable(
  'chapters',
  {
    id: id(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: text('type', { enum: ['video', 'audio'] }).notNull(),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    durationS: integer('duration_s'),
    sort: integer('sort').notNull().default(0),
    isPreview: boolean('is_preview').notNull().default(false), // free for everyone, even guests
    notes: text('notes'),
    attachmentUrl: text('attachment_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chapters_course_idx').on(t.courseId, t.sort)],
);

export const storeProducts = pgTable(
  'store_products',
  {
    id: id(),
    ownerType: text('owner_type', { enum: ['course', 'instructor_plan'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    store: text('store', { enum: ['apple', 'google'] }).notNull(),
    productId: text('product_id').notNull(),
    status: text('status', { enum: ['pending', 'in_review', 'live', 'failed', 'off_sale'] })
      .notNull()
      .default('pending'),
    lastError: text('last_error'),
    /** Made and kept up to date by the server (store-sync). False for a product someone made by hand and linked. */
    auto: boolean('auto').notNull().default(false),
    /** Apple's ID for the in-app purchase or subscription, and for the teacher's subscription group. */
    externalId: text('external_id'),
    groupId: text('group_id'),
    /** The store's own word for where the product stands, e.g. READY_TO_SUBMIT or ACTIVE. */
    storeState: text('store_state'),
    /** The price the store was last given, so a new price in the studio can be passed on. */
    pricePointId: uuid('price_point_id').references(() => pricePoints.id),
    /** Which steps of making the product are done, so a failed run picks up where it stopped. */
    steps: jsonb('steps').$type<Record<string, string | boolean>>().notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    syncedAt: tstz('synced_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('store_products_product_idx').on(t.store, t.productId),
    uniqueIndex('store_products_owner_idx').on(t.ownerType, t.ownerId, t.store), // one product per course or plan in each store
  ],
);

export const homeRails = pgTable('home_rails', {
  id: id(),
  title: text('title').notNull(),
  sort: integer('sort').notNull().default(0),
  courseIds: uuid('course_ids').array().notNull().default(sql`'{}'::uuid[]`),
  active: boolean('active').notNull().default(true),
});

/** The Today screen's quote, photo and short video ('clip'): one of each per date, each optional. */
export const dailyContent = pgTable(
  'daily_content',
  {
    date: date('date').notNull(),
    type: text('type', { enum: ['quote', 'image', 'clip'] }).notNull(),
    /** The quote, or the caption under a photo or video. */
    text: text('text'),
    /** Who said it, or who took the photo. */
    author: text('author'),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    /** A photo's size, so the app can make room for it before it loads. */
    width: smallint('width'),
    height: smallint('height'),
  },
  (t) => [primaryKey({ columns: [t.date, t.type] })],
);

export const breathingPatterns = pgTable('breathing_patterns', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  inhaleS: smallint('inhale_s').notNull(),
  holdInS: smallint('hold_in_s').notNull().default(0),
  exhaleS: smallint('exhale_s').notNull(),
  holdOutS: smallint('hold_out_s').notNull().default(0),
  rounds: smallint('rounds').notNull(),
  voiceAssetId: uuid('voice_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const scenes = pgTable('scenes', {
  id: id(),
  name: text('name').notNull(),
  visualAssetId: uuid('visual_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  ambientAssetId: uuid('ambient_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

/* ---------------------------------------------------------------- Engagement */

export const playbackEvents = pgTable(
  'playback_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    positionS: integer('position_s').notNull(),
    seconds: integer('seconds').notNull(),
    at: tstz('at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [index('playback_events_user_idx').on(t.userId, t.at)],
);

export const watchDaily = pgTable(
  'watch_daily',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    date: date('date').notNull(),
    seconds: integer('seconds').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.chapterId, t.date] }),
    index('watch_daily_instructor_idx').on(t.instructorId, t.date),
  ],
);

export const chapterProgress = pgTable(
  'chapter_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    positionS: integer('position_s').notNull().default(0),
    completedAt: tstz('completed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chapterId] })],
);

export const breathingSessions = pgTable(
  'breathing_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    patternId: uuid('pattern_id').references(() => breathingPatterns.id, { onDelete: 'set null' }),
    seconds: integer('seconds').notNull(),
    completedAt: tstz('completed_at').notNull().defaultNow(),
  },
  (t) => [index('breathing_sessions_user_idx').on(t.userId, t.completedAt)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    body: text('body'),
    status: text('status', { enum: ['visible', 'hidden', 'reported'] })
      .notNull()
      .default('visible'),
    teamReply: text('team_reply'),
    repliedAt: tstz('replied_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reviews_user_course_idx').on(t.userId, t.courseId),
    index('reviews_course_idx').on(t.courseId),
    check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
  ],
);

/** Private notes. Only the member reads these; no admin endpoint touches this table. */
export const notes = pgTable(
  'notes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    timestampS: integer('timestamp_s'),
    bodyEnc: text('body_enc').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('notes_user_idx').on(t.userId, t.chapterId)],
);

export const searchLog = pgTable('search_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  query: text('query').notNull(),
  resultsCount: integer('results_count').notNull(),
  at: tstz('at').notNull().defaultNow(),
});

/* ---------------------------------------------------------------- Money */

/**
 * The last number issued in each series of GST documents, one series per financial year: 'invoice/26-27' gives
 * EMB/26-27/000042, 'credit_note/26-27' gives CN/26-27/000007. The count goes up inside the transaction that issues
 * the document, so a sale that doesn't go through never uses up a number, and the series runs without gaps.
 */
export const documentCounters = pgTable('document_counters', {
  series: text('series').primaryKey(),
  last: integer('last').notNull(),
});

/** The seller as printed on an invoice, kept with it so a later change of address doesn't rewrite old invoices. */
export interface InvoiceSeller {
  name: string;
  address: string;
  gstin: string;
  /** The service code printed on invoices, if finance has set one. */
  sac?: string;
  /** The footnote printed at the bottom: for exports, the LUT they're made under. */
  note?: string;
}

/** One row per charge on any channel. Users are anonymised, never deleted, while payments exist. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind', { enum: ['course', 'subscription'] }).notNull(),
    courseId: uuid('course_id').references(() => courses.id),
    subscriptionId: uuid('subscription_id').references(() => instructorSubscriptions.id),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    country: text('country'),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    grossMinor: integer('gross_minor').notNull(),
    gstMinor: integer('gst_minor').notNull().default(0),
    /** The GST rate this sale was booked at: 1800 in India, 0 abroad. */
    gstRateBps: integer('gst_rate_bps').notNull().default(0),
    /** The buyer's state as it was on their account at the sale, as the invoice prints it. Null if none was given. */
    buyerState: text('buyer_state'),
    /**
     * Where the sale is taxed: the buyer's state, 96 for an export, null when it can't be said (a store sale, or a
     * sale booked before the seller's GSTIN was set). CGST + SGST, or IGST, add up to gstMinor whenever it's set.
     */
    placeOfSupply: text('place_of_supply'),
    cgstMinor: integer('cgst_minor').notNull().default(0),
    sgstMinor: integer('sgst_minor').notNull().default(0),
    igstMinor: integer('igst_minor').notNull().default(0),
    /** Who sold it, as the invoice says; only on sales with an Embodha invoice. */
    invoiceSeller: jsonb('invoice_seller').$type<InvoiceSeller>(),
    /** The channel's fee or commission, without any GST on it, in the payment's currency. */
    feeMinor: integer('fee_minor').notNull().default(0),
    /** GST the channel charged on its fee (Razorpay's), in paise. Claimed back as input credit, so it stays out of the split. */
    feeTaxPaise: integer('fee_tax_paise').notNull().default(0),
    feeSource: text('fee_source', { enum: FEE_SOURCES }).notNull().default('estimate'),
    netMinor: integer('net_minor').notNull(),
    netInrPaise: integer('net_inr_paise').notNull(),
    /** What the buyer paid, in rupees as the channel converted it: Razorpay's base amount for a dollar sale. */
    grossInrPaise: integer('gross_inr_paise'),
    fxRate: numeric('fx_rate', { precision: 12, scale: 6 }),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    /** App Store sandbox or Google Play test purchase: unlocks like a sale, but no invoice, no split, no money. */
    isTest: boolean('is_test').notNull().default(false),
    invoiceNo: text('invoice_no').unique(),
    capturedAt: tstz('captured_at'),
    /** In the apps: the store's product, and the price and currency the store said it charged, to match its reports. */
    productId: text('product_id'),
    chargedCurrency: text('charged_currency'),
    chargedPrice: numeric('charged_price', { precision: 14, scale: 2 }),
    /** What the channel paid out for this sale, in paise, once its settlement or report says, and the line that said so. */
    settledInrPaise: integer('settled_inr_paise'),
    reconciledAt: tstz('reconciled_at'),
    reconciliationLineId: bigint('reconciliation_line_id', { mode: 'number' }).references((): AnyPgColumn => reconciliationLines.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payments_external_idx').on(t.channel, t.externalId),
    index('payments_user_idx').on(t.userId),
    index('payments_instructor_idx').on(t.instructorId, t.capturedAt),
    index('payments_unreconciled_idx').on(t.channel, t.capturedAt).where(sql`reconciled_at is null and not is_test`),
  ],
);

/**
 * One imported settlement or store report: Razorpay's settlement recon (fetched with the API, or a file from the
 * dashboard), Google Play's monthly earnings report, or the App Store's monthly financial report.
 */
export const reconciliations = pgTable(
  'reconciliations',
  {
    id: id(),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    source: text('source', { enum: ['api', 'file'] }).notNull(),
    label: text('label').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    fileName: text('file_name'),
    /** App Store proceeds: rupees for one unit of each currency, from that month's payment in App Store Connect. */
    rates: jsonb('rates').$type<Record<string, string>>().notNull().default({}),
    /** Null for the nightly Razorpay fetch. */
    importedBy: uuid('imported_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('reconciliations_channel_idx').on(t.channel, t.createdAt)],
);

/** One line of a report, and what it came to against our books. A report's item is only ever matched once. */
export const reconciliationLines = pgTable(
  'reconciliation_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    /** The report's own reference: Razorpay's entity ID, Google's order ID, or for Apple the period, product and price. */
    ref: text('ref').notNull(),
    kind: text('kind', { enum: ['sale', 'refund', 'other'] }).notNull(),
    /** The payment it's about, when it's about one. An App Store line can cover several: see payments.reconciliationLineId. */
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, { onDelete: 'set null' }),
    quantity: integer('quantity').notNull().default(1),
    /** The currency of gross, fee and tax below, as the report gives them. */
    currency: text('currency'),
    grossMinor: bigint('gross_minor', { mode: 'number' }),
    feeMinor: bigint('fee_minor', { mode: 'number' }),
    taxMinor: bigint('tax_minor', { mode: 'number' }),
    /** What reached Embodha, in paise: positive for money in, negative for money out. Null while a rate is missing. */
    amountInrPaise: bigint('amount_inr_paise', { mode: 'number' }),
    /** What our books said Embodha would get for the same thing, in paise, before this line. */
    bookedInrPaise: bigint('booked_inr_paise', { mode: 'number' }),
    settledAt: tstz('settled_at'),
    settlementRef: text('settlement_ref'),
    status: text('status', { enum: RECON_STATUSES }).notNull(),
    /** What the importer found, in words. */
    note: text('note'),
    /** What finance found when they looked into it. */
    explanation: text('explanation'),
    explainedBy: uuid('explained_by').references(() => users.id, { onDelete: 'set null' }),
    explainedAt: tstz('explained_at'),
    raw: jsonb('raw'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reconciliation_lines_ref_idx').on(t.channel, t.ref, t.kind),
    index('reconciliation_lines_recon_idx').on(t.reconciliationId),
    index('reconciliation_lines_status_idx').on(t.status),
  ],
);

/** Courses owned for good. Free-course, subscription and own-course access are worked out, not stored. */
export const entitlements = pgTable(
  'entitlements',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['purchase', 'grant'] }).notNull(),
    paymentId: uuid('payment_id').references(() => payments.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.courseId] })],
);

export const instructorSubscriptions = pgTable(
  'instructor_subscriptions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    externalId: text('external_id').notNull(),
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
    currentPeriodEnd: tstz('current_period_end').notNull(), // access runs to here, even after cancelling
    autoRenew: boolean('auto_renew').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('instructor_subscriptions_external_idx').on(t.channel, t.externalId),
    index('instructor_subscriptions_member_idx').on(t.userId, t.instructorId),
  ],
);

/** Written the moment a payment is captured; the studio's live earnings read from here. */
export const splits = pgTable(
  'splits',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .unique()
      .references(() => payments.id),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    netInrPaise: integer('net_inr_paise').notNull(),
    percentBps: integer('percent_bps').notNull(), // the percentage this sale was split at, kept for good
    instructorPaise: integer('instructor_paise').notNull(),
    embodhaPaise: integer('embodha_paise').notNull(),
    state: text('state', { enum: SPLIT_STATES }).notNull().default('pending'),
    payableFrom: tstz('payable_from'),
    payoutLineId: uuid('payout_line_id'),
    createdAt: createdAt(),
  },
  (t) => [index('splits_instructor_state_idx').on(t.instructorId, t.state)],
);

export const refunds = pgTable('refunds', {
  id: id(),
  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id),
  amountMinor: integer('amount_minor').notNull(),
  reason: text('reason'),
  externalId: text('external_id'),
  /** Refunds of invoiced sales get a credit note, which takes the GST back off the books in the month it's issued. */
  creditNoteNo: text('credit_note_no').unique(),
  gstMinor: integer('gst_minor').notNull().default(0),
  cgstMinor: integer('cgst_minor').notNull().default(0),
  sgstMinor: integer('sgst_minor').notNull().default(0),
  igstMinor: integer('igst_minor').notNull().default(0),
  at: tstz('at').notNull().defaultNow(),
});

export const coupons = pgTable('coupons', {
  code: text('code').primaryKey(),
  discountBps: integer('discount_bps'),
  discountMinor: integer('discount_minor'),
  currency: text('currency', { enum: CURRENCIES }),
  validFrom: tstz('valid_from'),
  validTo: tstz('valid_to'),
  maxUses: integer('max_uses'),
  used: integer('used').notNull().default(0),
  createdAt: createdAt(),
});

export const payoutStatements = pgTable('payout_statements', {
  id: id(),
  month: date('month').notNull().unique(), // first day of the month the statement covers
  status: text('status', { enum: ['open', 'closed', 'paid'] })
    .notNull()
    .default('open'),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  closedAt: tstz('closed_at'),
  createdAt: createdAt(),
});

export const payoutLines = pgTable(
  'payout_lines',
  {
    id: id(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => payoutStatements.id, { onDelete: 'cascade' }),
    instructorId: uuid('instructor_id')
      .notNull()
      .references(() => instructors.id),
    payablePaise: integer('payable_paise').notNull(),
    tdsPaise: integer('tds_paise').notNull().default(0),
    netPaise: integer('net_paise').notNull(),
    bankReference: text('bank_reference'),
    paidAt: tstz('paid_at'),
    markedBy: uuid('marked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('payout_lines_statement_instructor_idx').on(t.statementId, t.instructorId)],
);

export const adjustments = pgTable('adjustments', {
  id: id(),
  instructorId: uuid('instructor_id')
    .notNull()
    .references(() => instructors.id),
  amountPaise: integer('amount_paise').notNull(), // negative for clawbacks
  reason: text('reason').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  statementId: uuid('statement_id').references(() => payoutStatements.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/* ---------------------------------------------------------------- Messaging and settings */

export const notifications = pgTable('notifications', {
  id: id(),
  type: text('type', { enum: NOTIFICATION_TYPES }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  imageUrl: text('image_url'),
  deepLink: text('deep_link'),
  audience: jsonb('audience'),
  scheduledAt: tstz('scheduled_at'),
  sentAt: tstz('sent_at'),
  sentCount: integer('sent_count').notNull().default(0),
  openCount: integer('open_count').notNull().default(0),
  /** Members whose push waited for their quiet hours to end. */
  heldCount: integer('held_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** The bell's history. */
export const userNotifications = pgTable(
  'user_notifications',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    readAt: tstz('read_at'),
    openedAt: tstz('opened_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.notificationId] }),
    index('user_notifications_user_idx').on(t.userId, t.createdAt),
  ],
);

/** A campaign's push to one member, held until their quiet hours end. The message is already in their bell. */
export const heldPushes = pgTable(
  'held_pushes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    sendAfter: tstz('send_after').notNull(),
  },
  (t) => [index('held_pushes_send_after_idx').on(t.sendAfter)],
);

/** One row per member per day of theirs that their daily reminder came due: sent, or not, because they'd practised. */
export const reminderLog = pgTable(
  'reminder_log',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    sent: boolean('sent').notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ Launch */

/** Where a webhook comes from. App Store notifications are kept apart by environment: production is the one launch needs. */
export const WEBHOOK_SOURCES = ['razorpay', 'apple', 'apple_sandbox', 'google', 'bunny'] as const;

/**
 * The last time each channel's webhook got through (its signature or secret checked, or Apple's payload read), so the
 * launch checklist can say a URL works. One row per source; it says nothing about whether the event was handled.
 */
export const webhookReceipts = pgTable('webhook_receipts', {
  source: text('source', { enum: WEBHOOK_SOURCES }).primaryKey(),
  lastAt: tstz('last_at').notNull(),
  lastEvent: text('last_event'),
  received: integer('received').notNull().default(0),
});

/** The launch gates only a person can confirm, such as the lawyer's read of the terms: who said so, when, and a note. */
export const launchSignoffs = pgTable('launch_signoffs', {
  key: text('key').primaryKey(),
  signedBy: uuid('signed_by').references(() => users.id, { onDelete: 'set null' }),
  signedAt: tstz('signed_at').notNull().defaultNow(),
  note: text('note'),
});

/* --------------------------------------------------------------- Downloads */

/**
 * Each phone a member keeps downloads on, by the random ID the app's download manager made for itself (a new one
 * after every sign-out). An account can have downloads on a few phones at once; a phone that hasn't checked in
 * for the keep window no longer counts, since its downloads have stopped playing.
 */
export const downloadDevices = pgTable(
  'download_devices',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
    /** The phone's model, as the app reports it ("Pixel 8"), so the member can tell their phones apart. */
    label: text('label'),
    checkedAt: tstz('checked_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/** The chapters on each of those phones, and which upload of the chapter each one is, so a replaced video gets fetched again. */
export const downloads = pgTable(
  'downloads',
  {
    userId: uuid('user_id').notNull(),
    deviceId: text('device_id').notNull(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
    /** The height of the video copy downloaded; null for audio. */
    height: smallint('height'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceId, t.chapterId] }),
    foreignKey({ columns: [t.userId, t.deviceId], foreignColumns: [downloadDevices.userId, downloadDevices.id] }).onDelete('cascade'),
    index('downloads_chapter_idx').on(t.chapterId),
  ],
);
