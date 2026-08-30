import { Controller, Get, Param, Query } from '@nestjs/common';
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

  @Get(':tag/content')
  async getTagContent(
    @Param('tag') tag: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit || '50', 10), 100);
    const parsedOffset = Math.max(parseInt(offset || '0', 10), 0);
    const items = await this.tagsService.getTagContent(tag, parsedLimit, parsedOffset);
    return { items, total: items.length };
  }
}
