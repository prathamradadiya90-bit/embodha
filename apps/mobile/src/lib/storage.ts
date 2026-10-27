import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** Tokens go in the Keychain / Keystore on phones. The web build (used for previews) falls back to localStorage. */
const web = Platform.OS === 'web';
const local = () => (globalThis as { localStorage?: Storage }).localStorage;

export const storage = {
  async get(key: string): Promise<string | null> {
    return web ? (local()?.getItem(key) ?? null) : SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (web) local()?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (web) local()?.removeItem(key);
    else await SecureStore.deleteItemAsync(key);
  },
};
