import { Controller, Get, Patch, Query, UseGuards, Request, Param } from '@nestjs/common';
import { MentionsService } from './mentions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentionsService: MentionsService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMyMentions(
    @Request() req,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const userId = req.user.sub;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? parseInt(offset, 10) : undefined;

    return this.mentionsService.getMentionsForUser(userId, {
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  @Patch('me/read-all')
  @UseGuards(JwtAuthGuard)
  async markAllRead(@Request() req) {
    await this.mentionsService.markAllMentionsAsRead(req.user.sub);
    return { message: 'All mentions marked as read' };
  }

  @Get('resolve-comment/:commentId')
  @UseGuards(JwtAuthGuard)
  async resolveCommentParent(@Param('commentId') commentId: string) {
    return this.mentionsService.resolveCommentParent(commentId);
  }
}
