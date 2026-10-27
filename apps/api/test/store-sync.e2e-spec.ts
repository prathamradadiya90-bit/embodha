import { and, eq } from 'drizzle-orm';
import { courses, pricePoints, staffRoles, storeProducts, users } from '../src/db/schema';
import { AppleProductState, AppStoreConnectClient } from '../src/money/app-store-connect.client';
import { GooglePlayClient, money } from '../src/money/google-play.client';
import { StoreSyncService } from '../src/money/store-sync.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TestApp } from './helpers';

/** The server making the store products itself. Both stores' management APIs are faked; the bookkeeping is real. */
describe('Store products made by the server', () => {
  let t: TestApp;
  let f: Fixtures;
  let admin: string;
  let sync: StoreSyncService;
  const calls: string[] = [];
  const states = new Map<string, AppleProductState>();
  let failScreenshot = false;
  let refuseSubmission = false;

  const rows = (ownerId: string) => t.db.select().from(storeProducts).where(eq(storeProducts.ownerId, ownerId));
  const row = async (ownerId: string, store: 'apple' | 'google') => (await rows(ownerId)).find((r) => r.store === store)!;
  const call = (token: string, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const req = t.http()[method](path).set(bearer(token));
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await seedFixtures(t.db);
    sync = t.app.get(StoreSyncService);
    const apple = t.app.get(AppStoreConnectClient);
    const google = t.app.get(GooglePlayClient);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = (name: string, result: (...args: any[]) => unknown) =>
      (async (...args: unknown[]) => {
        calls.push(`${name} ${JSON.stringify(args)}`);
        return result(...args);
      }) as never;
    jest.spyOn(apple, 'ready', 'get').mockReturnValue(true);
    jest.spyOn(google, 'ready', 'get').mockReturnValue(true);
    jest.spyOn(apple, 'findInAppPurchase').mockImplementation(log('findInAppPurchase', () => null));
    jest.spyOn(apple, 'findGroup').mockImplementation(log('findGroup', () => null));
    jest.spyOn(apple, 'findSubscription').mockImplementation(log('findSubscription', () => null));
    jest.spyOn(apple, 'createInAppPurchase').mockImplementation(
      log('createInAppPurchase', (input: { productId: string }) => (states.set('iap-1', 'MISSING_METADATA'), { id: 'iap-1', type: 'inAppPurchases', input })),
    );
    jest.spyOn(apple, 'createGroup').mockImplementation(log('createGroup', () => ({ id: 'grp-1', type: 'subscriptionGroups' })));
    jest.spyOn(apple, 'localizeGroup').mockImplementation(log('localizeGroup', () => undefined));
    jest.spyOn(apple, 'createSubscription').mockImplementation(log('createSubscription', () => (states.set('sub-1', 'MISSING_METADATA'), { id: 'sub-1', type: 'subscriptions' })));
    jest.spyOn(apple, 'localize').mockImplementation(log('localize', () => undefined));
    jest.spyOn(apple, 'priceInAppPurchase').mockImplementation(log('priceInAppPurchase', () => undefined));
    jest.spyOn(apple, 'priceSubscription').mockImplementation(log('priceSubscription', () => 175));
    jest.spyOn(apple, 'setOnSale').mockImplementation(log('setOnSale', () => undefined));
    jest.spyOn(apple, 'uploadReviewScreenshot').mockImplementation(
      log('uploadReviewScreenshot', (_kind: string, id: string) => {
        if (failScreenshot) throw new Error('App Store Connect said: The upload timed out.');
        states.set(id, 'READY_TO_SUBMIT');
      }),
    );
    jest.spyOn(apple, 'state').mockImplementation(async (_kind, id) => states.get(id)!);
    jest.spyOn(apple, 'submit').mockImplementation(
      log('submit', (_kind: string, id: string) => {
        if (refuseSubmission) throw new Error('App Store Connect said: The first in-app purchase must be submitted with a new app version.');
        states.set(id, 'WAITING_FOR_REVIEW');
      }),
    );
    jest.spyOn(google, 'convertPrices').mockImplementation(
      log('convertPrices', () => ({
        regions: [
          { regionCode: 'GB', price: money('GBP', 999) },
          { regionCode: 'IN', price: money('INR', 100_000) },
        ],
        other: { usdPrice: money('USD', 1200), eurPrice: money('EUR', 1100) },
      })),
    );
    jest.spyOn(google, 'saveOneTimeProduct').mockImplementation(log('saveOneTimeProduct', () => ({})));
    jest.spyOn(google, 'setPurchaseOptionOnSale').mockImplementation(log('setPurchaseOptionOnSale', () => ({})));
    jest.spyOn(google, 'subscriptionProduct').mockImplementation(log('subscriptionProduct', () => null));
    jest.spyOn(google, 'saveSubscriptionProduct').mockImplementation(log('saveSubscriptionProduct', () => ({})));
    jest.spyOn(google, 'setBasePlanOnSale').mockImplementation(log('setBasePlanOnSale', () => ({})));

    admin = (await signIn(t, 'products@embodha.test')).accessToken;
    const [person] = await t.db.select().from(users).where(eq(users.email, 'products@embodha.test'));
    await t.db.insert(staffRoles).values({ userId: person.id, role: 'content' });
  });
  afterAll(async () => {
    await sync.idle();
    await t.close();
  });
  beforeEach(() => {
    calls.length = 0;
  });

  it('makes both products when a paid course is published, picking up after a failed step', async () => {
    await t.db.update(courses).set({ status: 'in_review' }).where(eq(courses.id, f.draft.id));
    failScreenshot = true;
    await call(admin, 'post', `/v1/admin/courses/${f.draft.id}/review`, { decision: 'publish' }).expect(200);
    await sync.idle();

    // Google is done; Apple stopped at the screenshot, with what it had made so far written down.
    expect(await row(f.draft.id, 'google')).toMatchObject({ productId: 'course.draft_course', auto: true, status: 'live', storeState: 'ACTIVE' });
    const stuck = await row(f.draft.id, 'apple');
    expect(stuck).toMatchObject({ productId: 'course.draft_course', auto: true, status: 'failed', externalId: 'iap-1', attempts: 1, lastError: expect.stringContaining('timed out') });
    expect(stuck.steps).toMatchObject({ named: true, onSale: true });
    const save = calls.find((c) => c.startsWith('saveOneTimeProduct'))!;
    expect(save).toContain('"regionCode":"US","price":{"currencyCode":"USD","units":"12","nanos":0}');
    expect(save).toContain('"regionCode":"IN","price":{"currencyCode":"INR","units":"999","nanos":0}');
    expect(save).not.toContain('"units":"1000"'); // Play's own rupee conversion is replaced by the course's price
    expect(calls).toContainEqual('setPurchaseOptionOnSale ["course.draft_course",true]');
    expect(calls).toContainEqual('priceInAppPurchase ["iap-1",{"inr":999,"usd":12}]');

    // The retry carries on from the screenshot: nothing is made twice, and the product goes to review.
    failScreenshot = false;
    calls.length = 0;
    await call(admin, 'post', '/v1/admin/store-products/sync', { ownerType: 'course', ownerId: f.draft.id }).expect(202);
    await sync.idle();
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['uploadReviewScreenshot', 'submit']);
    expect(await row(f.draft.id, 'apple')).toMatchObject({ status: 'in_review', storeState: 'WAITING_FOR_REVIEW', attempts: 0, lastError: null });
    expect((await t.http().get(`/v1/store/offer?courseId=${f.draft.id}`).expect(200)).body).toEqual({ apple: 'course.draft_course', google: 'course.draft_course' });

    const list = (await call(admin, 'get', '/v1/admin/store-products').expect(200)).body;
    expect(list.automation).toEqual({ apple: true, google: true });
    expect(list.courses.find((c: { id: string }) => c.id === f.draft.id).apple).toMatchObject({ auto: true, storeState: 'WAITING_FOR_REVIEW' });
  });

  it('marks Apple’s approval on the next sweep, and leaves products linked by hand alone', async () => {
    states.set('iap-1', 'APPROVED');
    await call(admin, 'put', '/v1/admin/store-products', { ownerType: 'course', ownerId: f.paid.id, store: 'apple', productId: 'course.by_hand', status: 'live' }).expect(200);
    await sync.sweep();
    expect(await row(f.draft.id, 'apple')).toMatchObject({ status: 'live', storeState: 'APPROVED' });
    expect(await row(f.paid.id, 'apple')).toMatchObject({ productId: 'course.by_hand', auto: false, status: 'live' });
    // The sweep did make the hand-linked course's missing Play product.
    expect(await row(f.paid.id, 'google')).toMatchObject({ productId: 'course.gentle_spine', auto: true, status: 'live' });
    expect(calls.filter((c) => c.startsWith('createInAppPurchase'))).toEqual([]);
  });

  it('says so when Apple wants the first products sent with an app version', async () => {
    const [point] = await t.db.select().from(pricePoints).where(eq(pricePoints.code, 'C999'));
    const [extra] = await t.db
      .insert(courses)
      .values({ topicId: f.topic.id, instructorId: f.asha.id, title: 'Slow mornings', slug: 'slow-mornings', status: 'published', publishedAt: new Date(), pricePointId: point.id })
      .returning();
    refuseSubmission = true;
    jest
      .spyOn(t.app.get(AppStoreConnectClient), 'createInAppPurchase')
      .mockImplementationOnce((async () => (states.set('iap-2', 'MISSING_METADATA'), { id: 'iap-2', type: 'inAppPurchases' })) as never);
    await sync.sync({ type: 'course', id: extra.id });
    refuseSubmission = false;
    expect(await row(extra.id, 'apple')).toMatchObject({ status: 'pending', storeState: 'READY_TO_SUBMIT', lastError: expect.stringContaining('next app version') });
  });

  it('follows a teacher’s subscription: made when switched on, re-priced, and off sale in both stores when switched off', async () => {
    const asha = (await signIn(t, 'asha@embodha.test')).accessToken;
    await t.db.delete(storeProducts).where(and(eq(storeProducts.ownerType, 'instructor_plan'), eq(storeProducts.ownerId, f.asha.id)));
    await sync.sync({ type: 'instructor_plan', id: f.asha.id });
    expect(await row(f.asha.id, 'apple')).toMatchObject({ productId: 'sub.asha_rao', groupId: 'grp-1', externalId: 'sub-1', status: 'in_review' });
    expect(await row(f.asha.id, 'google')).toMatchObject({ productId: 'sub.asha_rao', status: 'live' });
    expect(calls).toContainEqual('priceSubscription ["sub-1",{"inr":499,"usd":6},false]');
    expect(calls).toContainEqual('setBasePlanOnSale ["sub.asha_rao",true]');

    // A new price: Apple keeps current subscribers on theirs; Play's base plan gets the new prices.
    const [dearer] = await t.db.insert(pricePoints).values({ code: 'S799X', kind: 'subscription', inrPaise: 79_900, usdCents: 1000 }).returning();
    calls.length = 0;
    await call(asha, 'put', '/v1/studio/plan', { enabled: true, pricePointId: dearer.id }).expect(200);
    await sync.idle();
    expect(calls).toContainEqual('priceSubscription ["sub-1",{"inr":799,"usd":10},true]');
    expect(calls.find((c) => c.startsWith('saveSubscriptionProduct'))).toContain('"units":"799"');

    calls.length = 0;
    const off = await call(asha, 'put', '/v1/studio/plan', { enabled: false }).expect(200);
    expect(off.body).toMatchObject({ enabled: false, appStoreOffSale: true });
    await sync.idle();
    expect(calls).toContainEqual('setOnSale ["subscription","sub-1",false]');
    expect(calls).toContainEqual('setBasePlanOnSale ["sub.asha_rao",false]');
    expect((await rows(f.asha.id)).map((r) => r.status)).toEqual(['off_sale', 'off_sale']);
    expect((await t.http().get(`/v1/store/offer?instructorId=${f.asha.id}`).expect(200)).body).toEqual({ apple: null, google: null });
  });
});
