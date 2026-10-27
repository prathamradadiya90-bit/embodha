import { Inject, Injectable, Logger } from '@nestjs/common';
import { safeEqual } from '../common/crypto';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import { parseServiceAccount, type Env } from '../config/env';
import { readPrivateKey, signJwt } from './jwt';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
/** Which list of Play regions prices are given for. Newer versions add regions; this one is what Play's samples use. */
const REGIONS_VERSION = '2022/02';

/** Google's money: whole units as a string, and billionths. */
export interface Money {
  currencyCode: string;
  units?: string;
  nanos?: number;
}

/** Minor units (paise, cents) as Google's money. */
export const money = (currencyCode: string, minor: number): Money => ({
  currencyCode,
  units: String(Math.trunc(minor / 100)),
  nanos: (minor % 100) * 10_000_000,
});

/** A one-time product purchase (purchases.products.get). */
export interface PlayProductPurchase {
  orderId?: string;
  /** 0 purchased, 1 cancelled, 2 pending (cash or a bank transfer that hasn't cleared). */
  purchaseState: 0 | 1 | 2;
  /** 0 for a licence tester's test purchase. Absent on a real sale. */
  purchaseType?: 0 | 1 | 2;
  acknowledgementState: 0 | 1;
  /** The member's Embodha ID. The app sets it on every purchase. */
  obfuscatedExternalAccountId?: string;
  /** Two letters: IN, US, GB. */
  regionCode?: string;
  purchaseTimeMillis?: string;
}

export type PlaySubscriptionState =
  | 'SUBSCRIPTION_STATE_UNSPECIFIED'
  | 'SUBSCRIPTION_STATE_PENDING'
  | 'SUBSCRIPTION_STATE_ACTIVE'
  | 'SUBSCRIPTION_STATE_PAUSED'
  | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
  | 'SUBSCRIPTION_STATE_ON_HOLD'
  | 'SUBSCRIPTION_STATE_CANCELED'
  | 'SUBSCRIPTION_STATE_EXPIRED'
  | 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';

/** A subscription (purchases.subscriptionsv2.get). Embodha's have one line item: one instructor, one base plan. */
export interface PlaySubscription {
  subscriptionState: PlaySubscriptionState;
  regionCode?: string;
  lineItems?: {
    productId: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: { currencyCode: string; units?: string; nanos?: number } };
  }[];
  linkedPurchaseToken?: string;
  /** Present, and empty, only on a licence tester's purchase. */
  testPurchase?: object;
  acknowledgementState?: 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED' | 'ACKNOWLEDGEMENT_STATE_PENDING' | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

/**
 * The Google Play Developer API calls Embodha needs, signed in as a service account. Play refunds any purchase
 * that isn't acknowledged within three days, so the server acknowledges as soon as it has recorded one.
 */
@Injectable()
export class GooglePlayClient {
  private readonly logger = new Logger('GooglePlay');
  private cached: { token: string; until: number } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get ready() {
    return Boolean(this.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  }

  product(productId: string, purchaseToken: string) {
    return this.call<PlayProductPurchase>('GET', `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`);
  }

  acknowledgeProduct(productId: string, purchaseToken: string) {
    return this.call('POST', `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
  }

  subscription(purchaseToken: string) {
    return this.call<PlaySubscription>('GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  }

  /** Stops the next payment for good (the teacher switched their subscription off). Access runs to the end of the paid month. */
  cancelSubscription(purchaseToken: string) {
    return this.call('POST', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}:cancel`, {
      cancellationContext: { cancellationType: 'DEVELOPER_REQUESTED_STOP_PAYMENTS' },
    });
  }

  /** Acknowledging still lives on the older subscriptions resource. */
  acknowledgeSubscription(productId: string, purchaseToken: string) {
    return this.call('POST', `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
  }

  /* ------------------------------------------------------------ Products (store-sync) */

  /** Play's prices for every region from one dollar price, the way Play Console fills them in. */
  async convertPrices(usd: Money) {
    const out = await this.manage<{ convertedRegionPrices?: Record<string, { regionCode: string; price: Money }>; convertedOtherRegionsPrice?: { usdPrice: Money; eurPrice: Money } }>(
      'POST',
      '/pricing:convertRegionPrices',
      { price: usd },
    );
    return { regions: Object.values(out?.convertedRegionPrices ?? {}), other: out?.convertedOtherRegionsPrice ?? { usdPrice: usd, eurPrice: usd } };
  }

  /** Creates or updates a course's one-time product, with one purchase option ("buy") priced in every region. */
  saveOneTimeProduct(product: { productId: string; title: string; description: string; prices: { regionCode: string; price: Money }[]; other: { usdPrice: Money; eurPrice: Money } }) {
    const id = encodeURIComponent(product.productId);
    return this.manage('PATCH', `/onetimeproducts/${id}?allowMissing=true&updateMask=listings,purchaseOptions&regionsVersion.version=${REGIONS_VERSION}`, {
      packageName: this.packageName,
      productId: product.productId,
      listings: [{ languageCode: 'en-US', title: product.title, description: product.description }],
      purchaseOptions: [
        {
          purchaseOptionId: 'buy',
          buyOption: { legacyCompatible: true },
          regionalPricingAndAvailabilityConfigs: product.prices.map((p) => ({ regionCode: p.regionCode, price: p.price, availability: 'AVAILABLE' })),
          newRegionsConfig: { ...product.other, availability: 'AVAILABLE' },
        },
      ],
    });
  }

  /** New purchase options start as drafts; this puts one on sale, or takes it off. */
  setPurchaseOptionOnSale(productId: string, onSale: boolean) {
    const request = { packageName: this.packageName, productId, purchaseOptionId: 'buy' };
    return this.manage('POST', `/oneTimeProducts/${encodeURIComponent(productId)}/purchaseOptions:batchUpdateStates`, {
      requests: [onSale ? { activatePurchaseOptionRequest: request } : { deactivatePurchaseOptionRequest: request }],
    });
  }

  /** A teacher's subscription, or null if Play hasn't got it yet. */
  subscriptionProduct(productId: string) {
    return this.manage<{ productId: string }>('GET', `/subscriptions/${encodeURIComponent(productId)}`, undefined, true);
  }

  /** Creates the teacher's subscription with one monthly base plan, or gives the base plan new prices (for new subscribers). */
  saveSubscriptionProduct(
    sub: { productId: string; title: string; description: string; prices: { regionCode: string; price: Money }[]; other: { usdPrice: Money; eurPrice: Money } },
    exists: boolean,
  ) {
    const body = {
      packageName: this.packageName,
      productId: sub.productId,
      listings: [{ languageCode: 'en-US', title: sub.title, description: sub.description }],
      basePlans: [
        {
          basePlanId: 'monthly',
          autoRenewingBasePlanType: { billingPeriodDuration: 'P1M', legacyCompatible: true },
          regionalConfigs: sub.prices.map((p) => ({ regionCode: p.regionCode, newSubscriberAvailability: true, price: p.price })),
          otherRegionsConfig: { ...sub.other, newSubscriberAvailability: true },
        },
      ],
    };
    const id = encodeURIComponent(sub.productId);
    return exists
      ? this.manage('PATCH', `/subscriptions/${id}?updateMask=listings,basePlans&regionsVersion.version=${REGIONS_VERSION}`, body)
      : this.manage('POST', `/subscriptions?productId=${id}&regionsVersion.version=${REGIONS_VERSION}`, body);
  }

  /** Base plans start as drafts. Deactivating stops new subscriptions; current ones are stopped separately. */
  setBasePlanOnSale(productId: string, onSale: boolean) {
    return this.manage('POST', `/subscriptions/${encodeURIComponent(productId)}/basePlans/monthly:${onSale ? 'activate' : 'deactivate'}`, {});
  }

  /** Product management answers with Google's own error message, which says what to fix. */
  private async manage<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, nullIfMissing = false): Promise<T | null> {
    const res = await fetch(`${API}/${encodeURIComponent(this.packageName)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && nullIfMissing) return null;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { error?: { message?: string } }) : {};
    if (res.status === 401) this.cached = null;
    if (!res.ok) {
      const detail = data.error?.message ?? String(res.status);
      this.logger.warn(`${method} ${path.split('?')[0]}: ${res.status} ${detail.slice(0, 300)}`);
      throw fail(502, 'google_play_error', `Google Play said: ${detail.slice(0, 280)}`);
    }
    return data as T;
  }

  /** The Pub/Sub push URL carries a secret, so strangers can't post notifications. (We re-check each one with Play anyway.) */
  notificationSecretValid(secret: string | undefined) {
    return Boolean(this.env.GOOGLE_PLAY_RTDN_SECRET && secret && safeEqual(secret, this.env.GOOGLE_PLAY_RTDN_SECRET));
  }

  get packageName() {
    return this.env.GOOGLE_PLAY_PACKAGE_NAME;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}/${encodeURIComponent(this.packageName)}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) this.cached = null;
    // Play answers a token it doesn't know with 400 or 404, and one that's long gone with 410.
    if ([400, 404, 410].includes(res.status)) throw fail(404, 'unknown_purchase', "Google Play doesn't know that purchase.");
    if (!res.ok) {
      // 401 or 403 usually means the service account hasn't been given access in Play Console yet.
      this.logger.warn(`${method} ${path}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      throw fail(502, 'google_play_error', `Google Play said ${res.status}. Try again in a moment.`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** A service account trades a signed JWT for an hour-long access token. */
  private async accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.until > now + 60) return this.cached.token;
    const account = this.ready ? parseServiceAccount(this.env.GOOGLE_PLAY_SERVICE_ACCOUNT) : null;
    if (!account) throw fail(503, 'store_not_configured', 'Google Play purchases are not switched on for this server yet.');
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const assertion = signJwt('RS256', readPrivateKey(account.private_key), { iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 });
    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !data.access_token) throw fail(502, 'google_play_error', `Google sign-in failed: ${data.error_description ?? res.status}`);
    this.cached = { token: data.access_token, until: now + (data.expires_in ?? 3600) };
    return data.access_token;
  }
}
