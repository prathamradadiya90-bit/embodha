import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { audit } from '../common/audit';
import { fail } from '../common/errors';
import { currentMonth, monthRange } from '../common/month';
import { readSetting } from '../common/settings';
import { Db, InjectDb } from '../db/db.module';
import { adjustments, instructors, payments, payoutLines, payoutStatements, splits, users } from '../db/schema';

const sum = (rows: { paise: number }[]) => rows.reduce((total, row) => total + row.paise, 0);

/**
 * Month-end payouts. Finance prepares a statement for a finished month, checks it, closes it, pays each line by
 * bank transfer and records the reference. A statement covers every share that is past the refund window and not
 * yet on a statement, plus adjustments. Balances under the minimum roll over to the next month.
 */
@Injectable()
export class PayoutsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async list() {
    const rows = await this.db
      .select({
        statement: payoutStatements,
        lines: count(payoutLines.id),
        netPaise: sql<number>`coalesce(sum(${payoutLines.netPaise}), 0)`.mapWith(Number),
        paidLines: sql<number>`count(${payoutLines.paidAt})`.mapWith(Number),
      })
      .from(payoutStatements)
      .leftJoin(payoutLines, eq(payoutLines.statementId, payoutStatements.id))
      .groupBy(payoutStatements.id)
      .orderBy(desc(payoutStatements.month));
    return rows.map(({ statement, ...totals }) => ({ month: statement.month.slice(0, 7), status: statement.status, closedAt: statement.closedAt, ...totals }));
  }

  async get(month: string) {
    const statement = await this.find(month);
    if (!statement) throw fail(404, 'not_found', 'No statement for that month yet.');
    const lines = await this.db
      .select({ line: payoutLines, name: instructors.displayName, email: users.email, gstin: instructors.gstin })
      .from(payoutLines)
      .innerJoin(instructors, eq(instructors.id, payoutLines.instructorId))
      .leftJoin(users, eq(users.id, instructors.userId))
      .where(eq(payoutLines.statementId, statement.id))
      .orderBy(desc(payoutLines.netPaise));
    return {
      month,
      status: statement.status,
      closedAt: statement.closedAt,
      lines: lines.map(({ line, name, email, gstin }) => ({
        id: line.id,
        instructor: { id: line.instructorId, displayName: name, email, gstin },
        payablePaise: line.payablePaise,
        tdsPaise: line.tdsPaise,
        netPaise: line.netPaise,
        paidAt: line.paidAt,
        bankReference: line.bankReference,
      })),
    };
  }

  /** Builds the statement for a month that has ended, or rebuilds it while it's still open. */
  async prepare(actorId: string, month: string) {
    if (month >= currentMonth()) throw fail(409, 'month_not_over', 'A month can be paid out once it has ended.');
    const existing = await this.find(month);
    if (existing && existing.status !== 'open') throw fail(409, 'statement_closed', "This statement is closed. Corrections go on next month's as adjustments.");
    const { end } = monthRange(month);
    const minPayout = await readSetting(this.db, 'min_payout_paise', 50_000);
    const now = new Date();

    await this.db.transaction(async (tx) => {
      let statementId = existing?.id;
      if (statementId) {
        // Start over: everything on the old lines goes back to waiting.
        const old = (await tx.select({ id: payoutLines.id }).from(payoutLines).where(eq(payoutLines.statementId, statementId))).map((l) => l.id);
        if (old.length) await tx.update(splits).set({ payoutLineId: null, state: 'pending' }).where(inArray(splits.payoutLineId, old));
        await tx.update(adjustments).set({ statementId: null }).where(eq(adjustments.statementId, statementId));
        await tx.delete(payoutLines).where(eq(payoutLines.statementId, statementId));
      } else {
        [{ id: statementId }] = await tx.insert(payoutStatements).values({ month: `${month}-01` }).returning({ id: payoutStatements.id });
      }

      const due = await tx
        .select({ id: splits.id, instructorId: splits.instructorId, paise: splits.instructorPaise })
        .from(splits)
        .innerJoin(payments, eq(payments.id, splits.paymentId))
        .where(and(inArray(splits.state, ['pending', 'payable']), isNull(splits.payoutLineId), lt(payments.capturedAt, end), lte(splits.payableFrom, now)));
      const owed = await tx
        .select({ id: adjustments.id, instructorId: adjustments.instructorId, paise: adjustments.amountPaise })
        .from(adjustments)
        .where(and(isNull(adjustments.statementId), lt(adjustments.createdAt, end)));
      const people = [...new Set([...due, ...owed].map((row) => row.instructorId))];
      const tdsRates = people.length
        ? await tx.select({ id: instructors.id, bps: instructors.tdsRateBps }).from(instructors).where(inArray(instructors.id, people))
        : [];

      for (const instructorId of people) {
        const shares = due.filter((row) => row.instructorId === instructorId);
        const extras = owed.filter((row) => row.instructorId === instructorId);
        const payable = sum(shares) + sum(extras);
        if (payable < minPayout) continue; // rolls over to next month's statement
        const tdsPaise = Math.round((payable * (tdsRates.find((t) => t.id === instructorId)?.bps ?? 0)) / 10_000);
        const [line] = await tx
          .insert(payoutLines)
          .values({ statementId: statementId!, instructorId, payablePaise: payable, tdsPaise, netPaise: payable - tdsPaise })
          .returning({ id: payoutLines.id });
        if (shares.length) await tx.update(splits).set({ payoutLineId: line.id, state: 'payable' }).where(inArray(splits.id, shares.map((row) => row.id)));
        if (extras.length) await tx.update(adjustments).set({ statementId }).where(inArray(adjustments.id, extras.map((row) => row.id)));
      }
      await audit(tx, { actorId, action: 'payout.prepare', entityType: 'payout_statement', entityId: statementId!, after: { month, lines: people.length } });
    });
    return this.get(month);
  }

  /** After this the numbers can't change, so it's safe to start paying. */
  async close(actorId: string, month: string) {
    const statement = await this.find(month);
    if (!statement) throw fail(404, 'not_found', 'Prepare the statement first.');
    if (statement.status !== 'open') throw fail(409, 'statement_closed', 'This statement is already closed.');
    await this.db.transaction(async (tx) => {
      await tx.update(payoutStatements).set({ status: 'closed', closedBy: actorId, closedAt: new Date() }).where(eq(payoutStatements.id, statement.id));
      await audit(tx, { actorId, action: 'payout.close', entityType: 'payout_statement', entityId: statement.id, after: { month } });
    });
    return this.get(month);
  }

  /** Records a bank transfer against one line. When every line is paid, so is the statement. */
  async markPaid(actorId: string, lineId: string, bankReference: string) {
    const [row] = await this.db
      .select({ line: payoutLines, statement: payoutStatements })
      .from(payoutLines)
      .innerJoin(payoutStatements, eq(payoutStatements.id, payoutLines.statementId))
      .where(eq(payoutLines.id, lineId))
      .limit(1);
    if (!row) throw fail(404, 'not_found', 'No such payout line.');
    if (row.statement.status === 'open') throw fail(409, 'close_first', "Close the statement first, so the amounts can't change after you've paid.");
    if (row.line.paidAt) throw fail(409, 'already_paid', 'This line is already marked as paid.');
    await this.db.transaction(async (tx) => {
      await tx.update(payoutLines).set({ paidAt: new Date(), markedBy: actorId, bankReference: bankReference.trim() }).where(eq(payoutLines.id, lineId));
      await tx.update(splits).set({ state: 'paid' }).where(and(eq(splits.payoutLineId, lineId), eq(splits.state, 'payable')));
      const [{ unpaid }] = await tx
        .select({ unpaid: count() })
        .from(payoutLines)
        .where(and(eq(payoutLines.statementId, row.statement.id), isNull(payoutLines.paidAt)));
      if (!unpaid) await tx.update(payoutStatements).set({ status: 'paid' }).where(eq(payoutStatements.id, row.statement.id));
      await audit(tx, { actorId, action: 'payout.paid', entityType: 'payout_line', entityId: lineId, after: { bankReference, netPaise: row.line.netPaise } });
    });
    return this.get(row.statement.month.slice(0, 7));
  }

  private async find(month: string) {
    const [row] = await this.db.select().from(payoutStatements).where(eq(payoutStatements.month, `${month}-01`)).limit(1);
    return row ?? null;
  }
}
