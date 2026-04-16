import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GiftController } from './gift.controller';
import { GiftService } from './gift.service';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Gifts Module
 * 
 * Handles virtual gift economy including:
 * - Gift catalog management
 * - Gift purchases (user wallet → admin gift wallet)
 * - Gift conversions (gifts → 80% user credits + 20% platform fee)
 * - Gift sending in calls/streams/auctions
 * - User gift collection management
 */
@Module({
  imports: [
    AuthModule,
    forwardRef(() => WalletModule),
    NotificationsModule,
    RealtimeModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') || 'your-secret-key-change-in-production',
        signOptions: {
          expiresIn: '8h',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [GiftController],
  providers: [GiftService],
  exports: [GiftService],
})
export class GiftModule {}

