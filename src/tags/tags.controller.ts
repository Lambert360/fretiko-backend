import { Controller, Get, Query } from '@nestjs/common';
import { TagsService } from './tags.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get('trending')
  async getTrendingTags(@Query('limit') limit?: string) {
    const parsedLimit = parseInt(limit || '20', 10);
    const tags = await this.tagsService.getTrendingTags(parsedLimit);
    return tags;
  }
}
