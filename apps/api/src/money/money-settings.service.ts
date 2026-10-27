import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { readSetting } from '../common/settings';
import { Db, InjectDb } from '../db/db.module';
import { instructors, InvoiceSeller, settings } from '../db/schema';
import { DEFAULT_SELLER, gstinProblem, placeLabel, sellerStateOf } from './gst';
import { MoneySettingsDto } from './money.dto';

/** Each field on the Money settings page, and the settings key it lives under. */
const KEYS = {
  usdInrRate: ['usd_inr_rate', 88],
  refundWindowDays: ['refund_window_days', 7],
  minPayoutPaise: ['min_payout_paise', 50_000],
  defaultShareBps: ['default_revenue_share_bps', 6000],
  storeCommissionBps: ['store_commission_bps', 1500],
  seller: ['invoice_seller', DEFAULT_SELLER],
  noteIndia: ['invoice_note_india', ''],
  noteAbroad: ['invoice_note_abroad', ''],
} as const;
type Field = keyof typeof KEYS;

@Injectable()
export class MoneySettingsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async get() {
    const entries = await Promise.all((Object.keys(KEYS) as Field[]).map(async (field) => [field, await readSetting(this.db, KEYS[field][0], KEYS[field][1])]));
    const seller = Object.fromEntries(entries).seller as InvoiceSeller;
    return {
      ...Object.fromEntries(entries),
      seller: { ...DEFAULT_SELLER, ...seller },
      // Where the seller is registered decides CGST and SGST or IGST, so the page shows which state the GSTIN says.
      sellerState: placeLabel(sellerStateOf(seller.gstin)),
      gstRateBps: await readSetting(this.db, 'gst_rate_bps', 1800),
    };
  }

  /** Changes apply to payments from now on; anything already recorded keeps the numbers it was booked with. */
  async update(actorId: string, dto: MoneySettingsDto) {
    const problem = dto.seller?.gstin ? gstinProblem(dto.seller.gstin) : null;
    if (problem) throw fail(400, 'invalid_gstin', problem);
    const before = await this.get();
    const changed = (Object.keys(KEYS) as Field[]).filter((field) => dto[field] !== undefined);
    await this.db.transaction(async (tx) => {
      for (const field of changed) {
        await tx
          .insert(settings)
          .values({ key: KEYS[field][0], value: dto[field], updatedBy: actorId })
          .onConflictDoUpdate({ target: settings.key, set: { value: dto[field], updatedBy: actorId } });
      }
      await audit(tx, {
        actorId,
        action: 'settings.money',
        entityType: 'settings',
        entityId: 'money',
        before: Object.fromEntries(changed.map((f) => [f, (before as Record<string, unknown>)[f]])),
        after: Object.fromEntries(changed.map((f) => [f, dto[f]])),
      });
    });
    return this.get();
  }

  /** Tax deducted at source on an instructor's payouts. It applies to statements prepared from now on. */
  async setTds(actorId: string, instructorId: string, tdsRateBps: number) {
    const [instructor] = await this.db.select({ id: instructors.id, tds: instructors.tdsRateBps }).from(instructors).where(eq(instructors.id, instructorId)).limit(1);
    if (!instructor) throw fail(404, 'not_found', 'No such instructor.');
    await this.db.transaction(async (tx) => {
      await tx.update(instructors).set({ tdsRateBps }).where(eq(instructors.id, instructorId));
      await audit(tx, { actorId, action: 'instructor.tds', entityType: 'instructor', entityId: instructorId, before: { tdsRateBps: instructor.tds }, after: { tdsRateBps } });
    });
    return { id: instructorId, tdsRateBps };
  }
}
