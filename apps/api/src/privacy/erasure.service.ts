import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { audit } from '../common/audit';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { emailCodes, users } from '../db/schema';

export const ERASE_AFTER_DAYS = 30;
const HOUR = 60 * 60_000;

interface Link {
  table: string;
  column: string;
  /** Postgres's on-delete rule: c cascade, n set null, a no action, r restrict, d set default. */
  rule: string;
}

/**
 * Erases accounts 30 days after the member (or support) asked, as the app promises. Runs every hour.
 *
 * Every table that points at a member is found in Postgres's own catalogue, so a table added later is covered too.
 * Rows the schema says go with the account (cascade) are deleted; rows that outlive it (set null), like anonymous
 * app events, lose the link. Payments and subscriptions are kept, because invoices must be (GST records, six years):
 * a member who bought something keeps an empty account row for those to point at, with no email, name or details.
 */
@Injectable()
export class ErasureService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ErasureService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    const run = () => void this.eraseDue().catch((error) => this.logger.warn(`Erasing accounts failed: ${error}`));
    this.timer = setInterval(run, HOUR);
    this.timer.unref();
    setTimeout(run, 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Erases every account whose 30 days are up. Returns how many. */
  async eraseDue(now = new Date()) {
    const cutoff = new Date(now.getTime() - ERASE_AFTER_DAYS * 86_400_000);
    const due = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.status, 'deleting'), lt(users.deletedAt, cutoff)));
    for (const user of due) {
      try {
        await this.erase(user);
      } catch (error) {
        this.logger.warn(`Couldn't erase account ${user.id}: ${error}`); // tried again next hour
      }
    }
    return due.length;
  }

  private async links(): Promise<Link[]> {
    const result = await this.db.execute(sql`
      select c.conrelid::regclass::text as "table", a.attname as "column", c.confdeltype as "rule"
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confrelid = 'users'::regclass`);
    return result.rows as unknown as Link[];
  }

  private async erase(user: { id: string; email: string }) {
    const links = await this.links();
    const where = (link: Link) => sql`${sql.identifier(link.column)} = ${user.id}`;
    const reviewed = (await this.db.execute(sql`select distinct course_id from reviews where user_id = ${user.id}`)).rows as { course_id: string }[];

    const kept = await this.db.transaction(async (tx) => {
      // Rows nothing may delete out from under (payments, subscriptions) decide whether the account row stays.
      const keep: string[] = [];
      for (const link of links.filter((l) => l.rule === 'a' || l.rule === 'r')) {
        const [row] = (await tx.execute(sql`select exists (select 1 from ${sql.identifier(link.table)} where ${where(link)}) as found`)).rows as { found: boolean }[];
        if (row.found) keep.push(link.table);
      }
      await tx.delete(emailCodes).where(eq(emailCodes.email, user.email));
      if (!keep.length) {
        await tx.delete(users).where(eq(users.id, user.id)); // the schema's cascades and set-nulls do the rest
      } else {
        for (const link of links) {
          if (link.rule === 'c') await tx.execute(sql`delete from ${sql.identifier(link.table)} where ${where(link)}`);
          if (link.rule === 'n') await tx.execute(sql`update ${sql.identifier(link.table)} set ${sql.identifier(link.column)} = null where ${where(link)}`);
        }
        await tx
          .update(users)
          .set({ email: `erased-${user.id}@erased.embodha.invalid`, name: null, country: null, state: null, birthYear: null, gender: null, timezone: null, status: 'erased' })
          .where(eq(users.id, user.id));
      }
      await audit(tx, { actorId: null, action: 'account.erase', entityType: 'user', entityId: user.id, after: { kept: keep } });
      return keep;
    });

    // Their reviews are gone, so the stars on those courses are worked out again.
    for (const { course_id: courseId } of reviewed) {
      await this.db.execute(sql`
        update courses set rating_avg = s.average, rating_count = s.n
        from (select round(avg(rating)::numeric, 2) as average, count(*)::int as n from reviews where course_id = ${courseId} and status = 'visible') s
        where courses.id = ${courseId}`);
    }
    this.logger.log(`Erased account ${user.id}${kept.length ? ` (kept ${kept.join(', ')} for the tax records)` : ''}`);
  }
}
