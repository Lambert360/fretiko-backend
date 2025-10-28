import { Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { StoriesCleanupService } from './stories-cleanup.service';

@Module({
  controllers: [StoriesController],
  providers: [StoriesService, StoriesCleanupService],
  exports: [StoriesService],
})
export class StoriesModule {}