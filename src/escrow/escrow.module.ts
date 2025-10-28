import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EscrowService } from './escrow.service';
import { EscrowController } from './escrow.controller';
import { EscrowSchedulerService } from './escrow-scheduler.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [
    ConfigModule,
    NotificationsModule,
    forwardRef(() => RealtimeModule),
    forwardRef(() => ConnectionsModule),
  ],
  controllers: [EscrowController],
  providers: [EscrowService, EscrowSchedulerService],
  exports: [EscrowService],
})
export class EscrowModule {}

