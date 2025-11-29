import { Controller, Post, Get, Patch, Body, Param, Query, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { MemosService } from './memos.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { SendMemoDto, MemoListFilterDto } from './dto/memo.dto';

/**
 * Memos Controller
 * Internal communication system endpoints
 */
@Controller('memos')
@UseGuards(StaffJwtAuthGuard)
export class MemosController {
  constructor(private readonly memosService: MemosService) {}

  /**
   * Send a memo
   * POST /memos
   * Requires: send_memos permission
   */
  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions('send_memos')
  @HttpCode(HttpStatus.CREATED)
  async sendMemo(@Body() memoDto: SendMemoDto, @Req() req) {
    return this.memosService.sendMemo(req.user.sub, memoDto);
  }

  /**
   * Get received memos
   * GET /memos/received
   */
  @Get('received')
  @UseGuards(PermissionsGuard)
  @Permissions('view_memos')
  async getReceivedMemos(@Query() filters: MemoListFilterDto, @Req() req) {
    return this.memosService.getReceivedMemos(req.user.sub, filters);
  }

  /**
   * Get sent memos
   * GET /memos/sent
   */
  @Get('sent')
  async getSentMemos(@Query() filters: MemoListFilterDto, @Req() req) {
    return this.memosService.getSentMemos(req.user.sub, filters);
  }

  /**
   * Get memo statistics
   * GET /memos/stats
   */
  @Get('stats')
  async getMemoStats(@Req() req) {
    return this.memosService.getMemoStats(req.user.sub);
  }

  /**
   * Get memo by ID with replies
   * GET /memos/:id
   */
  @Get(':id')
  async getMemoById(@Param('id') id: string, @Req() req) {
    return this.memosService.getMemoById(id, req.user.sub);
  }

  /**
   * Mark memo as read
   * PATCH /memos/:id/read
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(@Param('id') id: string, @Req() req) {
    return this.memosService.markAsRead(id, req.user.sub);
  }

  /**
   * Reply to a memo
   * POST /memos/:id/reply
   */
  @Post(':id/reply')
  @UseGuards(PermissionsGuard)
  @Permissions('send_memos')
  @HttpCode(HttpStatus.CREATED)
  async replyToMemo(
    @Param('id') parentMemoId: string,
    @Body() body: { subject: string; message: string },
    @Req() req,
  ) {
    // Get parent memo to determine recipient
    const parentMemo = await this.memosService.getMemoById(parentMemoId, req.user.sub);

    const replyDto: SendMemoDto = {
      subject: `Re: ${body.subject}`,
      body: body.message,
      recipientType: parentMemo.recipientType,
      recipientId: parentMemo.recipientId || undefined,
      priority: parentMemo.priority,
      parentMemoId: parentMemoId,
    };

    return this.memosService.sendMemo(req.user.sub, replyDto);
  }
}
