export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const KEY = 'embodha.studio.tokens';
const listeners = new Set<(signedIn: boolean) => void>();
let refreshing: Promise<boolean> | null = null;

function read(): Tokens | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

let tokens = read();

export const session = {
  get signedIn() {
    return tokens !== null;
  },
  set(next: Tokens | null) {
    tokens = next;
    try {
      if (next) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      // private mode: the session lasts as long as the tab
    }
    listeners.forEach((listener) => listener(next !== null));
  },
  subscribe(listener: (signedIn: boolean) => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

// Several requests can hit an expired token at once; they share one refresh.
function refresh(): Promise<boolean> {
  const current = tokens;
  if (!current) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) {
        session.set(null);
        return false;
      }
      const body = (await res.json()) as Tokens;
      session.set({ accessToken: body.accessToken, refreshToken: body.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && tokens) {
      const problem = (await res.clone().json().catch(() => ({}))) as { code?: string };
      if (problem.code === 'token_expired' && (await refresh())) res = await send();
      else if (problem.code === 'account_unavailable') session.set(null);
    }
  } catch {
    throw new ApiError(0, 'offline', "Can't reach the Embodha server. Check your connection.", {});
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.message === 'string' ? data.message : `Something went wrong (${res.status}).`;
    throw new ApiError(res.status, typeof data.code === 'string' ? data.code : 'error', message, data);
  }
  return data as T;
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

/** For uploads that need XMLHttpRequest's progress events. Call api() just before, so the token is fresh. */
export const authHeader = (): Record<string, string> => (tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {});
