import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { storage } from './storage';

const TOKEN_KEY = 'embodha.pushToken';

/**
 * Registers this phone for notifications. With `ask`, shows the system prompt if the member hasn't answered it;
 * without, it only refreshes a token they already allowed. Returns false where push can't work: the web build,
 * simulators, a declined prompt, or an app not yet linked to an EAS project (push tokens need its project ID).
 */
export async function syncPushToken(ask: boolean): Promise<boolean> {
  if (Platform.OS === 'web' || !Device.isDevice) return false;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return false;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Embodha', importance: Notifications.AndroidImportance.DEFAULT });
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return false;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api('/v1/devices', { method: 'POST', body: { token, platform: Platform.OS, appVersion: Constants.expoConfig?.version } });
    await storage.set(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** On sign-out, so the next person on this phone doesn't get the last member's notifications. */
export async function forgetPushToken() {
  const token = await storage.get(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await api(`/v1/devices/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => undefined);
  await storage.remove(TOKEN_KEY);
}
