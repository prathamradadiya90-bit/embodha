/** The calendar day of a moment in an IANA time zone, as YYYY-MM-DD (en-CA formats dates that way). */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Consecutive practice days ending today. A streak stays alive until the end of today even if
 * the member hasn't practised yet, so the morning screen doesn't show a broken streak at 7am.
 */
export function streakDays(days: ReadonlySet<string>, today: string): number {
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}
