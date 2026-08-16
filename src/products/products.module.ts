import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthModule } from '../auth/auth.module';
import { TagsModule } from '../tags/tags.module';
import { MentionsModule } from '../mentions/mentions.module';
import { EmbeddingService } from '../ai/core/embedding.service';

@Module({
  imports: [AuthModule, TagsModule, MentionsModule],
  controllers: [ProductsController],
  providers: [ProductsService, EmbeddingService],
  exports: [ProductsService],
})
export class ProductsModule {}