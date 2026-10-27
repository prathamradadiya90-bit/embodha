import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/db.module';
import { WEBHOOK_SOURCES, webhookReceipts } from '../db/schema';

const logger = new Logger('Webhooks');

/**
 * Notes that a channel's webhook got through, for the launch checklist. Called once the caller is known to be the
 * channel (signature or secret checked). It never fails the webhook itself: the channel would only retry.
 */
export async function heard(db: Pick<Db, 'insert'>, source: (typeof WEBHOOK_SOURCES)[number], event: string | null) {
  try {
    const now = new Date();
    await db
      .insert(webhookReceipts)
      .values({ source, lastAt: now, lastEvent: event?.slice(0, 120) ?? null, received: 1 })
      .onConflictDoUpdate({
        target: webhookReceipts.source,
        set: { lastAt: now, lastEvent: event?.slice(0, 120) ?? null, received: sql`${webhookReceipts.received} + 1` },
      });
  } catch (error) {
    logger.warn(`Couldn't note the ${source} webhook: ${error}`);
  }
}
