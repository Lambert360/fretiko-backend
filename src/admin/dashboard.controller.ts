import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Dashboard Controller (Staff)
 * Handles dashboard overview endpoints for staff admin panel
 * Requires staff authentication
 */
@Controller('admin/dashboard')
@UseGuards(StaffJwtAuthGuard)
export class DashboardController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get dashboard overview data
   * GET /admin/dashboard/overview
   * Returns platform stats, recent activities, and quick metrics
   */
  @Get('overview')
  async getDashboardOverview(@Req() req) {
    return this.adminService.getDashboardOverviewForStaff(req.user.sub);
  }
}

