import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoFeedsService } from './video-feeds.service';
import { VideoFeedsScheduler } from './video-feeds.scheduler';
import { VideoFeedsController } from './video-feeds.controller';
import { EngagementBotsModule } from '../engagement-bots/engagement-bots.module';

@Module({
  imports: [ConfigModule, EngagementBotsModule],
  controllers: [VideoFeedsController],
  providers: [VideoFeedsService, VideoFeedsScheduler],
  exports: [VideoFeedsService, VideoFeedsScheduler],
})
export class VideoFeedsModule {}
