import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChatModule } from '../chat/chat.module';
import { ConnectionsModule } from '../connections/connections.module';
import { EscrowModule } from '../escrow/escrow.module';
import { RewardsModule } from '../rewards/rewards.module';
import { WalletModule } from '../wallet/wallet.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    NotificationsModule,
    forwardRef(() => ChatModule),
    forwardRef(() => ConnectionsModule),
    forwardRef(() => EscrowModule),
    forwardRef(() => RewardsModule),
    WalletModule,
    PartnersModule,
    RealtimeModule, // For WebSocket real-time order status updates
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}