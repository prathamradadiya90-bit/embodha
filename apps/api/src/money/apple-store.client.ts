import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { readJws, readPrivateKey, signJwt } from './jwt';

const HOSTS = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
} as const;

export type AppleEnvironment = keyof typeof HOSTS;

/** The parts of Apple's JWSTransactionDecodedPayload that Embodha reads. Dates are milliseconds since 1970. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: 'Auto-Renewable Subscription' | 'Non-Consumable' | 'Consumable' | 'Non-Renewing Subscription';
  purchaseDate: number;
  expiresDate?: number;
  /** The member's Embodha ID. The app sets it on every purchase. */
  appAccountToken?: string;
  inAppOwnershipType?: 'PURCHASED' | 'FAMILY_SHARED';
  revocationDate?: number;
  environment: AppleEnvironment | 'Xcode';
  /** Three letters: IND, USA, GBR. */
  storefront?: string;
  /** In thousandths: 999000 is ₹999.00. */
  price?: number;
  currency?: string;
}

export interface AppleRenewalInfo {
  originalTransactionId: string;
  autoRenewStatus: 0 | 1;
  gracePeriodExpiresDate?: number;
}

/** Apple's subscription status codes: 1 active, 2 expired, 3 billing retry, 4 grace period, 5 refunded or revoked. */
export type AppleSubscriptionStatus = 1 | 2 | 3 | 4 | 5;

interface StatusResponse {
  data?: { lastTransactions: { originalTransactionId: string; status: AppleSubscriptionStatus; signedTransactionInfo: string; signedRenewalInfo?: string }[] }[];
}

/**
 * The two App Store Server API calls Embodha needs. Apple signs what it returns, and we only ever read what we
 * fetched ourselves over Apple's authenticated API, so a pushed notification is never trusted on its own word.
 */
@Injectable()
export class AppleStoreClient {
  private readonly logger = new Logger('AppStore');
  private key: KeyObject | null = null;
  private cached: { token: string; until: number } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get ready() {
    return Boolean(this.env.APPLE_ISSUER_ID && this.env.APPLE_KEY_ID && this.env.APPLE_PRIVATE_KEY);
  }

  get bundleId() {
    return this.env.APPLE_BUNDLE_ID;
  }

  /** Production first, then the sandbox, which is where TestFlight and App Review purchases live. */
  async transaction(transactionId: string): Promise<{ environment: AppleEnvironment; transaction: AppleTransaction }> {
    for (const environment of ['Production', 'Sandbox'] as const) {
      const body = await this.get<{ signedTransactionInfo: string }>(environment, `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
      if (body) return { environment, transaction: readJws<AppleTransaction>(body.signedTransactionInfo) };
    }
    throw fail(404, 'unknown_purchase', "The App Store doesn't know that purchase.");
  }

  /** Where one subscription stands now: its newest transaction, and whether it will renew. */
  async subscription(originalTransactionId: string, environment: AppleEnvironment) {
    const body = await this.get<StatusResponse>(environment, `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`);
    const last = body?.data?.flatMap((group) => group.lastTransactions).find((item) => item.originalTransactionId === originalTransactionId);
    if (!last) return null;
    return {
      status: last.status,
      transaction: readJws<AppleTransaction>(last.signedTransactionInfo),
      renewal: last.signedRenewalInfo ? readJws<AppleRenewalInfo>(last.signedRenewalInfo) : null,
    };
  }

  /**
   * Asks Apple to send a TEST notification to the URL set for this environment in App Store Connect, which proves the
   * URL works before any real purchase does. The notification itself arrives at /v1/webhooks/apple.
   */
  async requestTestNotification(environment: AppleEnvironment): Promise<{ testNotificationToken: string }> {
    if (!this.ready) throw fail(503, 'store_not_configured', 'App Store purchases are not switched on for this server yet.');
    const res = await fetch(`${HOSTS[environment]}/inApps/v1/notifications/test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) this.cached = null;
    if (!res.ok) {
      this.logger.warn(`${environment} test notification: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      throw fail(502, 'app_store_error', `The App Store said ${res.status}${res.status === 401 ? ': check the In-App Purchase key, issuer ID and bundle ID' : ''}.`);
    }
    return (await res.json()) as { testNotificationToken: string };
  }

  private async get<T>(environment: AppleEnvironment, path: string): Promise<T | null> {
    if (!this.ready) throw fail(503, 'store_not_configured', 'App Store purchases are not switched on for this server yet.');
    const res = await fetch(`${HOSTS[environment]}${path}`, { headers: { authorization: `Bearer ${this.token()}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (res.status === 401) this.cached = null; // a fresh token next time
    if (!res.ok) {
      // 401 almost always means the key, issuer ID or bundle ID in the environment is wrong.
      this.logger.warn(`${environment} ${path}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      throw fail(502, 'app_store_error', `The App Store said ${res.status}. Try again in a moment.`);
    }
    return (await res.json()) as T;
  }

  /** Apple allows an hour; this makes a new one every half hour. */
  private token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.until > now + 60) return this.cached.token;
    this.key ??= readPrivateKey(this.env.APPLE_PRIVATE_KEY);
    const token = signJwt(
      'ES256',
      this.key,
      { iss: this.env.APPLE_ISSUER_ID, iat: now, exp: now + 1800, aud: 'appstoreconnect-v1', bid: this.env.APPLE_BUNDLE_ID },
      { kid: this.env.APPLE_KEY_ID },
    );
    this.cached = { token, until: now + 1800 };
    return token;
  }
}
