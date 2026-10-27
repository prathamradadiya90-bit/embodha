import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { flushEvents, resetDevice } from './analytics';
import { api, session } from './api';
import { clearBeats, sendBeats } from './beats';
import { downloads } from './downloads';
import { deviceTimeZone } from './format';
import { forgetPushToken } from './push';
import type { Me } from './types';

export type MePatch = Partial<{
  name: string;
  country: string;
  state: string | null;
  birthYear: number;
  gender: string;
  timezone: string;
  goals: string[];
  reminderTime: string | null;
  breathOnLaunch: boolean;
}>;

interface AuthValue {
  ready: boolean;
  signedIn: boolean;
  me: Me | null;
  startSignIn(email: string): Promise<void>;
  verify(email: string, code: string): Promise<Me>;
  /** Signs in with the token from the one-tap link in the same email. */
  verifyLink(token: string): Promise<Me>;
  refreshMe(): Promise<Me | null>;
  updateMe(patch: MePatch): Promise<Me>;
  signOut(): Promise<void>;
  /** Erased after the date it returns, unless they sign back in. App Store subscriptions are the member's to cancel. */
  deleteAccount(): Promise<{ deleteAfter: string; appStoreSubscriptions: number }>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    if (!session.signedIn) {
      setMe(null);
      return null;
    }
    try {
      const profile = await api<Me>('/v1/me');
      setMe(profile);
      return profile;
    } catch {
      return null;
    }
  }, []);

  useEffect(
    () =>
      session.subscribe((value) => {
        setSignedIn(value);
        if (!value) setMe(null);
      }),
    [],
  );

  useEffect(() => {
    void (async () => {
      setSignedIn(await session.load());
      await refreshMe();
      setReady(true);
    })();
  }, [refreshMe]);

  const value = useMemo<AuthValue>(() => {
    const signInWith = async (body: { email: string; code: string } | { token: string }) => {
      const tokens = await api<{ accessToken: string; refreshToken: string }>('/v1/auth/email/verify', { method: 'POST', body });
      await session.set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      let profile = await api<Me>('/v1/me');
      // Streaks and reminders run on the member's own clock, so keep the time zone current.
      const timezone = deviceTimeZone();
      if (timezone && profile.timezone !== timezone) profile = await api<Me>('/v1/me', { method: 'PATCH', body: { timezone } });
      setMe(profile);
      await queryClient.invalidateQueries();
      return profile;
    };
    return {
      ready,
      signedIn,
      me,
      refreshMe,
      async startSignIn(email) {
        await api('/v1/auth/email/start', { method: 'POST', body: { email } });
      },
      verify: (email, code) => signInWith({ email, code }),
      verifyLink: (token) => signInWith({ token }),
      async updateMe(patch) {
        const profile = await api<Me>('/v1/me', { method: 'PATCH', body: patch });
        setMe(profile);
        return profile;
      },
      async signOut() {
        await flushEvents(); // what's waiting was this member's, so it goes up before the token does
        await sendBeats().catch(() => false);
        clearBeats();
        await downloads.forget(); // frees this phone's place for downloads, then deletes them here
        await forgetPushToken();
        await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
        await session.set(null);
        await resetDevice();
        queryClient.clear();
      },
      async deleteAccount() {
        await forgetPushToken();
        const closing = await api<{ deleteAfter: string; appStoreSubscriptions?: number }>('/v1/me', { method: 'DELETE' });
        clearBeats();
        await downloads.wipe();
        await session.set(null);
        await resetDevice();
        queryClient.clear();
        return { deleteAfter: closing.deleteAfter, appStoreSubscriptions: closing.appStoreSubscriptions ?? 0 };
      },
    };
  }, [ready, signedIn, me, refreshMe, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
