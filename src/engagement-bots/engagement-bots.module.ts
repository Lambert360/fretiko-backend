import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EngagementBotsService } from './engagement-bots.service';
import { EngagementBotsScheduler } from './engagement-bots.scheduler';
import { EngagementBotsController } from './engagement-bots.controller';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [ConfigModule, AiModule],
  controllers: [EngagementBotsController],
  providers: [EngagementBotsService, EngagementBotsScheduler],
  exports: [EngagementBotsService, EngagementBotsScheduler],
})
export class EngagementBotsModule {}
