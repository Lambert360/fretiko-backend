import { Module, forwardRef } from '@nestjs/common';
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
import { WalletModule } from '../wallet/wallet.module';
import { ContentReportsModule } from '../content-reports/content-reports.module';
import { EmailService } from '../shared/email.service';

@Module({
  imports: [ConfigModule, StaffModule, AuditModule, NotificationsModule, WalletModule, forwardRef(() => ContentReportsModule)],
  controllers: [AdminController, StaffAdminController, ContentModerationController, FinanceController, StaffAnalyticsController, LogisticsController, DashboardController, OrdersController, DisputesController],
  providers: [AdminService, EmailService],
  exports: [AdminService],
})
export class AdminModule {
  // WalletReconciliationService is imported via WalletModule and auto-injected into FinanceController
}

