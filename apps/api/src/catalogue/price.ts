export type Currency = 'INR' | 'USD';

export interface PriceLike {
  inrPaise: number;
  usdCents: number;
}

export interface Price {
  currency: Currency;
  amountMinor: number;
  display: string;
}

/** INR prices already include 18% GST; USD prices carry none. Both come from the same price point. */
export function priceIn(point: PriceLike | null | undefined, currency: Currency): Price | null {
  if (!point) return null;
  const amountMinor = currency === 'INR' ? point.inrPaise : point.usdCents;
  const digits = amountMinor % 100 === 0 ? 0 : 2;
  const display = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 100);
  return { currency, amountMinor, display };
}

/** An explicit ?currency= wins, then the member's country. Guests see INR until the app passes their region. */
export function resolveCurrency(requested: string | undefined, country: string | null | undefined): Currency {
  const upper = requested?.toUpperCase();
  if (upper === 'INR' || upper === 'USD') return upper;
  if (country) return country === 'IN' ? 'INR' : 'USD';
  return 'INR';
}

export interface Viewer {
  userId: string | null;
  currency: Currency;
}
