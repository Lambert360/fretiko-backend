import { Module } from '@nestjs/common';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';
import { StoriesCleanupService } from './stories-cleanup.service';
import { AuthModule } from '../auth/auth.module';
import { TagsModule } from '../tags/tags.module';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [AuthModule, TagsModule, MentionsModule],
  controllers: [StoriesController],
  providers: [StoriesService, StoriesCleanupService],
  exports: [StoriesService],
})
export class StoriesModule {}
