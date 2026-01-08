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

@Module({
  imports: [
    ConfigModule,
    NotificationsModule,
    forwardRef(() => ChatModule),
    forwardRef(() => ConnectionsModule),
    forwardRef(() => EscrowModule),
    forwardRef(() => RewardsModule),
    WalletModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}