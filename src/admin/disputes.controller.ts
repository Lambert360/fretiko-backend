import { Controller, Get, Post, Param, Query, UseGuards, Req, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Disputes Controller (Staff)
 * Handles dispute management endpoints for staff admin panel
 * Requires staff authentication and view_disputes permission
 */
@Controller('admin/disputes')
@UseGuards(StaffJwtAuthGuard)
export class DisputesController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get dispute statistics
   * GET /admin/disputes/stats
   * Requires: view_disputes permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_disputes')
  async getDisputeStats(@Req() req) {
    return this.adminService.getDisputeStatsForStaff(req.user.sub);
  }

  /**
   * Get all disputes
   * GET /admin/disputes
   * Requires: view_disputes permission
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('view_disputes')
  async getDisputes(
    @Req() req,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getDisputesForStaff(req.user.sub, {
      status: status !== 'all' ? status : undefined,
      type: type !== 'all' ? type : undefined,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Get dispute by ID
   * GET /admin/disputes/:id
   * Requires: view_disputes permission
   */
  @Get(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_disputes')
  async getDisputeById(@Req() req, @Param('id') id: string) {
    return this.adminService.getDisputeByIdForStaff(req.user.sub, id);
  }

  /**
   * Resolve dispute
   * POST /admin/disputes/:id/resolve
   * Requires: resolve_disputes permission
   */
  @Post(':id/resolve')
  @UseGuards(PermissionsGuard)
  @Permissions('resolve_disputes')
  async resolveDispute(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { resolution: string; outcome: 'favor_complainant' | 'favor_respondent' | 'partial' },
  ) {
    return this.adminService.resolveDisputeForStaff(req.user.sub, id, body.resolution, body.outcome);
  }

  /**
   * Escalate dispute
   * POST /admin/disputes/:id/escalate
   * Requires: escalate_disputes permission
   */
  @Post(':id/escalate')
  @UseGuards(PermissionsGuard)
  @Permissions('escalate_disputes')
  async escalateDispute(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.adminService.escalateDisputeForStaff(req.user.sub, id, body.reason);
  }

  /**
   * Add admin note to dispute
   * POST /admin/disputes/:id/notes
   * Requires: resolve_disputes permission
   */
  @Post(':id/notes')
  @UseGuards(PermissionsGuard)
  @Permissions('resolve_disputes')
  async addAdminNote(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { note: string },
  ) {
    return this.adminService.addAdminNoteToDispute(req.user.sub, id, body.note);
  }

  /**
   * Send message to dispute thread as staff
   * POST /admin/disputes/:id/messages
   * Requires: resolve_disputes permission
   */
  @Post(':id/messages')
  @UseGuards(PermissionsGuard)
  @Permissions('resolve_disputes')
  async sendMessage(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { message: string; attachments?: Array<{ type: string; url: string }> },
  ) {
    return this.adminService.addStaffMessageToDispute(req.user.sub, id, body.message, body.attachments);
  }
}

