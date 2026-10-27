import { Injectable, Logger } from '@nestjs/common';
import { SQL, and, count, countDistinct, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { audit } from '../common/audit';
import { Clock } from '../common/clock';
import { fail } from '../common/errors';
import { Db, InjectDb } from '../db/db.module';
import { devices, heldPushes, notifications, userNotifications, users } from '../db/schema';
import { quietUntil } from './local-time';
import { AudienceDto, CampaignDto, DeviceDto } from './notifications.dto';
import { PushService } from './push.service';

const MAX_AHEAD_DAYS = 60;
type Campaign = typeof notifications.$inferSelect;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly push: PushService,
    private readonly clock: Clock,
  ) {}

  /** A phone hands over its push token after sign-in. A token moves with whoever signed in on that phone last. */
  async registerDevice(userId: string, dto: DeviceDto) {
    const values = { userId, platform: dto.platform, appVersion: dto.appVersion ?? null, lastSeenAt: new Date() };
    await this.db
      .insert(devices)
      .values({ ...values, pushToken: dto.token })
      .onConflictDoUpdate({ target: devices.pushToken, set: values });
  }

  async forgetDevice(userId: string, token: string) {
    await this.db.delete(devices).where(and(eq(devices.userId, userId), eq(devices.pushToken, token)));
  }

  /** The bell: the latest 50, newest first. */
  async bell(userId: string) {
    const [items, [{ unread }]] = await Promise.all([
      this.db
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          deepLink: notifications.deepLink,
          imageUrl: notifications.imageUrl,
          createdAt: userNotifications.createdAt,
          readAt: userNotifications.readAt,
        })
        .from(userNotifications)
        .innerJoin(notifications, eq(notifications.id, userNotifications.notificationId))
        .where(eq(userNotifications.userId, userId))
        .orderBy(desc(userNotifications.createdAt))
        .limit(50),
      this.unreadQuery(userId),
    ]);
    return { unread, items };
  }

  async unread(userId: string) {
    const [{ unread }] = await this.unreadQuery(userId);
    return { unread };
  }

  async markRead(userId: string, ids?: string[]) {
    await this.db
      .update(userNotifications)
      .set({ readAt: new Date() })
      .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt), ids?.length ? inArray(userNotifications.notificationId, ids) : undefined));
    return this.unread(userId);
  }

  /* ------------------------------------------------------------ Campaigns (admin) */

  /** How many members a campaign would reach, and how many of them have a phone that accepts notifications. */
  async reach(audience: AudienceDto) {
    const where = this.audienceWhere(audience);
    const [[members], [phones]] = await Promise.all([
      this.db.select({ n: count() }).from(users).where(where),
      this.db.select({ n: countDistinct(devices.userId) }).from(devices).innerJoin(users, eq(users.id, devices.userId)).where(where),
    ]);
    return { members: members.n, withPush: phones.n };
  }

  /**
   * A message from Embodha, now or at a set time. Now: it goes into every matching member's bell straight away and
   * out to phones in the background, so a big send doesn't hold the admin page. Later: the scheduler sends it then,
   * to whoever matches at that moment.
   */
  async send(actorId: string, dto: CampaignDto) {
    const now = this.clock.now();
    const sendAt = dto.sendAt ? new Date(dto.sendAt) : null;
    if (sendAt && (sendAt.getTime() < now.getTime() + 60_000 || sendAt.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000)) {
      throw fail(400, 'invalid_send_at', `Pick a time between a minute and ${MAX_AHEAD_DAYS} days from now.`);
    }
    const [campaign] = await this.db
      .insert(notifications)
      .values({ type: 'campaign', title: dto.title.trim(), body: dto.body.trim(), deepLink: dto.deepLink ?? null, audience: dto.audience, scheduledAt: sendAt ?? now, createdBy: actorId })
      .returning();
    await audit(this.db, {
      actorId,
      action: sendAt ? 'notification.schedule' : 'notification.send',
      entityType: 'notification',
      entityId: campaign.id,
      after: { title: campaign.title, audience: dto.audience, sendAt: sendAt?.toISOString() ?? null },
    });
    if (sendAt) return { id: campaign.id, scheduledFor: sendAt.toISOString() };
    // If this fails halfway, the scheduler finds the message unsent and finishes the job a minute later.
    return { id: campaign.id, ...(await this.deliver(campaign.id, now)) };
  }

  /**
   * Sends a campaign that hasn't gone yet: into every matching member's bell, and to their phones, except members
   * in their quiet hours, whose push waits for 08:00 their time. Claiming it is the first step, so a message is
   * never sent twice, even by two servers at once. Null if it had already gone.
   */
  async deliver(id: string, now: Date) {
    const result = await this.db.transaction(async (tx) => {
      const [campaign] = await tx.update(notifications).set({ sentAt: now }).where(and(eq(notifications.id, id), isNull(notifications.sentAt))).returning();
      if (!campaign) return null;
      const where = this.audienceWhere((campaign.audience ?? {}) as AudienceDto);
      const [recipients, phones] = await Promise.all([
        tx.select({ id: users.id, timezone: users.timezone }).from(users).where(where),
        tx.select({ userId: devices.userId, token: devices.pushToken }).from(devices).innerJoin(users, eq(users.id, devices.userId)).where(where),
      ]);
      const waitUntil = new Map(recipients.map((r) => [r.id, quietUntil(now, r.timezone)]));
      const held = [...new Set(phones.map((p) => p.userId))].filter((userId) => waitUntil.get(userId));
      for (let i = 0; i < recipients.length; i += 1000) {
        await tx.insert(userNotifications).values(recipients.slice(i, i + 1000).map((r) => ({ userId: r.id, notificationId: campaign.id })));
      }
      for (let i = 0; i < held.length; i += 1000) {
        await tx.insert(heldPushes).values(held.slice(i, i + 1000).map((userId) => ({ userId, notificationId: campaign.id, sendAfter: waitUntil.get(userId)! })));
      }
      if (held.length) await tx.update(notifications).set({ heldCount: held.length }).where(eq(notifications.id, campaign.id));
      const awake = phones.filter((p) => !waitUntil.get(p.userId)).map((p) => p.token);
      return { campaign, awake, counts: { members: recipients.length, phones: phones.length, held: held.length } };
    });
    if (!result) return null;
    void this.pushTo(result.campaign, result.awake).catch((error: Error) => this.log.error(`Campaign ${id}: ${error.message}`));
    return result.counts;
  }

  /** Scheduled campaigns whose time has come, and any "now" one that didn't finish. */
  async sendDue(now: Date) {
    const due = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.type, 'campaign'), isNull(notifications.sentAt), lte(notifications.scheduledAt, now)));
    for (const { id } of due) await this.deliver(id, now);
    return due.length;
  }

  /** Pushes held overnight, once it's 08:00 for the member. Anyone who has read it in the app by then isn't pushed. */
  async releaseHeld(now: Date) {
    const due = await this.db.delete(heldPushes).where(lte(heldPushes.sendAfter, now)).returning({ userId: heldPushes.userId, notificationId: heldPushes.notificationId });
    for (const notificationId of new Set(due.map((d) => d.notificationId))) {
      const userIds = due.filter((d) => d.notificationId === notificationId).map((d) => d.userId);
      const [campaign] = await this.db.select().from(notifications).where(eq(notifications.id, notificationId));
      const phones = await this.db
        .select({ token: devices.pushToken })
        .from(devices)
        .innerJoin(userNotifications, and(eq(userNotifications.userId, devices.userId), eq(userNotifications.notificationId, notificationId)))
        .where(and(inArray(devices.userId, userIds), isNull(userNotifications.readAt)));
      if (campaign) await this.pushTo(campaign, phones.map((p) => p.token));
    }
    return due.length;
  }

  /** A scheduled message can be called back until it goes. */
  async cancel(actorId: string, id: string) {
    const [campaign] = await this.db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.type, 'campaign')));
    if (!campaign) throw fail(404, 'not_found', 'No such message.');
    if (campaign.sentAt) throw fail(409, 'already_sent', "That one has already gone out, so it can't be called back.");
    await this.db.delete(notifications).where(and(eq(notifications.id, id), isNull(notifications.sentAt)));
    await audit(this.db, { actorId, action: 'notification.cancel', entityType: 'notification', entityId: id, before: { title: campaign.title, sendAt: campaign.scheduledAt } });
  }

  private async pushTo(campaign: Campaign, tokens: string[]) {
    if (!tokens.length) return;
    const accepted = await this.push.send(
      tokens.map((to) => ({ to, title: campaign.title, body: campaign.body, data: { url: campaign.deepLink ?? '/notifications', notificationId: campaign.id } })),
    );
    await this.db.update(notifications).set({ sentCount: sql`${notifications.sentCount} + ${accepted}` }).where(eq(notifications.id, campaign.id));
  }

  async campaigns() {
    const rows = await this.db
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        deepLink: notifications.deepLink,
        audience: notifications.audience,
        scheduledAt: notifications.scheduledAt,
        sentAt: notifications.sentAt,
        sentCount: notifications.sentCount,
        heldCount: notifications.heldCount,
        members: count(userNotifications.userId),
        read: sql<number>`count(${userNotifications.readAt})`.mapWith(Number),
      })
      .from(notifications)
      .leftJoin(userNotifications, eq(userNotifications.notificationId, notifications.id))
      .where(eq(notifications.type, 'campaign'))
      .groupBy(notifications.id)
      // Waiting to go first, soonest at the top; then what went, newest first.
      .orderBy(sql`${notifications.sentAt} is null desc`, sql`case when ${notifications.sentAt} is null then ${notifications.scheduledAt} end asc`, desc(notifications.sentAt))
      .limit(50);
    return rows;
  }

  private unreadQuery(userId: string) {
    return this.db
      .select({ unread: count() })
      .from(userNotifications)
      .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt)));
  }

  /** Age comes from the year of birth members give at sign-up, so it can be a year out either way. */
  private audienceWhere(audience: AudienceDto): SQL {
    const year = new Date().getFullYear();
    return and(
      eq(users.status, 'active'),
      audience.genders?.length ? inArray(users.gender, audience.genders) : undefined,
      audience.ageMin !== undefined ? lte(users.birthYear, year - audience.ageMin) : undefined,
      audience.ageMax !== undefined ? gte(users.birthYear, year - audience.ageMax) : undefined,
      audience.countries?.length ? inArray(users.country, audience.countries) : undefined,
    )!;
  }
}
