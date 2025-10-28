import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RidersController } from './riders.controller';
import { RidersService } from './riders.service';
import { RiderProfileController } from './rider-profile.controller';
import { RiderProfileService } from './rider-profile.service';
import { RiderOptimizationService } from './rider-optimization.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ConfigModule, NotificationsModule],
  controllers: [RidersController, RiderProfileController],
  providers: [RidersService, RiderProfileService, RiderOptimizationService],
  exports: [RidersService, RiderProfileService, RiderOptimizationService],
})
export class RidersModule {}