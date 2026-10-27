import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, session } from './api';
import type { Me, StaffRole } from './types';

interface AuthValue {
  ready: boolean;
  me: Me | null;
  isStaff: boolean;
  isInstructor: boolean;
  /** Super admins pass every role check. */
  can: (...roles: StaffRole[]) => boolean;
  startSignIn: (email: string) => Promise<void>;
  verify: (email: string, code: string) => Promise<Me>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    if (!session.signedIn) return setMe(null);
    try {
      setMe(await api<Me>('/v1/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setReady(true));
    return session.subscribe((signedIn) => {
      if (!signedIn) {
        setMe(null);
        queryClient.clear();
      }
    });
  }, [load, queryClient]);

  const value = useMemo<AuthValue>(() => {
    const staff = me?.roles.staff ?? [];
    return {
      ready,
      me,
      isStaff: staff.length > 0,
      isInstructor: me?.roles.instructor?.status === 'approved',
      can: (...roles) => staff.includes('super_admin') || roles.some((role) => staff.includes(role)),
      async startSignIn(email) {
        await api('/v1/auth/email/start', { method: 'POST', body: { email } });
      },
      async verify(email, code) {
        const tokens = await api<{ accessToken: string; refreshToken: string }>('/v1/auth/email/verify', {
          method: 'POST',
          body: { email, code },
        });
        session.set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
        const profile = await api<Me>('/v1/me');
        setMe(profile);
        return profile;
      },
      async signOut() {
        await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
        session.set(null);
      },
    };
  }, [ready, me]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
