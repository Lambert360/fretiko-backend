import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { StaffAdminController } from './staff-admin.controller';
import { ContentModerationController } from './content-moderation.controller';
import { FinanceController } from './finance.controller';
import { StaffAnalyticsController } from './analytics.controller';
import { LogisticsController } from './logistics.controller';
import { DashboardController } from './dashboard.controller';
import { OrdersController } from './orders.controller';
import { DisputesController } from './disputes.controller';
import { AdminService } from './admin.service';
import { StaffModule } from '../staff/staff.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ConfigModule, StaffModule, AuditModule, NotificationsModule],
  controllers: [AdminController, StaffAdminController, ContentModerationController, FinanceController, StaffAnalyticsController, LogisticsController, DashboardController, OrdersController, DisputesController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}

