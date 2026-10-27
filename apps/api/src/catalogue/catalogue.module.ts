import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AccessService } from './access.service';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { PlaybackService } from './playback.service';

@Module({
  imports: [MediaModule],
  controllers: [CatalogueController],
  providers: [CatalogueService, PlaybackService, AccessService],
  exports: [AccessService],
})
export class CatalogueModule {}
