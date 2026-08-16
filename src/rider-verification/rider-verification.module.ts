import { Module } from '@nestjs/common'
import { RiderVerificationController } from './rider-verification.controller'
import { RiderVerificationService } from './rider-verification.service'
import { AuditModule } from '../audit/audit.module'
import { LogisticsPartnersModule } from '../logistics-partners/logistics-partners.module'
import { JwtModule } from '@nestjs/jwt'
import { ConfigModule, ConfigService } from '@nestjs/config'

@Module({
  imports: [AuditModule, LogisticsPartnersModule, JwtModule.registerAsync({
    imports: [ConfigModule],
    useFactory: async (configService: ConfigService) => ({
      secret: configService.get<string>('JWT_SECRET'),
      signOptions: { expiresIn: '1h' },
    }),
    inject: [ConfigService],
  })],
  controllers: [RiderVerificationController],
  providers: [RiderVerificationService],
  exports: [RiderVerificationService],
})
export class RiderVerificationModule {}
