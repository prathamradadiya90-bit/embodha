import { deflateRawSync, gzipSync } from 'node:zlib';
import { appleFinancial, fromHeader, headerOf, inPaise, openReport, playEarnings, razorpayFromApi, razorpayFromFile, readTable, ReportError, toDate, toMinor, unzip } from './reports';

/** A zip as Play's Cloud Storage hands it out: a central directory, one stored entry and one deflated. CRCs aren't read. */
function zip(entries: { name: string; text: string; deflate: boolean }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.text, 'utf8');
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('reading report files', () => {
  it('opens plain, gzipped and zipped reports, and UTF-16 spreadsheet exports', () => {
    expect(openReport('a.csv', Buffer.from('x,y\n1,2'))).toEqual([{ name: 'a.csv', text: 'x,y\n1,2' }]);
    expect(openReport('financial.txt.gz', gzipSync('Quantity\tPartner Share\n1\t2.00'))).toEqual([{ name: 'financial.txt', text: 'Quantity\tPartner Share\n1\t2.00' }]);
    const files = openReport(
      'earnings_202609.zip',
      zip([
        { name: 'earnings_202609_1.csv', text: 'Description,Amount\nGPA.1,1.00', deflate: true },
        { name: 'readme/', text: '', deflate: false },
        { name: 'earnings_202609_2.csv', text: 'Description,Amount\nGPA.2,2.00', deflate: false },
      ]),
    );
    expect(files.map((f) => [f.name, f.text])).toEqual([
      ['earnings_202609_1.csv', 'Description,Amount\nGPA.1,1.00'],
      ['earnings_202609_2.csv', 'Description,Amount\nGPA.2,2.00'],
    ]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('entity_id,amount', 'utf16le')]);
    expect(openReport('dashboard.csv', utf16)[0].text).toBe('entity_id,amount');
    expect(() => openReport('empty.zip', zip([{ name: 'notes.pdf', text: 'x', deflate: false }]))).toThrow(ReportError);
    expect(() => unzip(Buffer.from('PK\u0003\u0004 not really a zip'))).toThrow(ReportError);
  });

  it('reads CSV with quotes and commas, and tab files without quoting', () => {
    expect(readTable('Description,Product Title,Amount\r\nGPA.1,"Morning Breath, 5 Days",999.00\r\nGPA.2,"Say ""hi""",1\r\n')).toEqual([
      { description: 'GPA.1', producttitle: 'Morning Breath, 5 Days', amount: '999.00' },
      { description: 'GPA.2', producttitle: 'Say "hi"', amount: '1' },
    ]);
    expect(readTable('Title\tQuantity\n"Quoted" title\t2\n')).toEqual([{ title: '"Quoted" title', quantity: '2' }]);
    expect(readTable('a;b\n1;2')).toEqual([{ a: '1', b: '2' }]);
    // A title above the header, as some exports have.
    const titled = 'Settlement report for October\n\nentity_id,type,amount\npay_1,payment,999.00';
    expect(headerOf(titled)).toEqual(['entityid', 'type', 'amount']);
    expect(readTable(fromHeader(titled))).toEqual([{ entityid: 'pay_1', type: 'payment', amount: '999.00' }]);
    // A trailing comma is harmless; a comma nobody quoted would shift every value after it.
    expect(readTable('a,b\n1,2,\n')).toEqual([{ a: '1', b: '2' }]);
    expect(() => readTable('Description,Product Title,Amount\nGPA.1,Asha Rao, monthly,499.00\n')).toThrow(/Row 1 of the report has more columns than its header/);
  });

  it('turns amounts into hundredths and dates into days, the ways the reports write them', () => {
    expect(toMinor('1,234.56')).toBe(123_456);
    expect(toMinor('-12.3')).toBe(-1230);
    expect(toMinor('(5.00)')).toBe(-500);
    expect(toMinor('₹999')).toBe(99_900);
    expect(toMinor('0.005')).toBe(1);
    expect(toMinor('152.394')).toBe(15_239);
    expect(toMinor('abc')).toBeNull();
    expect(toMinor('')).toBeNull();
    expect(toDate(1_761_000_000)?.toISOString()).toBe('2025-10-20T22:40:00.000Z');
    expect(toDate('2026-10-22')?.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(toDate('22/10/2026')?.toISOString().slice(0, 10)).toBe('2026-10-22');
    expect(toDate('10/22/2026', 'mdy')?.toISOString().slice(0, 10)).toBe('2026-10-22');
    expect(toDate('Oct 22, 2026')?.toISOString().slice(0, 10)).toBe('2026-10-22');
    expect(toDate('22 Oct 2026')?.toISOString().slice(0, 10)).toBe('2026-10-22');
    expect(toDate('someday')).toBeNull();
  });
});

describe("Razorpay's settlement recon", () => {
  it('takes the API as it comes, in paise', () => {
    const [item] = razorpayFromApi([
      { entity_id: 'pay_1', type: 'payment', amount: 99_900, currency: 'INR', fee: 2358, tax: 360, credit: 97_542, debit: 0, settled_at: 1_761_000_000, settlement_id: 'setl_1', settlement_utr: 'UTR1' },
      { type: 'payment' }, // no entity: not a transaction
    ]);
    expect(item).toMatchObject({ entityId: 'pay_1', type: 'payment', currency: 'INR', amount: 99_900, fee: 2358, tax: 360, credit: 97_542, settlementId: 'setl_1', utr: 'UTR1' });
  });

  it('reads the dashboard file in rupees, and notices when it might be paise', () => {
    const rupees = razorpayFromFile('entity_id,type,amount,currency,fee,tax,credit,debit,settled_at,settlement_id\npay_1,payment,999.00,INR,23.58,3.60,975.42,0,22/10/2026,setl_1');
    expect(rupees.decimals).toBe(true);
    expect(rupees.items[0]).toMatchObject({ amount: 99_900, fee: 2358, tax: 360, credit: 97_542, settlementId: 'setl_1' });
    expect(rupees.items[0].settledAt?.toISOString().slice(0, 10)).toBe('2026-10-22');
    const unclear = razorpayFromFile('entity_id,type,amount,fee,tax,credit,debit\npay_1,payment,99900,2358,360,97542,0');
    expect(unclear.decimals).toBe(false);
    expect(inPaise(unclear.items)[0]).toMatchObject({ amount: 99_900, fee: 2358, tax: 360, credit: 97_542 });
    expect(() => razorpayFromFile('id,total\n1,2')).toThrow(ReportError);
  });
});

describe("Google Play's earnings report", () => {
  const header =
    'Description,Transaction Date,Transaction Time,Tax Type,Transaction Type,Refund Type,Product Title,Package ID,Product Type,SKU ID,Hardware,Buyer Country,Buyer State,Buyer Postcode,Buyer Currency,Amount (Buyer Currency),Currency Conversion Rate,Merchant Currency,Amount (Merchant Currency),Base Plan or Purchase Option ID,Offer ID,Group ID,First USD 1M Eligible,Service Fee %,Fee Description,Promotion ID,Sales Channel';
  const row = (order: string, date: string, type: string, buyer: string, merchant: string, currency = 'INR', sku = 'course.gentle_spine') =>
    `${order},"${date}",10:02:12 AM UTC,,${type},,Gentle Spine,com.embodha.app,inapp,${sku},,IN,KA,,${currency},${buyer},1,INR,${merchant},,,,,15,,,`;

  it('adds up each order: the charge, Google’s fee and any tax, and its refund', () => {
    const report = playEarnings(
      [
        header,
        row('GPA.1111-2222-3333-44444', 'Sep 3, 2026', 'Charge', '999.00', '999.00'),
        row('GPA.1111-2222-3333-44444', 'Sep 3, 2026', 'Tax', '-152.39', '-152.39'),
        row('GPA.1111-2222-3333-44444', 'Sep 3, 2026', 'Google fee', '-126.99', '-126.99'),
        row('GPA.1111-2222-3333-55555..1', 'Sep 9, 2026', 'Charge', '12.00', '1014.00', 'USD', 'plan.asha_rao'),
        row('GPA.1111-2222-3333-55555..1', 'Sep 9, 2026', 'Google fee', '-1.80', '-152.10', 'USD', 'plan.asha_rao'),
        row('GPA.1111-2222-3333-66666', 'Sep 20, 2026', 'Charge refund', '-999.00', '-999.00'),
        row('GPA.1111-2222-3333-66666', 'Sep 20, 2026', 'Google fee refund', '126.99', '126.99'),
        `Adjustment,"Sep 30, 2026",,,Adjustment,,,,,,,,,,,,,INR,-50.00,,,,,,,,`,
      ].join('\n'),
    );
    expect(report.merchantCurrency).toBe('INR');
    expect(report.period).toEqual({ start: '2026-09-03', end: '2026-09-30' });
    const [one, renewal, refunded] = report.orders;
    expect(one).toMatchObject({ orderId: 'GPA.1111-2222-3333-44444', skuId: 'course.gentle_spine', packageId: 'com.embodha.app', buyerCurrency: 'INR', refund: null });
    expect(one.sale).toEqual({ charge: { buyer: 99_900, merchant: 99_900 }, fee: { buyer: -12_699, merchant: -12_699 }, tax: { buyer: -15_239, merchant: -15_239 } });
    expect(renewal.sale).toMatchObject({ charge: { buyer: 1200, merchant: 101_400 }, fee: { merchant: -15_210 } });
    expect(refunded).toMatchObject({ sale: null, refund: { charge: { merchant: -99_900 }, fee: { merchant: 12_699 } } });
    expect(report.others).toEqual([expect.objectContaining({ type: 'Adjustment', merchant: -5000 })]);
  });

  it('refuses a file that isn’t one, or mixes payout currencies', () => {
    expect(() => playEarnings('Order,Amount\nGPA.1,2')).toThrow(/Google Play's earnings report/);
    expect(() => playEarnings([header, row('GPA.1111-2222-3333-44444', 'Sep 3, 2026', 'Charge', '1', '1'), row('GPA.1111-2222-3333-44445', 'Sep 3, 2026', 'Charge', '1', '1').replace(',1,INR,1,', ',1,USD,1,')].join('\n'))).toThrow(/mixes/);
  });
});

describe("the App Store's financial report", () => {
  const header =
    'Start Date\tEnd Date\tUPC\tISRC/ISBN\tVendor Identifier\tQuantity\tPartner Share\tExtended Partner Share\tPartner Share Currency\tSales or Return\tApple Identifier\tArtist/Show/Developer/Author\tTitle\tLabel/Studio/Network/Developer/Publisher\tGrid\tProduct Type Identifier\tISAN/Other Identifier\tCountry Of Sale\tPre-order Flag\tPromo Code\tCustomer Price\tCustomer Currency';
  const row = (product: string, quantity: number, share: string, extended: string, currency: string, saleOrReturn: string, country: string, price: string, customerCurrency: string) =>
    ['08/30/2026', '09/26/2026', '', product, product, quantity, share, extended, currency, saleOrReturn, '6740000000', 'Embodha Wellness Pvt Ltd', product, '', '', 'IA1', '', country, '', '', price, customerCurrency].join('\t');

  it('reads units and proceeds per product and price, returns included, totals left out', () => {
    const rows = appleFinancial(
      [
        header,
        row('course.gentle_spine', 3, '719.62', '2158.86', 'INR', 'S', 'IN', '999.00', 'INR'),
        row('course.gentle_spine', -1, '719.62', '-719.62', 'INR', 'R', 'IN', '-999.00', 'INR'),
        row('course.gentle_spine', 1, '10.20', '10.20', 'USD', 'S', 'US', '12.00', 'USD'),
        '',
        'Total_Rows\t3',
        'Total_Amount\t1449.44',
        'Total_Units\t3',
      ].join('\n'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      periodStart: '2026-08-30',
      periodEnd: '2026-09-26',
      productId: 'course.gentle_spine',
      title: 'course.gentle_spine',
      quantity: 3,
      partnerShare: 71_962,
      extendedPartnerShare: 215_886,
      partnerShareCurrency: 'INR',
      sale: true,
      country: 'IN',
      customerPrice: '999.00',
      customerCurrency: 'INR',
    });
    expect(rows[1]).toMatchObject({ quantity: -1, sale: false, customerPrice: '999.00', extendedPartnerShare: -71_962 });
    expect(rows[2]).toMatchObject({ partnerShareCurrency: 'USD', partnerShare: 1020, customerPrice: '12.00' });
    expect(() => appleFinancial('Quantity\tTitle\n1\tx')).toThrow(/financial report/);
  });
});
