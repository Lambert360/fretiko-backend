/**
 * FRETIKO REWARDS MODULE
 * Module configuration for rewards system
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RewardsSchedulerService } from './rewards-scheduler.service';

@Module({
  imports: [ConfigModule],
  controllers: [RewardsController],
  providers: [
    RewardsService,
    RewardsSchedulerService
  ],
  exports: [RewardsService] // Export for use in other modules (wallet, orders, etc.)
})
export class RewardsModule {}