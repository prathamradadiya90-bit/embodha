import { and, eq } from 'drizzle-orm';
import { entitlements, payments, splits, staffRoles, users } from '../src/db/schema';
import { AppleEnvironment, AppleRenewalInfo, AppleStoreClient, AppleSubscriptionStatus, AppleTransaction } from '../src/money/apple-store.client';
import { GooglePlayClient, PlayProductPurchase, PlaySubscription } from '../src/money/google-play.client';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

/** Apple's JWS, minus a real signature: the server reads these without checking, and asks Apple for the truth. */
const jws = (payload: object) => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
const days = (n: number) => Date.now() + n * 86_400_000;

describe('App Store and Google Play purchases', () => {
  let t: TestApp;
  let f: Fixtures;
  let staff: string;

  // Both stores, faked at their API edge. Everything Embodha does with the answers is real.
  const appleTx = new Map<string, { environment: AppleEnvironment; transaction: AppleTransaction }>();
  const appleSubs = new Map<string, { status: AppleSubscriptionStatus; transaction: AppleTransaction; renewal: AppleRenewalInfo | null }>();
  const playProducts = new Map<string, PlayProductPurchase>();
  const playSubs = new Map<string, PlaySubscription>();
  const acknowledged: string[] = [];
  const cancelled: string[] = [];

  const call = (token: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };
  const member = async (email: string) => {
    const token = (await signIn(t, email)).accessToken;
    const id = (await call(token, 'get', '/v1/me').expect(200)).body.id as string;
    return { token, id };
  };
  const link = (body: object) => call(staff, 'put', '/v1/admin/store-products', body);
  const canPlay = (token: string) => call(token, 'get', `/v1/chapters/${f.locked.id}/playback`).then((res) => res.status);
  const paymentFor = async (externalId: string) => (await t.db.select().from(payments).where(eq(payments.externalId, externalId)))[0];
  const appleNote = (notificationType: string, transactionId: string, subtype?: string) =>
    t
      .http()
      .post('/v1/webhooks/apple')
      .send({ signedPayload: jws({ notificationType, subtype, notificationUUID: `n-${transactionId}-${notificationType}`, data: { bundleId: 'com.embodha.app', signedTransactionInfo: jws({ transactionId }) } }) });
  const playNote = (note: object, secret = 'play-hook-secret-0123') =>
    t
      .http()
      .post(`/v1/webhooks/google?secret=${secret}`)
      .send({ message: { data: Buffer.from(JSON.stringify({ packageName: 'com.embodha.app', ...note })).toString('base64'), messageId: '1' }, subscription: 'projects/x/subscriptions/y' });

  const appleCourse = (transactionId: string, userId: string, extra: Partial<AppleTransaction> = {}): AppleTransaction => ({
    transactionId,
    originalTransactionId: transactionId,
    bundleId: 'com.embodha.app',
    productId: 'course.gentle_spine',
    type: 'Non-Consumable',
    purchaseDate: Date.now(),
    appAccountToken: userId,
    inAppOwnershipType: 'PURCHASED',
    environment: 'Production',
    storefront: 'IND',
    price: 999_000,
    currency: 'INR',
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    const apple = t.app.get(AppleStoreClient);
    jest.spyOn(apple, 'transaction').mockImplementation(async (id) => {
      const found = appleTx.get(id);
      if (!found) throw new Error(`no fake transaction ${id}`);
      return found;
    });
    jest.spyOn(apple, 'subscription').mockImplementation(async (id) => appleSubs.get(id) ?? null);
    const google = t.app.get(GooglePlayClient);
    jest.spyOn(google, 'product').mockImplementation(async (_productId, token) => playProducts.get(token)!);
    jest.spyOn(google, 'subscription').mockImplementation(async (token) => playSubs.get(token)!);
    jest.spyOn(google, 'acknowledgeProduct').mockImplementation(async (productId, token) => acknowledged.push(`${productId} ${token}`));
    jest.spyOn(google, 'acknowledgeSubscription').mockImplementation(async (productId, token) => acknowledged.push(`${productId} ${token}`));
    jest.spyOn(google, 'cancelSubscription').mockImplementation(async (token) => cancelled.push(token));

    staff = (await signIn(t, 'catalogue@embodha.test')).accessToken;
    const [person] = await t.db.select().from(users).where(eq(users.email, 'catalogue@embodha.test'));
    await t.db.insert(staffRoles).values([
      { userId: person.id, role: 'content' },
      { userId: person.id, role: 'finance' },
    ]);
  });
  afterAll(async () => {
    await t.close();
  });

  it('links store products to a course and a subscription, and offers only the ones that can be bought', async () => {
    await link({ ownerType: 'course', ownerId: f.paid.id, store: 'apple', productId: 'course.gentle_spine', status: 'live' }).expect(200);
    await link({ ownerType: 'course', ownerId: f.paid.id, store: 'google', productId: 'course.gentle_spine', status: 'pending' }).expect(200);
    await link({ ownerType: 'instructor_plan', ownerId: f.asha.id, store: 'apple', productId: 'sub.asha_rao', status: 'live' }).expect(200);
    await link({ ownerType: 'instructor_plan', ownerId: f.asha.id, store: 'google', productId: 'sub.asha_rao', status: 'live' }).expect(200);

    // One product sells one thing, and IDs have to work in both stores.
    expect((await link({ ownerType: 'course', ownerId: f.draft.id, store: 'apple', productId: 'course.gentle_spine', status: 'pending' }).expect(409)).body.code).toBe('product_taken');
    await link({ ownerType: 'course', ownerId: f.draft.id, store: 'apple', productId: 'Gentle Spine', status: 'pending' }).expect(400);

    const offer = () => t.http().get(`/v1/store/offer?courseId=${f.paid.id}`).expect(200).then((res) => res.body);
    expect(await offer()).toEqual({ apple: 'course.gentle_spine', google: null }); // still being set up in Play Console
    await link({ ownerType: 'course', ownerId: f.paid.id, store: 'google', productId: 'course.gentle_spine', status: 'in_review' }).expect(200);
    expect(await offer()).toEqual({ apple: 'course.gentle_spine', google: 'course.gentle_spine' });
    expect((await t.http().get(`/v1/store/offer?instructorId=${f.asha.id}`).expect(200)).body).toEqual({ apple: 'sub.asha_rao', google: 'sub.asha_rao' });

    const list = (await call(staff, 'get', '/v1/admin/store-products').expect(200)).body;
    expect(list.commissionBps).toBe(1500);
    expect(list.courses.find((c: { slug: string }) => c.slug === 'gentle-spine')).toMatchObject({
      suggestedId: 'course.gentle_spine',
      price: { inr: '₹999', usd: '$12' },
      apple: { productId: 'course.gentle_spine', status: 'live' },
      google: { productId: 'course.gentle_spine', status: 'in_review' },
    });
    expect(list.plans).toEqual([expect.objectContaining({ displayName: 'Asha Rao', suggestedId: 'sub.asha_rao', apple: expect.objectContaining({ status: 'live' }) })]);

    const { token } = await member('nosy@embodha.test');
    await call(token, 'get', '/v1/admin/store-products').expect(403);
  });

  it('unlocks a course bought on the App Store and books it with GST and Apple’s 15%, without an Embodha invoice', async () => {
    const buyer = await member('iphone@embodha.test');
    appleTx.set('2000000101', { environment: 'Production', transaction: appleCourse('2000000101', buyer.id) });
    expect(await canPlay(buyer.token)).toBe(402);

    const res = await call(buyer.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '2000000101' }).expect(200);
    expect(res.body).toEqual({ kind: 'course', course: { slug: 'gentle-spine', title: 'gentle-spine' }, test: false });
    expect(await canPlay(buyer.token)).toBe(200);

    // ₹999 = ₹846.61 + ₹152.39 GST; Apple keeps 15% of ₹846.61; 60% of the ₹719.62 left is ₹431.77. The spec's example.
    const row = await paymentFor('2000000101');
    expect(row).toMatchObject({ channel: 'apple', grossMinor: 99_900, gstMinor: 15_239, feeMinor: 12_699, netMinor: 71_962, invoiceNo: null, isTest: false });
    const [split] = await t.db.select().from(splits).where(eq(splits.paymentId, row.id));
    expect(split).toMatchObject({ instructorPaise: 43_177, embodhaPaise: 28_785 });
    expect(t.mail.outbox.filter((m) => m.to === 'iphone@embodha.test' && m.attachments?.length)).toHaveLength(0); // Apple sends the receipt

    // Again: nothing new. Someone else with the same receipt: no.
    await call(buyer.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '2000000101' }).expect(200);
    expect(await t.db.select().from(payments).where(eq(payments.channel, 'apple'))).toHaveLength(1);
    const other = await member('borrower@embodha.test');
    expect((await call(other.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '2000000101' }).expect(403)).body.code).toBe('not_yours');

    const purchases = (await call(buyer.token, 'get', '/v1/me/purchases').expect(200)).body;
    expect(purchases).toEqual([expect.objectContaining({ channel: 'apple', invoiceNo: null, test: false, amount: expect.objectContaining({ display: '₹999' }) })]);
  });

  it('subscribes through Google Play, then follows renewals, cancelling and expiry from Play’s notifications', async () => {
    const abroad = await member('pixel@embodha.test');
    const token = 'play-sub-token-0001';
    const active = (orderId: string, expiry: number): PlaySubscription => ({
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      regionCode: 'GB',
      lineItems: [{ productId: 'sub.asha_rao', expiryTime: new Date(expiry).toISOString(), latestSuccessfulOrderId: orderId, autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'USD', units: '6' } } }],
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: abroad.id },
    });
    playSubs.set(token, active('GPA.3301-1234-5678-90123', days(30)));

    const res = await call(abroad.token, 'post', '/v1/store/verify', { store: 'google', productId: 'sub.asha_rao', purchaseToken: token }).expect(200);
    expect(res.body).toMatchObject({ kind: 'subscription', instructor: { slug: 'asha-rao', displayName: 'Asha Rao' }, test: false });
    expect(acknowledged).toContain(`sub.asha_rao ${token}`);
    expect(await canPlay(abroad.token)).toBe(200);

    // $6, no GST outside India, Google keeps 15%, the rest into rupees at 88: ₹448.80, and 60% of it.
    const first = await paymentFor('GPA.3301-1234-5678-90123');
    expect(first).toMatchObject({ channel: 'google', kind: 'subscription', currency: 'USD', grossMinor: 600, gstMinor: 0, feeMinor: 90, netMinor: 510, netInrPaise: 44_880 });
    expect((await t.db.select().from(splits).where(eq(splits.paymentId, first.id)))[0].instructorPaise).toBe(26_928);

    await playNote({ subscriptionNotification: { notificationType: 2, purchaseToken: token } }, 'wrong-secret').expect(401);
    playSubs.set(token, active('GPA.3301-1234-5678-90123..0', days(60)));
    await playNote({ subscriptionNotification: { notificationType: 2, purchaseToken: token } }).expect(200, { ok: 'subscription.2' });
    await playNote({ subscriptionNotification: { notificationType: 2, purchaseToken: token } }).expect(200); // Pub/Sub delivers twice sometimes
    expect(await t.db.select().from(payments).where(and(eq(payments.channel, 'google'), eq(payments.kind, 'subscription')))).toHaveLength(2);

    const cancelled = active('GPA.3301-1234-5678-90123..0', days(60));
    cancelled.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    cancelled.lineItems![0].autoRenewingPlan!.autoRenewEnabled = false;
    playSubs.set(token, cancelled);
    await playNote({ subscriptionNotification: { notificationType: 3, purchaseToken: token } }).expect(200);
    const library = (await call(abroad.token, 'get', '/v1/library').expect(200)).body;
    expect(library.subscriptions).toEqual([expect.objectContaining({ channel: 'google', renews: false })]);
    expect(await canPlay(abroad.token)).toBe(200); // paid to the end of the month

    playSubs.set(token, { ...cancelled, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', lineItems: [{ ...cancelled.lineItems![0], expiryTime: new Date(days(-1)).toISOString() }] });
    await playNote({ subscriptionNotification: { notificationType: 13, purchaseToken: token } }).expect(200);
    expect(await canPlay(abroad.token)).toBe(402);
    expect(await t.db.select().from(payments).where(and(eq(payments.channel, 'google'), eq(payments.kind, 'subscription')))).toHaveLength(2);
  });

  it('follows an App Store subscription through renewal, auto-renew switched off, and expiry', async () => {
    const subscriber = await member('ipad@embodha.test');
    const tx = (transactionId: string, expires: number): AppleTransaction => ({
      ...appleCourse(transactionId, subscriber.id),
      originalTransactionId: '3000000001',
      productId: 'sub.asha_rao',
      type: 'Auto-Renewable Subscription',
      expiresDate: expires,
      price: 499_000,
    });
    appleTx.set('3000000001', { environment: 'Production', transaction: tx('3000000001', days(30)) });
    appleSubs.set('3000000001', { status: 1, transaction: tx('3000000001', days(30)), renewal: { originalTransactionId: '3000000001', autoRenewStatus: 1 } });

    const res = await call(subscriber.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '3000000001' }).expect(200);
    expect(res.body).toMatchObject({ kind: 'subscription', instructor: { slug: 'asha-rao' } });
    expect(await paymentFor('3000000001')).toMatchObject({ kind: 'subscription', grossMinor: 49_900, gstMinor: 7612, feeMinor: 6343, netMinor: 35_945 });
    expect(await canPlay(subscriber.token)).toBe(200);

    // A renewal: Apple pushes it; we look it up ourselves and book it.
    appleTx.set('3000000002', { environment: 'Production', transaction: tx('3000000002', days(60)) });
    appleSubs.set('3000000001', { status: 1, transaction: tx('3000000002', days(60)), renewal: { originalTransactionId: '3000000001', autoRenewStatus: 1 } });
    await appleNote('DID_RENEW', '3000000002').expect(200);
    expect(await paymentFor('3000000002')).toMatchObject({ kind: 'subscription', grossMinor: 49_900 });
    const renewed = (await call(subscriber.token, 'get', '/v1/library').expect(200)).body.subscriptions[0];
    expect(renewed).toMatchObject({ channel: 'apple', renews: true });
    expect(new Date(renewed.accessUntil).getTime()).toBeGreaterThan(days(59));

    appleSubs.set('3000000001', { status: 1, transaction: tx('3000000002', days(60)), renewal: { originalTransactionId: '3000000001', autoRenewStatus: 0 } });
    await appleNote('DID_CHANGE_RENEWAL_STATUS', '3000000002', 'AUTO_RENEW_DISABLED').expect(200);
    expect((await call(subscriber.token, 'get', '/v1/library').expect(200)).body.subscriptions[0].renews).toBe(false);

    appleSubs.set('3000000001', { status: 2, transaction: tx('3000000002', days(-1)), renewal: { originalTransactionId: '3000000001', autoRenewStatus: 0 } });
    await appleNote('EXPIRED', '3000000002', 'VOLUNTARY').expect(200);
    expect(await canPlay(subscriber.token)).toBe(402);
    expect(await t.db.select().from(payments).where(eq(payments.subscriptionId, (await paymentFor('3000000001')).subscriptionId!))).toHaveLength(2);
  });

  it('lets App Review and testers buy for real in the sandbox, with no invoice, no split and no money', async () => {
    const tester = await member('review-tester@embodha.test');
    appleTx.set('2000000909', { environment: 'Sandbox', transaction: appleCourse('2000000909', tester.id, { environment: 'Sandbox' }) });
    expect((await call(tester.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '2000000909' }).expect(200)).body.test).toBe(true);
    expect(await canPlay(tester.token)).toBe(200);
    const row = await paymentFor('2000000909');
    expect(row).toMatchObject({ isTest: true, invoiceNo: null });
    expect(await t.db.select().from(splits).where(eq(splits.paymentId, row.id))).toHaveLength(0);
    const listed = (await call(staff, 'get', '/v1/admin/payments').expect(200)).body.find((p: { id: string }) => p.id === row.id);
    expect(listed).toMatchObject({ channel: 'apple', test: true, split: null });
  });

  it('waits for a pending Play purchase, then unlocks when Google says the money arrived', async () => {
    const cash = await member('upi-later@embodha.test');
    const token = 'play-course-token-0007';
    playProducts.set(token, { purchaseState: 2, acknowledgementState: 0, obfuscatedExternalAccountId: cash.id, regionCode: 'IN' });
    expect((await call(cash.token, 'post', '/v1/store/verify', { store: 'google', productId: 'course.gentle_spine', purchaseToken: token }).expect(200)).body).toEqual({ pending: true });
    expect(await canPlay(cash.token)).toBe(402);

    playProducts.set(token, { purchaseState: 0, acknowledgementState: 0, orderId: 'GPA.7700-0000-0000-00007', obfuscatedExternalAccountId: cash.id, regionCode: 'IN', purchaseTimeMillis: String(Date.now()) });
    await playNote({ oneTimeProductNotification: { notificationType: 1, purchaseToken: token, sku: 'course.gentle_spine' } }).expect(200, { ok: 'one_time' });
    expect(await canPlay(cash.token)).toBe(200);
    expect(acknowledged).toContain(`course.gentle_spine ${token}`);
    // Play doesn't say what a one-time product cost, so the course's rupee price is booked.
    expect(await paymentFor('GPA.7700-0000-0000-00007')).toMatchObject({ currency: 'INR', grossMinor: 99_900, feeMinor: 12_699 });
  });

  it('takes the course back and reverses the share when Apple or Google refunds', async () => {
    const [iphone] = await t.db.select().from(users).where(eq(users.email, 'iphone@embodha.test'));
    appleTx.set('2000000101', { environment: 'Production', transaction: appleCourse('2000000101', iphone.id, { revocationDate: Date.now() }) });
    await appleNote('REFUND', '2000000101').expect(200);
    const apple = await paymentFor('2000000101');
    expect(apple.status).toBe('refunded');
    expect(await t.db.select().from(entitlements).where(eq(entitlements.paymentId, apple.id))).toHaveLength(0);
    expect((await t.db.select().from(splits).where(eq(splits.paymentId, apple.id)))[0].state).toBe('reversed');

    await playNote({ voidedPurchaseNotification: { purchaseToken: 'play-course-token-0007', orderId: 'GPA.7700-0000-0000-00007', productType: 2, refundType: 1 } }).expect(200, { ok: 'voided' });
    const play = await paymentFor('GPA.7700-0000-0000-00007');
    expect(play.status).toBe('refunded');

    // Refunds in the stores happen in the stores: finance can't start one here.
    expect((await call(staff, 'post', `/v1/admin/payments/${play.id}/refund`, { reason: 'Asked twice' }).expect(409)).body.code).toBe('not_refundable');
    expect((await call(staff, 'post', `/v1/admin/payments/${(await paymentFor('3000000002')).id}/refund`, { reason: 'Asked' }).expect(409)).body.code).toBe('store_refund');
  });

  it('ignores what it cannot act on, so the stores stop retrying', async () => {
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: jws({ notificationType: 'TEST' }) }).expect(200, { ok: 'test' });
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: 'not-a-jws' }).expect(200, { ignored: 'bad_jws' });
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: jws({ notificationType: 'REFUND', data: { bundleId: 'com.someone.else' } }) }).expect(200, { ignored: 'other_app' });
    await playNote({ packageName: 'com.someone.else', testNotification: {} }).expect(200, { ignored: 'other_app' });
    await playNote({ testNotification: { version: '1.0' } }).expect(200, { ok: 'test' });

    // A course nobody linked yet: the member is told plainly, and nothing is booked.
    const someone = await member('unlinked@embodha.test');
    appleTx.set('2000000555', { environment: 'Production', transaction: appleCourse('2000000555', someone.id, { productId: 'course.not_linked' }) });
    expect((await call(someone.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '2000000555' }).expect(404)).body.code).toBe('unknown_product');
    expect(await paymentFor('2000000555')).toBeUndefined();
  });

  it('stops Google Play renewals when the teacher switches the subscription off, and counts the App Store ones it cannot stop', async () => {
    const onPlay = await member('play-sub-2@embodha.test');
    const playToken = 'play-sub-token-0002';
    playSubs.set(playToken, {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      regionCode: 'IN',
      lineItems: [{ productId: 'sub.asha_rao', expiryTime: new Date(days(20)).toISOString(), latestSuccessfulOrderId: 'GPA.5501-0000-0000-00001', autoRenewingPlan: { autoRenewEnabled: true } }],
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: onPlay.id },
    });
    await call(onPlay.token, 'post', '/v1/store/verify', { store: 'google', productId: 'sub.asha_rao', purchaseToken: playToken }).expect(200);

    const onIphone = await member('ios-sub-2@embodha.test');
    const tx: AppleTransaction = { ...appleCourse('4000000001', onIphone.id), productId: 'sub.asha_rao', type: 'Auto-Renewable Subscription', expiresDate: days(20), price: 499_000 };
    appleTx.set('4000000001', { environment: 'Production', transaction: tx });
    appleSubs.set('4000000001', { status: 1, transaction: tx, renewal: { originalTransactionId: '4000000001', autoRenewStatus: 1 } });
    await call(onIphone.token, 'post', '/v1/store/verify', { store: 'apple', transactionId: '4000000001' }).expect(200);

    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    const off = await call(asha, 'put', '/v1/studio/plan', { enabled: false }).expect(200);
    expect(off.body).toMatchObject({ enabled: false, stoppedRenewals: 1, appStoreRenewals: 1 });
    expect(cancelled).toEqual([playToken]);
    expect((await call(onPlay.token, 'get', '/v1/library').expect(200)).body.subscriptions[0]).toMatchObject({ channel: 'google', renews: false });
    expect(await canPlay(onPlay.token)).toBe(200); // the paid month still runs
    expect((await t.http().get(`/v1/store/offer?instructorId=${f.asha.id}`).expect(200)).body).toEqual({ apple: null, google: null });
  });
});
