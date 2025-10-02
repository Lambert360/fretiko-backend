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
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LiveSalesService } from './live-sales.service';
import {
  CreateLiveStreamDto,
  UpdateStreamStatusDto,
  PostCommentDto,
  SendReactionDto,
  SendGiftDto,
  LiveProductPurchaseDto,
  LiveServiceBookingDto,
  JoinStreamDto,
  LeaveStreamDto,
} from './dto/live-sales.dto';

/**
 * Live Sales Controller
 * 
 * RESTful API endpoints for live streaming functionality:
 * - Stream discovery and management
 * - Real-time interactions
 * - Live commerce transactions
 * - Analytics and viewer tracking
 */
@Controller('live-sales')
@UseGuards(JwtAuthGuard)
export class LiveSalesController {
  constructor(private readonly liveSalesService: LiveSalesService) {}

  // =====================
  // STREAM DISCOVERY
  // =====================

  /**
   * GET /live-sales/streams
   * Get all active live streams for discovery feed
   */
  @Get('streams')
  async getActiveStreams(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('exclude_plugged') excludePlugged?: string,
    @Request() req?: any,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const excludePluggedVendors = excludePlugged === 'true';

    if (limitNum > 50) {
      throw new BadRequestException('Limit cannot exceed 50');
    }

    return this.liveSalesService.getActiveStreams(
      limitNum, 
      offsetNum, 
      excludePluggedVendors, 
      req?.user?.sub
    );
  }

  /**
   * GET /live-sales/plugged-vendors/streams
   * Get live streams from connected vendors (plugged)
   */
  @Get('plugged-vendors/streams')
  async getPluggedVendorsStreams(
    @Request() req: any,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    const limitNum = limit ? parseInt(limit, 10) : 10;

    if (limitNum > 20) {
      throw new BadRequestException('Limit cannot exceed 20');
    }

    return this.liveSalesService.getPluggedVendorsStreams(userId, limitNum);
  }

  /**
   * GET /live-sales/streams/:id
   * Get specific stream details
   */
  @Get('streams/:id')
  async getStreamById(
    @Param('id') streamId: string,
    @Request() req: any,
  ) {
    return this.liveSalesService.getStreamById(streamId, req.user?.sub);
  }

  // =====================
  // STREAM MANAGEMENT
  // =====================

  /**
   * POST /live-sales/streams
   * Create a new live stream (vendors only)
   */
  @Post('streams')
  async createStream(
    @Request() req: any,
    @Body() createStreamDto: CreateLiveStreamDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    // TODO: Add vendor role check
    // const user = await this.usersService.getUserById(userId);
    // if (!user.is_seller && !user.is_rider) {
    //   throw new ForbiddenException('Only vendors can create live streams');
    // }

    const token = req.headers.authorization?.replace('Bearer ', '');
    return this.liveSalesService.createStream(userId, createStreamDto, token);
  }

  /**
   * PUT /live-sales/streams/:id/status
   * Update stream status (setup -> live -> ended)
   */
  @Put('streams/:id/status')
  async updateStreamStatus(
    @Param('id') streamId: string,
    @Request() req: any,
    @Body() updateStatusDto: UpdateStreamStatusDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.liveSalesService.updateStreamStatus(streamId, userId, updateStatusDto);
  }

  /**
   * DELETE /live-sales/streams/:id
   * End a live stream
   */
  @Delete('streams/:id')
  async endStream(
    @Param('id') streamId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    await this.liveSalesService.endStream(streamId, userId);
    return { success: true, message: 'Stream ended successfully' };
  }

  // =====================
  // VIEWER ACTIONS
  // =====================

  /**
   * POST /live-sales/streams/:id/join
   * Join a live stream as viewer
   */
  @Post('streams/:id/join')
  async joinStream(
    @Param('id') streamId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    await this.liveSalesService.joinStream(streamId, userId);
    return { success: true, message: 'Joined stream successfully' };
  }

  /**
   * POST /live-sales/streams/:id/leave
   * Leave a live stream
   */
  @Post('streams/:id/leave')
  async leaveStream(
    @Param('id') streamId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    await this.liveSalesService.leaveStream(streamId, userId);
    return { success: true, message: 'Left stream successfully' };
  }

  // =====================
  // COMMENTS & REACTIONS
  // =====================

  /**
   * GET /live-sales/streams/:id/comments
   * Get comments for a stream
   */
  @Get('streams/:id/comments')
  async getStreamComments(
    @Param('id') streamId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    return this.liveSalesService.getStreamComments(streamId, limitNum, offsetNum);
  }

  /**
   * POST /live-sales/comments
   * Post a comment to a stream
   */
  @Post('comments')
  async postComment(
    @Request() req: any,
    @Body() postCommentDto: PostCommentDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    return this.liveSalesService.postComment(userId, postCommentDto, token);
  }

  /**
   * POST /live-sales/reactions
   * Send a reaction to a stream
   */
  @Post('reactions')
  async sendReaction(
    @Request() req: any,
    @Body() sendReactionDto: SendReactionDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    await this.liveSalesService.sendReaction(userId, sendReactionDto, token);
    return { success: true, message: 'Reaction sent successfully' };
  }

  // =====================
  // GIFTS & MONETIZATION
  // =====================

  /**
   * GET /live-sales/gift-types
   * Get available gift types
   */
  @Get('gift-types')
  async getGiftTypes() {
    return this.liveSalesService.getGiftTypes();
  }

  /**
   * POST /live-sales/gifts
   * Send a gift to a stream vendor
   */
  @Post('gifts')
  async sendGift(
    @Request() req: any,
    @Body() sendGiftDto: SendGiftDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    await this.liveSalesService.sendGift(userId, sendGiftDto);
    return { success: true, message: 'Gift sent successfully' };
  }

  // =====================
  // LIVE COMMERCE
  // =====================

  /**
   * POST /live-sales/purchase/product
   * Purchase a product during live stream
   */
  @Post('purchase/product')
  async purchaseProduct(
    @Request() req: any,
    @Body() purchaseDto: LiveProductPurchaseDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.liveSalesService.purchaseProduct(userId, purchaseDto);
  }

  /**
   * POST /live-sales/purchase/service
   * Book a service during live stream
   */
  @Post('purchase/service')
  async bookService(
    @Request() req: any,
    @Body() bookingDto: LiveServiceBookingDto,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    return this.liveSalesService.bookService(userId, bookingDto);
  }

  // =====================
  // VENDOR ANALYTICS
  // =====================

  /**
   * GET /live-sales/my-streams
   * Get vendor's own streams with analytics
   */
  @Get('my-streams')
  async getMyStreams(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    // TODO: Implement vendor stream analytics
    return { streams: [], message: 'Vendor streams retrieved' };
  }

  /**
   * GET /live-sales/streams/:id/analytics
   * Get detailed analytics for a specific stream
   */
  @Get('streams/:id/analytics')
  async getStreamAnalytics(
    @Param('id') streamId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.sub;
    if (!userId) {
      throw new BadRequestException('User not authenticated');
    }

    // TODO: Implement stream analytics
    return { analytics: {}, message: 'Stream analytics retrieved' };
  }
}