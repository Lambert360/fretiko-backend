import { Module, forwardRef } from '@nestjs/common';
import { LiveSalesController } from './live-sales.controller';
import { LiveSalesService } from './live-sales.service';
import { LiveStreamGateway } from './live-stream.gateway';
import { AnalyticsModule } from '../analytics/analytics.module';
import { EscrowModule } from '../escrow/escrow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { UsersModule } from '../users/users.module';
import { GiftModule } from '../gifts/gift.module';

/**
 * Live Sales Module
 * 
 * Handles all live streaming functionality including:
 * - Stream management (create, start, end)
 * - Real-time features (comments, reactions, gifts)
 * - Live product sales and service bookings (with escrow protection)
 * - Analytics and viewer tracking
 */
@Module({
  imports: [
    AnalyticsModule,
    forwardRef(() => EscrowModule),
    NotificationsModule,
    GiftModule,
    WalletModule,
    UsersModule,
  ],
  controllers: [LiveSalesController],
  providers: [LiveSalesService, LiveStreamGateway],

  exports: [LiveSalesService],
})
export class LiveSalesModule {}