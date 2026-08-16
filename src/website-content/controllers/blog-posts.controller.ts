import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete, 
  Body, 
  Param, 
  Query,
  UseGuards,
  HttpStatus,
  HttpCode
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { StaffJwtAuthGuard } from '../../staff/guards/staff-jwt-auth.guard';
import { BlogPostsService } from '../services/blog-posts.service';
import { CreateBlogPostDto, UpdateBlogPostDto, BlogPostQueryDto, BlogPostStatus } from '../dto/blog-post.dto';

@ApiTags('Website Content - Blog')
@Controller('admin/website-content/blog-posts')
@UseGuards(StaffJwtAuthGuard)
export class BlogPostsController {
  constructor(private readonly blogPostsService: BlogPostsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all blog posts' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog posts retrieved successfully' })
  async findAll(@Query() query: BlogPostQueryDto) {
    return this.blogPostsService.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get blog posts statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Statistics retrieved successfully' })
  async getStats() {
    const [stats, popularTags] = await Promise.all([
      this.blogPostsService.getBlogStats(),
      this.blogPostsService.getPopularTags(),
    ]);

    return {
      ...stats,
      popularTags,
    };
  }

  @Get('tags')
  @ApiOperation({ summary: 'Get popular blog tags' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Popular tags retrieved successfully' })
  async getPopularTags() {
    return this.blogPostsService.getPopularTags();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get blog post by ID' })
  @ApiParam({ name: 'id', description: 'Blog post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post retrieved successfully' })
  async findById(@Param('id') id: string) {
    return this.blogPostsService.findById(id);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get blog post by slug' })
  @ApiParam({ name: 'slug', description: 'Blog post slug' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post retrieved successfully' })
  async findBySlug(@Param('slug') slug: string) {
    return this.blogPostsService.findBySlug(slug);
  }

  @Post()
  @ApiOperation({ summary: 'Create new blog post' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Blog post created successfully' })
  async create(@Body() createBlogPostDto: CreateBlogPostDto) {
    return this.blogPostsService.create(createBlogPostDto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update blog post' })
  @ApiParam({ name: 'id', description: 'Blog post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateBlogPostDto: UpdateBlogPostDto
  ) {
    return this.blogPostsService.update(id, updateBlogPostDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete blog post' })
  @ApiParam({ name: 'id', description: 'Blog post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post deleted successfully' })
  async remove(@Param('id') id: string) {
    return this.blogPostsService.remove(id);
  }

  /**
   * Get published blog posts (admin filter view)
   * GET /admin/website-content/blog-posts/published
   */
  @Get('published')
  @ApiOperation({ summary: 'Get published blog posts (admin view)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Published blog posts retrieved successfully' })
  async findPublishedAdmin(@Query() query: BlogPostQueryDto) {
    // Force status to published for this endpoint
    return this.blogPostsService.findAll({ ...query, status: BlogPostStatus.PUBLISHED });
  }

  /**
   * Publish a blog post
   * POST /admin/website-content/blog-posts/:id/publish
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a blog post' })
  @ApiParam({ name: 'id', description: 'Blog post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post published successfully' })
  async publish(@Param('id') id: string) {
    return this.blogPostsService.publishPost(id);
  }

  /**
   * Archive a blog post
   * POST /admin/website-content/blog-posts/:id/archive
   */
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a blog post' })
  @ApiParam({ name: 'id', description: 'Blog post ID' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post archived successfully' })
  async archive(@Param('id') id: string) {
    return this.blogPostsService.archivePost(id);
  }
}

// Public controller for website frontend
@ApiTags('Public - Blog')
@Controller('public/blog-posts')
export class PublicBlogPostsController {
  constructor(private readonly blogPostsService: BlogPostsService) {}

  @Get()
  @ApiOperation({ summary: 'Get published blog posts' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Published blog posts retrieved successfully' })
  async findPublished(@Query() query: BlogPostQueryDto) {
    return this.blogPostsService.findPublished(query);
  }

  @Get('tags')
  @ApiOperation({ summary: 'Get popular blog tags' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Popular tags retrieved successfully' })
  async getPopularTags() {
    return this.blogPostsService.getPopularTags();
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get published blog post by slug' })
  @ApiParam({ name: 'slug', description: 'Blog post slug' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Blog post retrieved successfully' })
  async findBySlug(@Param('slug') slug: string) {
    return this.blogPostsService.findBySlug(slug);
  }
}
