import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
import { ExchangeRateController } from './shared/exchange-rate.controller';
import { ExchangeRateService } from './shared/exchange-rate.service';

@Module({
  imports: [
    ConfigModule.forRoot({ 
      isGlobal: true,
      envFilePath: '.env'
    }),
    ScheduleModule.forRoot(), // Enable scheduled tasks
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
  ],
  controllers: [AppController, ExchangeRateController],
  providers: [AppService, ExchangeRateService],
})
export class AppModule {}