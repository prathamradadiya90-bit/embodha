import type { Env } from '../config/env';
import type { mediaAssets } from '../db/schema';

type Media = typeof mediaAssets.$inferSelect;

export const QUALITIES = ['standard', 'high'] as const;
export type Quality = (typeof QUALITIES)[number];

/**
 * What the two download qualities aim for. Standard is sharp enough on a phone and half the size; high is for a
 * tablet, or a phone plugged into a TV. A video that was never that tall gives its tallest copy.
 */
const TARGET_HEIGHT: Record<Quality, number> = { standard: 480, high: 720 };

/**
 * Bunny's encoding defaults, H.264 video plus AAC audio, in kilobits a second. Bunny's own page says a video can come
 * out up to 1.4 times this when the original was shot at a high bitrate; yoga and breathwork, filmed on a tripod
 * against a plain wall, usually come out under it.
 */
const KBPS: [height: number, kbps: number][] = [
  [240, 600 + 96],
  [360, 800 + 128],
  [480, 1400 + 192],
  [720, 2800 + 256],
  [1080, 5000 + 256],
];
/** Audio chapters are AAC at 128 kbps (AudioService normalises every upload to that). */
const AUDIO_KBPS = 128;

/** How a chapter's media can be saved to a phone, or null if it can't be. */
export interface Downloadable {
  kind: 'video' | 'audio';
  /** The heights of the video's MP4 copies. Empty for audio, and for the development sample. */
  heights: number[];
  /** Development only: the sample file to save instead of a Bunny one. */
  sampleUrl?: string;
}

export function downloadable(media: Media | null | undefined, env: Pick<Env, 'NODE_ENV' | 'DEV_SAMPLE_DOWNLOAD_URL'>): Downloadable | null {
  if (!media || media.status !== 'ready') return null;
  if (media.provider === 'bunny_storage') return media.kind === 'audio' ? { kind: 'audio', heights: [] } : null;
  if (media.provider === 'bunny_stream') return media.downloadHeights.length ? { kind: 'video', heights: media.downloadHeights } : null;
  // The development sample: never served in production. An HLS stream can't be saved as one file.
  if (env.NODE_ENV === 'production') return null;
  const sampleUrl = env.DEV_SAMPLE_DOWNLOAD_URL ?? (/\.m3u8(\?|$)/i.test(media.hostAssetId) ? undefined : media.hostAssetId);
  return sampleUrl ? { kind: media.kind === 'audio' ? 'audio' : 'video', heights: [], sampleUrl } : null;
}

/** The copy to save: the tallest one at or under the quality's height, or failing that, the shortest there is. */
export function pickHeight(heights: number[], quality: Quality): number | null {
  if (!heights.length) return null;
  const fits = heights.filter((h) => h <= TARGET_HEIGHT[quality]);
  return fits.length ? Math.max(...fits) : Math.min(...heights);
}

function kbpsAt(height: number): number {
  return (KBPS.find(([h]) => h >= height) ?? KBPS[KBPS.length - 1])[1];
}

/** Roughly how big the file will be, from the chapter's length. The app shows it before downloading and checks for room. */
export function estimateBytes(kind: 'video' | 'audio', height: number | null, durationS: number | null): number | null {
  if (!durationS || durationS <= 0) return null;
  const kbps = kind === 'audio' ? AUDIO_KBPS : kbpsAt(height ?? TARGET_HEIGHT.standard);
  return Math.round((durationS * kbps * 1000) / 8);
}

/** Both qualities' sizes, for the course page. Audio is the same file either way. */
export function downloadSizes(found: Downloadable | null, durationS: number | null): Record<Quality, number> | null {
  if (!found) return null;
  const standard = estimateBytes(found.kind, pickHeight(found.heights, 'standard'), durationS);
  const high = estimateBytes(found.kind, pickHeight(found.heights, 'high'), durationS);
  return standard === null || high === null ? null : { standard, high };
}

/** The file's extension, so the phone saves it under a name its player recognises. */
export function extensionOf(found: Downloadable): string {
  if (!found.sampleUrl) return found.kind === 'audio' ? 'm4a' : 'mp4';
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(new URL(found.sampleUrl).pathname)?.[1]?.toLowerCase();
  return ext && ['mp4', 'm4a', 'm4v', 'mov', 'webm', 'mp3', 'aac'].includes(ext) ? ext : found.kind === 'audio' ? 'm4a' : 'mp4';
}
