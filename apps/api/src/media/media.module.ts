import { Module } from '@nestjs/common';
import { AudioService } from './audio.service';
import { ImageService } from './image.service';
import { BunnyService } from './bunny.service';
import { MediaService } from './media.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [BunnyService, MediaService, AudioService, ImageService],
  exports: [BunnyService, MediaService, AudioService, ImageService],
})
export class MediaModule {}
