import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AdminController } from './admin.controller';
import { StaffAdminController } from './staff-admin.controller';
import { ContentModerationController } from './content-moderation.controller';
import { AuctionAdminController } from './auction-admin.controller';
import { FinanceController } from './finance.controller';
import { StaffAnalyticsController } from './analytics.controller';
import { LogisticsController } from './logistics.controller';
import { DashboardController } from './dashboard.controller';
import { PartnershipsController } from '../partnerships/partnerships.controller';
import { OrdersController } from './orders.controller';
import { DisputesController } from './disputes.controller';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminService } from './admin.service';
import { AdminNotificationsGateway } from './admin-notifications.gateway';
import { AdminNotificationsService } from './admin-notifications.service';
import { StaffModule } from '../staff/staff.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { ContentReportsModule } from '../content-reports/content-reports.module';
import { AuctionsModule } from '../auctions/auctions.module';
import { GiftModule } from '../gifts/gift.module';
import { EmailService as AuthEmailService } from '../auth/email.service';
import { EmailService as SharedEmailService } from '../shared/email.service';
import { EscrowModule } from '../escrow/escrow.module';
import { PartnershipsModule } from '../partnerships/partnerships.module';
import { WebsiteContentModule } from '../website-content/website-content.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    EventEmitterModule.forRoot(), // For event-based notifications
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'your-secret-key',
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
    StaffModule,
    AuditModule,
    NotificationsModule,
    WalletModule,
    forwardRef(() => ContentReportsModule),
    AuctionsModule, // For fraud detection and auctions service
    GiftModule, // For gift wallet statistics
    EscrowModule, // For escrow release functionality in refunds
    PartnershipsModule, // For partnership applications management
    WebsiteContentModule, // For website content management
  ],
  controllers: [
    AdminController, 
    StaffAdminController, 
    ContentModerationController, 
    AuctionAdminController, // NEW: Auction management endpoints
    FinanceController, 
    StaffAnalyticsController, 
    LogisticsController, 
    DashboardController, 
    PartnershipsController, // NEW: Partnership applications management
    OrdersController, 
    DisputesController,
    AdminNotificationsController, // REST endpoints for admin notifications
  ],
  providers: [
    AdminService,
    AdminNotificationsGateway,
    AdminNotificationsService,
    AuthEmailService,
    SharedEmailService,
  ],
  exports: [AdminService, AdminNotificationsService],
})
export class AdminModule {
  // WalletReconciliationService is imported via WalletModule and auto-injected into FinanceController
  // AuctionFraudDetectionService is imported via AuctionsModule for admin auction management
  // AdminNotificationsGateway provides real-time WebSocket notifications for admin panel
}
