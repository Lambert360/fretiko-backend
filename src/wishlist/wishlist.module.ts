import { Module, forwardRef } from '@nestjs/common';
import { WishlistController } from './wishlist.controller';
import { WishlistService } from './wishlist.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { EscrowModule } from '../escrow/escrow.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    NotificationsModule,
    forwardRef(() => ChatModule), // Use forwardRef to avoid circular dependency
    forwardRef(() => EscrowModule), // EscrowService needed for wishlist orders
    WalletModule,
  ],
  controllers: [WishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {
  // Wishlist module for managing user wishlists and chat integration
}