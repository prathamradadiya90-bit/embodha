import { useEffect } from 'react';
import { AppState } from 'react-native';
import { session } from '../lib/api';
import { useAuth } from '../lib/auth';
import { clearBeats, sendBeats } from '../lib/beats';
import { downloads, startDownloads, useDownloads } from '../lib/downloads';

/**
 * Keeps the phone's downloads with the member they belong to, and sends heartbeats from chapters played offline.
 * Offline at launch the profile can't load, so the member is read from the saved sign-in instead. When the session
 * ends, for whatever reason, the downloads and the waiting heartbeats go with it. In the web app there are no
 * downloads, only the heartbeats.
 */
export function DownloadsBridge() {
  const { ready, signedIn, me } = useAuth();
  const userId = signedIn ? (me?.id ?? session.userId) : null;
  const { online } = useDownloads();

  useEffect(() => startDownloads(), []);

  useEffect(() => {
    if (!ready) return;
    void downloads.setUser(userId);
    if (userId) void sendBeats();
    else clearBeats();
  }, [ready, userId]);

  // Back from a flight: what was played offline goes up as soon as there's a connection.
  useEffect(() => {
    if (userId && online) void sendBeats();
  }, [userId, online]);

  useEffect(() => {
    if (!userId) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void sendBeats();
    });
    return () => subscription.remove();
  }, [userId]);

  return null;
}
