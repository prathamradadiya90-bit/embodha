import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Db, InjectDb } from '../db/db.module';
import { MediaStatus, chapters, mediaAssets } from '../db/schema';
import { BunnyService, type BunnyVideo } from './bunny.service';

/**
 * The MP4 copies a finished video has, by height. Bunny makes one per encoded resolution up to 1080p (never above
 * the original's), but only when MP4 fallback was on in the library as the video was uploaded.
 */
export function mp4Heights(video: Pick<BunnyVideo, 'status' | 'hasMP4Fallback' | 'availableResolutions'>): number[] {
  if (video.status !== 3 || !video.hasMP4Fallback || !video.availableResolutions) return [];
  const heights = video.availableResolutions
    .split(',')
    .map((r) => Number(/^\s*(\d+)p\s*$/i.exec(r)?.[1]))
    .filter((h) => Number.isInteger(h) && h > 0 && h <= 1080);
  return [...new Set(heights)].sort((a, b) => a - b);
}

export function mediaStatusFromBunny(code: number): MediaStatus {
  if (code === 3) return 'ready';
  if (code === 5 || code === 8) return 'failed';
  if (code === 6) return 'uploading';
  return 'processing';
}

@Injectable()
export class MediaService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly bunny: BunnyService,
  ) {}

  /** Reads the video's real state from Bunny and copies it across. Webhooks and studio polls both land here. */
  async syncFromBunny(guid: string) {
    const [media] = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.provider, 'bunny_stream'), eq(mediaAssets.hostAssetId, guid)))
      .limit(1);
    if (!media) return null;

    const video = await this.bunny.getVideo(guid);
    const status = mediaStatusFromBunny(video.status);
    const durationS = video.length > 0 ? Math.round(video.length) : media.durationS;
    const [updated] = await this.db
      .update(mediaAssets)
      .set({
        status,
        durationS,
        thumbnailUrl: status === 'ready' ? this.bunny.thumbnailUrl(guid, video.thumbnailFileName) : media.thumbnailUrl,
        downloadHeights: mp4Heights(video),
        error: status === 'failed' ? 'Bunny could not encode this file. Export it again as MP4 (H.264) and re-upload.' : null,
      })
      .where(eq(mediaAssets.id, media.id))
      .returning();
    if (status === 'ready' && durationS) {
      await this.db.update(chapters).set({ durationS }).where(eq(chapters.mediaAssetId, media.id));
    }
    return updated;
  }
}
