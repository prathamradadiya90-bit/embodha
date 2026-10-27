import { computeSplit } from './split';

describe('computeSplit', () => {
  // The three rows of the spec's worked example, instructor on 60%.
  it('website sale in India: ₹999 with GST, Razorpay 2%', () => {
    expect(computeSplit({ grossMinor: 99_900, gstRateBps: 1800, feeRateBps: 200, feeBase: 'gross', percentBps: 6000 })).toEqual({
      grossMinor: 99_900,
      gstMinor: 15_239,
      feeMinor: 1_998,
      netMinor: 82_663,
      instructorMinor: 49_598,
      embodhaMinor: 33_065,
    });
  });

  it('website sale abroad: US$12, no GST, 3% international card fee', () => {
    expect(computeSplit({ grossMinor: 1_200, gstRateBps: 0, feeRateBps: 300, feeBase: 'gross', percentBps: 6000 })).toEqual({
      grossMinor: 1_200,
      gstMinor: 0,
      feeMinor: 36,
      netMinor: 1_164,
      instructorMinor: 698,
      embodhaMinor: 466,
    });
  });

  it('iOS sale in India: Apple takes 15% of the price after tax', () => {
    expect(computeSplit({ grossMinor: 99_900, gstRateBps: 1800, feeRateBps: 1500, feeBase: 'after_gst', percentBps: 6000 })).toEqual({
      grossMinor: 99_900,
      gstMinor: 15_239,
      feeMinor: 12_699,
      netMinor: 71_962,
      instructorMinor: 43_177,
      embodhaMinor: 28_785,
    });
  });

  it('uses the fee the provider reported over an estimate', () => {
    const split = computeSplit({ grossMinor: 99_900, gstRateBps: 1800, feeMinor: 2_100, feeRateBps: 200, percentBps: 6000 });
    expect(split).toMatchObject({ feeMinor: 2_100, netMinor: 82_561, instructorMinor: 49_537, embodhaMinor: 33_024 });
  });

  it('never loses or invents a paisa when rounding', () => {
    for (let gross = 100; gross <= 500_000; gross += 997) {
      for (const percentBps of [0, 3333, 5000, 6000, 6667, 10_000]) {
        const split = computeSplit({ grossMinor: gross, gstRateBps: 1800, feeRateBps: 200, percentBps });
        expect(split.instructorMinor + split.embodhaMinor).toBe(split.netMinor);
        expect(split.gstMinor + split.feeMinor + split.netMinor).toBe(gross);
      }
    }
  });

  it('refuses inputs that would corrupt the ledger', () => {
    expect(() => computeSplit({ grossMinor: 999.5, gstRateBps: 1800, percentBps: 6000 })).toThrow();
    expect(() => computeSplit({ grossMinor: 99_900, gstRateBps: 1800, percentBps: 10_001 })).toThrow();
    expect(() => computeSplit({ grossMinor: 1_000, gstRateBps: 0, feeMinor: 1_001, percentBps: 6000 })).toThrow();
  });
});
