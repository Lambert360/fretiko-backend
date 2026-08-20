import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EngagementBotsService } from './engagement-bots.service';
import { EngagementBotsScheduler } from './engagement-bots.scheduler';
import { EngagementBotsController } from './engagement-bots.controller';

@Module({
  imports: [ConfigModule],
  controllers: [EngagementBotsController],
  providers: [EngagementBotsService, EngagementBotsScheduler],
  exports: [EngagementBotsService, EngagementBotsScheduler],
})
export class EngagementBotsModule {}
