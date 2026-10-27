import { deviceRegion } from './format';
import { storage } from './storage';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const TOKENS_KEY = 'embodha.tokens';
let tokens: Tokens | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export const session = {
  async load(): Promise<boolean> {
    const raw = await storage.get(TOKENS_KEY);
    tokens = raw ? (JSON.parse(raw) as Tokens) : null;
    return tokens !== null;
  },
  async set(next: Tokens | null): Promise<void> {
    tokens = next;
    if (next) await storage.set(TOKENS_KEY, JSON.stringify(next));
    else await storage.remove(TOKENS_KEY);
    listeners.forEach((listener) => listener(next !== null));
  },
  get signedIn(): boolean {
    return tokens !== null;
  },
  /**
   * The member's ID, read from the access token, so the app knows whose downloads these are while it's offline.
   * The token isn't checked here, only read: the server checks it on every request.
   */
  get userId(): string | null {
    const part = tokens?.accessToken.split('.')[1];
    if (!part) return null;
    try {
      const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
      const claims = JSON.parse(atob(base64)) as { sub?: unknown };
      return typeof claims.sub === 'string' ? claims.sub : null;
    } catch {
      return null;
    }
  },
  subscribe(listener: (signedIn: boolean) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** One refresh at a time: if five requests hit an expired token together, they share a single refresh. */
function refresh(): Promise<boolean> {
  if (!tokens) return Promise.resolve(false);
  const current = tokens;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await session.set(null); // the session is over; the member signs in again
        return false;
      }
      if (!res.ok) return false; // the server is having trouble: keep the tokens, and the member's downloads, and try later
      const body = (await res.json()) as Tokens;
      await session.set({ accessToken: body.accessToken, refreshToken: body.refreshToken });
      return true;
    } catch {
      return false; // offline: keep the tokens and try again later
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      // Lets a last batch of events finish sending when the web page is being closed.
      keepalive: init.keepalive,
    });

  let res = await send();
  if (res.status === 401 && tokens) {
    const problem = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (problem.code === 'token_expired' && (await refresh())) res = await send();
    else if (problem.code === 'account_unavailable') await session.set(null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.message === 'string' ? data.message : 'Something went wrong. Try again in a moment.';
    throw new ApiError(res.status, typeof data.code === 'string' ? data.code : 'error', message, data);
  }
  return data as T;
}

/** Guests are priced by the device's region; members by the country on their account, so they never pass one. */
export function withCurrency(path: string): string {
  if (session.signedIn) return path;
  const region = deviceRegion();
  const currency = !region || region === 'IN' ? 'INR' : 'USD';
  return `${path}${path.includes('?') ? '&' : '?'}currency=${currency}`;
}
