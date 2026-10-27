import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BetaModule } from '../beta/beta.module';
import { MediaModule } from '../media/media.module';
import { MoneyModule } from '../money/money.module';
import { LaunchController } from './launch.controller';
import { LaunchService } from './launch.service';

@Module({
  imports: [AuthModule, BetaModule, MoneyModule, MediaModule],
  controllers: [LaunchController],
  providers: [LaunchService],
})
export class LaunchModule {}
