import { gstinCheckChar, gstinProblem, MAX_DOCUMENT_NUMBER, placeLabel, sellerStateOf, shortFinancialYear, splitGst, STATE_CODES, stateTaxName } from './gst';

/** A made-up GSTIN for a company in Karnataka, with the check digit worked out. */
const karnataka = (() => {
  const first14 = '29ABCDE1234F1Z';
  return first14 + gstinCheckChar(first14);
})();

describe('GSTIN', () => {
  it('agrees with the check digits on real-shaped GSTINs, including the GST Network’s own example', () => {
    for (const gstin of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '33AAACH7409R1Z8']) expect(gstinProblem(gstin)).toBeNull();
  });

  it('catches a typo, a wrong shape and a state code that doesn’t exist', () => {
    expect(gstinProblem('27AAPFU0939F1ZW')).toMatch(/typo/);
    expect(gstinProblem('27AAPFU0939F1Z')).toMatch(/15 characters/);
    expect(gstinProblem('25AAPFU0939F1ZV')).toMatch(/isn't one/); // 25 was Daman and Diu, merged into 26 in 2020
  });

  it('gives the seller’s state, once the GSTIN is a real one', () => {
    expect(sellerStateOf(karnataka)).toBe('29');
    expect(sellerStateOf('')).toBeNull();
    const typo = karnataka.slice(0, 14) + (karnataka[14] === '0' ? '1' : '0');
    expect(sellerStateOf(typo)).toBeNull();
  });
});

describe('splitting GST', () => {
  const sale = { currency: 'INR' as const, gstMinor: 15_239, sellerState: '29' };

  it('halves it into CGST and SGST within the seller’s state, with the odd paisa on SGST', () => {
    expect(splitGst({ ...sale, buyerState: '29' })).toEqual({ placeOfSupply: '29', cgstMinor: 7619, sgstMinor: 7620, igstMinor: 0 });
    expect(splitGst({ ...sale, gstMinor: 15_238, buyerState: '29' })).toMatchObject({ cgstMinor: 7619, sgstMinor: 7619 });
  });

  it('makes it all IGST for a buyer in another state', () => {
    expect(splitGst({ ...sale, buyerState: '27' })).toEqual({ placeOfSupply: '27', cgstMinor: 0, sgstMinor: 0, igstMinor: 15_239 });
  });

  it('taxes it in the seller’s state when the buyer’s isn’t on record (IGST Act, section 12(2)(b)(ii))', () => {
    expect(splitGst({ ...sale, buyerState: null })).toMatchObject({ placeOfSupply: '29', cgstMinor: 7619, sgstMinor: 7620 });
    expect(splitGst({ ...sale, buyerState: '99' })).toMatchObject({ placeOfSupply: '29' });
  });

  it('files a dollar sale as an export, place of supply 96, with no tax', () => {
    expect(splitGst({ currency: 'USD', gstMinor: 0, buyerState: null, sellerState: '29' })).toEqual({ placeOfSupply: '96', cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
    expect(placeLabel('96')).toBe('Outside India (96)');
  });

  it('leaves GST in one piece until the seller has a GSTIN', () => {
    expect(splitGst({ ...sale, sellerState: null, buyerState: '27' })).toEqual({ placeOfSupply: '27', cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
  });

  it('always adds up to the GST booked', () => {
    for (let gst = 0; gst < 500; gst += 7) {
      const intra = splitGst({ ...sale, gstMinor: gst, buyerState: '29' });
      expect(intra.cgstMinor + intra.sgstMinor + intra.igstMinor).toBe(gst);
      expect(intra.sgstMinor - intra.cgstMinor).toBeLessThanOrEqual(1);
    }
  });

  it('calls it UTGST where the seller is in a union territory without a legislature', () => {
    expect(stateTaxName('04')).toBe('UTGST'); // Chandigarh
    expect(stateTaxName('07')).toBe('SGST'); // Delhi has a legislature
    expect(stateTaxName('29')).toBe('SGST');
  });
});

describe('document numbers', () => {
  it('uses the short financial year, turning over in April, Indian time', () => {
    expect(shortFinancialYear(new Date('2026-10-22T10:00:00+05:30'))).toBe('26-27');
    expect(shortFinancialYear(new Date('2027-03-31T23:30:00+05:30'))).toBe('26-27');
    expect(shortFinancialYear(new Date('2027-03-31T19:00:00Z'))).toBe('27-28'); // 12:30 a.m. on 1 April in India
  });

  it('stays within the 16 characters GST allows', () => {
    expect(`EMB/26-27/${'9'.repeat(6)}`).toHaveLength(MAX_DOCUMENT_NUMBER);
    expect(`CN/26-27/${'9'.repeat(6)}`.length).toBeLessThanOrEqual(MAX_DOCUMENT_NUMBER);
  });

  it('knows all 36 states and union territories', () => {
    expect(STATE_CODES).toHaveLength(36);
  });
});
