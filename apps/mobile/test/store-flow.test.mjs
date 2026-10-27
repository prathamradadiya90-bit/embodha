// The in-app purchase flow (src/lib/store.native.ts) with the stores played by test code.
// Run: npm test. Node strips the TypeScript; mocks/ stands in for expo-iap, React Native and the API.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const MEMBER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const unlocked = { kind: 'course', course: { slug: 'gentle-spine', title: 'Gentle spine' }, test: false };

let fresh = 0;
/** A clean copy of the module, as if the app had just started on that phone. */
async function phone(os, server) {
  const state = { os, server, calls: [], products: [], available: [], sheet: null, purchased: null, failed: null };
  globalThis.__store = state;
  const store = await import(`../src/lib/store.native.ts?${os}-${++fresh}`);
  const calls = (kind) => state.calls.filter((c) => c[0] === kind || c[1] === kind);
  return { store, state, calls };
}

test('iPhone: shows the store’s price, buys with the member tagged, and finishes only after the server unlocks it', async () => {
  const { store, state, calls } = await phone('ios', async (path) => (path.startsWith('/v1/store/offer') ? { apple: 'course.gentle_spine', google: null } : unlocked));
  state.products = [{ id: 'course.gentle_spine', displayPrice: '₹999.00' }];

  const product = await store.findStoreProduct('course', 'c1');
  assert.deepEqual(product, { sku: 'course.gentle_spine', type: 'in-app', displayPrice: '₹999.00' });

  const buying = store.buyFromStore(product, MEMBER);
  await settle();
  const [, request] = calls('requestPurchase')[0];
  assert.deepEqual(request.request.apple, { sku: 'course.gentle_spine', appAccountToken: MEMBER });

  const purchase = { id: 'x', transactionId: '2000000101', productId: 'course.gentle_spine', purchaseState: 'purchased' };
  state.purchased(purchase);
  state.sheet.resolve(purchase); // expo-iap hands it back here too; it must not be checked twice
  assert.deepEqual(await buying, unlocked);
  await settle();

  assert.deepEqual(calls('/v1/store/verify').map((c) => c[2]), [{ store: 'apple', transactionId: '2000000101' }]);
  const order = state.calls.map((c) => (c[0] === 'api' ? c[1] : c[0])).filter((step) => step === '/v1/store/verify' || step === 'finish');
  assert.deepEqual(order, ['/v1/store/verify', 'finish']);
});

test('iPhone: closing the sheet is a quiet no; Ask to Buy waits for the parent', async () => {
  const { store, state } = await phone('ios', async () => unlocked);
  const product = { sku: 'course.x', type: 'in-app', displayPrice: '$12' };

  const closed = store.buyFromStore(product, MEMBER);
  await settle();
  state.failed({ code: 'user-cancelled', message: 'cancelled' });
  state.sheet.reject({ code: 'user-cancelled', message: 'cancelled' });
  assert.equal(await closed, null);

  const asked = store.buyFromStore(product, MEMBER);
  await settle();
  state.failed({ code: 'deferred-payment', message: 'Ask to Buy' });
  assert.deepEqual(await asked, { pending: true });
});

test('iPhone: a purchase that belongs to another Embodha account is finished, so it stops coming back, and the member is told', async () => {
  const { store, state, calls } = await phone('ios', async () => ({ error: { status: 403, code: 'not_yours', message: 'That purchase belongs to another Embodha account.' } }));
  const buying = store.buyFromStore({ sku: 'course.x', type: 'in-app', displayPrice: '$12' }, MEMBER);
  await settle();
  state.purchased({ id: 'x', transactionId: '9', productId: 'course.x', purchaseState: 'purchased' });
  await assert.rejects(buying, /another Embodha account/);
  assert.deepEqual(calls('finish'), [['finish', '9']]);
});

test('iPhone: if our server can’t be reached the purchase stays open, and unlocks when the store replays it', async () => {
  let down = true;
  const { store, state, calls } = await phone('ios', async () => {
    if (down) throw new Error('Network request failed');
    return unlocked;
  });
  const buying = store.buyFromStore({ sku: 'course.x', type: 'in-app', displayPrice: '$12' }, MEMBER);
  await settle();
  const purchase = { id: 'x', transactionId: '5', productId: 'course.x', purchaseState: 'purchased' };
  state.purchased(purchase);
  await assert.rejects(buying, /Network/);
  assert.equal(calls('finish').length, 0);

  const credited = [];
  const stop = store.startStoreListener((result) => credited.push(result));
  down = false;
  state.purchased(purchase); // StoreKit replays unfinished transactions on the next launch
  await settle();
  assert.deepEqual(credited, [unlocked]);
  assert.deepEqual(calls('finish'), [['finish', '5']]);
  stop();
});

test('Android: subscribes on the base monthly plan, not a promotional offer', async () => {
  const subscribed = { kind: 'subscription', instructor: { slug: 'asha-rao', displayName: 'Asha Rao' }, accessUntil: '2026-11-21', test: false };
  const { store, state, calls } = await phone('android', async (path) => (path.startsWith('/v1/store/offer') ? { apple: null, google: 'sub.asha_rao' } : subscribed));
  state.products = [
    {
      id: 'sub.asha_rao',
      displayPrice: '₹249.00',
      subscriptionOffers: [
        { id: 'first_month_half', basePlanIdAndroid: 'monthly', offerTokenAndroid: 'tok-offer', displayPrice: '₹249.00' },
        { id: 'monthly', basePlanIdAndroid: 'monthly', offerTokenAndroid: 'tok-base', displayPrice: '₹499.00' },
      ],
    },
  ];
  const product = await store.findStoreProduct('instructor', 'i1');
  assert.deepEqual(product, { sku: 'sub.asha_rao', type: 'subs', displayPrice: '₹499.00', offerToken: 'tok-base' });
  assert.equal(calls('api')[0][1], '/v1/store/offer?instructorId=i1');

  const buying = store.buyFromStore(product, MEMBER);
  await settle();
  const [, request] = calls('requestPurchase')[0];
  assert.deepEqual(request, {
    type: 'subs',
    request: {
      apple: { sku: 'sub.asha_rao', appAccountToken: MEMBER },
      google: { skus: ['sub.asha_rao'], obfuscatedAccountId: MEMBER, subscriptionOffers: [{ sku: 'sub.asha_rao', offerToken: 'tok-base' }] },
    },
  });
  state.purchased({ id: 'x', productId: 'sub.asha_rao', purchaseToken: 'play-token-1', purchaseState: 'purchased' });
  assert.deepEqual(await buying, subscribed);
  assert.deepEqual(calls('/v1/store/verify')[0][2], { store: 'google', productId: 'sub.asha_rao', purchaseToken: 'play-token-1' });
});

test('Android: a payment still pending is reported as pending and left alone', async () => {
  const { store, state, calls } = await phone('android', async () => unlocked);
  const buying = store.buyFromStore({ sku: 'course.x', type: 'in-app', displayPrice: '₹999' }, MEMBER);
  await settle();
  state.purchased({ id: 'x', productId: 'course.x', purchaseToken: 'tok-2', purchaseState: 'pending' });
  assert.deepEqual(await buying, { pending: true });
  assert.equal(calls('/v1/store/verify').length + calls('finish').length, 0);
});

test('Android: on launch, anything paid but never acknowledged is picked up', async () => {
  const { store, state, calls } = await phone('android', async () => unlocked);
  state.available = [
    { id: 'a', productId: 'course.x', purchaseToken: 'tok-done', purchaseState: 'purchased', isAcknowledgedAndroid: true },
    { id: 'b', productId: 'course.x', purchaseToken: 'tok-open', purchaseState: 'purchased', isAcknowledgedAndroid: false },
  ];
  const credited = [];
  store.startStoreListener((result) => credited.push(result));
  await settle();
  assert.equal(credited.length, 1);
  assert.deepEqual(calls('/v1/store/verify').map((c) => c[2].purchaseToken), ['tok-open']);
});

test('Restore: checks everything the store has and counts what came back', async () => {
  let n = 0;
  const { store, state } = await phone('ios', async () => (++n === 2 ? { error: { status: 403, code: 'not_yours', message: 'another account' } } : unlocked));
  state.available = [
    { id: '1', transactionId: '1', productId: 'course.a', purchaseState: 'purchased' },
    { id: '2', transactionId: '2', productId: 'course.b', purchaseState: 'purchased' },
    { id: '3', transactionId: '3', productId: 'course.c', purchaseState: 'pending' },
  ];
  assert.deepEqual(await store.restoreStorePurchases(), { restored: 1, failed: 1 });
});

test('Subscriptions are managed in the store that bills them, from that store’s phone', async () => {
  const ios = (await phone('ios', async () => unlocked)).store;
  assert.equal(ios.manageSubscriptionsUrl('apple'), 'https://apps.apple.com/account/subscriptions');
  assert.equal(ios.manageSubscriptionsUrl('google'), null);
  const android = (await phone('android', async () => unlocked)).store;
  assert.equal(android.manageSubscriptionsUrl('google'), 'https://play.google.com/store/account/subscriptions?package=com.embodha.app');
  assert.equal(android.manageSubscriptionsUrl('razorpay'), null);
});
