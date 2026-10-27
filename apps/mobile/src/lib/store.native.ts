/**
 * App Store and Google Play billing, which Apple and Google require for anything digital bought inside the app.
 * The store takes the money; then the app sends the purchase to the Embodha server, which checks it with the store
 * itself before unlocking anything, and only after that does the app tell the store the purchase is done.
 *
 * Every purchase is tagged with the member's Embodha ID (Apple's appAccountToken, Google's obfuscated account ID),
 * so a purchase made on one Embodha account can't be claimed by another.
 */
import {
  ErrorCode,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  type Product,
  type ProductSubscription,
  type ProductSubscriptionAndroid,
  type Purchase,
  type PurchaseAndroid,
  type PurchaseIOS,
} from 'expo-iap';
import { Platform } from 'react-native';
import { api, ApiError } from './api';
import type { StoreKind, StoreProduct, StoreResult } from './store-types';

export const inAppStore = true;
export const storeName = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

const ANDROID_PACKAGE = 'com.embodha.app';

let connection: Promise<boolean> | null = null;
function connect() {
  connection ??= initConnection()
    .then((ok) => Boolean(ok))
    .catch(() => {
      connection = null; // try again next time, e.g. once the phone is back online
      return false;
    });
  return connection;
}

/** The store's product and price for a course or a teacher's subscription, or null if it isn't on sale in this store yet. */
export async function findStoreProduct(kind: StoreKind, ownerId: string): Promise<StoreProduct | null> {
  const offer = await api<{ apple: string | null; google: string | null }>(`/v1/store/offer?${kind === 'course' ? 'courseId' : 'instructorId'}=${ownerId}`);
  const sku = Platform.OS === 'ios' ? offer.apple : offer.google;
  if (!sku || !(await connect())) return null;
  const type = kind === 'course' ? 'in-app' : 'subs';
  const found = ((await fetchProducts({ skus: [sku], type })) ?? []) as (Product | ProductSubscription)[];
  const product = found.find((p) => p.id === sku);
  if (!product) return null;
  if (Platform.OS === 'android' && type === 'subs') {
    // The base monthly plan, not a promotional offer.
    const offers = (product as ProductSubscriptionAndroid).subscriptionOffers ?? [];
    const base = offers.find((o) => !o.id || o.id === o.basePlanIdAndroid) ?? offers[0];
    if (!base?.offerTokenAndroid) return null;
    return { sku, type, displayPrice: base.displayPrice || product.displayPrice, offerToken: base.offerTokenAndroid };
  }
  return { sku, type, displayPrice: product.displayPrice };
}

/* ------------------------------------------------------------ Purchases */

type Waiting = { sku: string; resolve: (result: StoreResult | null) => void; reject: (error: Error) => void };
let waiting: Waiting | null = null;
let listening = false;
let onBackgroundCredit: ((result: StoreResult) => void) | null = null;
const handling = new Set<string>();

const keyOf = (purchase: Purchase) => (Platform.OS === 'ios' ? (purchase as PurchaseIOS).transactionId : purchase.purchaseToken) ?? purchase.id;

function verify(purchase: Purchase) {
  const body =
    Platform.OS === 'ios'
      ? { store: 'apple', transactionId: (purchase as PurchaseIOS).transactionId ?? purchase.id }
      : { store: 'google', productId: purchase.productId, purchaseToken: purchase.purchaseToken };
  return api<StoreResult>('/v1/store/verify', { method: 'POST', body });
}

function finish(purchase: Purchase) {
  return finishTransaction({ purchase, isConsumable: false }).catch(() => undefined);
}

function settleWaiting(sku: string, outcome: { result?: StoreResult | null; error?: unknown }) {
  if (!waiting || waiting.sku !== sku) return false;
  const current = waiting;
  waiting = null;
  if (outcome.error !== undefined) current.reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
  else current.resolve(outcome.result ?? null);
  return true;
}

/** Every purchase the store reports goes through here: the one being bought now, and any that finished while the app was closed. */
async function settle(purchase: Purchase) {
  if (purchase.purchaseState === 'pending') {
    // Paid in cash or by a parent's approval later: it comes back here once it's paid.
    settleWaiting(purchase.productId, { result: { pending: true } });
    return;
  }
  const key = keyOf(purchase);
  if (handling.has(key)) return;
  handling.add(key);
  try {
    const result = await verify(purchase);
    if (!('pending' in result)) await finish(purchase);
    if (!settleWaiting(purchase.productId, { result }) && !('pending' in result)) onBackgroundCredit?.(result);
  } catch (error) {
    handling.delete(key); // not finished, so the store offers it again next launch and we try again
    // A purchase made on another Embodha account is still a real purchase; finish it so the store stops re-sending it here.
    if (error instanceof ApiError && error.code === 'not_yours') await finish(purchase);
    settleWaiting(purchase.productId, { error });
  }
}

function listen() {
  if (listening) return;
  listening = true;
  purchaseUpdatedListener((purchase) => void settle(purchase));
  purchaseErrorListener((error) => {
    if (!waiting) return;
    const sku = waiting.sku;
    if (error.code === ErrorCode.UserCancelled) settleWaiting(sku, { result: null });
    else if (error.code === ErrorCode.DeferredPayment || error.code === ErrorCode.Pending) settleWaiting(sku, { result: { pending: true } });
    else settleWaiting(sku, { error: new Error(error.message || "The store couldn't complete the purchase.") });
  });
}

/**
 * Opens the store's payment sheet and waits until the server has unlocked what was bought. Resolves null if the
 * member closed the sheet, and { pending: true } if the store is still waiting for the money.
 */
export async function buyFromStore(product: StoreProduct, userId: string): Promise<StoreResult | null> {
  if (!(await connect())) throw new Error(`Couldn't reach ${storeName}. Check your connection and try again.`);
  listen();
  if (waiting) throw new Error('Another purchase is still going through. Give it a moment.');
  return new Promise<StoreResult | null>((resolve, reject) => {
    waiting = { sku: product.sku, resolve, reject };
    const google = { skus: [product.sku], obfuscatedAccountId: userId };
    const request =
      product.type === 'subs'
        ? requestPurchase({
            type: 'subs',
            request: {
              apple: { sku: product.sku, appAccountToken: userId },
              google: { ...google, subscriptionOffers: product.offerToken ? [{ sku: product.sku, offerToken: product.offerToken }] : undefined },
            },
          })
        : requestPurchase({ type: 'in-app', request: { apple: { sku: product.sku, appAccountToken: userId }, google } });
    request
      .then((done) => {
        // Usually the listener has it already; if not, this does the same work once.
        for (const purchase of Array.isArray(done) ? done : done ? [done] : []) if (purchase.productId === product.sku) void settle(purchase);
      })
      .catch((error: { code?: string; message?: string }) => {
        if (error?.code === ErrorCode.UserCancelled) settleWaiting(product.sku, { result: null });
        else if (error?.code === ErrorCode.DeferredPayment) settleWaiting(product.sku, { result: { pending: true } });
        else settleWaiting(product.sku, { error: new Error(error?.message || "The store couldn't complete the purchase.") });
      });
  });
}

/** For someone on a new phone, or who bought before signing in: finds their purchases in the store and adds them to this account. */
export async function restoreStorePurchases() {
  if (!(await connect())) throw new Error(`Couldn't reach ${storeName}. Check your connection and try again.`);
  listen();
  const purchases = ((await getAvailablePurchases()) ?? []) as Purchase[];
  let restored = 0;
  let failed = 0;
  for (const purchase of purchases) {
    if (purchase.purchaseState !== 'purchased') continue;
    try {
      const result = await verify(purchase);
      if ('pending' in result) continue;
      restored += 1;
      if (Platform.OS === 'ios' || !(purchase as PurchaseAndroid).isAcknowledgedAndroid) await finish(purchase);
    } catch {
      failed += 1;
    }
  }
  return { restored, failed };
}

/**
 * Started once someone is signed in. iOS replays unfinished purchases to the listener by itself; Google Play
 * doesn't, so on Android we ask for any purchase that was paid but never acknowledged.
 */
export function startStoreListener(onCredit: (result: StoreResult) => void) {
  let stopped = false;
  onBackgroundCredit = onCredit;
  void connect().then(async (ok) => {
    if (!ok || stopped) return;
    listen();
    if (Platform.OS !== 'android') return;
    const purchases = ((await getAvailablePurchases().catch(() => [])) ?? []) as PurchaseAndroid[];
    for (const purchase of purchases) if (!purchase.isAcknowledgedAndroid) void settle(purchase);
  });
  return () => {
    stopped = true;
    if (onBackgroundCredit === onCredit) onBackgroundCredit = null;
  };
}

/** Store subscriptions are managed in the store. Null when this phone's store isn't the one that bills it. */
export function manageSubscriptionsUrl(channel: 'razorpay' | 'apple' | 'google') {
  if (channel === 'apple' && Platform.OS === 'ios') return 'https://apps.apple.com/account/subscriptions';
  if (channel === 'google' && Platform.OS === 'android') return `https://play.google.com/store/account/subscriptions?package=${ANDROID_PACKAGE}`;
  return null;
}
