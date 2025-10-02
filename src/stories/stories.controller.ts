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
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StoriesService } from './stories.service';
import {
  CreateStoryDto,
  UpdateStoryDto,
  CreateStoryCommentDto,
  StoryQueryDto,
} from './dto/story.dto';

@Controller('stories')
@UseGuards(JwtAuthGuard)
export class StoriesController {
  constructor(private readonly storiesService: StoriesService) {}

  @Post()
  async createStory(@Request() req, @Body() createStoryDto: CreateStoryDto) {
    return await this.storiesService.createStory(
      req.user.sub,
      createStoryDto,
      req.user.token,
    );
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadStory(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { caption?: string; duration?: number },
  ) {
    return await this.storiesService.uploadStoryWithFile(
      req.user.sub,
      file,
      body.caption,
      body.duration ? parseInt(body.duration.toString()) : undefined,
      req.supabaseToken,
    );
  }

  @Get('feed')
  async getStoriesFeed(@Request() req, @Query() query: StoryQueryDto) {
    return await this.storiesService.getStoriesForFeed(
      req.user.sub,
      query,
      req.user.token,
    );
  }

  @Get('grouped')
  async getStoriesGroupedByUser(@Request() req) {
    return await this.storiesService.getStoriesGroupedByUser(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('my-stories')
  async getMyStories(@Request() req) {
    return await this.storiesService.getMyStories(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('user/:userId')
  async getUserStories(
    @Request() req,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return await this.storiesService.getUserStories(
      userId,
      req.user.sub,
      req.user.token,
    );
  }

  @Get(':id')
  async getStory(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return await this.storiesService.getStoryById(
      id,
      req.user.sub,
      req.user.token,
    );
  }

  @Put(':id')
  async updateStory(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateStoryDto: UpdateStoryDto,
  ) {
    return await this.storiesService.updateStory(
      req.user.sub,
      id,
      updateStoryDto,
      req.user.token,
    );
  }

  @Delete(':id')
  async deleteStory(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return await this.storiesService.deleteStory(
      req.user.sub,
      id,
      req.user.token,
    );
  }

  @Post(':id/view')
  async viewStory(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return await this.storiesService.viewStory(
      req.user.sub,
      id,
      req.supabaseToken,
    );
  }

  @Post(':id/like')
  async toggleLike(@Request() req, @Param('id', ParseUUIDPipe) id: string) {
    return await this.storiesService.toggleLike(
      req.user.sub,
      id,
      req.supabaseToken,
    );
  }

  @Post(':id/comments')
  async addComment(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() createCommentDto: CreateStoryCommentDto,
  ) {
    return await this.storiesService.addComment(
      req.user.sub,
      id,
      createCommentDto,
      req.supabaseToken,
    );
  }

  @Get(':id/comments')
  async getStoryComments(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return await this.storiesService.getStoryComments(
      id,
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Post(':id/notify-comment')
  async notifyComment(
    @Request() req,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() notifyCommentDto: {
      commenterId: string;
      commenterUsername: string;
      commenterAvatarUrl?: string;
      commentText: string;
    },
  ) {
    return await this.storiesService.notifyComment(
      req.user.sub,
      id,
      notifyCommentDto,
      req.supabaseToken,
    );
  }

  @Post('cleanup')
  async cleanupExpiredStories() {
    return await this.storiesService.cleanupExpiredStories();
  }
}