/**
 * How one payment divides between an instructor and Embodha (spec: "The split").
 *
 *   net        = price - GST - fee
 *   instructor = percent x net, rounded to the nearest paisa or cent
 *   Embodha    = net - instructor, so the two always add up to the net exactly
 *
 * Everything is in minor units (paise or cents). Percentages are basis points: 6000 = 60%.
 */
export interface SplitInput {
  /** What the buyer paid. For Indian buyers this already includes GST. */
  grossMinor: number;
  /** 1800 for buyers in India, 0 for buyers abroad. */
  gstRateBps: number;
  /** The fee the gateway or store actually reported. Preferred over an estimate whenever it's known. */
  feeMinor?: number;
  /** Used only when feeMinor is missing: Razorpay 200 or 300, Apple and Google 1500. */
  feeRateBps?: number;
  /** Razorpay charges on the full price; Apple and Google take their cut from the price after tax. */
  feeBase?: 'gross' | 'after_gst';
  /** The instructor's admin-set percentage at the moment of sale. */
  percentBps: number;
}

export interface SplitResult {
  grossMinor: number;
  gstMinor: number;
  feeMinor: number;
  netMinor: number;
  instructorMinor: number;
  embodhaMinor: number;
}

const isWhole = (n: number) => Number.isInteger(n) && n >= 0;

/** GST inside a GST-inclusive price: 999.00 at 18% holds 152.39 of tax. */
export function gstInside(grossMinor: number, rateBps: number): number {
  return Math.round(grossMinor - (grossMinor * 10_000) / (10_000 + rateBps));
}

export function computeSplit(input: SplitInput): SplitResult {
  const { grossMinor, gstRateBps, percentBps } = input;
  if (!isWhole(grossMinor)) throw new Error('grossMinor must be a whole number of paise or cents');
  if (!isWhole(gstRateBps) || gstRateBps > 10_000) throw new Error('gstRateBps must be between 0 and 10000');
  if (!isWhole(percentBps) || percentBps > 10_000) throw new Error('percentBps must be between 0 and 10000');

  const gstMinor = gstRateBps > 0 ? gstInside(grossMinor, gstRateBps) : 0;
  const afterGst = grossMinor - gstMinor;
  const feeBase = input.feeBase === 'after_gst' ? afterGst : grossMinor;
  const feeMinor = input.feeMinor ?? Math.round((feeBase * (input.feeRateBps ?? 0)) / 10_000);
  if (!isWhole(feeMinor)) throw new Error('feeMinor must be a whole number of paise or cents');

  const netMinor = afterGst - feeMinor;
  if (netMinor < 0) throw new Error('fees are larger than the price after tax');
  const instructorMinor = Math.round((netMinor * percentBps) / 10_000);
  return { grossMinor, gstMinor, feeMinor, netMinor, instructorMinor, embodhaMinor: netMinor - instructorMinor };
}
