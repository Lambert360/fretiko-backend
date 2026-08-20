import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RssFeedsService } from './rss-feeds.service';
import { RssFeedsScheduler } from './rss-feeds.scheduler';
import { RssFeedsController } from './rss-feeds.controller';
import { EngagementBotsModule } from '../engagement-bots/engagement-bots.module';

@Module({
  imports: [ConfigModule, EngagementBotsModule],
  controllers: [RssFeedsController],
  providers: [RssFeedsService, RssFeedsScheduler],
  exports: [RssFeedsService, RssFeedsScheduler],
})
export class RssFeedsModule {}
