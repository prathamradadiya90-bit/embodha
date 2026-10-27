import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { NotificationsService } from './notifications.service';
import { RemindersService } from './reminders.service';

/** Once a minute: scheduled messages that are due, pushes held through quiet hours, and daily reminders. */
@Injectable()
export class NotificationsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Scheduler');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly reminders: RemindersService,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = this.clock.now()) {
    if (this.busy) return; // a slow minute doesn't start a second run on top of itself
    this.busy = true;
    try {
      const jobs: [string, () => Promise<unknown>][] = [
        ['scheduled messages', () => this.notifications.sendDue(now)],
        ['held pushes', () => this.notifications.releaseHeld(now)],
        ['reminders', () => this.reminders.run(now)],
      ];
      for (const [name, job] of jobs) {
        try {
          await job();
        } catch (error) {
          this.log.warn(`${name}: ${(error as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
