import { createHmac, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { BetaHealthService } from '../src/beta/beta.module';
import { mediaAssets, chapters, settings, staffRoles, storeProducts, users } from '../src/db/schema';
import { LaunchService } from '../src/launch/launch.service';
import { AppleStoreClient } from '../src/money/apple-store.client';
import { PaymentsService } from '../src/money/payments.service';
import { Fixtures, seedFixtures } from './fixtures';
import { bearer, createTestApp, signIn, TEST_ENV, TestApp } from './helpers';

type Check = { key: string; status: 'done' | 'todo' | 'waiting'; detail: string; blocking: boolean; action?: string; signoff?: unknown };
type Checklist = { ready: boolean; left: number; counts: Record<string, number>; total: number; sections: { key: string; title: string; checks: Check[] }[] };

const env = TEST_ENV as unknown as Record<string, string | undefined>;
const ORIGINAL = { ...env };

/** The public website and the members' web app, as they'd be served. `mode` breaks them in the ways that happen. */
let mode: 'down' | 'up' | 'redirecting' | 'spa' = 'down';
const PAGES = ['/', '/pricing/', '/privacy/', '/terms/', '/refunds/', '/shipping/', '/support/', '/delete-account/'];
const site = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (mode === 'down') {
    res.writeHead(502, { 'content-type': 'text/html' }).end('<h1>Bad gateway</h1>');
    return;
  }
  if (mode === 'spa' && url.startsWith('/.well-known/')) {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><div id="root"></div>');
    return;
  }
  if (url === '/.well-known/apple-app-site-association') {
    if (mode === 'redirecting') {
      res.writeHead(301, { location: '/apple-app-site-association.json' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ applinks: { details: [{ appIDs: ['ABCDE12345.com.embodha.app'], components: [{ '/': '/auth/link' }] }] } }));
    return;
  }
  if (url === '/.well-known/assetlinks.json') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.embodha.app', sha256_cert_fingerprints: ['AA:BB'] } }]));
    return;
  }
  if (PAGES.includes(url)) {
    const body = url === '/refunds/' ? '<p>Changed your mind? Write to us within <strong>7</strong> days of buying a course.</p>' : `<h1>${url}</h1>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
});

describe('Launch checklist', () => {
  let t: TestApp;
  let f: Fixtures;
  let owner: string;
  let support: string;
  let finance: string;
  let base: string;

  const check = (list: Checklist, key: string) => list.sections.flatMap((s) => s.checks).find((c) => c.key === key)!;
  const load = async (token = support, fresh = true) => (await t.http().get(`/v1/admin/launch${fresh ? '?fresh=1' : ''}`).set(bearer(token)).expect(200)).body as Checklist;
  const staff = async (email: string, role: 'super_admin' | 'support' | 'finance') => {
    const token = (await signIn(t, email)).accessToken;
    const [user] = await t.db.select().from(users).where(eq(users.email, email));
    await t.db.insert(staffRoles).values({ userId: user.id, role });
    return token;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    env.SITE_URL = base;
    env.WEB_URL = base;
    t = await createTestApp();
    f = await seedFixtures(t.db);
    owner = await staff('owner@embodha.test', 'super_admin');
    support = await staff('help@embodha.test', 'support');
    finance = await staff('books@embodha.test', 'finance');
  });
  afterAll(async () => {
    for (const key of Object.keys(env)) if (!(key in ORIGINAL)) delete env[key];
    Object.assign(env, ORIGINAL);
    await t.close();
    await new Promise((resolve) => site.close(resolve));
  });

  it('starts out saying, in words, what stands between here and launch', async () => {
    const list = await load();
    expect(list.ready).toBe(false);
    expect(list.sections.map((s) => s.key)).toEqual(['catalogue', 'website', 'apps', 'money', 'media', 'links', 'bars', 'signoffs']);

    expect(check(list, 'free_course')).toMatchObject({ status: 'done', detail: 'morning-breath is free for everyone.' });
    expect(check(list, 'categories')).toMatchObject({ status: 'done', detail: 'All 1 categories on show have courses on sale: Yoga 1.' });
    expect(check(list, 'chapters_play')).toMatchObject({ status: 'todo', detail: "Members would hit chapters that won't play. Still processing, or failed: gentle-spine (1)." });
    expect(check(list, 'razorpay_keys')).toMatchObject({ status: 'todo', detail: expect.stringContaining('test-mode keys') });
    expect(check(list, 'razorpay_webhook').status).toBe('todo');
    expect(check(list, 'apple_keys').status).toBe('todo');
    expect(check(list, 'apple_notifications').action).toBeUndefined(); // nothing to ask Apple with yet
    expect(check(list, 'store_products')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/^0 of 4 live\. Not yet: gentle-spine on the App Store \(no product\)/) });
    expect(check(list, 'seller')).toMatchObject({ status: 'todo', detail: expect.stringContaining('missing the address and the GSTIN.') });
    expect(check(list, 'review_account').status).toBe('done');
    expect(check(list, 'email')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/^Mail goes to the console/) });
    expect(check(list, 'site_pages')).toMatchObject({ status: 'todo', detail: expect.stringContaining('/privacy/ answered 502') });
    expect(check(list, 'link_files').detail).toMatch(/phones only open https links/);
    expect(check(list, 'bar_crash_free')).toMatchObject({ status: 'waiting', detail: '0 sessions on iOS and Android so far; it calls it at 100.' });
    expect(check(list, 'bar_switch_off')).toMatchObject({ status: 'waiting', detail: expect.stringMatching(/^No teacher has switched a subscription off yet\./) });
    expect(check(list, 'bar_money')).toMatchObject({ status: 'waiting', detail: expect.stringMatching(/^No payments in the last 14 days\./) });
    expect(check(list, 'finance_inbox')).toMatchObject({ status: 'todo', blocking: false });
    expect(list.sections.find((s) => s.key === 'signoffs')!.checks.every((c) => c.status === 'todo' && c.signoff === null)).toBe(true);
    expect(list.left).toBe(list.sections.flatMap((s) => s.checks).filter((c) => c.blocking && c.status !== 'done').length);
  });

  it('goes green as each thing is put right, and says ready once the bars are met and everything is signed off', async () => {
    const launch = t.app.get(LaunchService);
    const money = t.app.get(PaymentsService);
    mode = 'up';

    // The catalogue: the last chapter finished processing.
    await t.db.update(mediaAssets).set({ status: 'ready' }).where(eq(mediaAssets.status, 'processing'));
    // Live keys, a real mail domain, and the stores' keys.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    Object.assign(env, {
      RAZORPAY_KEY_ID: 'rzp_live_key',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.net',
      MAIL_FROM: 'Embodha <hello@embodha.in>',
      APPLE_ISSUER_ID: 'issuer',
      APPLE_KEY_ID: 'KEY123',
      APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      GOOGLE_PLAY_SERVICE_ACCOUNT: '{"client_email":"play@embodha.iam.gserviceaccount.com","private_key":"x"}',
      FINANCE_EMAIL: 'accounts@embodha.test',
      FEEDBACK_EMAIL: 'beta@embodha.test',
    });
    jest.spyOn(launch, 'txt').mockImplementation(async (name) => (name === 'embodha.in' ? ['v=spf1 include:_spf.example.net ~all', 'google-site-verification=x'] : name === '_dmarc.embodha.in' ? ['v=DMARC1; p=quarantine'] : []));

    // Each channel's webhook, through the real endpoints.
    const razorpayBody = JSON.stringify({ event: 'order.paid', payload: {} });
    await t.http()
      .post('/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', createHmac('sha256', 'rzp-hook-secret').update(razorpayBody).digest('hex'))
      .send(razorpayBody)
      .expect(200);
    const jws = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: jws({ notificationType: 'TEST', data: { bundleId: 'com.embodha.app', environment: 'Sandbox' } }) }).expect(200);
    const sandboxOnly = check(await load(), 'apple_notifications');
    expect(sandboxOnly).toMatchObject({ status: 'todo', action: 'apple_test', detail: expect.stringContaining('The sandbox one got through') });
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: jws({ notificationType: 'TEST', data: { bundleId: 'com.embodha.app', environment: 'Production' } }) }).expect(200);
    await t.http()
      .post('/v1/webhooks/google?secret=play-hook-secret-0123')
      .send({ message: { data: Buffer.from(JSON.stringify({ packageName: 'com.embodha.app', testNotification: { version: '1.0' } })).toString('base64') } })
      .expect(200);
    await t.http().post('/v1/webhooks/video?secret=hook-secret').send({ Status: 3 }).expect(200);
    // A stranger without the secret is not "heard".
    await t.http().post('/v1/webhooks/google?secret=wrong').send({}).expect(401);

    // Products live in both stores, and a test purchase from each.
    for (const store of ['apple', 'google'] as const) {
      await t.db.insert(storeProducts).values([
        { ownerType: 'course', ownerId: f.paid.id, store, productId: 'course.gentle_spine', status: 'live' },
        { ownerType: 'instructor_plan', ownerId: f.asha.id, store, productId: 'plan.asha_rao', status: 'live' },
      ]);
    }
    const [buyer] = await t.db.insert(users).values({ email: 'tester@embodha.test', name: 'Tester', country: 'IN', state: '29' }).returning();
    for (const channel of ['apple', 'google'] as const) {
      await money.book({
        charge: { channel, externalId: `${channel}-test-1`, currency: 'INR', grossMinor: 99_900, feeRateBps: 1500, feeBase: 'after_gst', test: true, productId: 'course.gentle_spine' },
        userId: buyer.id,
        instructorId: f.asha.id,
        courseId: f.paid.id,
      });
    }

    // Money settings.
    await t.http()
      .put('/v1/admin/money-settings')
      .set(bearer(finance))
      .send({ seller: { name: 'Embodha Wellness Pvt Ltd', address: 'Indiranagar, Bengaluru', gstin: '29ABCDE1234F1ZW', sac: '999293' }, noteAbroad: 'Supply meant for export under LUT ARN AD290426000123X without payment of IGST.' })
      .expect(200);

    let list = await load();
    for (const key of ['chapters_play', 'razorpay_keys', 'razorpay_webhook', 'apple_keys', 'apple_notifications', 'google_keys', 'google_notifications', 'store_products', 'test_purchases', 'seller', 'lut', 'finance_inbox', 'bunny_video', 'bunny_webhook', 'bunny_audio', 'email', 'feedback_inbox', 'site_pages', 'refund_window']) {
      expect([key, check(list, key).status]).toEqual([key, 'done']);
    }
    expect(check(list, 'razorpay_webhook').detail).toMatch(/: order\.paid\. 1 webhook so far\.$/);
    expect(check(list, 'apple_notifications').detail).toMatch(/production server came in .*: TEST\.$/);
    expect(check(list, 'store_products').detail).toBe('All 4 products are live: 1 course and 1 subscription, in both stores.');
    expect(check(list, 'email').detail).toMatch(/^Codes go out over SMTP from hello@embodha\.in, and embodha\.in has SPF and DMARC records\./);
    expect(check(list, 'site_pages').detail).toContain(`All 8 pages answer at ${base}`);
    expect(check(list, 'refund_window').detail).toBe('The refunds page promises 7 days, the same as the refund window in Money settings.');
    // The link files are right, but the web app is on http: phones won't open the link in the app.
    expect(check(list, 'link_files')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/^WEB_URL is http:\/\/127\.0\.0\.1:\d+, and phones only open https links in an app\./) });

    // On https, with both files right, it's done.
    env.WEB_URL = 'https://app.embodha.test';
    const realFetch = global.fetch;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://app.embodha.test/')) return realFetch(url.replace('https://app.embodha.test', base), init);
      return realFetch(input, init);
    });
    list = await load();
    expect(check(list, 'link_files')).toMatchObject({ status: 'done', detail: 'https://app.embodha.test vouches for the app (com.embodha.app), so the sign-in email opens it on iPhone and Android.' });

    // The person-only gates, signed off by the owner.
    for (const item of list.sections.find((s) => s.key === 'signoffs')!.checks) {
      await t.http().post(`/v1/admin/launch/signoffs/${item.key}`).set(bearer(owner)).send({ note: item.key === 'lawyer' ? 'Read by Mehta & Associates, 14 Oct' : undefined }).expect(200);
    }
    list = await load();
    expect(check(list, 'lawyer')).toMatchObject({ status: 'done', signoff: { by: expect.stringContaining('owner'), note: 'Read by Mehta & Associates, 14 Oct', at: expect.any(String) } });
    // Everything but the four bars, which need two weeks of beta.
    expect(list.left).toBe(4);
    expect(list.ready).toBe(false);

    // With the bars met, it's ready.
    const beta = t.app.get(BetaHealthService);
    const real = await beta.report(14);
    jest.spyOn(beta, 'report').mockResolvedValue({
      ...real,
      bars: {
        crashFree: { ...real.bars.crashFree, sessions: 1200, crashes: 2, valueBps: 9983, enough: true, met: true },
        videoStart: { ...real.bars.videoStart, starts: 140, p90Ms: 1640, enough: true, met: true },
        switchOff: { switchOffs: 1, renewalsTested: 3, chargedAfter: 0, enough: true, met: true },
        reconciliation: { ...real.bars.reconciliation, due: 40, reconciled: 40, met: true, enough: true, currencies: ['INR', 'USD'] },
      },
      switchOffs: [{ instructor: 'Asha Rao', offAt: new Date().toISOString(), onAgainAt: null, renewalsDue: { website: 1, appStore: 1, googlePlay: 1 }, chargedAfter: { website: 0, appStore: 0, googlePlay: 0 }, testCharges: 2 }],
      video: {
        ...real.video,
        byPlace: [
          { place: 'Karnataka', starts: 40, p50Ms: 800, p90Ms: 1500 },
          { place: 'Maharashtra', starts: 22, p50Ms: 850, p90Ms: 1700 },
          { place: 'Assam', starts: 9, p50Ms: 1200, p90Ms: 1950 },
          { place: 'Outside India', starts: 6, p50Ms: 900, p90Ms: 1600 },
        ],
      },
    } as Awaited<ReturnType<BetaHealthService['report']>>);
    list = await load();
    expect(check(list, 'bar_video')).toMatchObject({ status: 'done', detail: '9 in 10 starts on 4G within 1.6 s, from 140 starts; within 2 s in Karnataka, Maharashtra and Assam; and tested from outside India.' });
    expect(check(list, 'bar_switch_off').detail).toBe('Renewals fell due after a switch-off on all three channels, 3 in all, and nobody was charged.');
    expect(list).toMatchObject({ ready: true, left: 0 });

    // A sign-off taken back makes it not ready again, and the log says who did both.
    await t.http().delete('/v1/admin/launch/signoffs/pen_test').set(bearer(owner)).expect(200);
    expect((await load()).ready).toBe(false);
    await t.http().delete('/v1/admin/launch/signoffs/pen_test').set(bearer(owner)).expect(404);
    fetchSpy.mockRestore();
    env.WEB_URL = base;
  });

  it('notices when the website and the books disagree, and when a link file redirects or is caught by the fallback', async () => {
    await t.db.insert(settings).values({ key: 'refund_window_days', value: 10 }).onConflictDoUpdate({ target: settings.key, set: { value: 10 } });
    mode = 'redirecting';
    const list = await load();
    expect(check(list, 'refund_window')).toMatchObject({
      status: 'todo',
      detail: "The refunds page promises 7 days, but the refund window in Money settings is 10. Change refundWindowDays in the site's config, or the setting, so they agree.",
    });
    expect(check(list, 'link_files').detail).toContain("/.well-known/apple-app-site-association redirects, and Apple won't follow it");
    // A single-page app's fallback answering for the files.
    mode = 'spa';
    expect(check(await load(), 'link_files').detail).toContain("answers with a web page, not the file: the web app's fallback is catching it; /.well-known/assetlinks.json answers with a web page too.");
    mode = 'up';
  });

  it('asks Apple for a test notification, and says so until one arrives', async () => {
    const apple = t.app.get(AppleStoreClient);
    const asked = jest.spyOn(apple, 'requestTestNotification').mockResolvedValue({ testNotificationToken: 'token-1' });
    await t.http().post('/v1/admin/launch/apple-test').set(bearer(support)).expect(403);
    const result = (await t.http().post('/v1/admin/launch/apple-test').set(bearer(finance)).expect(200)).body;
    expect(result.results).toEqual([
      { environment: 'Production', asked: true },
      { environment: 'Sandbox', asked: true },
    ]);
    expect(asked).toHaveBeenCalledTimes(2);
    // The production notification heard earlier came before the ask, so it doesn't count.
    expect(check(await load(), 'apple_notifications')).toMatchObject({ status: 'todo', detail: expect.stringContaining('Apple was asked for a test on') });
    const jws = `e30.${Buffer.from(JSON.stringify({ notificationType: 'TEST', data: { bundleId: 'com.embodha.app', environment: 'Production' } })).toString('base64url')}.sig`;
    await t.http().post('/v1/webhooks/apple').send({ signedPayload: jws }).expect(200);
    expect(check(await load(), 'apple_notifications').status).toBe('done');
  });

  it("is every staff role's to read, the owner's to sign off, and nobody else's", async () => {
    const member = (await signIn(t, 'member@embodha.test')).accessToken;
    await t.http().get('/v1/admin/launch').set(bearer(member)).expect(403);
    await load(support, false);
    await t.http().post('/v1/admin/launch/signoffs/lawyer').set(bearer(support)).send({}).expect(403);
    await t.http().post('/v1/admin/launch/signoffs/lawyer').set(bearer(finance)).send({}).expect(403);
    await t.http().post('/v1/admin/launch/signoffs/moon_landing').set(bearer(owner)).send({}).expect(404);
    await t.http().post('/v1/admin/launch/signoffs/lawyer').set(bearer(owner)).send({ note: 'x'.repeat(501) }).expect(400);
    // An unpublished chapter's media doesn't matter; a published course's missing video does.
    await t.db.update(chapters).set({ mediaAssetId: null }).where(eq(chapters.id, f.locked.id));
    expect(check(await load(), 'chapters_play').detail).toContain('With no video or audio: gentle-spine (1).');
  });
});
