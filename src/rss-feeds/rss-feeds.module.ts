import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RssFeedsService } from './rss-feeds.service';
import { RssFeedsScheduler } from './rss-feeds.scheduler';
import { RssFeedsController } from './rss-feeds.controller';

@Module({
  imports: [ConfigModule],
  controllers: [RssFeedsController],
  providers: [RssFeedsService, RssFeedsScheduler],
  exports: [RssFeedsService, RssFeedsScheduler],
})
export class RssFeedsModule {}
