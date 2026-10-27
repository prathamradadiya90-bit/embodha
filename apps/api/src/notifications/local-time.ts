import { BUSINESS_TIME_ZONE } from '../common/month';

/** Pushes from Embodha wait out 22:00 to 08:00 on the member's own clock. Their own reminder doesn't: they chose its time. */
export const QUIET_FROM = 22 * 60;
export const QUIET_UNTIL = 8 * 60;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string) {
  let found = formats.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formats.set(timeZone, found);
  }
  return found;
}

/** The member's date and time of day. No time zone on the account (or one the runtime doesn't know) means India's. */
export function localClock(at: Date, timeZone: string | null) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone || BUSINESS_TIME_ZONE).formatToParts(at);
  } catch {
    parts = format(BUSINESS_TIME_ZONE).formatToParts(at);
  }
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')), seconds: Number(part('second')) };
}

/** Null if a push can go now; otherwise 08:00 on the member's clock, when it may. */
export function quietUntil(at: Date, timeZone: string | null): Date | null {
  const { minutes, seconds } = localClock(at, timeZone);
  if (minutes >= QUIET_UNTIL && minutes < QUIET_FROM) return null;
  const wait = (QUIET_UNTIL - minutes + 1440) % 1440;
  return new Date(at.getTime() + (wait * 60 - seconds) * 1000);
}
