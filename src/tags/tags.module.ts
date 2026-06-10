import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseClientManager } from '../auth/supabase-client-manager.service';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';

@Module({
  imports: [ConfigModule],
  controllers: [TagsController],
  providers: [TagsService, SupabaseClientManager],
  exports: [TagsService],
})
export class TagsModule {}
