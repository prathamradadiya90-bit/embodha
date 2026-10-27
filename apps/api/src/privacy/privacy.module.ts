import { Controller, Delete, HttpCode, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { and, count, eq, gt } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AuthModule } from '../auth/auth.module';
import { UsersService } from '../auth/users.service';
import { audit } from '../common/audit';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import {
  activeDays,
  appErrors,
  auditLog,
  breathingSessions,
  chapterProgress,
  devices,
  downloadDevices,
  downloads,
  entitlements,
  events,
  feedback,
  installs,
  instructors,
  instructorSubscriptions,
  notifications,
  payments,
  playbackEvents,
  reminderLog,
  reviews,
  searchLog,
  sessions,
  staffRoles,
  userNotifications,
  userPreferences,
  users,
  watchDaily,
} from '../db/schema';
import { MailService } from '../mail/mail.service';
import { MoneyModule } from '../money/money.module';
import { SubscriptionsService } from '../money/subscriptions.service';
import { NotesModule } from '../notes/notes.module';
import { NotesService } from '../notes/notes.service';
import { ErasureService } from './erasure.service';

/** Every table that holds rows about one member, under the name it has in the download. */
const OWN_ROWS: Record<string, PgTable & { userId: PgColumn }> = {
  preferences: userPreferences,
  signedInDevices: sessions,
  pushDevices: devices,
  phonesWithDownloads: downloadDevices,
  downloadedChapters: downloads,
  staffRoles,
  instructorProfile: instructors,
  library: entitlements,
  purchases: payments,
  subscriptions: instructorSubscriptions,
  chapterProgress,
  minutesPractisedByDay: watchDaily,
  playbackHistory: playbackEvents,
  breathingSessions,
  reviews,
  searches: searchLog,
  appEvents: events,
  appErrors,
  feedback,
  appInstalls: installs,
  activeDays,
  reminders: reminderLog,
};
/**
 * Secrets that are ours, not the member's: hashes of their sign-in tokens, and the address push messages go to. And
 * which staff member marked their feedback handled, which is about that person, not them.
 */
const LEFT_OUT: Record<string, string[]> = { signedInDevices: ['refreshTokenHash', 'previousTokenHash'], pushDevices: ['pushToken'], feedback: ['handledBy'] };

const without = (row: Record<string, unknown>, keys: string[] = []) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

/**
 * A member's right to a copy of their data (India's DPDP Act, and GDPR for members in Europe). Everything Embodha
 * holds about them goes into one JSON file, which is emailed to the account's own address: the inbox is the proof
 * that the person asking is the person it's about, on the web and in the phone apps alike.
 */
@Injectable()
export class ExportService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notesService: NotesService,
    private readonly mail: MailService,
  ) {}

  async build(userId: string) {
    const [account] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const data: Record<string, unknown> = {
      about: 'Everything Embodha holds about this account, as of the date below. Times are UTC.',
      exportedAt: new Date().toISOString(),
      account,
    };
    for (const [name, table] of Object.entries(OWN_ROWS)) {
      const rows = (await this.db.select().from(table).where(eq(table.userId, userId))) as Record<string, unknown>[];
      data[name] = rows.map((row) => without(row, LEFT_OUT[name]));
    }
    data.notes = await this.notesService.everything(userId);
    data.notifications = await this.db
      .select({ title: notifications.title, body: notifications.body, receivedAt: userNotifications.createdAt, readAt: userNotifications.readAt })
      .from(userNotifications)
      .innerJoin(notifications, eq(notifications.id, userNotifications.notificationId))
      .where(eq(userNotifications.userId, userId));
    return { account, data };
  }

  /** Three a day per member, counted in the audit log, which also keeps a record that the data went out. */
  async send(userId: string) {
    const [recent] = await this.db
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, userId), eq(auditLog.action, 'account.export'), gt(auditLog.at, new Date(Date.now() - 86_400_000))));
    if (recent.n >= 3) throw fail(429, 'too_many_exports', "You've asked for your data three times today. The emails are on their way; try again tomorrow if one hasn't arrived.");
    const { account, data } = await this.build(userId);
    const day = new Date().toISOString().slice(0, 10);
    await this.mail.send({
      to: account.email,
      subject: 'Your Embodha data',
      text: [
        `Hello${account.name ? ` ${account.name.split(' ')[0]}` : ''},`,
        '',
        "Here's everything Embodha holds about your account: your details, what you've practised and bought, your notes, reviews and the rest.",
        "It's a JSON file. Any text editor opens it, and other apps can read it too.",
        '',
        "If something in it looks wrong, or you'd like any of it deleted, reply to this email.",
      ].join('\n'),
      attachments: [{ filename: `embodha-data-${day}.json`, content: Buffer.from(JSON.stringify(data, null, 2)), contentType: 'application/json' }],
    });
    await audit(this.db, { actorId: userId, action: 'account.export', entityType: 'user', entityId: userId, after: { to: account.email } });
    return { sent: true, to: account.email };
  }
}

@ApiTags('account')
@Controller('v1/me')
@UseGuards(AuthGuard)
export class PrivacyController {
  constructor(
    private readonly exports: ExportService,
    private readonly users: UsersService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Both stores require deletion inside the app. Signs the member out everywhere; the account is erased 30 days later
   * unless they sign back in. Subscriptions stop renewing now, except App Store ones, which only the member can stop:
   * the app tells them how many there are.
   */
  @Delete()
  @HttpCode(202)
  async remove(@CurrentUser() me: AuthUser) {
    const { appStore } = await this.subscriptions.stopRenewalsFor(me.id);
    return { ...(await this.users.requestDeletion(me.id)), appStoreSubscriptions: appStore };
  }

  /** Emails the member a copy of their data. Three a day per member; the per-address ceiling is a second line. */
  @Post('export')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 86_400_000 } })
  export(@CurrentUser() me: AuthUser) {
    return this.exports.send(me.id);
  }
}

@Module({ imports: [AuthModule, NotesModule, MoneyModule], controllers: [PrivacyController], providers: [ExportService, ErasureService], exports: [ErasureService] })
export class PrivacyModule {}
