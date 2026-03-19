import { Controller, Get, UseGuards, Req, Query } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Dashboard Controller (Staff)
 * Handles dashboard overview endpoints for staff admin panel
 * Requires staff authentication
 */
@Controller('dashboard')
@UseGuards(StaffJwtAuthGuard)
export class DashboardController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get dashboard overview data
   * GET /dashboard/overview
   * Returns platform stats, recent activities, and quick metrics
   */
  @Get('overview')
  async getDashboardOverview(@Req() req) {
    return this.adminService.getDashboardOverviewForStaff(req.user.sub);
  }

  /**
   * Get all users for dashboard
   * GET /dashboard/users
   * Requires: view_users permission
   */
  @Get('users')
  @UseGuards(PermissionsGuard)
  @Permissions('view_users')
  async getDashboardUsers(
    @Req() req,
    @Query('role') role?: 'citizen' | 'vendor' | 'rider' | 'all',
    @Query('status') status?: 'active' | 'suspended' | 'all',
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getAllUsersForStaff(
      req.user.sub,
      {
        role: role === 'all' ? undefined : role,
        status: status === 'all' ? undefined : status,
        search,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
      }
    );
  }
}

