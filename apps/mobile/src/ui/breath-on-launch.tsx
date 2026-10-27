import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { todayLocal } from '../lib/format';
import { storage } from '../lib/storage';

export const LAST_BREATH_KEY = 'embodha.lastBreath';

/** The first open of each day starts on a one-minute breath, with a Skip button. Members can turn this off in You. */
export function BreathOnLaunch() {
  const { ready, me } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (!ready || handled.current) return;
    handled.current = true;
    void (async () => {
      if (me && !me.preferences.breathOnLaunch) return;
      const today = todayLocal();
      if ((await storage.get(LAST_BREATH_KEY)) === today) return;
      await storage.set(LAST_BREATH_KEY, today);
      setTimeout(() => router.push('/breathe?launch=1'), 0);
    })();
  }, [ready, me]);

  return null;
}
