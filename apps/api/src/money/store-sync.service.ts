import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { courses, instructorPlans, instructors, pricePoints, storeProducts } from '../db/schema';
import { AppleProductState, AppStoreConnectClient } from './app-store-connect.client';
import { GooglePlayClient, money } from './google-play.client';

export type Owner = { type: 'course' | 'instructor_plan'; id: string };
type Store = 'apple' | 'google';
type Row = typeof storeProducts.$inferSelect;
type Status = Row['status'];

/** What the catalogue says a product should be right now. */
interface Wanted {
  title: string;
  slug: string;
  onSale: boolean;
  price: { id: string; inrPaise: number; usdCents: number } | null;
}

/** What a run has done so far. Saved even when a step fails, so the next run carries on from there. */
interface Progress {
  steps: Record<string, string | boolean>;
  externalId: string | null;
  groupId: string | null;
  notice: string | null;
}

const APPLE_STATUS: Partial<Record<AppleProductState, Status>> = {
  APPROVED: 'live',
  WAITING_FOR_REVIEW: 'in_review',
  IN_REVIEW: 'in_review',
  PENDING_BINARY_APPROVAL: 'in_review',
  REJECTED: 'failed',
  DEVELOPER_ACTION_NEEDED: 'failed',
  DEVELOPER_REMOVED_FROM_SALE: 'off_sale',
  REMOVED_FROM_SALE: 'off_sale',
};

/** Cuts at a word, for the stores' short name and description limits. */
export function fit(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).replace(/\s+\S*$/, '').trim();
  return (cut || text.slice(0, max)).replace(/[\s,.;:–-]+$/, '');
}

const suggest = (prefix: string, slug: string) => `${prefix}.${slug.replace(/-/g, '_')}`.slice(0, 60);
let screenshot: Buffer | null = null;
/** The image App Review sees for every product: the buy button on a course page. */
function reviewScreenshot() {
  screenshot ??= readFileSync(path.join(__dirname, '..', '..', 'assets', 'store-review.png'));
  return screenshot;
}

/**
 * Makes and keeps up the store products the phone apps sell, so nobody types IDs and prices into App Store Connect
 * and Play Console. A course gets its products when it's published and loses them from sale when it's archived; a
 * teacher's subscription follows the studio switch and price. Products someone linked by hand are left alone.
 *
 * Each run is safe to repeat: finished steps are recorded on the row, and a failed run is retried later, from the
 * step that failed, by the sweep that also checks on products waiting for Apple's review.
 */
@Injectable()
export class StoreSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('StoreSync');
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly apple: AppStoreConnectClient,
    private readonly google: GooglePlayClient,
  ) {}

  automation() {
    return { apple: this.apple.ready, google: this.google.ready };
  }

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test' || !this.env.STORE_SYNC_MINUTES || !(this.apple.ready || this.google.ready)) return;
    this.timer = setInterval(() => void this.sweep().catch((error) => this.logger.warn(`Sweep failed: ${error}`)), this.env.STORE_SYNC_MINUTES * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** After a course is published or archived, or a teacher's subscription changes. Runs in the background. */
  request(owner: Owner) {
    if (!this.apple.ready && !this.google.ready) return;
    void this.sync(owner).catch((error) => this.logger.warn(`${owner.type} ${owner.id}: ${error}`));
  }

  /** Every run started by request() has finished. For tests and shutdown. */
  async idle() {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  /** Brings one course's or teacher's products in both stores in line with the catalogue. One run at a time each. */
  async sync(owner: Owner) {
    if (!this.apple.ready && !this.google.ready) throw fail(503, 'store_not_configured', 'Neither store has product keys set on this server yet.');
    const key = `${owner.type}:${owner.id}`;
    const run = (this.running.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.syncNow(owner));
    this.running.set(key, run);
    try {
      await run;
    } finally {
      if (this.running.get(key) === run) this.running.delete(key);
    }
  }

  /**
   * Retries unfinished and failed products (backing off as failures repeat), checks on ones in Apple's review,
   * and makes products for anything on sale that has none yet, such as courses published before the keys were set.
   */
  async sweep() {
    const due = (row: Row) => {
      if (row.status !== 'failed' || !row.syncedAt) return true;
      const waitMinutes = Math.min(5 * 2 ** Math.max(row.attempts - 1, 0), 12 * 60);
      return Date.now() - row.syncedAt.getTime() >= waitMinutes * 60_000;
    };
    const rows = await this.db.select().from(storeProducts).where(eq(storeProducts.auto, true));
    const owners = new Map<string, Owner>();
    for (const row of rows) {
      if (['pending', 'in_review', 'failed'].includes(row.status) && due(row)) owners.set(`${row.ownerType}:${row.ownerId}`, { type: row.ownerType, id: row.ownerId });
    }
    const stores = (['apple', 'google'] as const).filter((store) => (store === 'apple' ? this.apple.ready : this.google.ready));
    const linked = await this.db.select({ ownerId: storeProducts.ownerId, store: storeProducts.store }).from(storeProducts);
    const missing = (id: string) => stores.some((store) => !linked.some((l) => l.ownerId === id && l.store === store));
    const onSale = await this.db
      .select({ id: courses.id })
      .from(courses)
      .where(and(eq(courses.status, 'published'), eq(courses.isFree, false), isNotNull(courses.pricePointId)));
    for (const course of onSale) if (missing(course.id)) owners.set(`course:${course.id}`, { type: 'course', id: course.id });
    const plans = await this.db
      .select({ id: instructorPlans.instructorId })
      .from(instructorPlans)
      .where(and(eq(instructorPlans.enabled, true), isNotNull(instructorPlans.pricePointId)));
    for (const plan of plans) if (missing(plan.id)) owners.set(`instructor_plan:${plan.id}`, { type: 'instructor_plan', id: plan.id });
    for (const owner of owners.values()) await this.sync(owner).catch((error) => this.logger.warn(`${owner.type} ${owner.id}: ${error}`));
    return owners.size;
  }

  /* ------------------------------------------------------------ One owner */

  /** Both stores, side by side: trouble with one never holds up the other. */
  private async syncNow(owner: Owner) {
    const wanted = await this.wanted(owner);
    const stores = (['apple', 'google'] as const).filter((store) => (store === 'apple' ? this.apple.ready : this.google.ready));
    const results = await Promise.allSettled(stores.map((store) => this.syncStore(owner, store, wanted)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private async syncStore(owner: Owner, store: Store, wanted: Wanted | null) {
    let [row] = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.ownerType, owner.type), eq(storeProducts.ownerId, owner.id), eq(storeProducts.store, store)))
      .limit(1);
    if (row && !row.auto) return; // made by hand and linked on the Store products page: not ours to change
    if (!row) {
      if (!wanted?.onSale || !wanted.price) return; // nothing on sale, nothing to make
      row = await this.newRow(owner, store, wanted);
    }
    const target: Wanted = wanted ?? { title: row.productId, slug: row.productId, onSale: false, price: null };
    const progress: Progress = { steps: { ...row.steps }, externalId: row.externalId, groupId: row.groupId, notice: null };
    try {
      const state =
        store === 'apple'
          ? await this.appleProduct(owner.type === 'course' ? 'inAppPurchase' : 'subscription', row, target, progress)
          : await this.googleProduct(owner.type, row, target, progress);
      const status: Status = !target.onSale ? 'off_sale' : store === 'google' ? 'live' : (APPLE_STATUS[state as AppleProductState] ?? 'pending');
      await this.save(row, progress, { status, storeState: state, lastError: progress.notice, attempts: 0, pricePointId: target.price?.id ?? row.pricePointId });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // fetch's own "fetch failed" says nothing to whoever reads the Store products page.
      const unreachable = error instanceof TypeError && raw === 'fetch failed';
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      const message = unreachable
        ? `Couldn't reach ${store === 'apple' ? 'App Store Connect' : 'Google Play'}${cause ? ` (${cause})` : ''}. The server tries again on its own.`
        : raw;
      await this.save(row, progress, { status: 'failed', lastError: message.slice(0, 500), attempts: row.attempts + 1 });
      throw error;
    }
  }

  /* ------------------------------------------------------------ App Store */

  private async appleProduct(kind: 'inAppPurchase' | 'subscription', row: Row, w: Wanted, p: Progress) {
    const reference = fit(`${w.title} (${row.productId})`, 64);
    if (kind === 'subscription' && !p.groupId) {
      // One group per teacher: subscriptions in the same group exclude each other, and members may want several teachers.
      p.groupId = (await this.apple.findGroup(reference))?.id ?? (await this.apple.createGroup(reference)).id;
    }
    if (kind === 'subscription' && !p.steps.groupNamed) {
      await this.apple.localizeGroup(p.groupId!, fit(w.title, 30));
      p.steps.groupNamed = true;
    }
    if (!p.externalId) {
      const found = kind === 'inAppPurchase' ? await this.apple.findInAppPurchase(row.productId) : await this.apple.findSubscription(p.groupId!, row.productId);
      const note = reviewNote(kind, w.title);
      p.externalId =
        found?.id ??
        (kind === 'inAppPurchase'
          ? await this.apple.createInAppPurchase({ productId: row.productId, name: reference, reviewNote: note })
          : await this.apple.createSubscription(p.groupId!, { productId: row.productId, name: reference, reviewNote: note })
        ).id;
    }
    const id = p.externalId;
    if (!p.steps.named) {
      const text =
        kind === 'inAppPurchase'
          ? { name: fit(w.title, 30), description: fit(`Every chapter of ${w.title}, yours to keep`, 45) }
          : { name: fit(`${w.title}, monthly`, 30), description: fit('Every course they teach, including new ones', 45) };
      await this.apple.localize(kind, id, text);
      p.steps.named = true;
    }
    if (w.price && p.steps.priced !== w.price.id) {
      const price = { inr: w.price.inrPaise / 100, usd: w.price.usdCents / 100 };
      if (kind === 'inAppPurchase') await this.apple.priceInAppPurchase(id, price);
      else await this.apple.priceSubscription(id, price, Boolean(p.steps.priced));
      p.steps.priced = w.price.id;
    }
    const onSale = w.onSale && Boolean(w.price);
    if (p.steps.onSale !== onSale) {
      await this.apple.setOnSale(kind, id, onSale);
      p.steps.onSale = onSale;
    }
    if (!p.steps.screenshot) {
      await this.apple.uploadReviewScreenshot(kind, id, reviewScreenshot());
      p.steps.screenshot = true;
    }
    let state = await this.apple.state(kind, id);
    if (onSale && state === 'READY_TO_SUBMIT') {
      try {
        await this.apple.submit(kind, id);
        state = await this.apple.state(kind, id);
      } catch (error) {
        // Apple takes an app's first products only alongside a new version of the app, so this is expected once.
        p.notice = `Ready, but Apple didn't take it for review on its own: ${error instanceof Error ? error.message : error} If this is among the first products, add it to the next app version in App Store Connect.`;
      }
    }
    return state;
  }

  /* ------------------------------------------------------------ Google Play */

  private async googleProduct(type: Owner['type'], row: Row, w: Wanted, p: Progress) {
    if (w.price && p.steps.priced !== w.price.id) {
      const { regions, other } = await this.google.convertPrices(money('USD', w.price.usdCents));
      const prices = [
        ...regions.filter((r) => r.regionCode !== 'IN' && r.regionCode !== 'US'),
        { regionCode: 'US', price: money('USD', w.price.usdCents) },
        { regionCode: 'IN', price: money('INR', w.price.inrPaise) },
      ];
      if (type === 'course') {
        await this.google.saveOneTimeProduct({
          productId: row.productId,
          title: fit(w.title, 55),
          description: fit(`Every chapter of ${w.title}, yours to keep. Practise at your own pace, on any device you sign in on.`, 200),
          prices,
          other,
        });
      } else {
        const exists = Boolean(p.steps.created) || (await this.google.subscriptionProduct(row.productId)) !== null;
        await this.google.saveSubscriptionProduct({ productId: row.productId, title: fit(`${w.title}, monthly`, 55), description: fit('Every course they teach, including new ones', 80), prices, other }, exists);
      }
      p.steps.created = true;
      p.steps.priced = w.price.id;
    }
    if (!p.steps.created) return 'NOT_CREATED'; // never had a price, so never made: nothing to take off sale
    const onSale = w.onSale && Boolean(w.price);
    if (p.steps.onSale !== onSale) {
      if (type === 'course') await this.google.setPurchaseOptionOnSale(row.productId, onSale);
      else await this.google.setBasePlanOnSale(row.productId, onSale);
      p.steps.onSale = onSale;
    }
    return onSale ? 'ACTIVE' : 'INACTIVE';
  }

  /* ------------------------------------------------------------ Rows */

  private async wanted(owner: Owner): Promise<Wanted | null> {
    if (owner.type === 'course') {
      const [course] = await this.db
        .select({ title: courses.title, slug: courses.slug, status: courses.status, isFree: courses.isFree, price: pricePoints })
        .from(courses)
        .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
        .where(eq(courses.id, owner.id))
        .limit(1);
      if (!course) return null;
      return { title: course.title, slug: course.slug, onSale: course.status === 'published' && !course.isFree, price: course.price };
    }
    const [plan] = await this.db
      .select({ title: instructors.displayName, slug: instructors.slug, enabled: instructorPlans.enabled, price: pricePoints })
      .from(instructorPlans)
      .innerJoin(instructors, eq(instructors.id, instructorPlans.instructorId))
      .leftJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
      .where(eq(instructorPlans.instructorId, owner.id))
      .limit(1);
    if (!plan) return null;
    return { title: plan.title, slug: plan.slug, onSale: plan.enabled && plan.title !== '', price: plan.price };
  }

  /** A product ID nobody has used in that store; store IDs can never be reused, even after deletion. */
  private async newRow(owner: Owner, store: Store, w: Wanted) {
    const base = suggest(owner.type === 'course' ? 'course' : 'sub', w.slug);
    const taken = new Set(
      (await this.db.select({ productId: storeProducts.productId }).from(storeProducts).where(eq(storeProducts.store, store))).map((r) => r.productId),
    );
    let productId = base;
    for (let n = 2; taken.has(productId); n += 1) productId = `${base.slice(0, 56)}_${n}`;
    const [row] = await this.db
      .insert(storeProducts)
      .values({ ownerType: owner.type, ownerId: owner.id, store, productId, status: 'pending', auto: true })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [existing] = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.ownerType, owner.type), eq(storeProducts.ownerId, owner.id), eq(storeProducts.store, store)));
    return existing;
  }

  private async save(row: Row, p: Progress, values: Partial<Pick<Row, 'status' | 'storeState' | 'lastError' | 'attempts' | 'pricePointId'>>) {
    await this.db
      .update(storeProducts)
      .set({ ...values, steps: p.steps, externalId: p.externalId, groupId: p.groupId, syncedAt: new Date() })
      .where(eq(storeProducts.id, row.id));
  }

  /** Whether the server looks after this owner's App Store product, so taking it off sale is handled. */
  async managesApple(owner: Owner) {
    if (!this.apple.ready) return false;
    const [row] = await this.db
      .select({ auto: storeProducts.auto })
      .from(storeProducts)
      .where(and(eq(storeProducts.ownerType, owner.type), eq(storeProducts.ownerId, owner.id), eq(storeProducts.store, 'apple')))
      .limit(1);
    return Boolean(row?.auto);
  }

  /** For the admin page: which owners have a run going right now. */
  busy(ids: string[]) {
    return ids.filter((id) => [...this.running.keys()].some((key) => key.endsWith(`:${id}`)));
  }

  /** Rows the admin page shows as made by the server. */
  autoRows(ids: string[]) {
    return ids.length ? this.db.select().from(storeProducts).where(and(eq(storeProducts.auto, true), inArray(storeProducts.ownerId, ids))) : Promise.resolve([]);
  }
}

function reviewNote(kind: 'inAppPurchase' | 'subscription', title: string) {
  return kind === 'inAppPurchase'
    ? `Unlocks the course "${title}" for good. Sign in with the review account in the app's review notes, open the course from Explore and tap Unlock.`
    : `A monthly subscription to ${title}, which opens every course they teach, including new ones. Sign in with the review account in the app's review notes, open one of their courses and tap Subscribe.`;
}
