/**
 * FRETIKO NOTIFICATIONS MODULE
 * Module configuration for notification system with WebSocket support
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationHelperService } from './notification-helper.service';
import { NotificationsGateway } from './notifications.gateway';
import { PushNotificationService } from './push-notification.service';
import { EmailNotificationService } from './email-notification.service';
import { EmailReminderService } from './email-reminder.service';
import { AuthModule } from '../auth/auth.module';
import { forwardRef } from '@nestjs/common';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET') || configService.get('SUPABASE_JWT_SECRET'),
        signOptions: { expiresIn: '24h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    PushNotificationService,
    EmailNotificationService,
    EmailReminderService,
    {
      provide: NotificationHelperService,
      useFactory: (notificationsService: NotificationsService, gateway: NotificationsGateway, pushNotificationService: PushNotificationService, emailNotificationService: EmailNotificationService) => {
        const helperService = new NotificationHelperService(notificationsService);
        // Set gateway reference to avoid circular dependency
        helperService.setGateway(gateway);
        // Set push notification service reference
        helperService.setPushNotificationService(pushNotificationService);
        // Set email notification service reference
        helperService.setEmailNotificationService(emailNotificationService);
        return helperService;
      },
      inject: [NotificationsService, NotificationsGateway, PushNotificationService, EmailNotificationService],
    },
    NotificationsGateway
  ],
  exports: [
    NotificationsService, 
    NotificationHelperService,
    PushNotificationService,
    EmailNotificationService,
    NotificationsGateway  // Export gateway for other services to send real-time notifications
  ] 
})
export class NotificationsModule {}