import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { Price, priceIn, resolveCurrency } from '../catalogue/price';
import { requireIndianState } from './gst';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import { instructorPlans, instructors, instructorSubscriptions, pricePoints, razorpayPlans, users } from '../db/schema';
import { PaymentsService, razorpayCharge } from './payments.service';
import { GooglePlayClient } from './google-play.client';
import { RazorpayService, RazorpaySubscription } from './razorpay.service';

const STATUS_FROM_RAZORPAY: Record<string, 'active' | 'past_due' | 'cancelled' | 'expired'> = {
  active: 'active',
  halted: 'past_due',
  paused: 'past_due',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
};

/**
 * Monthly subscriptions to one instructor, through Razorpay. Each charge, the first and every renewal, is booked
 * like a course sale: invoice, GST, fee, split at the instructor's share. Access runs to the end of the paid month.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger('Subscriptions');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly razorpay: RazorpayService,
    private readonly payments: PaymentsService,
    private readonly google: GooglePlayClient,
  ) {}

  async start(userId: string, instructorId: string) {
    const [row] = await this.db
      .select({ instructor: instructors, plan: instructorPlans, price: pricePoints, user: users })
      .from(instructors)
      .innerJoin(users, eq(users.id, userId))
      .leftJoin(instructorPlans, eq(instructorPlans.instructorId, instructors.id))
      .leftJoin(pricePoints, eq(pricePoints.id, instructorPlans.pricePointId))
      .where(and(eq(instructors.id, instructorId), eq(instructors.status, 'approved')))
      .limit(1);
    if (!row?.plan?.enabled || !row.price) throw fail(409, 'no_subscription', "This teacher doesn't offer a monthly subscription right now.");
    const [live] = await this.db
      .select({ id: instructorSubscriptions.id })
      .from(instructorSubscriptions)
      .where(
        and(
          eq(instructorSubscriptions.userId, userId),
          eq(instructorSubscriptions.instructorId, instructorId),
          inArray(instructorSubscriptions.status, ['active', 'past_due']),
          gt(instructorSubscriptions.currentPeriodEnd, new Date()),
        ),
      )
      .limit(1);
    if (live) throw fail(409, 'already_subscribed', 'You already subscribe to this teacher.');

    const price = priceIn(row.price, resolveCurrency(undefined, row.user.country))!;
    requireIndianState(row.user, price.currency);
    const planId = await this.planFor(row.instructor, row.price.id, price);
    const subscription = await this.razorpay.createSubscription({
      plan_id: planId,
      total_count: 120, // Razorpay needs an end; ten years of months
      customer_notify: 1,
      notes: { kind: 'subscription', user_id: userId, instructor_id: instructorId },
    });
    return {
      keyId: this.razorpay.keyId,
      subscriptionId: subscription.id,
      display: `${price.display} a month`,
      name: 'Embodha',
      description: `Monthly subscription: ${row.instructor.displayName}`,
      prefill: { email: row.user.email, name: row.user.name ?? '' },
    };
  }

  /** Checkout's success response: the signature proves Razorpay took the first payment for this subscription. */
  async confirm(userId: string, dto: { subscriptionId: string; paymentId: string; signature: string }) {
    if (!this.razorpay.subscriptionSignatureValid(dto.paymentId, dto.subscriptionId, dto.signature)) {
      throw fail(400, 'bad_signature', "That payment couldn't be verified. If money left your account, write to us and we'll sort it out.");
    }
    const { subscription, payment } = await this.charge(dto.subscriptionId, dto.paymentId);
    if (subscription.userId !== userId) throw fail(403, 'not_yours', 'That subscription belongs to another account.');
    const [instructor] = await this.db
      .select({ slug: instructors.slug, displayName: instructors.displayName })
      .from(instructors)
      .where(eq(instructors.id, subscription.instructorId));
    return { subscribed: true, instructor, accessUntil: subscription.currentPeriodEnd, invoiceNo: payment.invoiceNo };
  }

  /** One charge, the first or a renewal: brings our copy of the subscription up to date, then books the payment. */
  async charge(razorpaySubscriptionId: string, razorpayPaymentId: string) {
    const remote = await this.razorpay.fetchSubscription(razorpaySubscriptionId);
    const notes = Array.isArray(remote.notes) ? {} : remote.notes;
    if (notes.kind !== 'subscription' || !notes.user_id || !notes.instructor_id) throw fail(400, 'unknown_subscription', 'That is not an Embodha subscription.');
    const payment = await this.payments.capturedPayment(razorpayPaymentId);
    const periodEnd = remote.current_end ? new Date(remote.current_end * 1000) : new Date(Date.now() + 31 * 86_400_000);

    const [subscription] = await this.db
      .insert(instructorSubscriptions)
      .values({
        userId: notes.user_id,
        instructorId: notes.instructor_id,
        channel: 'razorpay',
        externalId: remote.id,
        status: 'active',
        currentPeriodEnd: periodEnd,
        autoRenew: remote.status !== 'cancelled',
      })
      .onConflictDoUpdate({
        target: [instructorSubscriptions.channel, instructorSubscriptions.externalId],
        // Renewals can arrive out of order; the paid-up date only ever moves forward.
        set: { status: 'active', currentPeriodEnd: sql`greatest(${instructorSubscriptions.currentPeriodEnd}, ${periodEnd.toISOString()}::timestamptz)` },
      })
      .returning();
    const booked = await this.payments.book({ charge: razorpayCharge(payment), userId: notes.user_id, instructorId: notes.instructor_id, subscriptionId: subscription.id });
    return { subscription, payment: booked };
  }

  /** The member stops renewing. They keep everything until the end of the month they've paid for. */
  async cancel(userId: string, subscriptionId: string) {
    const [subscription] = await this.db
      .select()
      .from(instructorSubscriptions)
      .where(and(eq(instructorSubscriptions.id, subscriptionId), eq(instructorSubscriptions.userId, userId)))
      .limit(1);
    if (!subscription) throw fail(404, 'not_found', 'No such subscription.');
    if (subscription.channel !== 'razorpay') throw fail(409, 'store_subscription', "Cancel App Store and Google Play subscriptions in your phone's settings.");
    if (subscription.autoRenew) {
      await this.razorpay.cancelSubscription(subscription.externalId);
      await this.db.update(instructorSubscriptions).set({ autoRenew: false }).where(eq(instructorSubscriptions.id, subscription.id));
    }
    return { id: subscription.id, renews: false, accessUntil: subscription.currentPeriodEnd };
  }

  /**
   * The instructor switched their subscription off: nobody renews, and everyone keeps the month they paid for.
   * Razorpay and Google Play renewals are stopped here. Apple has no way to cancel someone else's subscription;
   * App Store subscribers stop renewing once the product is taken off sale, so those are counted, not stopped.
   */
  windDown(instructorId: string) {
    return this.stopRenewals(eq(instructorSubscriptions.instructorId, instructorId));
  }

  /**
   * A member asked to delete their account: none of their subscriptions renews again, and each keeps the time
   * already paid for. App Store ones are counted, because only the member can cancel those, in their phone's settings.
   */
  stopRenewalsFor(userId: string) {
    return this.stopRenewals(eq(instructorSubscriptions.userId, userId));
  }

  private async stopRenewals(whose: SQL) {
    const renewing = await this.db
      .select()
      .from(instructorSubscriptions)
      .where(and(whose, eq(instructorSubscriptions.autoRenew, true), inArray(instructorSubscriptions.status, ['active', 'past_due'])));
    let stopped = 0;
    let appStore = 0;
    for (const subscription of renewing) {
      if (subscription.channel === 'apple') {
        appStore += 1;
        continue;
      }
      try {
        if (subscription.channel === 'razorpay') await this.razorpay.cancelSubscription(subscription.externalId);
        else await this.google.cancelSubscription(subscription.externalId);
        await this.db.update(instructorSubscriptions).set({ autoRenew: false }).where(eq(instructorSubscriptions.id, subscription.id));
        stopped += 1;
      } catch (error) {
        this.logger.warn(`Couldn't stop renewal of ${subscription.channel} ${subscription.externalId}: ${error}`);
      }
    }
    return { stopped, appStore };
  }

  /** Status changes from the webhook: cancelled, halted after failed charges, completed. */
  async statusFromRazorpay(remote: Pick<RazorpaySubscription, 'id' | 'status'>) {
    const status = STATUS_FROM_RAZORPAY[remote.status];
    if (!status) return;
    await this.db
      .update(instructorSubscriptions)
      .set({ status, ...(status === 'active' ? {} : { autoRenew: false }) })
      .where(and(eq(instructorSubscriptions.channel, 'razorpay'), eq(instructorSubscriptions.externalId, remote.id)));
  }

  private async planFor(instructor: { id: string; displayName: string }, pricePointId: string, price: Price) {
    const lookup = and(eq(razorpayPlans.instructorId, instructor.id), eq(razorpayPlans.pricePointId, pricePointId), eq(razorpayPlans.currency, price.currency));
    const [existing] = await this.db.select({ planId: razorpayPlans.planId }).from(razorpayPlans).where(lookup).limit(1);
    if (existing) return existing.planId;
    const plan = await this.razorpay.createPlan({
      period: 'monthly',
      interval: 1,
      item: { name: `${instructor.displayName} on Embodha`, amount: price.amountMinor, currency: price.currency, description: 'Every course, including new ones' },
    });
    await this.db.insert(razorpayPlans).values({ instructorId: instructor.id, pricePointId, currency: price.currency, planId: plan.id }).onConflictDoNothing();
    const [saved] = await this.db.select({ planId: razorpayPlans.planId }).from(razorpayPlans).where(lookup).limit(1);
    return saved.planId; // if two people subscribed at once, both use the plan that was saved first
  }
}
