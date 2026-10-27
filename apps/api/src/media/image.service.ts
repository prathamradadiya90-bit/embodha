import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fail } from '../common/errors';
import { AudioService } from './audio.service';

const run = promisify(execFile);
/** ffmpeg may only open the uploaded file: no playlists pointing elsewhere, no URLs. */
const LOCAL_ONLY = ['-protocol_whitelist', 'file'];
const PHOTO_CODECS = new Set(['mjpeg', 'png', 'webp']);

/**
 * Photos for the Today screen. ffmpeg checks the file really is a JPEG, PNG or WebP, scales it to at most 1,600 px
 * wide and saves it as a JPEG. Re-saving drops the metadata too, including the location phones write into photos.
 */
@Injectable()
export class ImageService {
  constructor(private readonly storage: AudioService) {}

  get ready() {
    return this.storage.ready;
  }

  async store(input: string, path: string) {
    const output = `${input}.jpg`;
    try {
      const probe = await run('ffprobe', ['-v', 'error', ...LOCAL_ONLY, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'json', input]).catch(() => ({ stdout: '{}' }));
      const codec = (JSON.parse(probe.stdout) as { streams?: { codec_name?: string }[] }).streams?.[0]?.codec_name;
      if (!codec || !PHOTO_CODECS.has(codec)) throw fail(400, 'not_image', 'Upload a photo: JPEG, PNG or WebP.');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...LOCAL_ONLY, '-i', input, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-map_metadata', '-1', '-q:v', '3', output], { timeout: 60_000 });
      const size = await run('ffprobe', ['-v', 'error', ...LOCAL_ONLY, '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', output]);
      const [width, height] = size.stdout.trim().split('x').map(Number);
      await this.storage.put(path, output, 'image/jpeg');
      return { width, height };
    } finally {
      await rm(output, { force: true });
    }
  }
}
