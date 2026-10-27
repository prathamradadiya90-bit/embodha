export function minutes(totalSeconds: number | null | undefined): string {
  if (!totalSeconds) return '';
  const m = Math.max(1, Math.round(totalSeconds / 60));
  if (m < 60) return `${m} min`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function ago(iso: string, now = Date.now()): string {
  const minutesAgo = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutesAgo < 1) return 'Just now';
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  if (minutesAgo < 24 * 60) return `${Math.floor(minutesAgo / 60)} h ago`;
  if (minutesAgo < 7 * 24 * 60) return `${Math.floor(minutesAgo / (24 * 60))} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The device's own calendar day, YYYY-MM-DD. */
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Two-letter region from the device locale, e.g. "en-IN" -> "IN". */
export function deviceRegion(): string | undefined {
  try {
    return /[-_]([A-Z]{2})\b/.exec(Intl.DateTimeFormat().resolvedOptions().locale)?.[1];
  } catch {
    return undefined;
  }
}

export const levelLabel = (level: string) =>
  ({ beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', all: 'All levels' })[level] ?? '';
