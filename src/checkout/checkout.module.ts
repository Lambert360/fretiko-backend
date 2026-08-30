import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CartModule } from '../cart/cart.module';
import { EscrowModule } from '../escrow/escrow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RewardsModule } from '../rewards/rewards.module';
import { RidersModule } from '../riders/riders.module';
import { ChatModule } from '../chat/chat.module';
import { WishlistModule } from '../wishlist/wishlist.module';
import { WalletModule } from '../wallet/wallet.module';
import { AuctionsModule } from '../auctions/auctions.module';
import { AuthModule } from '../auth/auth.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    CartModule,
    forwardRef(() => EscrowModule),
    NotificationsModule,
    forwardRef(() => RewardsModule),
    RidersModule,
    forwardRef(() => ChatModule),
    WishlistModule,
    WalletModule,
    forwardRef(() => AuctionsModule), // For marking auction wins as checked out
    forwardRef(() => GiftCardsModule), // For gift card payment integration
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}