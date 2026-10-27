/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { loadEnv } from '../config/env';
import { AppleStoreClient } from './apple-store.client';
import { AppStoreConnectClient } from './app-store-connect.client';
import { GooglePlayClient } from './google-play.client';
import { readJws, readPrivateKey, signJwt } from './jwt';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const env = loadEnv({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-jwt-secret-long-enough-for-the-check',
  CODE_SECRET: 'test-code-secret-long-enough-for-the-check',
  APPLE_ISSUER_ID: '57246542-96fe-1a63-e053-0824d011072a',
  APPLE_KEY_ID: '2X9R4HXF34',
  APPLE_PRIVATE_KEY: ecPem.replace(/\n/g, '\\n'), // the way hosting dashboards store it
  APPLE_CONNECT_KEY_ID: 'TEAMKEY123',
  APPLE_CONNECT_PRIVATE_KEY: ecPem,
  APPLE_APP_ID: '6740000000',
  GOOGLE_PLAY_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ client_email: 'billing@embodha.iam.gserviceaccount.com', private_key: rsaPem })).toString('base64'),
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const parts = (jwt: string) => jwt.split('.').map((part, i) => (i < 2 ? JSON.parse(Buffer.from(part, 'base64url').toString()) : Buffer.from(part, 'base64url')));

afterEach(() => jest.restoreAllMocks());

describe('JWTs for the stores', () => {
  it('signs ES256 the way Apple checks it: raw r||s, with the key ID in the header', () => {
    const jwt = signJwt('ES256', readPrivateKey(ecPem), { iss: 'issuer' }, { kid: 'KEY123' });
    const [header, payload, signature] = parts(jwt);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY123' });
    expect(payload).toEqual({ iss: 'issuer' });
    expect(signature).toHaveLength(64);
    const data = Buffer.from(jwt.split('.').slice(0, 2).join('.'));
    expect(verify('sha256', data, { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
  });

  it('signs RS256 for Google, and reads keys pasted with \\n or as base64', () => {
    const jwt = signJwt('RS256', readPrivateKey(Buffer.from(rsaPem).toString('base64')), { iss: 'me' });
    const data = Buffer.from(jwt.split('.').slice(0, 2).join('.'));
    expect(verify('sha256', data, rsa.publicKey, parts(jwt)[2] as Buffer)).toBe(true);
    expect(() => readPrivateKey(ecPem.replace(/\n/g, '\\n'))).not.toThrow();
  });

  it('reads a JWS payload and refuses anything else', () => {
    expect(readJws(signJwt('ES256', readPrivateKey(ecPem), { transactionId: '1' }))).toEqual({ transactionId: '1' });
    expect(() => readJws('nope')).toThrow();
    expect(() => readJws('a.%%%.c')).toThrow();
    expect(() => readJws(undefined)).toThrow();
  });
});

describe('AppleStoreClient', () => {
  it('looks in production, then the sandbox, with a token Apple will accept', async () => {
    const seen: string[] = [];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      seen.push(String(url));
      const token = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      expect(parts(token)[1]).toMatchObject({ iss: env.APPLE_ISSUER_ID, aud: 'appstoreconnect-v1', bid: 'com.embodha.app' });
      expect(parts(token)[0]).toMatchObject({ alg: 'ES256', kid: '2X9R4HXF34' });
      return String(url).includes('sandbox')
        ? json(200, { signedTransactionInfo: signJwt('ES256', ec.privateKey, { transactionId: '2000000101', productId: 'course.x' }) })
        : json(404, { errorCode: 4040010, errorMessage: 'Transaction id not found.' });
    });
    const found = await new AppleStoreClient(env).transaction('2000000101');
    expect(found).toEqual({ environment: 'Sandbox', transaction: { transactionId: '2000000101', productId: 'course.x' } });
    expect(seen).toEqual([
      'https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000101',
      'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/2000000101',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('picks the right subscription out of everything the customer has', async () => {
    const tx = (id: string) => signJwt('ES256', ec.privateKey, { transactionId: `${id}9`, originalTransactionId: id });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      json(200, {
        data: [
          { lastTransactions: [{ originalTransactionId: '111', status: 1, signedTransactionInfo: tx('111') }] },
          { lastTransactions: [{ originalTransactionId: '222', status: 4, signedTransactionInfo: tx('222'), signedRenewalInfo: signJwt('ES256', ec.privateKey, { autoRenewStatus: 1 }) }] },
        ],
      }),
    );
    const found = await new AppleStoreClient(env).subscription('222', 'Production');
    expect(found).toEqual({ status: 4, transaction: { transactionId: '2229', originalTransactionId: '222' }, renewal: { autoRenewStatus: 1 } });
  });

  it('says so plainly when the keys are missing', async () => {
    const client = new AppleStoreClient(loadEnv({ NODE_ENV: 'test', JWT_SECRET: env.JWT_SECRET, CODE_SECRET: env.CODE_SECRET }));
    await expect(client.transaction('1')).rejects.toMatchObject({ status: 503 });
  });
});

describe('GooglePlayClient', () => {
  it('signs in as the service account once, then asks Play about purchases', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.token', expires_in: 3599 });
      return json(200, { purchaseState: 0, acknowledgementState: 0, orderId: 'GPA.1' });
    });
    const client = new GooglePlayClient(env);
    expect(await client.product('course.x', 'tok-1')).toMatchObject({ orderId: 'GPA.1' });
    await client.subscription('tok-2');

    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.embodha.app/purchases/products/course.x/tokens/tok-1',
      'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.embodha.app/purchases/subscriptionsv2/tokens/tok-2',
    ]);
    const form = new URLSearchParams(String(calls[0].init!.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    expect(parts(assertion)[1]).toMatchObject({ iss: 'billing@embodha.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token' });
    expect(verify('sha256', Buffer.from(assertion.split('.').slice(0, 2).join('.')), rsa.publicKey, parts(assertion)[2] as Buffer)).toBe(true);
    expect((calls[1].init!.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
  });

  it('stops a subscription for good when the teacher switches theirs off', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).includes('oauth2') ? json(200, { access_token: 't' }) : new Response('', { status: 200 });
    });
    await new GooglePlayClient(env).cancelSubscription('tok-9');
    expect(calls[1].url).toBe('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.embodha.app/purchases/subscriptionsv2/tokens/tok-9:cancel');
    expect(calls[1].init!.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ cancellationContext: { cancellationType: 'DEVELOPER_REQUESTED_STOP_PAYMENTS' } });
  });

  it('treats a token Play has never heard of as unknown, not as a server error', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => (String(url).includes('oauth2') ? json(200, { access_token: 't' }) : json(410, { error: { message: 'gone' } })));
    await expect(new GooglePlayClient(env).product('course.x', 'old')).rejects.toMatchObject({ status: 404 });
  });

  it('checks the notification secret', () => {
    const client = new GooglePlayClient({ ...env, GOOGLE_PLAY_RTDN_SECRET: 'a-long-enough-secret' });
    expect(client.notificationSecretValid('a-long-enough-secret')).toBe(true);
    expect(client.notificationSecretValid('wrong')).toBe(false);
    expect(client.notificationSecretValid(undefined)).toBe(false);
    expect(new GooglePlayClient(env).notificationSecretValid('')).toBe(false);
  });
});

describe('AppStoreConnectClient', () => {
  const point = (id: string, customerPrice: string) => ({ id, type: 'inAppPurchasePricePoints', attributes: { customerPrice } });
  type Sent = { url: string; method: string; body: Record<string, any> | null; auth: string };
  const record = (answer: (url: string, method: string) => Response) => {
    const sent: Sent[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, auth: headers.authorization ?? '' });
      return answer(String(url), init?.method ?? 'GET');
    });
    return sent;
  };

  it('signs in with the team key (no bundle ID, 15 minutes) and prices a course at the nearest price points', async () => {
    const sent = record((url) =>
      url.includes('territory]=USA') ? json(200, { data: [point('u1', '11.99'), point('u2', '12.99')] }) : url.includes('territory]=IND') ? json(200, { data: [point('i1', '999.0'), point('i2', '1099.0')] }) : json(201, { data: { id: 's', type: 'inAppPurchasePriceSchedules' } }),
    );
    await new AppStoreConnectClient(env).priceInAppPurchase('iap-1', { inr: 999, usd: 12 });
    const [header, claims] = parts(sent[0].auth.replace('Bearer ', '')) as Record<string, unknown>[];
    expect(header).toMatchObject({ alg: 'ES256', kid: 'TEAMKEY123' });
    expect(claims).toMatchObject({ iss: env.APPLE_ISSUER_ID, aud: 'appstoreconnect-v1' });
    expect(claims.bid).toBeUndefined();
    expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    const schedule = sent.find((s) => s.method === 'POST')!;
    expect(schedule.url).toBe('https://api.appstoreconnect.apple.com/v1/inAppPurchasePriceSchedules');
    expect(schedule.body!.data.relationships.baseTerritory.data.id).toBe('USA');
    expect(schedule.body!.included.map((i: any) => i.relationships.inAppPurchasePricePoint.data.id)).toEqual(['u1', 'i1']);
  });

  it('prices a subscription in every territory from Apple’s equivalents of the dollar price', async () => {
    const sent = record((url) => {
      if (url.includes('territory]=USA')) return json(200, { data: [point('u6', '5.99'), point('u7', '6.99')] });
      if (url.includes('territory]=IND')) return json(200, { data: [point('i4', '499.0')] });
      if (url.includes('/equalizations')) return json(200, { data: ['GBR', 'DEU'].map((t) => ({ id: `eq-${t}`, type: 'subscriptionPricePoints', relationships: { territory: { data: { type: 'territories', id: t } } } })) });
      return json(201, { data: { id: 'p', type: 'subscriptionPrices' } });
    });
    expect(await new AppStoreConnectClient(env).priceSubscription('sub-1', { inr: 499, usd: 6 }, true)).toBe(4);
    const prices = sent.filter((s) => s.method === 'POST').map((s) => [s.body!.data.relationships.territory.data.id, s.body!.data.relationships.subscriptionPricePoint.data.id, s.body!.data.attributes.preserveCurrentPrice]);
    expect(prices).toEqual([
      ['GBR', 'eq-GBR', true],
      ['DEU', 'eq-DEU', true],
      ['USA', 'u6', true],
      ['IND', 'i4', true],
    ]);
  });

  it('uploads the review screenshot in the pieces Apple asks for, then confirms it with a checksum', async () => {
    const png = Buffer.from('not really a png, but bytes all the same');
    const sent = record((url, method) =>
      method === 'POST'
        ? json(201, { data: { id: 'shot-1', type: 'inAppPurchaseAppStoreReviewScreenshots', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/1', offset: 0, length: 10, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }, { method: 'PUT', url: 'https://upload.example/2', offset: 10, length: png.length - 10 }] } } })
        : json(200, {}),
    );
    await new AppStoreConnectClient(env).uploadReviewScreenshot('inAppPurchase', 'iap-1', png);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST https://api.appstoreconnect.apple.com/v1/inAppPurchaseAppStoreReviewScreenshots',
      'PUT https://upload.example/1',
      'PUT https://upload.example/2',
      'PATCH https://api.appstoreconnect.apple.com/v1/inAppPurchaseAppStoreReviewScreenshots/shot-1',
    ]);
    expect(sent[0].body!.data).toMatchObject({ attributes: { fileSize: png.length }, relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: 'iap-1' } } } });
    expect(sent[3].body!.data.attributes).toEqual({ uploaded: true, sourceFileChecksum: createHash('md5').update(png).digest('hex') });
  });
});

describe('GooglePlayClient, making products', () => {
  it('saves a course as a one-time product with one priced purchase option, then puts it on sale', async () => {
    const sent: { url: string; method?: string; body: any }[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('oauth2')) return json(200, { access_token: 't' });
      sent.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      return json(200, {});
    });
    const client = new GooglePlayClient(env);
    const usd = { currencyCode: 'USD', units: '12', nanos: 0 };
    await client.saveOneTimeProduct({ productId: 'course.x', title: 'X', description: 'Every chapter', prices: [{ regionCode: 'US', price: usd }], other: { usdPrice: usd, eurPrice: { currencyCode: 'EUR', units: '11' } } });
    await client.setPurchaseOptionOnSale('course.x', true);
    const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.embodha.app';
    expect(sent[0].url).toBe(`${base}/onetimeproducts/course.x?allowMissing=true&updateMask=listings,purchaseOptions&regionsVersion.version=2022/02`);
    expect(sent[0].method).toBe('PATCH');
    expect(sent[0].body.purchaseOptions[0]).toMatchObject({ purchaseOptionId: 'buy', buyOption: { legacyCompatible: true }, regionalPricingAndAvailabilityConfigs: [{ regionCode: 'US', price: usd, availability: 'AVAILABLE' }] });
    expect(sent[1].url).toBe(`${base}/oneTimeProducts/course.x/purchaseOptions:batchUpdateStates`);
    expect(sent[1].body).toEqual({ requests: [{ activatePurchaseOptionRequest: { packageName: 'com.embodha.app', productId: 'course.x', purchaseOptionId: 'buy' } }] });
  });
});
