import { Module } from '@nestjs/common';
import { RssFeedsService } from './rss-feeds.service';
import { RssFeedsScheduler } from './rss-feeds.scheduler';
import { RssFeedsController } from './rss-feeds.controller';
import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [SharedModule],
  controllers: [RssFeedsController],
  providers: [RssFeedsService, RssFeedsScheduler],
  exports: [RssFeedsService, RssFeedsScheduler],
})
export class RssFeedsModule {}
