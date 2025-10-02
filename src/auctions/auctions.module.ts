import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { AuctionGateway } from './auction.gateway';
import { AuctionSchedulerService } from './auction-scheduler.service';
import { AuctioneerAiService } from './auctioneer-ai.service';
import { AuctionPaymentService } from './auction-payment.service';
import { WalletModule } from '../wallet/wallet.module';

/**
 * Auctions Module
 *
 * Handles complete auction functionality including:
 * - Auction management (create, update, delete)
 * - Real-time bidding with WebSocket support
 * - Live auctions with AI auctioneer
 * - Auction lifecycle management (scheduled tasks)
 * - Integration with wallet system for payments
 * - Category management and discovery
 */
@Module({
  imports: [
    ScheduleModule.forRoot(), // For auction lifecycle cron jobs
    WalletModule, // For payment integration
  ],
  controllers: [AuctionsController],
  providers: [
    AuctionsService,
    AuctionGateway,
    AuctionSchedulerService,
    AuctioneerAiService,
    AuctionPaymentService,
  ],
  exports: [AuctionsService], // Export for use in other modules
})
export class AuctionsModule {}