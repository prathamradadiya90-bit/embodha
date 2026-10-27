import { localDay, shiftDay, streakDays } from './streak';

describe('streaks', () => {
  const days = (...list: string[]) => new Set(list);

  it('counts back from today', () => {
    expect(streakDays(days('2026-10-21', '2026-10-20', '2026-10-19', '2026-10-17'), '2026-10-21')).toBe(3);
  });

  it("keeps yesterday's streak alive until today is over", () => {
    expect(streakDays(days('2026-10-20', '2026-10-19'), '2026-10-21')).toBe(2);
  });

  it('is zero after a missed day', () => {
    expect(streakDays(days('2026-10-19'), '2026-10-21')).toBe(0);
  });

  it('crosses month and year ends', () => {
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
    expect(streakDays(days('2027-03-01', '2027-02-28'), '2027-03-01')).toBe(2);
  });

  it("uses the member's own calendar day", () => {
    const lateEvening = new Date('2026-10-21T20:00:00Z'); // 01:30 on the 22nd in India
    expect(localDay(lateEvening, 'UTC')).toBe('2026-10-21');
    expect(localDay(lateEvening, 'Asia/Kolkata')).toBe('2026-10-22');
  });
});
