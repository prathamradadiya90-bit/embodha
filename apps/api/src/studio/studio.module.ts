import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { MoneyModule } from '../money/money.module';
import { StudioController } from './studio.controller';
import { ChangesService } from './changes.service';
import { StudioService } from './studio.service';

@Module({
  imports: [MediaModule, MoneyModule],
  controllers: [StudioController],
  providers: [StudioService, ChangesService],
  exports: [ChangesService],
})
export class StudioModule {}
