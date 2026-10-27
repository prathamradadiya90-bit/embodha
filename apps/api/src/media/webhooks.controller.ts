import { Body, Controller, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { safeEqual } from '../common/crypto';
import { fail } from '../common/errors';
import { heard } from '../common/webhooks';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { MediaService } from './media.service';

/** What Bunny's webhook Status codes mean (docs.bunny.net, Stream webhooks). */
const BUNNY_STATUS: Record<number, string> = {
  0: 'queued',
  1: 'processing',
  2: 'encoding',
  3: 'finished',
  4: 'resolution finished',
  5: 'failed',
  6: 'upload started',
  7: 'upload finished',
  8: 'upload failed',
  9: 'captions generated',
  10: 'title or description generated',
};

@ApiExcludeController()
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectDb() private readonly db: Db,
    private readonly media: MediaService,
  ) {}

  /** Bunny calls this when a video changes state. The body is only a hint: we re-read the video from Bunny's API. */
  @Post('video')
  @HttpCode(200)
  async video(@Query('secret') secret: string | undefined, @Body() body: { VideoGuid?: unknown; Status?: unknown }) {
    if (!this.env.BUNNY_WEBHOOK_SECRET || !safeEqual(secret ?? '', this.env.BUNNY_WEBHOOK_SECRET)) {
      throw fail(401, 'bad_secret', 'Unknown webhook caller.');
    }
    await heard(this.db, 'bunny', typeof body?.Status === 'number' ? `a video ${BUNNY_STATUS[body.Status] ?? `in status ${body.Status}`}` : 'a video update');
    if (typeof body?.VideoGuid === 'string') await this.media.syncFromBunny(body.VideoGuid);
    return { ok: true };
  }
}
