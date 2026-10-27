import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { AppleStoreClient } from './apple-store.client';
import { AppStoreConnectClient } from './app-store-connect.client';
import { GooglePlayClient } from './google-play.client';
import { GstReportService } from './gst-report.service';
import { InvoicesService } from './invoices.service';
import { MoneySettingsService } from './money-settings.service';
import { MoneyAdminController, MoneyController } from './money.controller';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';
import { RazorpayService } from './razorpay.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { StoreAdminController, StoreController } from './store.controller';
import { StoreSyncService } from './store-sync.service';
import { StoreService } from './store.service';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [CatalogueModule, AuthModule],
  controllers: [MoneyController, MoneyAdminController, StoreController, StoreAdminController, ReconciliationController],
  providers: [
    RazorpayService,
    AppleStoreClient,
    AppStoreConnectClient,
    GooglePlayClient,
    PaymentsService,
    PayoutsService,
    SubscriptionsService,
    StoreService,
    StoreSyncService,
    InvoicesService,
    MoneySettingsService,
    GstReportService,
    ReconciliationService,
  ],
  exports: [SubscriptionsService, StoreSyncService, ReconciliationService, AppleStoreClient],
})
export class MoneyModule {}
