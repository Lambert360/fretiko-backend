import { Controller, Get, Query, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SignPostsService } from '../sign-posts.service';

@ApiTags('Public - Hero Images')
@Controller('hero-images')
export class PublicSignPostsController {
  constructor(private readonly signPostsService: SignPostsService) {}

  @Get()
  @ApiOperation({ summary: 'Get active hero/sign-post images for mobile' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Active hero media retrieved successfully',
  })
  async getHeroImages(@Query('screen') screen?: string) {
    return this.signPostsService.getHeroImages(screen || 'all');
  }
}
