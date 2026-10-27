import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useAuth } from '../lib/auth';
import { syncPushToken } from '../lib/push';

if (Platform.OS !== 'web') {
  // A notification that arrives while the app is open still shows as a banner.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/** Keeps this phone's push token current while someone is signed in, and opens the screen a tapped notification points at. */
export function PushBridge() {
  const { signedIn } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (signedIn) void syncPushToken(false);
  }, [signedIn]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (response: Notifications.NotificationResponse) => {
      const link = response.notification.request.content.data?.link;
      void queryClient.invalidateQueries({ queryKey: ['bell'] });
      void queryClient.invalidateQueries({ queryKey: ['unread'] });
      router.push(typeof link === 'string' && link.startsWith('/') ? (link as never) : '/notifications');
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    // The tap that launched the app from closed.
    const launch = Notifications.getLastNotificationResponse();
    if (launch) setTimeout(() => open(launch), 0);
    return () => subscription.remove();
  }, [queryClient]);

  return null;
}
