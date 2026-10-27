// A stand-in for expo-iap's native module: records what the app asks for, and lets a test play the store's part.
const m = () => globalThis.__store;
export const ErrorCode = { UserCancelled: 'user-cancelled', DeferredPayment: 'deferred-payment', Pending: 'pending' };
export const initConnection = async () => true;
export const fetchProducts = async (args) => m().products.filter((p) => args.skus.includes(p.id));
export const requestPurchase = (args) => {
  m().calls.push(['requestPurchase', args]);
  return new Promise((resolve, reject) => (m().sheet = { resolve, reject }));
};
export const purchaseUpdatedListener = (fn) => ((m().purchased = fn), { remove() {} });
export const purchaseErrorListener = (fn) => ((m().failed = fn), { remove() {} });
export const finishTransaction = async ({ purchase }) => m().calls.push(['finish', purchase.transactionId ?? purchase.purchaseToken]);
export const getAvailablePurchases = async () => m().available;
