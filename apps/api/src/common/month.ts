import { localDay } from '../practice/streak';

/** Payouts and reports run on Indian months: a session at 1 a.m. IST on the 1st counts for the new month. */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

export const currentMonth = (now = new Date()) => localDay(now, BUSINESS_TIME_ZONE).slice(0, 7);

/** "2026-10" → the first day of the month and of the next one, as YYYY-MM-DD, plus the instant the month ends. */
export function monthRange(month: string) {
  const [year, m] = month.split('-').map(Number);
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, to: `${next}-01`, start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`) };
}
