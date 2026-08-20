import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImageFeedsService } from './image-feeds.service';
import { ImageFeedsScheduler } from './image-feeds.scheduler';
import { ImageFeedsController } from './image-feeds.controller';
import { EngagementBotsModule } from '../engagement-bots/engagement-bots.module';

@Module({
  imports: [ConfigModule, EngagementBotsModule],
  controllers: [ImageFeedsController],
  providers: [ImageFeedsService, ImageFeedsScheduler],
  exports: [ImageFeedsService, ImageFeedsScheduler],
})
export class ImageFeedsModule {}
