/**
 * The web build has no App Store or Google Play: it sells through Razorpay (see ui/checkout). The phone apps load
 * store.native.ts instead of this file, with the same exports.
 */
import type { StoreKind, StoreProduct, StoreResult } from './store-types';

export const inAppStore: boolean = false;
export const storeName: string = '';

export async function findStoreProduct(_kind: StoreKind, _ownerId: string): Promise<StoreProduct | null> {
  return null;
}

export async function buyFromStore(_product: StoreProduct, _userId: string): Promise<StoreResult | null> {
  throw new Error('Buying through a store only works in the iOS and Android apps.');
}

export async function restoreStorePurchases(): Promise<{ restored: number; failed: number }> {
  return { restored: 0, failed: 0 };
}

export function startStoreListener(_onCredit: (result: StoreResult) => void): () => void {
  return () => undefined;
}

export function manageSubscriptionsUrl(_channel: 'razorpay' | 'apple' | 'google'): string | null {
  return null;
}
