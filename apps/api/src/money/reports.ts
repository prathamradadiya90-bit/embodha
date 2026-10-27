import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * Reading the three reports that say what the channels actually paid: Razorpay's settlement recon (from its API, or
 * the dashboard's CSV), Google Play's monthly earnings report (CSV, often zipped), and the App Store's monthly
 * financial report (tab-separated text, gzipped when it comes from the API). Everything here is pure, so each
 * format is tested on its own (reports.spec.ts); matching against the books is ReconciliationService's job.
 */

export class ReportError extends Error {}

/* ------------------------------------------------------------------ Files */

export interface ReportFile {
  name: string;
  text: string;
}

/** The text in an upload: plain, gzipped (App Store Connect's API), or zipped (Play's reports in Cloud Storage). */
export function openReport(name: string, data: Buffer): ReportFile[] {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return [{ name: name.replace(/\.gz$/i, ''), text: decode(gunzipSync(data)) }];
  if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
    const files = unzip(data)
      .filter((entry) => !entry.name.endsWith('/') && /\.(csv|txt|tsv)$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, text: decode(entry.data) }));
    if (!files.length) throw new ReportError('That zip file has no CSV or text report in it.');
    return files;
  }
  return [{ name, text: decode(data) }];
}

/** UTF-8, or UTF-16 with a byte-order mark (some spreadsheet exports), without the mark. */
function decode(data: Buffer) {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data[0] === 0xfe && data[1] === 0xff) return Buffer.from(data.subarray(2)).swap16().toString('utf16le');
  return data.toString('utf8').replace(/^﻿/, '');
}

/** The files in a zip, read through its central directory. Stored and deflated entries; no zip64 or encryption. */
export function unzip(zip: Buffer): { name: string; data: Buffer }[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ReportError("That zip file couldn't be opened.");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new ReportError('That zip file is damaged.');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ReportError('That zip file is password-protected.');
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new ReportError('That zip file is damaged.');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new ReportError(`That zip file uses a kind of compression Embodha can't open (${method}).`);
  }
  return out;
}

/* ------------------------------------------------------------------ Tables */

/** A header name as a key: lower case, letters and digits only. "Amount (Merchant Currency)" is amountmerchantcurrency. */
export const keyOf = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Rows of a CSV or tab-separated file, as records keyed by keyOf(header). Commas and semicolons follow CSV quoting;
 * tabs don't quote at all, because the App Store's files don't, and a title may start with a quote mark.
 */
export function readTable(text: string): Record<string, string>[] {
  const newline = text.indexOf('\n');
  const first = newline < 0 ? text : text.slice(0, newline);
  const delimiter = first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',';
  const quoting = delimiter !== '\t';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (quoting && c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const filled = rows.filter((r) => r.some((value) => value.trim() !== ''));
  if (filled.length < 1) return [];
  const header = filled[0].map((h) => keyOf(h.trim()));
  // A row can be shorter than the header (the App Store's totals at the end) but not longer: its values wouldn't line up.
  const long = filled.findIndex((values, i) => i > 0 && values.slice(header.length).some((value) => value.trim() !== ''));
  if (long > 0) {
    throw new ReportError(
      `Row ${long} of the report has more columns than its header, so its values can't be lined up. A field with a comma in it needs quotes around it; download the report again rather than saving it from a spreadsheet.`,
    );
  }
  return filled.slice(1).map((values) => Object.fromEntries(header.map((key, i) => [key, (values[i] ?? '').trim()])));
}

const has = (records: Record<string, string>[], ...keys: string[]) => records.length > 0 && keys.every((key) => key in records[0]);

/** Known column names in a report, wherever its header row is. */
const KNOWN = ['entityid', 'transactiontype', 'partnershare', 'amountmerchantcurrency', 'vendoridentifier', 'settlementid'];

/**
 * A report from its header row on: some exports put a title or a blank line above it. The header is the first of
 * the first ten lines that names a column Embodha knows.
 */
export function fromHeader(text: string) {
  const lines = text.split(/\r?\n/);
  const at = lines.slice(0, 10).findIndex((line) => {
    const keys = line.split(/[\t,;]/).map((cell) => keyOf(cell.replace(/"/g, '')));
    return keys.some((key) => KNOWN.includes(key));
  });
  return at > 0 ? lines.slice(at).join('\n') : text;
}

/** The keys of a report's header row, to tell which report it is. */
export function headerOf(text: string): string[] {
  const start = fromHeader(text);
  const end = start.indexOf('\n');
  const first = (end < 0 ? start : start.slice(0, end)).replace(/\r$/, '');
  const delimiter = first.includes('\t') ? '\t' : first.split(';').length > first.split(',').length ? ';' : ',';
  return first.split(delimiter).map((cell) => keyOf(cell.replace(/"/g, '')));
}

/* ------------------------------------------------------------------ Numbers and dates */

/**
 * A decimal amount as minor units (hundredths), rounded half up at the third decimal: "1,234.56" is 123456,
 * "-12.3" is -1230, "(5.00)" is -500. Currency signs and spaces are ignored. Null for anything that isn't a number.
 */
export function toMinor(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let s = value.trim().replace(/[,\s₹$€£]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  const match = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!match || (match[1] === '' && !match[2])) return null;
  const fraction = (match[2] ?? '').padEnd(3, '0');
  let minor = Number(match[1] || '0') * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) minor += 1;
  return negative ? -minor : minor;
}

/** Whole minor units, as Razorpay's API sends them. */
const toInt = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : 0);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date as the reports write them, at midnight UTC unless a time is given: Unix seconds (Razorpay's API),
 * 2026-10-22, 22/10/2026 or 10/22/2026 (order says which), "Oct 22, 2026" and "22 Oct 2026" (Play).
 */
export function toDate(value: unknown, order: 'dmy' | 'mdy' = 'dmy'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const time = (h?: string, m?: string, sec?: string) => [Number(h ?? 0), Number(m ?? 0), Number(sec ?? 0)] as const;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], ...time(match[4], match[5], match[6])));
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (match) {
    const [day, month] = order === 'dmy' ? [+match[1], +match[2]] : [+match[2], +match[1]];
    return new Date(Date.UTC(+match[3], month - 1, day, ...time(match[4], match[5], match[6])));
  }
  match = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s) ?? null;
  if (match && MONTHS.includes(match[1].toLowerCase())) return new Date(Date.UTC(+match[3], MONTHS.indexOf(match[1].toLowerCase()), +match[2]));
  match = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})/.exec(s);
  if (match && MONTHS.includes(match[2].toLowerCase())) return new Date(Date.UTC(+match[3], MONTHS.indexOf(match[2].toLowerCase()), +match[1]));
  return null;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ Razorpay */

/** One settled transaction. Amounts in minor units of `currency`; credit is what was paid in, debit what was taken. */
export interface RazorpayItem {
  entityId: string;
  /** payment, refund, adjustment, transfer… */
  type: string;
  currency: string;
  amount: number;
  /** Razorpay's fee including the GST on it, as Razorpay reports it. */
  fee: number;
  /** The GST part of the fee. */
  tax: number;
  credit: number;
  debit: number;
  settledAt: Date | null;
  settlementId: string | null;
  utr: string | null;
  /** For a refund or transfer: the payment it belongs to. */
  paymentId: string | null;
  orderId: string | null;
  description: string | null;
  disputeId: string | null;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** From the settlement recon API: amounts in paise already. */
export function razorpayFromApi(items: Record<string, unknown>[]): RazorpayItem[] {
  return items
    .filter((item) => text(item.entity_id))
    .map((item) => ({
      entityId: String(item.entity_id),
      type: String(item.type ?? '').toLowerCase(),
      currency: (text(item.currency) ?? 'INR').toUpperCase(),
      amount: toInt(item.amount),
      fee: toInt(item.fee),
      tax: toInt(item.tax),
      credit: toInt(item.credit),
      debit: toInt(item.debit),
      settledAt: toDate(item.settled_at),
      settlementId: text(item.settlement_id),
      utr: text(item.settlement_utr),
      paymentId: text(item.payment_id),
      orderId: text(item.order_id),
      description: text(item.description),
      disputeId: text(item.dispute_id),
    }));
}

/**
 * From the dashboard's settlement report, saved as CSV. Its amounts are in rupees; if none has decimals, the file
 * may be in paise instead, which the importer settles by checking amounts against the books (`decimals: false`).
 */
export function razorpayFromFile(content: string): { items: RazorpayItem[]; decimals: boolean } {
  const records = readTable(fromHeader(content));
  if (!has(records, 'entityid', 'type', 'amount')) throw new ReportError("This doesn't look like Razorpay's settlement report: it needs entity_id, type and amount columns.");
  const amountKeys = ['amount', 'fee', 'tax', 'credit', 'debit'];
  const decimals = records.some((record) => amountKeys.some((key) => (record[key] ?? '').includes('.')));
  const minor = (value: string | undefined) => toMinor(value ?? '') ?? 0;
  const items = records
    .filter((record) => record.entityid)
    .map((record) => ({
      entityId: record.entityid,
      type: record.type.toLowerCase(),
      currency: (record.currency || 'INR').toUpperCase(),
      amount: minor(record.amount),
      fee: minor(record.fee),
      tax: minor(record.tax),
      credit: minor(record.credit),
      debit: minor(record.debit),
      settledAt: toDate(record.settledat, 'dmy'),
      settlementId: text(record.settlementid),
      utr: text(record.settlementutr),
      paymentId: text(record.paymentid),
      orderId: text(record.orderid),
      description: text(record.description),
      disputeId: text(record.disputeid),
    }));
  return { items, decimals };
}

/** The same items with every amount divided by 100: for a report that turned out to be in paise. */
export const inPaise = (items: RazorpayItem[]): RazorpayItem[] =>
  items.map((item) => ({ ...item, amount: item.amount / 100, fee: item.fee / 100, tax: item.tax / 100, credit: item.credit / 100, debit: item.debit / 100 }));

/* ------------------------------------------------------------------ Google Play */

/** Amounts in the buyer's currency and in Embodha's (the merchant's), in hundredths, as the report adds them up. */
export interface PlayMoney {
  buyer: number;
  merchant: number;
}

export interface PlayParts {
  charge: PlayMoney;
  fee: PlayMoney;
  tax: PlayMoney;
}

/** Every line the earnings report has for one order: the sale, and its refund if there was one. */
export interface PlayOrder {
  orderId: string;
  /** The app's package name ("Product id" in older reports); skuId is the product bought. */
  packageId: string | null;
  skuId: string | null;
  buyerCountry: string | null;
  buyerCurrency: string;
  date: Date | null;
  sale: PlayParts | null;
  refund: PlayParts | null;
}

/** Money in or out that isn't a sale or a refund of one, like an adjustment. */
export interface PlayOther {
  ref: string;
  type: string;
  description: string;
  merchant: number;
  date: Date | null;
}

export interface PlayEarnings {
  merchantCurrency: string;
  orders: PlayOrder[];
  others: PlayOther[];
  /** The first and last transaction dates, YYYY-MM-DD, UTC as the report is. */
  period: { start: string; end: string } | null;
}

const zero = (): PlayParts => ({ charge: { buyer: 0, merchant: 0 }, fee: { buyer: 0, merchant: 0 }, tax: { buyer: 0, merchant: 0 } });
/** Play's order IDs: GPA.1234-5678-9012-34567, with ..0, ..1 on subscription renewals. */
const PLAY_ORDER = /^GPA\.\d{4}-\d{4}-\d{4}-\d{5}(\.\.\d+)?$/;

/** Play's monthly earnings report: one or more lines per order (Charge, Google fee, Tax, and refunds of each). */
export function playEarnings(content: string): PlayEarnings {
  const records = readTable(fromHeader(content));
  if (!has(records, 'description', 'transactiontype', 'amountmerchantcurrency', 'merchantcurrency')) {
    throw new ReportError("This doesn't look like Google Play's earnings report: it needs Description, Transaction Type, Merchant Currency and Amount (Merchant Currency) columns.");
  }
  const currencies = new Set(records.map((record) => record.merchantcurrency).filter(Boolean));
  if (currencies.size > 1) throw new ReportError(`This report mixes ${[...currencies].join(' and ')}; Embodha's books are in one currency.`);
  const orders = new Map<string, PlayOrder>();
  const others: PlayOther[] = [];
  const dates: number[] = [];
  for (const [index, record] of records.entries()) {
    const type = record.transactiontype.toLowerCase();
    const date = toDate(record.transactiondate);
    if (date) dates.push(date.getTime());
    const amount = { buyer: toMinor(record.amountbuyercurrency) ?? 0, merchant: toMinor(record.amountmerchantcurrency) ?? 0 };
    if (type.includes('adjustment') || !PLAY_ORDER.test(record.description)) {
      others.push({ ref: `${record.description || 'adjustment'}|${record.transactiondate}|${index}`, type: record.transactiontype, description: record.description, merchant: amount.merchant, date });
      continue;
    }
    let order = orders.get(record.description);
    if (!order) {
      order = {
        orderId: record.description,
        packageId: text(record.packageid ?? record.productid),
        skuId: text(record.skuid),
        buyerCountry: text(record.buyercountry),
        buyerCurrency: record.buyercurrency || record.merchantcurrency,
        date,
        sale: null,
        refund: null,
      };
      orders.set(order.orderId, order);
    }
    const refund = type.includes('refund');
    const parts = refund ? (order.refund ??= zero()) : (order.sale ??= zero());
    const part = type.includes('fee') ? parts.fee : type.includes('tax') ? parts.tax : parts.charge;
    part.buyer += amount.buyer;
    part.merchant += amount.merchant;
  }
  dates.sort((a, b) => a - b);
  return {
    merchantCurrency: [...currencies][0] ?? 'INR',
    orders: [...orders.values()],
    others,
    period: dates.length ? { start: day(new Date(dates[0])), end: day(new Date(dates[dates.length - 1])) } : null,
  };
}

/* ------------------------------------------------------------------ App Store */

/** One row of Apple's financial report: units of one product at one price, and Apple's proceeds for each. */
export interface AppleRow {
  periodStart: string;
  periodEnd: string;
  productId: string;
  title: string | null;
  /** Negative for returns. */
  quantity: number;
  /** Proceeds for one unit, in hundredths of partnerShareCurrency. */
  partnerShare: number;
  /** Proceeds for the row: quantity times partner share, as Apple rounds it. */
  extendedPartnerShare: number;
  partnerShareCurrency: string;
  sale: boolean;
  country: string | null;
  /** What the buyer paid for one unit, tax included, as 999.00. */
  customerPrice: string;
  customerCurrency: string;
}

/** Apple's "All Countries or Regions" financial report, single file or detailed. Total lines at the end are skipped. */
export function appleFinancial(content: string): AppleRow[] {
  const records = readTable(fromHeader(content));
  const product = (record: Record<string, string>) => record.vendoridentifier || record.sku || record.isrcisbn || '';
  if (!has(records, 'quantity', 'partnershare', 'partnersharecurrency', 'customerprice', 'customercurrency') || !product(records[0])) {
    throw new ReportError("This doesn't look like the App Store's financial report: it needs Vendor Identifier (or SKU), Quantity, Partner Share, Partner Share Currency, Customer Price and Customer Currency columns.");
  }
  const rows: AppleRow[] = [];
  for (const record of records) {
    const quantity = Number(record.quantity);
    if (!product(record) || !Number.isInteger(quantity) || quantity === 0 || /^total/i.test(Object.values(record)[0] ?? '')) continue;
    const start = toDate(record.startdate, 'mdy');
    const end = toDate(record.enddate, 'mdy');
    const share = toMinor(record.partnershare) ?? 0;
    const price = Math.abs(toMinor(record.customerprice) ?? 0);
    rows.push({
      periodStart: start ? day(start) : '',
      periodEnd: end ? day(end) : '',
      productId: product(record),
      title: text(record.title),
      quantity,
      partnerShare: Math.abs(share),
      extendedPartnerShare: toMinor(record.extendedpartnershare) ?? quantity * Math.abs(share),
      partnerShareCurrency: record.partnersharecurrency.toUpperCase(),
      sale: (record.saleorreturn ?? record.salesorreturn ?? 'S').toUpperCase() !== 'R' && quantity > 0,
      country: text(record.countryofsale),
      customerPrice: (price / 100).toFixed(2),
      customerCurrency: record.customercurrency.toUpperCase(),
    });
  }
  return rows;
}
