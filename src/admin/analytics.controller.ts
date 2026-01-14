import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Staff Analytics Controller
 * Handles analytics endpoints for staff admin panel
 * Requires staff authentication and view_platform_stats permission
 */
@Controller('admin/analytics')
@UseGuards(StaffJwtAuthGuard)
export class StaffAnalyticsController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get platform statistics
   * GET /admin/analytics/stats
   * Requires: view_platform_stats permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_platform_stats')
  async getPlatformStats(@Req() req) {
    return this.adminService.getPlatformStatsForStaff(req.user.sub);
  }

  /**
   * Get analytics summary
   * GET /admin/analytics/summary
   * Requires: view_platform_stats permission
   */
  @Get('summary')
  @UseGuards(PermissionsGuard)
  @Permissions('view_platform_stats')
  async getAnalyticsSummary(@Req() req) {
    return this.adminService.getAnalyticsSummaryForStaff(req.user.sub);
  }

  /**
   * Get time series data
   * GET /admin/analytics/timeseries?start=2024-01-01&end=2024-01-31&period=daily
   * Requires: view_platform_stats permission
   */
  @Get('timeseries')
  @UseGuards(PermissionsGuard)
  @Permissions('view_platform_stats')
  async getTimeSeries(
    @Req() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('period') period?: 'daily' | 'weekly' | 'monthly',
    @Query('timezoneOffset') timezoneOffset?: string,
  ) {
    return this.adminService.getTimeSeriesForStaff(
      req.user.sub,
      { start, end },
      period || 'daily',
      timezoneOffset ? parseInt(timezoneOffset) : undefined,
    );
  }
}

