import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { chapters, mediaAssets } from '../db/schema';

const run = promisify(execFile);

/**
 * What ffprobe may call an upload. Anything else is refused before ffmpeg touches it: a playlist or "concat" file
 * dressed up as audio could otherwise make ffmpeg read other files on the server, or fetch URLs.
 */
const AUDIO_FORMATS = new Set(['mp3', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'wav', 'aac', 'flac', 'ogg', 'matroska', 'webm', 'aiff']);
/** ffmpeg may open the one local file it's given, and nothing else: no http, no pipes, no other protocols. */
const LOCAL_ONLY = ['-protocol_whitelist', 'file'];

/**
 * Audio chapters: every file comes out at the same loudness, so members never reach for the volume between
 * chapters or instructors. Then it goes to Bunny Storage, and members stream it through the audio pull zone.
 */
@Injectable()
export class AudioService {
  private readonly log = new Logger('Audio');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectDb() private readonly db: Db,
  ) {}

  get ready(): boolean {
    return Boolean(this.env.BUNNY_STORAGE_ZONE && this.env.BUNNY_STORAGE_PASSWORD && this.env.BUNNY_AUDIO_CDN_HOST);
  }

  /**
   * -16 LUFS integrated, -1.5 dB true peak: the level podcast apps aim for. AAC at 128 kbps in an M4A with the index
   * at the front, so playback starts before the download finishes. Returns the length in seconds.
   */
  async normalize(input: string, output: string): Promise<number> {
    const probed = await run('ffprobe', ['-v', 'error', ...LOCAL_ONLY, '-show_entries', 'format=format_name', '-of', 'default=nw=1:nk=1', input]);
    const formats = probed.stdout.trim().split(',');
    if (!formats.some((format) => AUDIO_FORMATS.has(format))) throw new Error(`Refused a ${probed.stdout.trim() || 'unknown'} file`);
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', ...LOCAL_ONLY, '-i', input, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output],
      { timeout: 20 * 60_000 },
    );
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output]);
    return Math.round(Number(stdout.trim()));
  }

  async put(path: string, file: string, contentType = 'audio/mp4'): Promise<void> {
    const res = await fetch(`https://${this.env.BUNNY_STORAGE_HOST}/${this.env.BUNNY_STORAGE_ZONE}/${path}`, {
      method: 'PUT',
      headers: { AccessKey: this.env.BUNNY_STORAGE_PASSWORD, 'content-type': contentType },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      duplex: 'half',
    } as RequestInit);
    if (!res.ok) throw new Error(`Bunny Storage answered ${res.status}`);
  }

  /** Runs after the upload request has answered: normalise, store, then mark the chapter's audio ready (or failed). */
  async process(mediaId: string, chapterId: string, input: string): Promise<void> {
    const output = `${input}.m4a`;
    try {
      const durationS = await this.normalize(input, output);
      const path = `audio/${chapterId}/${mediaId}.m4a`;
      await this.put(path, output);
      await this.db.transaction(async (tx) => {
        await tx.update(mediaAssets).set({ status: 'ready', hostAssetId: path, durationS, error: null }).where(eq(mediaAssets.id, mediaId));
        await tx.update(chapters).set({ durationS }).where(and(eq(chapters.id, chapterId), eq(chapters.mediaAssetId, mediaId)));
      });
    } catch (error) {
      this.log.error(`Audio ${mediaId} failed: ${(error as Error).message}`);
      await this.db
        .update(mediaAssets)
        .set({ status: 'failed', error: "Couldn't process this file. Try exporting it again as WAV, MP3 or M4A." })
        .where(eq(mediaAssets.id, mediaId));
    } finally {
      await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    }
  }
}
