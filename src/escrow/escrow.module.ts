import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowSchedulerService } from './escrow-scheduler.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConnectionsModule } from '../connections/connections.module';
import { WalletModule } from '../wallet/wallet.module';
import { AuthModule } from '../auth/auth.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    NotificationsModule,
    WalletModule,
    PartnersModule,
    forwardRef(() => RealtimeModule),
    forwardRef(() => ConnectionsModule),
  ],
  controllers: [EscrowController],
  providers: [EscrowService, EscrowSchedulerService],
  exports: [EscrowService],
})
export class EscrowModule {}

