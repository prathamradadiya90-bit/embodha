import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { track, type EventProps } from '../lib/analytics';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { buyFromStore, findStoreProduct, inAppStore, storeName } from '../lib/store';
import type { StoreKind, StoreResult } from '../lib/store-types';
import { notify } from './components';
import { colors } from './theme';

const storeOfferKey = (kind: StoreKind, ownerId: string) => ['store-offer', kind, ownerId];
const seller = () => (storeName === 'the App Store' ? 'Apple' : 'Google');
/**
 * A website checkout in India needs the buyer's state on record first, because GST rules print it on the invoice.
 * True when that's why the API said no; the member is sent to their details to pick it.
 */
function askedForState(error: unknown, what: EventProps) {
  if (!(error instanceof ApiError && error.code === 'state_needed')) return false;
  track('purchase_cancel', { ...what, reason: 'state_needed' });
  notify('Which state are you in?', 'It goes on your invoice, as GST rules require. Pick it, save, and buy again.');
  router.push('/onboarding?edit=1');
  return true;
}

/** Who takes the money, for the purchase events. */
const via = () => (!inAppStore ? 'razorpay' : storeName === 'the App Store' ? 'apple' : 'google');

/** The store's price for a course or a teacher's subscription, in the member's own currency. Null on the web, or until it loads. */
export function useStorePrice(kind: StoreKind, ownerId: string | undefined, wanted: boolean) {
  const query = useQuery({
    queryKey: storeOfferKey(kind, ownerId ?? ''),
    queryFn: () => findStoreProduct(kind, ownerId!),
    enabled: inAppStore && wanted && Boolean(ownerId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data?.displayPrice ?? null;
}

/**
 * In the iOS and Android apps, Apple and Google take the payment. Resolves once the server has unlocked it, or
 * says why not. Null when the member closed the store's sheet.
 */
async function buyInApp(queryClient: QueryClient, kind: StoreKind, ownerId: string, userId: string, what: EventProps): Promise<StoreResult | null> {
  const product = await queryClient.fetchQuery({ queryKey: storeOfferKey(kind, ownerId), queryFn: () => findStoreProduct(kind, ownerId), staleTime: 5 * 60_000 });
  if (!product) {
    track('purchase_cancel', { ...what, reason: 'not_in_store' });
    notify('Not in the app yet', kind === 'course' ? "This course isn't on sale in the app yet. Check back soon." : "This subscription isn't on sale in the app yet. Check back soon.");
    return null;
  }
  const result = await buyFromStore(product, userId);
  if (result) await queryClient.invalidateQueries();
  else track('purchase_cancel', { ...what, reason: 'closed' });
  return result;
}

interface CheckoutOrder {
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { email: string; name: string };
}

interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => { open(): void };
const browser = () => globalThis as unknown as { Razorpay?: RazorpayConstructor; document: Document };

function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = browser().Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = browser().document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => (browser().Razorpay ? resolve(browser().Razorpay!) : reject(new Error('Razorpay did not load')));
    script.onerror = () => reject(new Error("Couldn't reach Razorpay. Check your connection."));
    browser().document.body.appendChild(script);
  });
}

/** Opens Razorpay Checkout and waits: the success response, or null if the member closed it. */
async function payWithRazorpay(order: CheckoutOrder): Promise<CheckoutSuccess | null> {
  const Razorpay = await loadRazorpay();
  return new Promise((resolve) =>
    new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: order.description,
      prefill: order.prefill,
      theme: { color: colors.maroon },
      handler: (response: CheckoutSuccess) => resolve(response),
      modal: { ondismiss: () => resolve(null) },
    }).open(),
  );
}

/**
 * Buying a course. On the web build this is Razorpay Checkout. In the iOS and Android apps it's the App Store or
 * Google Play, which the stores require for anything digital bought inside an app.
 */
export function useBuyCourse() {
  const { signedIn, me } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const buy = async (course: { id: string; title: string }) => {
    if (!signedIn || !me) return router.push('/sign-in');
    const what = { kind: 'course', courseId: course.id, via: via() };
    track('purchase_start', what);
    if (inAppStore) {
      setBusy(true);
      try {
        const result = await buyInApp(queryClient, 'course', course.id, me.id, what);
        if (!result) return;
        track('purchase_done', { ...what, pending: 'pending' in result });
        if ('pending' in result) notify('Waiting for the payment', `${course.title} unlocks as soon as ${storeName} confirms the payment. You don't need to keep the app open.`);
        else notify("It's yours", `${course.title} is in your library for good. ${seller()} emails you the receipt.`);
      } catch (error) {
        track('purchase_cancel', { ...what, reason: 'error' });
        notify("That didn't go through", error instanceof Error ? error.message : 'If you were charged, the course unlocks within a few minutes.');
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const order = await api<CheckoutOrder>('/v1/checkout/course', { method: 'POST', body: { courseId: course.id } });
      const paid = await payWithRazorpay(order);
      if (!paid) {
        track('purchase_cancel', { ...what, reason: 'closed' });
        return;
      }
      const done = await api<{ invoiceNo: string | null }>('/v1/checkout/confirm', {
        method: 'POST',
        body: { orderId: paid.razorpay_order_id, paymentId: paid.razorpay_payment_id, signature: paid.razorpay_signature },
      });
      track('purchase_done', what);
      await queryClient.invalidateQueries();
      notify("It's yours", `${course.title} is in your library for good.${done.invoiceNo ? ` Your invoice number is ${done.invoiceNo}.` : ''}`);
    } catch (error) {
      if (askedForState(error, what)) return;
      track('purchase_cancel', { ...what, reason: 'error' });
      notify(
        "That didn't go through",
        error instanceof ApiError ? error.message : 'If you were charged, the course unlocks within a few minutes. Otherwise, try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return { buy, busy };
}

interface SubscriptionCheckout {
  keyId: string;
  subscriptionId: string;
  display: string;
  name: string;
  description: string;
  prefill: { email: string; name: string };
}

/**
 * A monthly subscription to one instructor. On the web build: Razorpay Checkout with the subscription, then the
 * API checks the signature and unlocks everything they teach. In the phone apps: the App Store or Google Play.
 */
export function useSubscribe() {
  const { signedIn, me } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const subscribe = async (instructor: { id: string; displayName?: string }) => {
    const who = instructor.displayName ?? 'this teacher';
    if (!signedIn || !me) return router.push('/sign-in');
    const what = { kind: 'subscription', instructorId: instructor.id, via: via() };
    track('purchase_start', what);
    if (inAppStore) {
      setBusy(true);
      try {
        const result = await buyInApp(queryClient, 'instructor', instructor.id, me.id, what);
        if (!result) return;
        track('purchase_done', { ...what, pending: 'pending' in result });
        if ('pending' in result) notify('Waiting for the payment', `Your subscription to ${who} starts as soon as ${storeName} confirms the payment.`);
        else if (result.kind === 'subscription') {
          notify("You're subscribed", `Every course from ${result.instructor.displayName} is open to you. It renews monthly; ${storeName} is where you can stop it.`);
        }
      } catch (error) {
        track('purchase_cancel', { ...what, reason: 'error' });
        notify("That didn't go through", error instanceof Error ? error.message : 'If you were charged, your subscription starts within a few minutes.');
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const sub = await api<SubscriptionCheckout>('/v1/checkout/subscription', { method: 'POST', body: { instructorId: instructor.id } });
      const Razorpay = await loadRazorpay();
      const paid = await new Promise<{ razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string } | null>((resolve) =>
        new Razorpay({
          key: sub.keyId,
          subscription_id: sub.subscriptionId,
          name: sub.name,
          description: sub.description,
          prefill: sub.prefill,
          theme: { color: colors.maroon },
          handler: resolve,
          modal: { ondismiss: () => resolve(null) },
        }).open(),
      );
      if (!paid) {
        track('purchase_cancel', { ...what, reason: 'closed' });
        return;
      }
      const done = await api<{ instructor: { displayName: string }; accessUntil: string }>('/v1/checkout/subscription/confirm', {
        method: 'POST',
        body: { subscriptionId: paid.razorpay_subscription_id, paymentId: paid.razorpay_payment_id, signature: paid.razorpay_signature },
      });
      track('purchase_done', what);
      await queryClient.invalidateQueries();
      notify("You're subscribed", `Every course from ${done.instructor.displayName} is open to you. It renews monthly; you can stop that any time in Library.`);
    } catch (error) {
      if (askedForState(error, what)) return;
      track('purchase_cancel', { ...what, reason: 'error' });
      notify("That didn't go through", error instanceof ApiError ? error.message : 'If you were charged, your subscription starts within a few minutes. Otherwise, try again.');
    } finally {
      setBusy(false);
    }
  };

  return { subscribe, busy };
}
