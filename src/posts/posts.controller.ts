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
  Request,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PostsService } from './posts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostOwnershipGuard } from './guards/post-ownership.guard';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateInteractionDto, PostGiftDto, CommentGiftDto } from './dto/interaction.dto';
import { InteractionType } from './interfaces/post.interface';
import { FeedQueryDto, PaginationQueryDto } from './dto/feed-query.dto';
import { CreateReportDto } from './dto/report.dto';

@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  // Create a new post
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() createPostDto: CreatePostDto, @Request() req) {
    const post = await this.postsService.create(req.user.id, createPostDto);
    return {
      success: true,
      data: post,
      message: 'Post created successfully',
    };
  }

  // Upload media for posts
  @Post('upload-media')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB limit for videos
    },
  }))
  @ApiOperation({ summary: 'Upload post media (image or video)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Media uploaded successfully' })
  async uploadMedia(@UploadedFile() file: Express.Multer.File, @Request() req) {
    console.log('📤 uploadMedia called:', { userId: req.user.id, fileName: file?.originalname, size: file?.size });
    const result = await this.postsService.uploadMedia(req.user.id, file);
    return {
      success: true,
      data: result,
      message: 'Media uploaded successfully',
    };
  }

  // Get personalized feed
  @Get('feed')
  @UseGuards(JwtAuthGuard)
  async getFeed(@Query() query: FeedQueryDto, @Request() req) {
    const feed = await this.postsService.getFeed(req.user.id, query);
    return {
      success: true,
      data: feed,
      meta: {
        limit: query.limit,
        offset: query.offset,
        total: feed.length,
      },
    };
  }

  // Get all posts (public feed)
  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(@Query() query: PaginationQueryDto, @Request() req) {
    const posts = await this.postsService.getFeed(req.user.id, { 
      limit: query.limit, 
      offset: query.offset 
    });
    return {
      success: true,
      data: posts,
      meta: {
        limit: query.limit,
        offset: query.offset,
      },
    };
  }

  // Get single post
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Request() req) {
    const post = await this.postsService.findById(id, req.user.id);
    return {
      success: true,
      data: post,
    };
  }

  // Get posts by user
  @Get('user/:userId')
  @UseGuards(JwtAuthGuard)
  async findByUser(
    @Param('userId') userId: string,
    @Query() query: PaginationQueryDto,
    @Request() req,
  ) {
    const posts = await this.postsService.findByUser(
      userId,
      req.user.id,
      query.limit,
      query.offset,
    );
    return {
      success: true,
      data: posts,
      meta: {
        limit: query.limit,
        offset: query.offset,
      },
    };
  }

  // Update post
  @Put(':id')
  @UseGuards(JwtAuthGuard, PostOwnershipGuard)
  async update(
    @Param('id') id: string,
    @Body() updatePostDto: UpdatePostDto,
    @Request() req,
  ) {
    const post = await this.postsService.update(id, req.user.id, updatePostDto);
    return {
      success: true,
      data: post,
      message: 'Post updated successfully',
    };
  }

  // Delete post (soft delete)
  @Delete(':id')
  @UseGuards(JwtAuthGuard, PostOwnershipGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string, @Request() req) {
    await this.postsService.delete(id, req.user.id);
    return {
      success: true,
      message: 'Post deleted successfully',
    };
  }

  // Create interaction (like, comment, share, gift)
  @Post(':id/interact')
  @UseGuards(JwtAuthGuard)
  async interact(
    @Param('id') id: string,
    @Body() dto: CreateInteractionDto,
    @Request() req,
  ) {
    const interaction = await this.postsService.createInteraction(
      id,
      req.user.id,
      dto,
    );
    return {
      success: true,
      data: interaction,
      message: `${dto.interactionType} added successfully`,
    };
  }

  // Remove interaction (unlike, etc.)
  @Delete(':id/interact/:type')
  @UseGuards(JwtAuthGuard)
  async removeInteraction(
    @Param('id') id: string,
    @Param('type') type: string,
    @Request() req,
  ) {
    await this.postsService.removeInteraction(
      id,
      req.user.id,
      type as any,
    );
    return {
      success: true,
      message: 'Interaction removed successfully',
    };
  }

  // Get comments for a post (with reaction counts)
  @Get(':id/comments')
  @UseGuards(JwtAuthGuard)
  async getComments(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
    @Query('sortBy') sortBy: 'popular' | 'newest' = 'popular',
    @Request() req,
  ) {
    const comments = await this.postsService.getCommentsWithReactions(
      id,
      req.user.id,
      query.limit,
      query.offset,
      sortBy,
    );
    return {
      success: true,
      data: comments,
      meta: {
        limit: query.limit,
        offset: query.offset,
        sortBy,
      },
    };
  }

  // Like a comment
  @Post('comments/:commentId/like')
  @UseGuards(JwtAuthGuard)
  async likeComment(
    @Param('commentId') commentId: string,
    @Request() req,
  ) {
    const interaction = await this.postsService.likeComment(
      commentId,
      req.user.id,
    );
    return {
      success: true,
      data: interaction,
      message: 'Comment liked successfully',
    };
  }

  // Unlike a comment
  @Delete('comments/:commentId/like')
  @UseGuards(JwtAuthGuard)
  async unlikeComment(
    @Param('commentId') commentId: string,
    @Request() req,
  ) {
    await this.postsService.unlikeComment(commentId, req.user.id);
    return {
      success: true,
      message: 'Comment unliked successfully',
    };
  }

  // Send gift to comment
  @Post('comments/:commentId/gift')
  @UseGuards(JwtAuthGuard)
  async sendGiftToComment(
    @Param('commentId') commentId: string,
    @Body() dto: CommentGiftDto,
    @Request() req,
  ) {
    const interaction = await this.postsService.sendGiftToComment(
      commentId,
      req.user.id,
      dto.giftId,
    );
    return {
      success: true,
      data: interaction,
      message: 'Gift sent successfully',
    };
  }

  // Toggle bookmark
  @Post(':id/bookmark')
  @UseGuards(JwtAuthGuard)
  async toggleBookmark(@Param('id') id: string, @Request() req) {
    const isBookmarked = await this.postsService.toggleBookmark(
      id,
      req.user.id,
    );
    return {
      success: true,
      data: { isBookmarked },
      message: isBookmarked ? 'Post bookmarked' : 'Bookmark removed',
    };
  }

  // Get user's bookmarks
  @Get('user/bookmarks/me')
  @UseGuards(JwtAuthGuard)
  async getUserBookmarks(@Query() query: PaginationQueryDto, @Request() req) {
    const bookmarks = await this.postsService.getUserBookmarks(
      req.user.id,
      query.limit,
      query.offset,
    );
    return {
      success: true,
      data: bookmarks,
      meta: {
        limit: query.limit,
        offset: query.offset,
      },
    };
  }

  // Send gift to post
  @Post(':id/gift')
  @UseGuards(JwtAuthGuard)
  async sendGift(
    @Param('id') id: string,
    @Body() dto: PostGiftDto,
    @Request() req,
  ) {
    console.log('🎁 sendGift called:', { postId: id, giftId: dto.giftId, userId: req.user.id });
    const interaction = await this.postsService.sendGiftToPost(id, req.user.id, dto.giftId);
    return {
      success: true,
      data: interaction,
      message: 'Gift sent successfully',
    };
  }

  // Report post
  @Post(':id/report')
  @UseGuards(JwtAuthGuard)
  async reportPost(
    @Param('id') id: string,
    @Body() dto: CreateReportDto,
    @Request() req,
  ) {
    // This would create a report entry
    // For now, just return success
    return {
      success: true,
      message: 'Report submitted successfully',
    };
  }

  // Get related posts (more from user)
  @Get(':id/related')
  @UseGuards(JwtAuthGuard)
  async getRelatedPosts(
    @Param('id') id: string,
    @Query('limit') limit: number = 10,
    @Request() req,
  ) {
    const relatedPosts = await this.postsService.getRelatedPosts(
      id,
      req.user.id,
      limit,
    );
    return {
      success: true,
      data: relatedPosts,
      meta: {
        limit,
        total: relatedPosts.length,
      },
    };
  }
}
