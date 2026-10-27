import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { devices } from '../db/schema';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

@Injectable()
export class PushService {
  private readonly log = new Logger('Push');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectDb() private readonly db: Db,
  ) {}

  /**
   * Sends through Expo's push service (which talks to Apple and Google), 100 at a time. Devices Expo reports as
   * gone are forgotten. Returns how many messages Expo accepted.
   */
  async send(messages: PushMessage[]): Promise<number> {
    let accepted = 0;
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      try {
        const res = await fetch(EXPO_PUSH, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(this.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${this.env.EXPO_ACCESS_TOKEN}` } : {}),
          },
          body: JSON.stringify(batch.map((message) => ({ ...message, sound: 'default' }))),
        });
        const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
        const gone: string[] = [];
        (json.data ?? []).forEach((ticket, k) => {
          if (ticket.status === 'ok') accepted += 1;
          else if (ticket.details?.error === 'DeviceNotRegistered') gone.push(batch[k].to);
        });
        if (gone.length) await this.db.delete(devices).where(inArray(devices.pushToken, gone));
      } catch (error) {
        this.log.warn(`A push batch failed: ${(error as Error).message}`);
      }
    }
    return accepted;
  }
}
