import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { MoneyModule } from '../money/money.module';
import { StudioModule } from '../studio/studio.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, MoneyModule, StudioModule, MediaModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
