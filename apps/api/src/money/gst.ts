import { fail } from '../common/errors';
import { BUSINESS_TIME_ZONE } from '../common/month';
import type { InvoiceSeller } from '../db/schema';
import { localDay } from '../practice/streak';

/**
 * GST on Embodha's own invoices (website sales through Razorpay): where a sale is taxed, and how its GST divides.
 *
 * A sale to someone in India is taxed where they are: the state on their account. For online services to unregistered
 * buyers, CBIC circular 242/36/2024-GST makes that state compulsory on every invoice, whatever the amount, and says to
 * collect it before the sale; checkout asks for it. Only a renewal for someone who never gave one falls back to the
 * seller's state (IGST Act, section 12(2)(b)(ii)), and the GST page flags it. Same state as the seller: half CGST,
 * half SGST (UTGST in a union territory without a legislature). Another state: all IGST. Buyers abroad pay no GST:
 * the sale is an export, which GSTR-1 files under place of supply 96, "other countries". App Store and Google Play
 * sales aren't split here, because there the store is the seller and accounts for the tax.
 */

/** Every state and union territory by its GST code, the two digits a GSTIN starts with. */
export const INDIAN_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};
export const STATE_CODES = Object.keys(INDIAN_STATES);

/** Until finance fills in Money settings. */
export const DEFAULT_SELLER: InvoiceSeller = { name: 'Embodha', address: '', gstin: '', sac: '' };

/** GSTR-1's place of supply for exports. */
export const OUTSIDE_INDIA = '96';

/** Union territories without a legislature charge UTGST where a state charges SGST. */
const UTGST_TERRITORIES = new Set(['04', '26', '31', '35', '38']);

export const isStateCode = (code: string | null | undefined): code is string => Boolean(code && code in INDIAN_STATES);

/** "Karnataka (29)", or "Outside India (96)" for exports. */
export function placeLabel(code: string | null | undefined) {
  if (code === OUTSIDE_INDIA) return `Outside India (${OUTSIDE_INDIA})`;
  return isStateCode(code) ? `${INDIAN_STATES[code]} (${code})` : null;
}

export const stateTaxName = (sellerState: string | null) => (sellerState && UTGST_TERRITORIES.has(sellerState) ? 'UTGST' : 'SGST');

/* ------------------------------------------------------------------ GSTIN */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The 15th character of a GSTIN: Luhn mod 36 over the first 14, the way the GST Network computes it. */
export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = ALPHABET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

/** Why a GSTIN can't be right, in words for the Money settings page, or null if it looks right. */
export function gstinProblem(gstin: string): string | null {
  if (!GSTIN_SHAPE.test(gstin)) return 'A GSTIN is 15 characters: two digits, the PAN, then three more. Check it against the registration certificate.';
  if (!isStateCode(gstin.slice(0, 2))) return `A GSTIN starts with a state code, and ${gstin.slice(0, 2)} isn't one.`;
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "That GSTIN's last character doesn't match the rest, so there's a typo somewhere.";
  return null;
}

/** The seller's state, from the first two digits of its GSTIN. Null until a GSTIN is set. */
export const sellerStateOf = (gstin: string | null | undefined) => (gstin && !gstinProblem(gstin) ? gstin.slice(0, 2) : null);

/** The state on a member's account, if they're in India and gave a real one. */
export const buyerStateOf = (user: { country: string | null; state: string | null }) => (user.country === 'IN' && isStateCode(user.state) ? user.state : null);

/** Before taking rupees on the website: the invoice has to name the buyer's state, so it has to be on record. */
export function requireIndianState(user: { country: string | null; state: string | null }, currency: 'INR' | 'USD') {
  if (currency === 'INR' && !buyerStateOf(user)) {
    throw fail(409, 'state_needed', 'Add your state under You, Your details, first. GST rules need it on your invoice.');
  }
}

/* ------------------------------------------------------------- The split */

export interface GstSplit {
  /** A state code, 96 for an export, or null when nothing can be said (no GSTIN yet). */
  placeOfSupply: string | null;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
}

/**
 * Where a sale is taxed and how its GST divides. The parts always add up to the GST already booked: when it's an
 * odd number of paise, SGST carries the extra one (₹152.39 is ₹76.19 CGST and ₹76.20 SGST).
 */
export function splitGst(input: { currency: 'INR' | 'USD'; gstMinor: number; buyerState: string | null; sellerState: string | null }): GstSplit {
  const none = { cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  if (input.currency !== 'INR') return { placeOfSupply: OUTSIDE_INDIA, ...none };
  if (!input.sellerState) return { placeOfSupply: isStateCode(input.buyerState) ? input.buyerState : null, ...none };
  const placeOfSupply = isStateCode(input.buyerState) ? input.buyerState : input.sellerState;
  if (placeOfSupply !== input.sellerState) return { placeOfSupply, ...none, igstMinor: input.gstMinor };
  const cgstMinor = Math.floor(input.gstMinor / 2);
  return { placeOfSupply, cgstMinor, sgstMinor: input.gstMinor - cgstMinor, igstMinor: 0 };
}

/* ------------------------------------------------------- Document numbers */

/** The financial year as GSTR-1 likes it short: "26-27" for anything from April 2026 to March 2027. */
export function shortFinancialYear(at: Date) {
  const [y, m] = localDay(at, BUSINESS_TIME_ZONE).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST invoice and credit note numbers may be at most 16 characters: EMB/26-27/000042 and CN/26-27/000007 fit. */
export const MAX_DOCUMENT_NUMBER = 16;
