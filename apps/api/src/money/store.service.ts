import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { priceIn, type PriceLike } from '../catalogue/price';
import { audit } from '../common/audit';
import { sha256 } from '../common/crypto';
import { fail } from '../common/errors';
import { readSetting } from '../common/settings';
import { heard } from '../common/webhooks';
import { Db, InjectDb } from '../db/db.module';
import { courses, instructorPlans, instructors, instructorSubscriptions, pricePoints, storeProducts, users } from '../db/schema';
import { AppleEnvironment, AppleStoreClient, AppleSubscriptionStatus, AppleTransaction } from './apple-store.client';
import { GooglePlayClient, PlaySubscriptionState } from './google-play.client';
import { readJws } from './jwt';
import { Charge, PaymentsService } from './payments.service';
import type { StoreProductDto } from './store.dto';

type Store = 'apple' | 'google';
type SubscriptionStatus = (typeof instructorSubscriptions.$inferSelect)['status'];
/** The price the store says it charged, in minor units. Only rupees and dollars can be booked as they are. */
type Reported = { currency: string; amountMinor: number } | null;

export type Credited =
  | { kind: 'course'; course: { slug: string; title: string }; test: boolean }
  | { kind: 'subscription'; instructor: { slug: string; displayName: string }; accessUntil: Date; test: boolean }
  | { pending: true };

const APPLE_STATUS: Record<AppleSubscriptionStatus, SubscriptionStatus> = { 1: 'active', 2: 'expired', 3: 'past_due', 4: 'past_due', 5: 'expired' };

const PLAY_STATUS: Record<PlaySubscriptionState, SubscriptionStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled', // stops renewing; access runs to expiryTime
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'past_due',
  SUBSCRIPTION_STATE_ON_HOLD: 'past_due',
  SUBSCRIPTION_STATE_PAUSED: 'past_due',
  SUBSCRIPTION_STATE_PENDING: 'past_due',
  SUBSCRIPTION_STATE_UNSPECIFIED: 'past_due',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
};
/** States in which the latest order was actually charged. */
const PLAY_CHARGED = new Set<PlaySubscriptionState>(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Some test purchases on Play come without an order ID; the token stands in for it. */
const tokenRef = (purchaseToken: string) => `token:${sha256(purchaseToken).slice(0, 40)}`;
const suggest = (prefix: string, slug: string) => `${prefix}.${slug.replace(/-/g, '_')}`.slice(0, 60);

interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID?: string;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string };
}

/** Play's subscription notification types, in words, for the launch checklist's "last heard" line. */
const PLAY_SUBSCRIPTION_EVENT: Record<number, string> = {
  1: 'recovered',
  2: 'renewed',
  3: 'cancelled',
  4: 'bought',
  5: 'on hold',
  6: 'in its grace period',
  7: 'restarted',
  8: 'price change confirmed',
  9: 'deferred',
  10: 'paused',
  11: 'pause rescheduled',
  12: 'revoked',
  13: 'expired',
  20: 'pending purchase cancelled',
};

interface PlayNotification {
  packageName?: string;
  testNotification?: object;
  oneTimeProductNotification?: { notificationType: number; purchaseToken: string; sku: string };
  subscriptionNotification?: { notificationType: number; purchaseToken: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType?: number };
}

/**
 * Purchases made inside the iOS and Android apps, which Apple and Google require for digital goods. Each store
 * charge is booked like a Razorpay sale (GST in India, the store's commission, the split at the instructor's
 * share) except that the store is the seller, so there's no Embodha invoice. Nothing is taken on the app's word:
 * every purchase, and every notification, is checked with the store's own server first.
 */
@Injectable()
export class StoreService {
  private readonly logger = new Logger('Store');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly apple: AppleStoreClient,
    private readonly google: GooglePlayClient,
    private readonly payments: PaymentsService,
  ) {}

  /* ------------------------------------------------------------ From the app */

  async verify(userId: string, dto: { store: Store; transactionId?: string; productId?: string; purchaseToken?: string }): Promise<Credited> {
    if (dto.store === 'apple') {
      if (!dto.transactionId) throw fail(400, 'missing_transaction', 'Send the App Store transaction ID.');
      const { environment, transaction } = await this.apple.transaction(dto.transactionId);
      return this.creditApple(environment, transaction, userId);
    }
    if (!dto.productId || !dto.purchaseToken) throw fail(400, 'missing_purchase', 'Send the Google Play product ID and purchase token.');
    const product = await this.productFor('google', dto.productId);
    return product.ownerType === 'course'
      ? this.creditPlayProduct(product.ownerId, dto.productId, dto.purchaseToken, userId)
      : this.syncPlaySubscription(dto.purchaseToken, userId);
  }

  /** Which store products sell a course or an instructor's subscription. The app then asks the store for the price. */
  async offer(query: { courseId?: string; instructorId?: string }) {
    const none = { apple: null as string | null, google: null as string | null };
    let owner: { type: 'course' | 'instructor_plan'; id: string } | null = null;
    if (query.courseId) {
      const [course] = await this.db
        .select({ id: courses.id })
        .from(courses)
        .where(and(eq(courses.id, query.courseId), eq(courses.status, 'published'), eq(courses.isFree, false)))
        .limit(1);
      if (course) owner = { type: 'course', id: course.id };
    } else if (query.instructorId) {
      const [plan] = await this.db
        .select({ id: instructorPlans.instructorId })
        .from(instructorPlans)
        .where(and(eq(instructorPlans.instructorId, query.instructorId), eq(instructorPlans.enabled, true)))
        .limit(1);
      if (plan) owner = { type: 'instructor_plan', id: plan.id };
    } else {
      throw fail(400, 'missing_owner', 'Ask about a courseId or an instructorId.');
    }
    if (!owner) return none;
    // "In review" counts: App Review buys with sandbox accounts before a product goes live.
    const rows = await this.db
      .select({ store: storeProducts.store, productId: storeProducts.productId })
      .from(storeProducts)
      .where(and(eq(storeProducts.ownerType, owner.type), eq(storeProducts.ownerId, owner.id), inArray(storeProducts.status, ['in_review', 'live'])));
    return {
      apple: rows.find((row) => row.store === 'apple')?.productId ?? null,
      google: rows.find((row) => row.store === 'google')?.productId ?? null,
    };
  }

  /* ------------------------------------------------------------ App Store */

  private async creditApple(environment: AppleEnvironment, transaction: AppleTransaction, claimant: string | null): Promise<Credited> {
    if (transaction.bundleId !== this.apple.bundleId) throw fail(400, 'wrong_app', 'That purchase was made in another app.');
    if (transaction.inAppOwnershipType === 'FAMILY_SHARED') {
      throw fail(409, 'family_shared', 'Purchases shared through Family Sharing work only on the account of the person who bought them.');
    }
    const money = {
      reported: transaction.price !== undefined && transaction.currency ? { currency: transaction.currency, amountMinor: Math.round(transaction.price / 10) } : null,
      india: transaction.storefront === 'IND' || transaction.currency === 'INR',
      test: environment !== 'Production',
      capturedAt: new Date(transaction.purchaseDate),
    };
    if (transaction.type === 'Auto-Renewable Subscription') return this.creditAppleSubscription(environment, transaction, claimant, money);

    const product = await this.productFor('apple', transaction.productId);
    if (product.ownerType !== 'course') throw this.unknownProduct('apple', transaction.productId);
    if (transaction.revocationDate) throw fail(409, 'refunded', 'Apple refunded that purchase, so the course is no longer unlocked.');
    return this.creditCourse({
      store: 'apple',
      externalId: transaction.transactionId,
      tag: transaction.appAccountToken,
      claimant,
      courseId: product.ownerId,
      productId: transaction.productId,
      ...money,
    });
  }

  /**
   * Brings one App Store subscription up to date from Apple's own record of it, then books the charge in hand.
   * During a billing grace period the member keeps access; once Apple gives up, or refunds, access ends.
   */
  private async creditAppleSubscription(
    environment: AppleEnvironment,
    transaction: AppleTransaction,
    claimant: string | null,
    money: { reported: Reported; india: boolean; test: boolean; capturedAt: Date },
  ): Promise<Credited> {
    const existing = await this.subscriptionRow('apple', transaction.originalTransactionId);
    const instructorId = existing?.instructorId ?? (await this.planProduct('apple', transaction.productId));
    const userId = await this.whoOwns(transaction.appAccountToken, claimant, existing?.userId ?? null);

    const now = await this.apple.subscription(transaction.originalTransactionId, environment);
    const latest = now?.transaction ?? transaction;
    const code: AppleSubscriptionStatus = now?.status ?? ((latest.expiresDate ?? 0) > Date.now() ? 1 : 2);
    let until = latest.expiresDate ?? Date.now();
    if (code === 4 && now?.renewal?.gracePeriodExpiresDate) until = Math.max(until, now.renewal.gracePeriodExpiresDate);
    if (code === 5) until = Math.min(until, latest.revocationDate ?? Date.now());
    const renews = now?.renewal ? now.renewal.autoRenewStatus === 1 : code === 1;

    const subscription = await this.saveSubscription({
      userId,
      instructorId,
      channel: 'apple',
      externalId: transaction.originalTransactionId,
      status: APPLE_STATUS[code],
      currentPeriodEnd: new Date(until),
      autoRenew: renews && (code === 1 || code === 3 || code === 4),
    });
    if (!transaction.revocationDate && transaction.price !== 0) {
      const charge = await this.charge('apple', transaction.transactionId, await this.planPrice(instructorId), { ...money, productId: transaction.productId });
      await this.payments.book({ charge, userId, instructorId, subscriptionId: subscription.id });
    }
    return this.subscribed(subscription, money.test);
  }

  /**
   * App Store Server Notifications, version 2. The notification only tells us which transaction to look at:
   * we ask Apple for it directly, so a forged notification can't unlock or refund anything.
   */
  async appleNotification(signedPayload: unknown) {
    const note = readJws<AppleNotification>(signedPayload);
    if (note.data?.bundleId && note.data.bundleId !== this.apple.bundleId) return { ignored: 'other_app' };
    // For the launch checklist: Apple's notifications aren't signature-checked here, so this says a URL works, no more.
    const sandbox = note.data?.environment === 'Sandbox';
    await heard(this.db, sandbox ? 'apple_sandbox' : 'apple', `${note.notificationType}${note.subtype ? `.${note.subtype}` : ''}`);
    if (note.notificationType === 'TEST') return { ok: 'test' };
    if (!note.data?.signedTransactionInfo) return { ignored: note.notificationType };
    const { transactionId } = readJws<Pick<AppleTransaction, 'transactionId'>>(note.data.signedTransactionInfo);
    const { environment, transaction } = await this.apple.transaction(transactionId);

    if (transaction.revocationDate) {
      await this.payments.refundFromStore('apple', transaction.transactionId, note.notificationUUID ?? transaction.transactionId, 'Refunded by Apple');
    }
    if (transaction.type === 'Auto-Renewable Subscription') {
      // Renewals, failed charges, grace periods, expiry, refunds, auto-renew switched off: all a fresh look at the subscription.
      await this.creditAppleSubscription(environment, transaction, null, {
        reported: transaction.price !== undefined && transaction.currency ? { currency: transaction.currency, amountMinor: Math.round(transaction.price / 10) } : null,
        india: transaction.storefront === 'IND' || transaction.currency === 'INR',
        test: environment !== 'Production',
        capturedAt: new Date(transaction.purchaseDate),
      });
    } else if (!transaction.revocationDate) {
      await this.creditApple(environment, transaction, null); // a course bought while the app was closed or crashed
    }
    return { ok: `${note.notificationType}${note.subtype ? `.${note.subtype}` : ''}` };
  }

  /* ------------------------------------------------------------ Google Play */

  private async creditPlayProduct(courseId: string, productId: string, purchaseToken: string, claimant: string | null): Promise<Credited> {
    const purchase = await this.google.product(productId, purchaseToken);
    if (purchase.purchaseState === 2) return { pending: true }; // unlocks when Play says the money arrived
    if (purchase.purchaseState !== 0) throw fail(409, 'cancelled', 'Google Play cancelled that purchase.');
    const result = await this.creditCourse({
      store: 'google',
      externalId: purchase.orderId ?? tokenRef(purchaseToken),
      tag: purchase.obfuscatedExternalAccountId,
      claimant,
      courseId,
      productId,
      reported: null, // Play doesn't say what a one-time product cost, so the course's own price is booked
      india: purchase.regionCode === 'IN',
      test: purchase.purchaseType === 0,
      capturedAt: purchase.purchaseTimeMillis ? new Date(Number(purchase.purchaseTimeMillis)) : new Date(),
    });
    if (purchase.acknowledgementState === 0) {
      await this.google.acknowledgeProduct(productId, purchaseToken).catch((error) => this.logger.warn(`Couldn't acknowledge ${productId}: ${error}`));
    }
    return result;
  }

  /** Brings one Play subscription up to date from Google's record of it, and books its latest charge if that's new. */
  private async syncPlaySubscription(purchaseToken: string, claimant: string | null): Promise<Credited> {
    const sub = await this.google.subscription(purchaseToken);
    const line = sub.lineItems?.[0];
    if (!line) throw fail(404, 'unknown_purchase', "Google Play doesn't know that purchase.");
    const existing = await this.subscriptionRow('google', purchaseToken);
    if (!existing && (sub.subscriptionState === 'SUBSCRIPTION_STATE_PENDING' || sub.subscriptionState === 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED')) {
      return { pending: true };
    }
    const instructorId = existing?.instructorId ?? (await this.planProduct('google', line.productId));
    const userId = await this.whoOwns(sub.externalAccountIdentifiers?.obfuscatedExternalAccountId, claimant, existing?.userId ?? null);

    const subscription = await this.saveSubscription({
      userId,
      instructorId,
      channel: 'google',
      externalId: purchaseToken,
      status: PLAY_STATUS[sub.subscriptionState] ?? 'past_due',
      currentPeriodEnd: line.expiryTime ? new Date(line.expiryTime) : new Date(),
      autoRenew: Boolean(line.autoRenewingPlan?.autoRenewEnabled) && sub.subscriptionState !== 'SUBSCRIPTION_STATE_EXPIRED',
    });
    if (sub.linkedPurchaseToken) {
      // A resubscription replaces the old purchase; the old one stops counting.
      await this.db
        .update(instructorSubscriptions)
        .set({ status: 'expired', autoRenew: false })
        .where(and(eq(instructorSubscriptions.channel, 'google'), eq(instructorSubscriptions.externalId, sub.linkedPurchaseToken), eq(instructorSubscriptions.userId, userId)));
    }
    const orderId = line.latestSuccessfulOrderId;
    if (orderId && PLAY_CHARGED.has(sub.subscriptionState)) {
      const price = line.autoRenewingPlan?.recurringPrice;
      const reported = price ? { currency: price.currencyCode, amountMinor: Number(price.units ?? 0) * 100 + Math.round((price.nanos ?? 0) / 10_000_000) } : null;
      const charge = await this.charge('google', orderId, await this.planPrice(instructorId), {
        productId: line.productId,
        reported,
        india: sub.regionCode === 'IN',
        test: Boolean(sub.testPurchase),
      });
      await this.payments.book({ charge, userId, instructorId, subscriptionId: subscription.id });
    }
    if (sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      await this.google.acknowledgeSubscription(line.productId, purchaseToken).catch((error) => this.logger.warn(`Couldn't acknowledge ${line.productId}: ${error}`));
    }
    return this.subscribed(subscription, Boolean(sub.testPurchase));
  }

  /** Real-time developer notifications, pushed by Pub/Sub. Like Apple's, each one is only a cue to ask Play. */
  async playNotification(body: unknown) {
    const encoded = (body as { message?: { data?: unknown } } | null)?.message?.data;
    let note: PlayNotification;
    try {
      note = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8')) as PlayNotification;
    } catch {
      return { ignored: 'unreadable' };
    }
    if (note.packageName !== this.google.packageName) return { ignored: 'other_app' };
    const kind = note.testNotification
      ? 'a test notification'
      : note.voidedPurchaseNotification
        ? 'a refund or chargeback (voided purchase)'
        : note.oneTimeProductNotification
          ? `a course ${note.oneTimeProductNotification.notificationType === 1 ? 'bought' : 'purchase given up'}`
          : note.subscriptionNotification
            ? `a subscription ${PLAY_SUBSCRIPTION_EVENT[note.subscriptionNotification.notificationType] ?? `event ${note.subscriptionNotification.notificationType}`}`
            : 'something Embodha doesn\'t read';
    await heard(this.db, 'google', kind);
    if (note.testNotification) return { ok: 'test' };

    if (note.voidedPurchaseNotification) {
      const voided = note.voidedPurchaseNotification;
      const reason = 'Refunded by Google Play';
      const refunded =
        (await this.payments.refundFromStore('google', voided.orderId, voided.orderId, reason)) ??
        (await this.payments.refundFromStore('google', tokenRef(voided.purchaseToken), voided.orderId, reason));
      if (voided.productType === 1) await this.syncPlaySubscription(voided.purchaseToken, null).catch(() => undefined);
      return refunded ? { ok: 'voided' } : { ignored: 'voided_unknown' };
    }
    if (note.oneTimeProductNotification) {
      const { notificationType, sku, purchaseToken } = note.oneTimeProductNotification;
      if (notificationType !== 1) return { ignored: 'one_time_cancelled' }; // 2: a pending purchase was given up
      const product = await this.productFor('google', sku);
      if (product.ownerType !== 'course') throw this.unknownProduct('google', sku);
      await this.creditPlayProduct(product.ownerId, sku, purchaseToken, null);
      return { ok: 'one_time' };
    }
    if (note.subscriptionNotification) {
      await this.syncPlaySubscription(note.subscriptionNotification.purchaseToken, null);
      return { ok: `subscription.${note.subscriptionNotification.notificationType}` };
    }
    return { ignored: 'unknown' };
  }

  /* ------------------------------------------------------------ Shared */

  private async creditCourse(input: {
    store: Store;
    externalId: string;
    tag: string | null | undefined;
    claimant: string | null;
    courseId: string;
    productId: string;
    reported: Reported;
    india: boolean;
    test: boolean;
    capturedAt: Date;
  }): Promise<Credited> {
    const recorded = await this.payments.find(input.store, input.externalId);
    if (recorded && recorded.status !== 'captured') throw fail(409, 'refunded', 'That purchase was refunded, so the course is no longer unlocked.');
    const userId = await this.whoOwns(input.tag, input.claimant, recorded?.userId ?? null);
    const [course] = await this.db
      .select({ id: courses.id, slug: courses.slug, title: courses.title, instructorId: courses.instructorId, price: pricePoints })
      .from(courses)
      .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
      .where(eq(courses.id, input.courseId))
      .limit(1);
    if (!course) throw fail(404, 'not_found', 'The course on that purchase no longer exists.');
    if (!recorded) {
      const charge = await this.charge(input.store, input.externalId, course.price, input);
      await this.payments.book({ charge, userId, instructorId: course.instructorId, courseId: course.id });
    }
    return { kind: 'course', course: { slug: course.slug, title: course.title }, test: input.test };
  }

  /**
   * Who a store purchase belongs to. The app tags each purchase with the member's Embodha ID, so a purchase made on
   * one account can't be claimed by another. One with no tag belongs to whoever first brings it to us.
   */
  private async whoOwns(tag: string | null | undefined, claimant: string | null, recorded: string | null) {
    const tagged = tag && UUID.test(tag.toLowerCase()) ? tag.toLowerCase() : null;
    const owner = recorded ?? tagged ?? claimant;
    if (!owner) throw fail(409, 'no_owner', "That purchase isn't linked to an Embodha account yet.");
    if (claimant && owner !== claimant) {
      throw fail(403, 'not_yours', 'That purchase belongs to another Embodha account. Sign in with the account you used to buy it.');
    }
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, owner)).limit(1);
    if (!user) throw fail(404, 'no_owner', 'The account that made that purchase no longer exists.');
    return owner;
  }

  /**
   * A store charge in our ledger. Rupees and dollars are booked as the store charged them; anything else at our price.
   * The commission is an estimate until the store's monthly report gives the real proceeds (ReconciliationService).
   */
  private async charge(
    store: Store,
    externalId: string,
    point: PriceLike | null,
    money: { reported: Reported; india: boolean; test: boolean; capturedAt?: Date; productId: string },
  ): Promise<Charge> {
    const commissionBps = await readSetting(this.db, 'store_commission_bps', 1500);
    const reported = money.reported && (money.reported.currency === 'INR' || money.reported.currency === 'USD') ? money.reported : null;
    const currency = (reported?.currency ?? (money.india ? 'INR' : 'USD')) as 'INR' | 'USD';
    const grossMinor = reported?.amountMinor ?? priceIn(point, currency)?.amountMinor ?? 0;
    if (!reported && !point) this.logger.warn(`${store} ${externalId}: no price to book; recorded at zero for finance to correct`);
    return {
      channel: store,
      externalId,
      currency,
      grossMinor,
      feeRateBps: commissionBps,
      feeBase: 'after_gst',
      capturedAt: money.capturedAt,
      test: money.test,
      productId: money.productId,
      charged: money.reported ? { currency: money.reported.currency, price: (money.reported.amountMinor / 100).toFixed(2) } : undefined,
    };
  }

  private async productFor(store: Store, productId: string) {
    const [row] = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.store, store), eq(storeProducts.productId, productId)))
      .limit(1);
    if (!row) throw this.unknownProduct(store, productId);
    return row;
  }

  private async planProduct(store: Store, productId: string) {
    const product = await this.productFor(store, productId);
    if (product.ownerType !== 'instructor_plan') throw this.unknownProduct(store, productId);
    return product.ownerId;
  }

  private unknownProduct(store: Store, productId: string) {
    this.logger.warn(`${store} product ${productId} isn't linked to anything on the Store products page`);
    return fail(404, 'unknown_product', "We couldn't match that purchase to a course. Write to us and we'll sort it out; you won't pay twice.");
  }

  private async planPrice(instructorId: string) {
    const [row] = await this.db
      .select({ price: pricePoints })
      .from(instructorPlans)
      .leftJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
      .where(eq(instructorPlans.instructorId, instructorId))
      .limit(1);
    return row?.price ?? null;
  }

  private async subscriptionRow(channel: Store, externalId: string) {
    const [row] = await this.db
      .select()
      .from(instructorSubscriptions)
      .where(and(eq(instructorSubscriptions.channel, channel), eq(instructorSubscriptions.externalId, externalId)))
      .limit(1);
    return row ?? null;
  }

  /** The store's word is final for its own subscriptions, so this overwrites rather than merges. */
  private async saveSubscription(values: typeof instructorSubscriptions.$inferInsert) {
    const [row] = await this.db
      .insert(instructorSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: [instructorSubscriptions.channel, instructorSubscriptions.externalId],
        set: { status: values.status, currentPeriodEnd: values.currentPeriodEnd, autoRenew: values.autoRenew, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  private async subscribed(subscription: typeof instructorSubscriptions.$inferSelect, test: boolean): Promise<Credited> {
    const [instructor] = await this.db
      .select({ slug: instructors.slug, displayName: instructors.displayName })
      .from(instructors)
      .where(eq(instructors.id, subscription.instructorId));
    return { kind: 'subscription', instructor, accessUntil: subscription.currentPeriodEnd, test };
  }

  /* ------------------------------------------------------------ Admin */

  /**
   * Every paid course and every instructor subscription, with the product that sells it in each store. Products
   * are made by hand in App Store Connect and Play Console; this is where their IDs are linked to the catalogue.
   */
  async adminList() {
    const [courseRows, planRows, mapped, commissionBps] = await Promise.all([
      this.db
        .select({ id: courses.id, title: courses.title, slug: courses.slug, status: courses.status, instructor: instructors.displayName, price: pricePoints })
        .from(courses)
        .innerJoin(instructors, eq(instructors.id, courses.instructorId))
        .leftJoin(pricePoints, eq(pricePoints.id, courses.pricePointId))
        .where(and(eq(courses.isFree, false), ne(courses.status, 'archived')))
        .orderBy(asc(courses.title)),
      this.db
        .select({ id: instructors.id, displayName: instructors.displayName, slug: instructors.slug, enabled: instructorPlans.enabled, price: pricePoints })
        .from(instructorPlans)
        .innerJoin(instructors, eq(instructors.id, instructorPlans.instructorId))
        .leftJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
        .orderBy(asc(instructors.displayName)),
      this.db.select().from(storeProducts),
      readSetting(this.db, 'store_commission_bps', 1500),
    ]);
    const linked = (ownerType: 'course' | 'instructor_plan', ownerId: string, store: Store) => {
      const row = mapped.find((m) => m.ownerType === ownerType && m.ownerId === ownerId && m.store === store);
      return row
        ? { id: row.id, productId: row.productId, status: row.status, note: row.lastError, auto: row.auto, storeState: row.storeState, syncedAt: row.syncedAt }
        : null;
    };
    const prices = (point: PriceLike | null) => (point ? { inr: priceIn(point, 'INR')!.display, usd: priceIn(point, 'USD')!.display } : null);
    const hasLink = (ownerId: string) => mapped.some((m) => m.ownerId === ownerId);
    return {
      commissionBps,
      courses: courseRows
        .filter((c) => c.price || hasLink(c.id))
        .map((c) => ({
          id: c.id,
          title: c.title,
          slug: c.slug,
          status: c.status,
          instructor: c.instructor,
          price: prices(c.price),
          suggestedId: suggest('course', c.slug),
          apple: linked('course', c.id, 'apple'),
          google: linked('course', c.id, 'google'),
        })),
      plans: planRows
        .filter((p) => p.enabled || hasLink(p.id))
        .map((p) => ({
          instructorId: p.id,
          displayName: p.displayName,
          slug: p.slug,
          enabled: p.enabled,
          price: prices(p.price),
          suggestedId: suggest('sub', p.slug),
          apple: linked('instructor_plan', p.id, 'apple'),
          google: linked('instructor_plan', p.id, 'google'),
        })),
    };
  }

  async saveProduct(actorId: string, dto: StoreProductDto) {
    const owner =
      dto.ownerType === 'course'
        ? (await this.db.select({ id: courses.id }).from(courses).where(eq(courses.id, dto.ownerId)).limit(1))[0]
        : (await this.db.select({ id: instructorPlans.instructorId }).from(instructorPlans).where(eq(instructorPlans.instructorId, dto.ownerId)).limit(1))[0];
    if (!owner) throw fail(404, 'not_found', dto.ownerType === 'course' ? 'No such course.' : "That instructor hasn't set up a subscription.");
    const [taken] = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.store, dto.store), eq(storeProducts.productId, dto.productId)))
      .limit(1);
    if (taken && !(taken.ownerType === dto.ownerType && taken.ownerId === dto.ownerId)) {
      throw fail(409, 'product_taken', `${dto.productId} already sells something else in this store. Store product IDs can't be shared or reused.`);
    }
    const [before] = await this.db
      .select()
      .from(storeProducts)
      .where(and(eq(storeProducts.ownerType, dto.ownerType), eq(storeProducts.ownerId, dto.ownerId), eq(storeProducts.store, dto.store)))
      .limit(1);
    // Saving by hand takes a product over from the server's automatic upkeep.
    const values = { productId: dto.productId, status: dto.status, lastError: dto.status === 'failed' ? dto.note?.trim() || null : null, auto: false };
    const [row] = await this.db
      .insert(storeProducts)
      .values({ ownerType: dto.ownerType, ownerId: dto.ownerId, store: dto.store, ...values })
      .onConflictDoUpdate({ target: [storeProducts.ownerType, storeProducts.ownerId, storeProducts.store], set: values })
      .returning();
    await audit(this.db, {
      actorId,
      action: 'store_product.save',
      entityType: 'store_product',
      entityId: row.id,
      before: before ? { productId: before.productId, status: before.status } : undefined,
      after: { ownerType: dto.ownerType, ownerId: dto.ownerId, store: dto.store, ...values },
    });
    return { id: row.id, productId: row.productId, status: row.status, note: row.lastError };
  }

  async removeProduct(actorId: string, id: string) {
    const [row] = await this.db.delete(storeProducts).where(eq(storeProducts.id, id)).returning();
    if (!row) throw fail(404, 'not_found', 'No such store product.');
    await audit(this.db, { actorId, action: 'store_product.remove', entityType: 'store_product', entityId: id, before: { productId: row.productId, store: row.store } });
    return { removed: true };
  }
}
