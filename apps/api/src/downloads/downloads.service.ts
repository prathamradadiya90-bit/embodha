import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import { AccessService, AccessVia } from '../catalogue/access.service';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { chapters, courses, downloadDevices, downloads, instructors, instructorSubscriptions, mediaAssets } from '../db/schema';
import { BunnyService } from '../media/bunny.service';
import type { CheckDownloadsDto, DevicePartDto, StartDownloadDto } from './downloads.dto';
import { downloadable, estimateBytes, extensionOf, pickHeight } from './files';

const DAY = 86_400_000;

/**
 * Why a phone should drop a download it has:
 * - gone: the chapter was deleted, or its course taken down;
 * - subscription_ended: it came with a subscription to the instructor, and that has run out;
 * - access_ended: the member can't play it any more for another reason, such as a refund;
 * - replaced: the instructor uploaded a new video or recording, so the saved one is out of date;
 * - device_removed: the member took this phone off their list of phones with downloads.
 */
export type DropReason = 'gone' | 'subscription_ended' | 'access_ended' | 'replaced' | 'device_removed';

type Row = { chapter: typeof chapters.$inferSelect; course: typeof courses.$inferSelect; media: typeof mediaAssets.$inferSelect | null };

/**
 * Offline downloads. The phone asks here before saving each chapter, which checks the member may play it (a whole
 * course they have, not just its free preview) and that the account isn't over its phone limit, then hands out a
 * short-lived link to the file. Every so often the phone checks in with what it holds; each check renews how long
 * the downloads play offline, and says which to delete because access ended.
 */
@Injectable()
export class DownloadsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly access: AccessService,
    private readonly bunny: BunnyService,
  ) {}

  async start(userId: string, dto: StartDownloadDto, now = new Date()) {
    const [row] = await this.chapterRows([dto.chapterId]);
    if (!row) throw fail(404, 'not_found', 'There is no chapter at that address.');
    const via = (await this.access.forCourses(userId, [row.course])).get(row.course.id);
    if (row.course.status !== 'published' && via !== 'instructor') throw fail(404, 'not_found', 'There is no chapter at that address.');
    if (!via) {
      throw fail(402, 'locked', 'Downloads come with the course. Unlock it to keep its chapters on your phone.', {
        course: { id: row.course.id, slug: row.course.slug, title: row.course.title },
      });
    }
    const found = downloadable(row.media, this.env);
    if (!found || !row.media) {
      throw fail(409, 'not_downloadable', row.media?.status === 'ready' ? "This chapter can't be downloaded yet. It still plays here as usual." : 'This chapter is still being prepared.');
    }

    await this.makeRoomFor(userId, dto.deviceId, now);
    const height = found.kind === 'video' ? pickHeight(found.heights, dto.quality) : null;
    await this.db.transaction(async (tx) => {
      await this.touchDevice(tx, userId, dto, now);
      await tx
        .insert(downloads)
        .values({ userId, deviceId: dto.deviceId, chapterId: row.chapter.id, mediaAssetId: row.media!.id, height })
        .onConflictDoUpdate({ target: [downloads.userId, downloads.deviceId, downloads.chapterId], set: { mediaAssetId: row.media!.id, height } });
    });

    const ttl = this.env.DOWNLOAD_URL_TTL_S;
    const signed = found.sampleUrl
      ? { url: found.sampleUrl, expiresAt: null }
      : found.kind === 'audio'
        ? this.bunny.signedAudio(row.media.hostAssetId, ttl, now.getTime())
        : this.bunny.signedMp4(row.media.hostAssetId, height!, ttl, now.getTime());
    const durationS = row.chapter.durationS ?? row.media.durationS;
    const [keepUntil] = (await this.keepUntil(userId, [{ row, via }], now)).values();

    return {
      chapterId: row.chapter.id,
      url: signed.url,
      expiresAt: signed.expiresAt,
      kind: found.kind,
      height,
      extension: extensionOf(found),
      estimatedBytes: estimateBytes(found.kind, height, durationS),
      keepUntil: keepUntil.toISOString(),
      chapter: { id: row.chapter.id, title: row.chapter.title, type: row.chapter.type, durationS },
      course: await this.courseOutline(row.course),
    };
  }

  /**
   * The phone says what it holds, and hears back which to keep (until when) and which to delete. Chapters it no
   * longer lists are forgotten, and a phone left with nothing stops counting toward the limit.
   */
  async check(userId: string, dto: CheckDownloadsDto, now = new Date()) {
    const chapterIds = [...new Set(dto.chapterIds)];
    const [device] = await this.db
      .select({ id: downloadDevices.id })
      .from(downloadDevices)
      .where(and(eq(downloadDevices.userId, userId), eq(downloadDevices.id, dto.deviceId)))
      .limit(1);
    if (!device) {
      // Nothing known for this phone. With downloads on it, that's because the member removed the phone elsewhere.
      return { checkedAt: now.toISOString(), chapters: chapterIds.map((chapterId) => ({ chapterId, keep: false as const, reason: 'device_removed' as DropReason })) };
    }

    const held = new Map(
      (await this.db.select().from(downloads).where(and(eq(downloads.userId, userId), eq(downloads.deviceId, dto.deviceId)))).map((d) => [d.chapterId, d]),
    );
    const rows = new Map((await this.chapterRows(chapterIds)).map((row) => [row.chapter.id, row]));
    const access = await this.access.forCourses(
      userId,
      [...rows.values()].map((row) => row.course),
    );

    const kept: { row: Row; via: AccessVia }[] = [];
    const dropped = new Map<string, DropReason>();
    const locked: Row[] = [];
    for (const chapterId of chapterIds) {
      const row = rows.get(chapterId);
      const via = row ? access.get(row.course.id) : undefined;
      const saved = held.get(chapterId);
      if (!row || (row.course.status !== 'published' && via !== 'instructor') || !row.chapter.mediaAssetId) dropped.set(chapterId, 'gone');
      else if (!via) locked.push(row);
      // The upload the phone saved isn't the chapter's any more (a deleted upload leaves the link empty).
      else if (saved && saved.mediaAssetId !== row.chapter.mediaAssetId) dropped.set(chapterId, 'replaced');
      else kept.push({ row, via });
    }
    for (const [chapterId, reason] of await this.whyLocked(userId, locked)) dropped.set(chapterId, reason);
    const until = await this.keepUntil(userId, kept, now);

    await this.db.transaction(async (tx) => {
      const keepIds = kept.map((k) => k.row.chapter.id);
      const mine = and(eq(downloads.userId, userId), eq(downloads.deviceId, dto.deviceId));
      await tx.delete(downloads).where(keepIds.length ? and(mine, notInArray(downloads.chapterId, keepIds)) : mine);
      // A download the phone has but the server lost track of (it was still saving at the last check) is adopted.
      const missing = kept.filter((k) => !held.has(k.row.chapter.id));
      if (missing.length) {
        await tx
          .insert(downloads)
          .values(missing.map(({ row }) => ({ userId, deviceId: dto.deviceId, chapterId: row.chapter.id, mediaAssetId: row.chapter.mediaAssetId })))
          .onConflictDoNothing();
      }
      if (keepIds.length) await this.touchDevice(tx, userId, dto, now);
      else await tx.delete(downloadDevices).where(and(eq(downloadDevices.userId, userId), eq(downloadDevices.id, dto.deviceId)));
    });

    return {
      checkedAt: now.toISOString(),
      chapters: chapterIds.map((chapterId) => {
        const reason = dropped.get(chapterId);
        return reason ? { chapterId, keep: false as const, reason } : { chapterId, keep: true as const, keepUntil: until.get(chapterId)!.toISOString() };
      }),
    };
  }

  /** The member's phones that have downloads, newest check-in first, for the Downloads screen. */
  async devices(userId: string, thisDevice: string | undefined, now = new Date()) {
    const rows = await this.db
      .select({
        id: downloadDevices.id,
        platform: downloadDevices.platform,
        label: downloadDevices.label,
        checkedAt: downloadDevices.checkedAt,
        chapters: count(downloads.chapterId),
      })
      .from(downloadDevices)
      .innerJoin(downloads, and(eq(downloads.userId, downloadDevices.userId), eq(downloads.deviceId, downloadDevices.id)))
      .where(eq(downloadDevices.userId, userId))
      .groupBy(downloadDevices.userId, downloadDevices.id)
      .orderBy(desc(downloadDevices.checkedAt));
    const since = now.getTime() - this.env.DOWNLOAD_KEEP_DAYS * DAY;
    return {
      limit: this.env.DOWNLOAD_DEVICE_LIMIT,
      keepDays: this.env.DOWNLOAD_KEEP_DAYS,
      devices: rows.map((d) => ({
        id: d.id,
        platform: d.platform,
        label: d.label,
        checkedAt: d.checkedAt.toISOString(),
        chapters: d.chapters,
        // Not checked in for the whole window: its downloads have stopped playing, and it no longer takes a place.
        counts: d.checkedAt.getTime() > since,
        thisPhone: d.id === thisDevice,
      })),
    };
  }

  /** Takes a phone off the list. Its downloads are deleted the next time it checks in. */
  async removeDevice(userId: string, deviceId: string) {
    await this.db.delete(downloadDevices).where(and(eq(downloadDevices.userId, userId), eq(downloadDevices.id, deviceId)));
  }

  /** A new phone needs a free place: phones that checked in within the keep window, and still hold something, count. */
  private async makeRoomFor(userId: string, deviceId: string, now: Date) {
    const { devices, limit } = await this.devices(userId, deviceId, now);
    const counted = devices.filter((d) => d.counts);
    if (counted.some((d) => d.thisPhone) || counted.length < limit) return;
    const names = counted.map((d) => d.label ?? (d.platform === 'ios' ? 'an iPhone' : 'an Android phone'));
    throw fail(
      409,
      'device_limit',
      `Your downloads are on ${limit} phones already (${listOf(names)}). Remove one from Downloads on any phone, then try again.`,
      { limit, devices: counted.map(({ thisPhone: _, ...d }) => d) },
    );
  }

  private touchDevice(tx: Pick<Db, 'insert'>, userId: string, dto: DevicePartDto, now: Date) {
    const label = dto.label?.trim() || null;
    return tx
      .insert(downloadDevices)
      .values({ userId, id: dto.deviceId, platform: dto.platform, label, checkedAt: now })
      .onConflictDoUpdate({
        target: [downloadDevices.userId, downloadDevices.id],
        set: { platform: dto.platform, checkedAt: now, ...(label ? { label } : {}) },
      });
  }

  private async chapterRows(ids: string[]): Promise<Row[]> {
    if (!ids.length) return [];
    return this.db
      .select({ chapter: chapters, course: courses, media: mediaAssets })
      .from(chapters)
      .innerJoin(courses, eq(courses.id, chapters.courseId))
      .leftJoin(mediaAssets, eq(mediaAssets.id, chapters.mediaAssetId))
      .where(inArray(chapters.id, ids));
  }

  /**
   * How long each download may play before the phone has to check in again: the keep window, or a subscription's
   * end if it isn't renewing. A renewing one carries on, and the next check-in sees the new month.
   */
  private async keepUntil(userId: string, list: { row: Row; via: AccessVia }[], now: Date) {
    const base = new Date(now.getTime() + this.env.DOWNLOAD_KEEP_DAYS * DAY);
    const viaSubscription = [...new Set(list.filter((k) => k.via === 'subscription').map((k) => k.row.course.instructorId))];
    const ends = new Map<string, Date | null>(); // null: renews
    if (viaSubscription.length) {
      const running = await this.db
        .select({ instructorId: instructorSubscriptions.instructorId, status: instructorSubscriptions.status, autoRenew: instructorSubscriptions.autoRenew, end: instructorSubscriptions.currentPeriodEnd })
        .from(instructorSubscriptions)
        .where(
          and(
            eq(instructorSubscriptions.userId, userId),
            inArray(instructorSubscriptions.instructorId, viaSubscription),
            gt(instructorSubscriptions.currentPeriodEnd, now),
            sql`${instructorSubscriptions.status} <> 'expired'`,
          ),
        );
      for (const s of running) {
        const previous = ends.get(s.instructorId);
        if (previous === null) continue;
        ends.set(s.instructorId, s.autoRenew && s.status === 'active' ? null : !previous || s.end > previous ? s.end : previous);
      }
    }
    return new Map(
      list.map(({ row, via }) => {
        const end = via === 'subscription' ? ends.get(row.course.instructorId) : null;
        return [row.chapter.id, end && end < base ? end : base];
      }),
    );
  }

  /** For chapters the member can no longer play: whether a subscription ran out, or access ended some other way. */
  private async whyLocked(userId: string, locked: Row[]) {
    const reasons = new Map<string, DropReason>();
    if (!locked.length) return reasons;
    const instructorIds = [...new Set(locked.map((row) => row.course.instructorId))];
    const lapsed = await this.db
      .selectDistinct({ instructorId: instructorSubscriptions.instructorId })
      .from(instructorSubscriptions)
      .where(and(eq(instructorSubscriptions.userId, userId), inArray(instructorSubscriptions.instructorId, instructorIds)));
    const hadOne = new Set(lapsed.map((s) => s.instructorId));
    for (const row of locked) reasons.set(row.chapter.id, hadOne.has(row.course.instructorId) ? 'subscription_ended' : 'access_ended');
    return reasons;
  }

  /** The course, with every chapter's title in order, so the phone can list and step through downloads offline. */
  private async courseOutline(course: typeof courses.$inferSelect) {
    const [teacher] = await this.db.select({ displayName: instructors.displayName }).from(instructors).where(eq(instructors.id, course.instructorId)).limit(1);
    const list = await this.db
      .select({ id: chapters.id, title: chapters.title, type: chapters.type, durationS: chapters.durationS })
      .from(chapters)
      .where(eq(chapters.courseId, course.id))
      .orderBy(asc(chapters.sort), asc(chapters.createdAt));
    return { id: course.id, slug: course.slug, title: course.title, instructor: teacher?.displayName ?? null, chapters: list };
  }
}

function listOf(items: string[]) {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
