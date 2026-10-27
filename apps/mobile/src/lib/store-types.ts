/** What can be bought in the app: one course, or a monthly subscription to one teacher. */
export type StoreKind = 'course' | 'instructor';

/** A product as the App Store or Google Play prices it for this person, ready to buy. */
export interface StoreProduct {
  sku: string;
  type: 'in-app' | 'subs';
  /** The store's own price string, in the member's currency: what the payment sheet will charge. */
  displayPrice: string;
  /** Android subscriptions are bought through one of their offers; this is the base monthly plan's. */
  offerToken?: string;
}

/** The server's answer once it has checked a purchase with the store. */
export type StoreResult =
  | { kind: 'course'; course: { slug: string; title: string }; test: boolean }
  | { kind: 'subscription'; instructor: { slug: string; displayName: string }; accessUntil: string; test: boolean }
  | { pending: true };

export const isPending = (result: StoreResult): result is { pending: true } => 'pending' in result;
