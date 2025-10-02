import { Module } from '@nestjs/common';
import { LiveSalesController } from './live-sales.controller';
import { LiveSalesService } from './live-sales.service';
import { LiveStreamGateway } from './live-stream.gateway';
import { AnalyticsModule } from '../analytics/analytics.module';

/**
 * Live Sales Module
 * 
 * Handles all live streaming functionality including:
 * - Stream management (create, start, end)
 * - Real-time features (comments, reactions, gifts)
 * - Live product sales and service bookings
 * - Analytics and viewer tracking
 */
@Module({
  imports: [AnalyticsModule],
  controllers: [LiveSalesController],
  providers: [LiveSalesService, LiveStreamGateway],
  exports: [LiveSalesService],
})
export class LiveSalesModule {}