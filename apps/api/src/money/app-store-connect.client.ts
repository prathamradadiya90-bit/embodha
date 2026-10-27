import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, type KeyObject } from 'node:crypto';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { readPrivateKey, signJwt } from './jwt';

const API = 'https://api.appstoreconnect.apple.com';

/** Where Apple says a product stands. Shared by in-app purchases (courses) and subscriptions (teachers). */
export type AppleProductState =
  | 'MISSING_METADATA'
  | 'WAITING_FOR_UPLOAD'
  | 'PROCESSING_CONTENT'
  | 'READY_TO_SUBMIT'
  | 'WAITING_FOR_REVIEW'
  | 'IN_REVIEW'
  | 'DEVELOPER_ACTION_NEEDED'
  | 'PENDING_BINARY_APPROVAL'
  | 'APPROVED'
  | 'DEVELOPER_REMOVED_FROM_SALE'
  | 'REMOVED_FROM_SALE'
  | 'REJECTED';

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}
interface Doc<T> {
  data: T;
  included?: Resource[];
  links?: { next?: string };
}
interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: { name: string; value: string }[];
}

type Kind = 'inAppPurchase' | 'subscription';
/** The resource names differ between the two kinds; everything else about making them is the same. */
const NAMES = {
  inAppPurchase: { type: 'inAppPurchases', relation: 'inAppPurchaseV2', path: '/v2/inAppPurchases', prefix: 'inAppPurchase' },
  subscription: { type: 'subscriptions', relation: 'subscription', path: '/v1/subscriptions', prefix: 'subscription' },
} as const;

/**
 * The App Store Connect API, for making the products the app sells: a non-consumable in-app purchase per course,
 * and a subscription per teacher, each in the teacher's own group so a member can subscribe to several.
 * Needs a team key with the App Manager role. Prices follow Embodha's: rupees in India, dollars in the US, and
 * the rest of the world equalised from the dollar price by Apple.
 */
@Injectable()
export class AppStoreConnectClient {
  private readonly logger = new Logger('AppStoreConnect');
  private key: KeyObject | null = null;
  private cached: { token: string; until: number } | null = null;
  private app: string | null = null;
  private territories: string[] | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get ready() {
    return Boolean(this.env.APPLE_ISSUER_ID && this.env.APPLE_CONNECT_KEY_ID && this.env.APPLE_CONNECT_PRIVATE_KEY);
  }

  /* ------------------------------------------------------------ Finding */

  async findInAppPurchase(productId: string) {
    const found = await this.get<Doc<Resource[]>>(`/v1/apps/${await this.appId()}/inAppPurchasesV2?filter[productId]=${encodeURIComponent(productId)}&limit=1`);
    return found.data[0] ?? null;
  }

  async findGroup(referenceName: string) {
    const found = await this.get<Doc<Resource[]>>(`/v1/apps/${await this.appId()}/subscriptionGroups?filter[referenceName]=${encodeURIComponent(referenceName)}&limit=1`);
    return found.data[0] ?? null;
  }

  async findSubscription(groupId: string, productId: string) {
    const found = await this.get<Doc<Resource[]>>(`/v1/subscriptionGroups/${groupId}/subscriptions?filter[productId]=${encodeURIComponent(productId)}&limit=1`);
    return found.data[0] ?? null;
  }

  async state(kind: Kind, id: string) {
    const found = await this.get<Doc<Resource>>(`${NAMES[kind].path}/${id}`);
    return found.data.attributes?.state as AppleProductState;
  }

  /* ------------------------------------------------------------ Making */

  async createInAppPurchase(input: { productId: string; name: string; reviewNote: string }) {
    const made = await this.post<Doc<Resource>>('/v2/inAppPurchases', {
      data: {
        type: 'inAppPurchases',
        attributes: { name: input.name, productId: input.productId, inAppPurchaseType: 'NON_CONSUMABLE', reviewNote: input.reviewNote, familySharable: false },
        relationships: { app: { data: { type: 'apps', id: await this.appId() } } },
      },
    });
    return made.data;
  }

  /** A teacher's own subscription group, with the name members see in their subscription settings. */
  async createGroup(referenceName: string) {
    const made = await this.post<Doc<Resource>>('/v1/subscriptionGroups', {
      data: { type: 'subscriptionGroups', attributes: { referenceName }, relationships: { app: { data: { type: 'apps', id: await this.appId() } } } },
    });
    return made.data;
  }

  async localizeGroup(groupId: string, name: string) {
    await this.post('/v1/subscriptionGroupLocalizations', {
      data: {
        type: 'subscriptionGroupLocalizations',
        attributes: { name, locale: 'en-US' },
        relationships: { subscriptionGroup: { data: { type: 'subscriptionGroups', id: groupId } } },
      },
    });
  }

  async createSubscription(groupId: string, input: { productId: string; name: string; reviewNote: string }) {
    const made = await this.post<Doc<Resource>>('/v1/subscriptions', {
      data: {
        type: 'subscriptions',
        attributes: { name: input.name, productId: input.productId, subscriptionPeriod: 'ONE_MONTH', groupLevel: 1, familySharable: false, reviewNote: input.reviewNote },
        relationships: { group: { data: { type: 'subscriptionGroups', id: groupId } } },
      },
    });
    return made.data;
  }

  /** The name and line members see on the payment sheet: 30 and 45 characters at most. */
  async localize(kind: Kind, id: string, text: { name: string; description: string }) {
    const { type, relation, prefix } = NAMES[kind];
    await this.post(`/v1/${prefix}Localizations`, {
      data: { type: `${prefix}Localizations`, attributes: { ...text, locale: 'en-US' }, relationships: { [relation]: { data: { type, id } } } },
    });
  }

  /* ------------------------------------------------------------ Prices */

  /** A course's price: dollars in the US as the base, rupees set by hand for India, Apple's equalised prices elsewhere. */
  async priceInAppPurchase(id: string, price: { inr: number; usd: number }) {
    const usa = await this.closestPoint(`/v2/inAppPurchases/${id}/pricePoints?filter[territory]=USA&limit=8000`, price.usd);
    const ind = await this.closestPoint(`/v2/inAppPurchases/${id}/pricePoints?filter[territory]=IND&limit=8000`, price.inr);
    await this.post('/v1/inAppPurchasePriceSchedules', {
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${usa}' }, { type: 'inAppPurchasePrices', id: '${ind}' }] },
        },
      },
      included: [
        { type: 'inAppPurchasePrices', id: '${usa}', attributes: { startDate: null }, relationships: { inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: usa } } } },
        { type: 'inAppPurchasePrices', id: '${ind}', attributes: { startDate: null }, relationships: { inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: ind } } } },
      ],
    });
  }

  /**
   * A teacher's monthly price. Subscriptions are priced territory by territory: dollars in the US, rupees in
   * India, and Apple's equivalents of the dollar price everywhere else. A new price keeps current subscribers on
   * the price they signed up at, so nobody needs to agree to an increase.
   */
  async priceSubscription(id: string, price: { inr: number; usd: number }, keepCurrentSubscribers: boolean) {
    const usa = await this.closestPoint(`/v1/subscriptions/${id}/pricePoints?filter[territory]=USA&limit=8000`, price.usd);
    const ind = await this.closestPoint(`/v1/subscriptions/${id}/pricePoints?filter[territory]=IND&limit=8000`, price.inr);
    const others = await this.all(`/v1/subscriptionPricePoints/${usa}/equalizations?include=territory&fields[territories]=currency&limit=8000`);
    const points = new Map<string, string>(others.flatMap((p) => (p.relationships?.territory?.data ? [[p.relationships.territory.data.id, p.id] as [string, string]] : [])));
    points.set('USA', usa);
    points.set('IND', ind);
    for (const [territory, point] of points) {
      await this.post('/v1/subscriptionPrices', {
        data: {
          type: 'subscriptionPrices',
          attributes: { startDate: null, preserveCurrentPrice: keepCurrentSubscribers },
          relationships: {
            subscription: { data: { type: 'subscriptions', id } },
            subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: point } },
            territory: { data: { type: 'territories', id: territory } },
          },
        },
      });
    }
    return points.size;
  }

  /** The price point nearest the amount, in that territory's currency. Apple's points don't include every price. */
  private async closestPoint(path: string, amount: number) {
    const points = await this.all(path);
    let best: { id: string; gap: number; price: number } | null = null;
    for (const point of points) {
      const price = Number(point.attributes?.customerPrice);
      if (!Number.isFinite(price)) continue;
      const gap = Math.abs(price - amount);
      if (!best || gap < best.gap - 1e-9 || (Math.abs(gap - best.gap) < 1e-9 && price < best.price)) best = { id: point.id, gap, price };
    }
    if (!best) throw fail(502, 'app_store_error', `Apple has no price points at ${path}.`);
    return best.id;
  }

  /* ------------------------------------------------------------ On sale, review */

  /** On sale everywhere Apple sells, or nowhere. Off sale stops new purchases, and stops subscriptions renewing. */
  async setOnSale(kind: Kind, id: string, onSale: boolean) {
    const { type, relation, prefix } = NAMES[kind];
    const relationName = kind === 'inAppPurchase' ? 'inAppPurchase' : relation;
    const everywhere = onSale ? (await this.allTerritories()).map((territory) => ({ type: 'territories', id: territory })) : [];
    await this.post(`/v1/${prefix}Availabilities`, {
      data: {
        type: `${prefix}Availabilities`,
        attributes: { availableInNewTerritories: onSale },
        relationships: { [relationName]: { data: { type, id } }, availableTerritories: { data: everywhere } },
      },
    });
  }

  /** App Review wants to see where the purchase happens in the app. One image serves every product. */
  async uploadReviewScreenshot(kind: Kind, id: string, png: Buffer) {
    const { type, relation, prefix } = NAMES[kind];
    const resource = `${prefix}AppStoreReviewScreenshots`;
    const reserved = await this.post<Doc<Resource>>(`/v1/${resource}`, {
      data: { type: resource, attributes: { fileName: 'embodha-review.png', fileSize: png.length }, relationships: { [relation]: { data: { type, id } } } },
    });
    const operations = (reserved.data.attributes?.uploadOperations ?? []) as UploadOperation[];
    for (const op of operations) {
      const res = await fetch(op.url, {
        method: op.method,
        headers: Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])),
        body: png.subarray(op.offset, op.offset + op.length),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw fail(502, 'app_store_error', `Uploading the review screenshot failed with ${res.status}.`);
    }
    await this.patch(`/v1/${resource}/${reserved.data.id}`, {
      data: { type: resource, id: reserved.data.id, attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(png).digest('hex') } },
    });
  }

  async submit(kind: Kind, id: string) {
    const { type, relation, prefix } = NAMES[kind];
    await this.post(`/v1/${prefix}Submissions`, { data: { type: `${prefix}Submissions`, relationships: { [relation]: { data: { type, id } } } } });
  }

  /* ------------------------------------------------------------ Plumbing */

  async appId() {
    if (this.env.APPLE_APP_ID) return this.env.APPLE_APP_ID;
    if (this.app) return this.app;
    const found = await this.get<Doc<Resource[]>>(`/v1/apps?filter[bundleId]=${encodeURIComponent(this.env.APPLE_BUNDLE_ID)}&limit=1`);
    if (!found.data[0]) throw fail(502, 'app_store_error', `App Store Connect has no app with bundle ID ${this.env.APPLE_BUNDLE_ID}. Create it there first.`);
    this.app = found.data[0].id;
    return this.app;
  }

  private async allTerritories() {
    this.territories ??= (await this.all('/v1/territories?limit=200')).map((t) => t.id);
    return this.territories;
  }

  private async all(path: string) {
    const items: Resource[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Doc<Resource[]> = await this.get<Doc<Resource[]>>(next);
      items.push(...page.data);
      next = page.links?.next;
    }
    return items;
  }

  private get<T>(path: string) {
    return this.call<T>('GET', path);
  }

  private post<T = unknown>(path: string, body: unknown) {
    return this.call<T>('POST', path, body);
  }

  private patch<T = unknown>(path: string, body: unknown) {
    return this.call<T>('PATCH', path, body);
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    if (!this.ready) throw fail(503, 'store_not_configured', 'App Store Connect keys are not set on this server.');
    const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { errors?: { detail?: string; title?: string }[] }) : {};
    if (res.status === 401) this.cached = null;
    if (!res.ok) {
      const detail = data.errors?.map((e) => e.detail ?? e.title).join(' ') || String(res.status);
      this.logger.warn(`${method} ${path}: ${res.status} ${detail.slice(0, 300)}`);
      throw fail(502, 'app_store_error', `App Store Connect said: ${detail.slice(0, 280)}`, { appleStatus: res.status });
    }
    return data as T;
  }

  /** Team keys allow tokens of up to 20 minutes; this makes a new one every 15. */
  private token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.until > now + 60) return this.cached.token;
    this.key ??= readPrivateKey(this.env.APPLE_CONNECT_PRIVATE_KEY);
    const token = signJwt('ES256', this.key, { iss: this.env.APPLE_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }, { kid: this.env.APPLE_CONNECT_KEY_ID });
    this.cached = { token, until: now + 900 };
    return token;
  }
}
