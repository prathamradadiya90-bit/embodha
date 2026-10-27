import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CatalogueModule } from './catalogue/catalogue.module';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env';
import { DbModule } from './db/db.module';
import { DownloadsModule } from './downloads/downloads.module';
import { HealthController } from './health.controller';
import { MediaModule } from './media/media.module';
import { PracticeModule } from './practice/practice.module';
import { AdminModule } from './admin/admin.module';
import { MoneyModule } from './money/money.module';
import { NotesModule } from './notes/notes.module';
import { PrivacyModule } from './privacy/privacy.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BetaModule } from './beta/beta.module';
import { LaunchModule } from './launch/launch.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReviewsModule } from './reviews/reviews.module';
import { StudioModule } from './studio/studio.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_SECRET, signOptions: { expiresIn: env.ACCESS_TOKEN_TTL_S } }),
    }),
    // A blunt per-IP ceiling. Sign-in has its own, tighter limits on top.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    AuthModule,
    CatalogueModule,
    MediaModule,
    StudioModule,
    PracticeModule,
    AdminModule,
    MoneyModule,
    ReviewsModule,
    NotesModule,
    PrivacyModule,
    AnalyticsModule,
    BetaModule,
    LaunchModule,
    NotificationsModule,
    DownloadsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
