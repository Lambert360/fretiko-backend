import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { ScheduleRemindersService } from './schedule-reminders.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EscrowModule } from '../escrow/escrow.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule, 
    ConfigModule, 
    ScheduleModule.forRoot(),
    NotificationsModule, 
    forwardRef(() => EscrowModule)
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, ScheduleRemindersService],
  exports: [WorkspaceService, ScheduleRemindersService],
})
export class WorkspaceModule {}