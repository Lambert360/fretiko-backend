import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AboutContentService } from '../services/about-content.service';
import { BlogPostsService } from '../services/blog-posts.service';
import { JobListingsService } from '../services/job-listings.service';
import { SupportMessagesService } from '../services/support-messages.service';

@ApiTags('Website Content')
@Controller('admin/website-content')
export class WebsiteContentController {
  constructor(
    private readonly aboutContentService: AboutContentService,
    private readonly blogPostsService: BlogPostsService,
    private readonly jobListingsService: JobListingsService,
    private readonly supportMessagesService: SupportMessagesService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get website content statistics' })
  async getStats() {
    const [aboutStats, blogStats, jobStats, supportStats] = await Promise.all([
      this.aboutContentService.getSectionStats(),
      this.blogPostsService.getBlogStats(),
      this.jobListingsService.getJobStats(),
      this.supportMessagesService.getSupportStats(),
    ]);

    return {
      about: aboutStats,
      blog: blogStats,
      jobs: jobStats,
      support: supportStats,
    };
  }
}
