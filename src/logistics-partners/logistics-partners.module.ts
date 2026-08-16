import { Module } from '@nestjs/common';
import { LogisticsPartnersController } from './logistics-partners.controller';
import { LogisticsPartnersService } from './logistics-partners.service';
import { LogisticsNotificationService } from './logistics-notification.service';
import { RiderVerificationController } from '../rider-verification/rider-verification.controller';
import { RiderVerificationService } from '../rider-verification/rider-verification.service';
import { AuditModule } from '../audit/audit.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [
    LogisticsPartnersController,
    RiderVerificationController,
  ],
  providers: [
    LogisticsPartnersService,
    LogisticsNotificationService,
    RiderVerificationService,
  ],
  exports: [
    LogisticsPartnersService,
    LogisticsNotificationService,
    RiderVerificationService,
  ],
})
export class LogisticsPartnersModule {}
