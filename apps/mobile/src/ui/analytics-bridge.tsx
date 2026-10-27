import { usePathname, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { startAnalytics, track } from '../lib/analytics';
import { noteScreen } from '../lib/crashes';

/**
 * App opens and screen changes. `screen` is the route ("/course/[slug]"), so screens add up across courses;
 * `path` is the actual page ("/course/gentle-spine"). Query strings, like a sign-in link's token, aren't in either.
 */
export function AnalyticsBridge() {
  const path = usePathname();
  const segments = useSegments() as string[];
  const screen = `/${segments.filter((segment) => !segment.startsWith('(')).join('/')}`;

  useEffect(() => startAnalytics(), []);
  useEffect(() => {
    track('screen_view', { screen, path });
    noteScreen(path);
  }, [screen, path]);

  return null;
}
