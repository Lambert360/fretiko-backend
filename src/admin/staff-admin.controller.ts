import { Controller, Get, Query, Request, UseGuards, Post, Delete, Param, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Staff Admin Controller
 * Admin panel endpoints for staff members to manage platform users
 * Uses StaffJwtAuthGuard and permission-based access control
 */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard)
export class StaffAdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get user statistics
   * GET /admin/users/stats
   * Requires: view_users permission
   */
  @Get('users/stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_users')
  async getUserStats(@Request() req) {
    return this.adminService.getUserStatsForStaff(req.user.sub);
  }

  /**
   * Get user by ID
   * GET /admin/users/:id
   * Requires: view_users permission
   */
  @Get('users/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_users')
  async getUserById(@Request() req, @Param('id') id: string) {
    return this.adminService.getUserByIdForStaff(req.user.sub, id);
  }

  /**
   * Suspend user account
   * POST /admin/users/:id/suspend
   * Requires: suspend_users permission
   */
  @Post('users/:id/suspend')
  @UseGuards(PermissionsGuard)
  @Permissions('suspend_users')
  async suspendUser(@Request() req, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.adminService.suspendUser(req.user.sub, id, body.reason);
  }

  /**
   * Activate user account
   * POST /admin/users/:id/activate
   * Requires: suspend_users permission
   */
  @Post('users/:id/activate')
  @UseGuards(PermissionsGuard)
  @Permissions('suspend_users')
  async activateUser(@Request() req, @Param('id') id: string) {
    return this.adminService.activateUser(req.user.sub, id);
  }

  /**
   * Delete user account
   * DELETE /admin/users/:id
   * Requires: delete_users permission
   */
  @Delete('users/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('delete_users')
  async deleteUser(@Request() req, @Param('id') id: string) {
    return this.adminService.deleteUserForStaff(req.user.sub, id);
  }

  /**
   * Warn a user
   * POST /admin/users/:id/warn
   * Requires: suspend_users permission
   */
  @Post('users/:id/warn')
  @UseGuards(PermissionsGuard)
  @Permissions('suspend_users')
  async warnUser(
    @Request() req,
    @Param('id') id: string,
    @Body() body: {
      severity: 'low' | 'medium' | 'high';
      reason: string;
      relatedContentId?: string;
      relatedContentType?: 'product' | 'service' | 'chat' | 'user';
    },
  ) {
    return this.adminService.warnUser(
      req.user.sub,
      id,
      body.severity,
      body.reason,
      body.relatedContentId,
      body.relatedContentType,
    );
  }

  /**
   * Get user's warning history
   * GET /admin/users/:id/warnings
   * Requires: view_users permission
   */
  @Get('users/:id/warnings')
  @UseGuards(PermissionsGuard)
  @Permissions('view_users')
  async getUserWarnings(@Request() req, @Param('id') id: string) {
    return this.adminService.getUserWarnings(id);
  }

  /**
   * Get all suspension appeals
   * GET /admin/appeals
   * Requires: suspend_users permission
   */
  @Get('appeals')
  @UseGuards(PermissionsGuard)
  @Permissions('suspend_users')
  async getAppeals(
    @Request() req,
    @Query('status') status?: 'pending' | 'under_review' | 'approved' | 'rejected' | 'all',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getAppealsForStaff(req.user.sub, {
      status: status === 'all' ? undefined : status,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Review a suspension appeal
   * POST /admin/appeals/:id/review
   * Requires: suspend_users permission
   */
  @Post('appeals/:id/review')
  @UseGuards(PermissionsGuard)
  @Permissions('suspend_users')
  async reviewAppeal(
    @Request() req,
    @Param('id') id: string,
    @Body() body: {
      decision: 'approved' | 'rejected';
      notes?: string;
    },
  ) {
    return this.adminService.reviewAppeal(req.user.sub, id, body.decision, body.notes);
  }
}

