import { Controller, Post, Get, Body, Param, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import type { CreateDisputeDto, ResolveDisputeDto } from './disputes.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  /**
   * Create a new dispute for an order
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDispute(@Req() req, @Body() createDisputeDto: CreateDisputeDto) {
    return this.disputesService.createDispute(req.user.sub, createDisputeDto);
  }

  /**
   * Get all disputes for current user
   */
  @Get('my-disputes')
  async getMyDisputes(@Req() req) {
    return this.disputesService.getUserDisputes(req.user.sub);
  }

  /**
   * Get dispute details
   */
  @Get(':id')
  async getDispute(@Req() req, @Param('id') disputeId: string) {
    return this.disputesService.getDispute(req.user.sub, disputeId);
  }

  /**
   * Add a message to a dispute thread
   */
  @Post(':id/messages')
  async addMessage(
    @Req() req,
    @Param('id') disputeId: string,
    @Body() body: { message: string; attachments?: Array<{ type: string; url: string }> },
  ) {
    return this.disputesService.addDisputeMessage(req.user.sub, disputeId, body.message, body.attachments);
  }

  /**
   * Resolve a dispute (admin only)
   */
  @Post(':id/resolve')
  @UseGuards(AdminGuard)
  async resolveDispute(@Req() req, @Param('id') disputeId: string, @Body() resolveDisputeDto: ResolveDisputeDto) {
    return this.disputesService.resolveDispute(req.user.sub, disputeId, resolveDisputeDto);
  }

  /**
   * Get all open disputes (admin only)
   */
  @Get('admin/open')
  @UseGuards(AdminGuard)
  async getAllOpenDisputes(@Req() req) {
    return this.disputesService.getAllOpenDisputes();
  }
}

