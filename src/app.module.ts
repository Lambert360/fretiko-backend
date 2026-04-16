import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConnectionsModule } from './connections/connections.module';
import { WalletModule } from './wallet/wallet.module';
import { ProductsModule } from './products/products.module';
import { ServicesModule } from './services/services.module';
import { CartModule } from './cart/cart.module';
import { CheckoutModule } from './checkout/checkout.module';
import { OrdersModule } from './orders/orders.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { RidersModule } from './riders/riders.module';
import { SearchModule } from './search/search.module';
import { ChatModule } from './chat/chat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RewardsModule } from './rewards/rewards.module';
import { LiveSalesModule } from './live-sales/live-sales.module';
import { StoresModule } from './stores/stores.module';
import { AuctionsModule } from './auctions/auctions.module';
import { IkoModule } from './iko/iko.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StoriesModule } from './stories/stories.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EscrowModule } from './escrow/escrow.module';
import { DisputesModule } from './disputes/disputes.module';
import { ContentReportsModule } from './content-reports/content-reports.module';
import { AdminModule } from './admin/admin.module';
import { ExchangeRateController } from './shared/exchange-rate.controller';
import { ExchangeRateService } from './shared/exchange-rate.service';
// Internal Tool Modules
import { StaffModule } from './staff/staff.module';
import { DepartmentsModule } from './departments/departments.module';
import { MemosModule } from './memos/memos.module';
import { ReportsModule } from './reports/reports.module';
import { AuditModule } from './audit/audit.module';
import { GiftModule } from './gifts/gift.module';
import { LoggerModule } from './logger/logger.module';
import { LogisticsPartnersModule } from './logistics-partners/logistics-partners.module';
import { RiderVerificationModule } from './rider-verification/rider-verification.module';
import { PartnershipsModule } from './partnerships/partnerships.module';
import { PartnersModule } from './partners/partners.module';
import { GeneralPartnershipsModule } from './general-partnerships/general-partnerships.module';
import { WebsiteContentModule } from './website-content/website-content.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ 
      isGlobal: true,
      envFilePath: '.env'
    }),
    ScheduleModule.forRoot(), // Enable scheduled tasks
    ThrottlerModule.forRoot([{
      ttl: 60000, // Time window: 60 seconds
      limit: 100, // Maximum 100 requests per window (global default)
    }]),
    AuthModule,
    UsersModule,
    ConnectionsModule,
    WalletModule,
    ProductsModule,
    ServicesModule,
    CartModule,
    CheckoutModule,
    OrdersModule,
    WishlistModule,
    RidersModule,
    SearchModule,
    ChatModule,
    NotificationsModule,
    RewardsModule,
    LiveSalesModule,
    StoresModule,
    AuctionsModule,
    IkoModule,
    RealtimeModule,
    StoriesModule,
    WorkspaceModule,
    AnalyticsModule,
    EscrowModule,
    DisputesModule,
    ContentReportsModule,
    AdminModule,
    DepartmentsModule,
    MemosModule,
    ReportsModule,
    AuditModule,
    GiftModule,
    StaffModule,
    LogisticsPartnersModule,
    RiderVerificationModule,
    PartnershipsModule,
    PartnersModule,
    GeneralPartnershipsModule,
    WebsiteContentModule,
  ],
  controllers: [AppController, ExchangeRateController],
  providers: [
    AppService,
    ExchangeRateService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard, // Apply rate limiting globally
    },
  ],
})
export class AppModule {}