import { Module, forwardRef } from '@nestjs/common';
import { WishlistController } from './wishlist.controller';
import { WishlistService } from './wishlist.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    NotificationsModule,
    forwardRef(() => ChatModule), // Use forwardRef to avoid circular dependency
  ],
  controllers: [WishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {
  // Wishlist module for managing user wishlists and chat integration
}