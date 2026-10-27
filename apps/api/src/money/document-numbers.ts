import { sql } from 'drizzle-orm';
import type { Db } from '../db/db.module';
import { documentCounters } from '../db/schema';
import { shortFinancialYear } from './gst';

const PREFIX = { invoice: 'EMB', credit_note: 'CN' } as const;

/**
 * The next number in a series, like EMB/26-27/000042, with a fresh series every April. Take it inside the
 * transaction that issues the document: the counter row stays locked until it commits, and a rollback hands the
 * number back, so the series never skips one.
 */
export async function nextDocumentNumber(tx: Pick<Db, 'insert'>, kind: keyof typeof PREFIX, at: Date) {
  const year = shortFinancialYear(at);
  const [row] = await tx
    .insert(documentCounters)
    .values({ series: `${kind}/${year}`, last: 1 })
    .onConflictDoUpdate({ target: documentCounters.series, set: { last: sql`${documentCounters.last} + 1` } })
    .returning({ last: documentCounters.last });
  return `${PREFIX[kind]}/${year}/${String(row.last).padStart(6, '0')}`;
}
