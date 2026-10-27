import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../lib/auth';
import { cast, useCast } from '../lib/cast';

/** The screens that show progress: course ticks, Continue on Today, the library, the streak. */
const PROGRESS = ['course', 'home', 'library', 'stats'];

/**
 * Casting for the whole app, whichever screen is open: what the TV plays counts for the member signed in, the count
 * hears when the app goes to the background and comes back, and the progress screens catch up when the TV finishes a
 * chapter, moves on, or is left.
 */
export function CastBridge() {
  const { ready, signedIn } = useAuth();
  const queryClient = useQueryClient();
  const { connection, tv } = useCast();

  useEffect(() => cast.start(), []);

  useEffect(() => {
    if (ready) cast.setTracking(signedIn);
  }, [ready, signedIn]);

  useEffect(() => {
    // 'inactive' is iOS pulling something over the app (Control Center, the local network question): still open.
    const subscription = AppState.addEventListener('change', (next) => cast.setForeground(next !== 'background'));
    return () => subscription.remove();
  }, []);

  const moment = `${connection === 'connected'}|${tv?.chapterId ?? ''}|${tv?.finished ?? false}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // A moment for the last heartbeat to reach the server first.
    const timer = setTimeout(() => {
      for (const key of PROGRESS) void queryClient.invalidateQueries({ queryKey: [key] });
    }, 2000);
    return () => clearTimeout(timer);
  }, [moment, queryClient]);

  return null;
}
