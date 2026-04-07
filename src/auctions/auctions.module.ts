import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { AuctionGateway } from './auction.gateway';
import { AuctionSchedulerService } from './auction-scheduler.service';
import { AuctioneerAiService } from './auctioneer-ai.service';
import { AuctionPaymentService } from './auction-payment.service';
import { AuctionFraudDetectionService } from './fraud-detection.service';
import { WalletModule } from '../wallet/wallet.module';
import { EscrowModule } from '../escrow/escrow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Auctions Module
 *
 * Handles complete auction functionality including:
 * - Auction management (create, update, delete)
 * - Real-time bidding with WebSocket support
 * - Live auctions with AI auctioneer
 * - Auction lifecycle management (scheduled tasks)
 * - Integration with wallet and escrow systems for payments
 * - Category management and discovery
 */
@Module({
  imports: [
    ScheduleModule.forRoot(), // For auction lifecycle cron jobs
    AuthModule, // For JWT authentication
    WalletModule, // For payment integration
    forwardRef(() => EscrowModule), // For escrow protection
    NotificationsModule, // For seller notifications
  ],
  controllers: [AuctionsController],
  providers: [
    AuctionsService,
    AuctionGateway,
    AuctionSchedulerService,
    AuctioneerAiService,
    AuctionPaymentService,
    AuctionFraudDetectionService,
  ],
  exports: [AuctionsService, AuctionFraudDetectionService], // Export for use in other modules (especially admin)
})
export class AuctionsModule {}