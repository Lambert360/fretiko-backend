import { Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { StoriesCleanupService } from './stories-cleanup.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StoriesController],
  providers: [StoriesService, StoriesCleanupService],
  exports: [StoriesService],
})
export class StoriesModule {}
