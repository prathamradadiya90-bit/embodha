// The phone's local storage, as a Map the test can read and carry over to the "next launch".
export const storage = {
  async get(key) { return globalThis.__store.storage.get(key) ?? null; },
  async set(key, value) { globalThis.__store.storage.set(key, value); },
  async remove(key) { globalThis.__store.storage.delete(key); },
};
