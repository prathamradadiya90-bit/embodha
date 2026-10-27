import { Inject, Injectable } from '@nestjs/common';
import { fail } from '../common/errors';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { signBunnyUrl, tusSignature } from './bunny-sign';

const STREAM_API = 'https://video.bunnycdn.com';
const UPLOAD_WINDOW_S = 24 * 3600;

export interface BunnyVideo {
  guid: string;
  /** 0 queued, 1 processing, 2 encoding, 3 finished, 4 resolution finished, 5 failed, 6-8 presigned upload states. */
  status: number;
  /** Seconds. */
  length: number;
  thumbnailFileName?: string;
  /** Whether Bunny made single-file MP4 copies: the library had MP4 fallback on when this video was uploaded. */
  hasMP4Fallback?: boolean;
  /** The renditions encoded so far, like "240p,360p,480p,720p". */
  availableResolutions?: string | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: string | null;
}

@Injectable()
export class BunnyService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get streamReady(): boolean {
    return Boolean(this.env.BUNNY_STREAM_LIBRARY_ID && this.env.BUNNY_STREAM_API_KEY && this.env.BUNNY_STREAM_CDN_HOST);
  }

  async createVideo(title: string): Promise<{ guid: string }> {
    const res = await fetch(`${STREAM_API}/library/${this.env.BUNNY_STREAM_LIBRARY_ID}/videos`, {
      method: 'POST',
      headers: { AccessKey: this.env.BUNNY_STREAM_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw fail(502, 'video_host_error', `Bunny would not create the video (HTTP ${res.status}).`);
    const body = (await res.json()) as { guid: string };
    return { guid: body.guid };
  }

  async getVideo(guid: string): Promise<BunnyVideo> {
    const res = await fetch(`${STREAM_API}/library/${this.env.BUNNY_STREAM_LIBRARY_ID}/videos/${guid}`, {
      headers: { AccessKey: this.env.BUNNY_STREAM_API_KEY, accept: 'application/json' },
    });
    if (!res.ok) throw fail(502, 'video_host_error', `Bunny would not return the video (HTTP ${res.status}).`);
    return (await res.json()) as BunnyVideo;
  }

  /** Everything the studio needs to upload straight to Bunny with tus-js-client. Our API never carries video bytes. */
  tusUpload(guid: string, now = Date.now()) {
    const expire = Math.floor(now / 1000) + UPLOAD_WINDOW_S;
    const libraryId = this.env.BUNNY_STREAM_LIBRARY_ID;
    return {
      endpoint: `${STREAM_API}/tusupload`,
      headers: {
        AuthorizationSignature: tusSignature(libraryId, this.env.BUNNY_STREAM_API_KEY, expire, guid),
        AuthorizationExpire: expire,
        VideoId: guid,
        LibraryId: libraryId,
      },
      expiresAt: new Date(expire * 1000).toISOString(),
    };
  }

  signedHls(guid: string, ttlS: number, now = Date.now()): SignedUrl {
    const url = `https://${this.env.BUNNY_STREAM_CDN_HOST}/${guid}/playlist.m3u8`;
    return this.sign(url, this.env.BUNNY_STREAM_TOKEN_KEY, ttlS, now, `/${guid}/`);
  }

  /**
   * One of the video's MP4 copies, for saving to a phone. Signed for that one file, so the link can't be turned
   * into one for the rest of the video's folder.
   */
  signedMp4(guid: string, height: number, ttlS: number, now = Date.now()): SignedUrl {
    const url = `https://${this.env.BUNNY_STREAM_CDN_HOST}/${guid}/play_${height}p.mp4`;
    return this.sign(url, this.env.BUNNY_STREAM_TOKEN_KEY, ttlS, now);
  }

  signedAudio(path: string, ttlS: number, now = Date.now()): SignedUrl {
    const url = `https://${this.env.BUNNY_AUDIO_CDN_HOST}/${path.replace(/^\/+/, '')}`;
    return this.sign(url, this.env.BUNNY_AUDIO_TOKEN_KEY, ttlS, now);
  }

  thumbnailUrl(guid: string, fileName = 'thumbnail.jpg') {
    return `https://${this.env.BUNNY_STREAM_CDN_HOST}/${guid}/${fileName}`;
  }

  private sign(url: string, key: string, ttlS: number, now: number, tokenPath?: string): SignedUrl {
    if (!key) return { url, expiresAt: null }; // token auth off: local development only, refused in production
    const expires = Math.floor(now / 1000) + ttlS;
    return { url: signBunnyUrl({ url, securityKey: key, expires, tokenPath }), expiresAt: new Date(expires * 1000).toISOString() };
  }
}
