import { Controller, Get, Post, Patch, Param, Query, UseGuards, Req, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Logistics Controller (Staff)
 * Handles logistics endpoints for staff admin panel
 * Requires staff authentication and view_riders permission
 */
@Controller('admin/logistics')
@UseGuards(StaffJwtAuthGuard)
export class LogisticsController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get logistics statistics
   * GET /admin/logistics/stats
   * Requires: view_riders permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_riders')
  async getLogisticsStats(@Req() req) {
    return this.adminService.getLogisticsStatsForStaff(req.user.sub);
  }

  /**
   * Get rider/delivery analytics
   * GET /admin/logistics/analytics?timeRange=24h|7d|30d
   * Requires: view_riders permission
   */
  @Get('analytics')
  @UseGuards(PermissionsGuard)
  @Permissions('view_riders')
  async getLogisticsAnalytics(
    @Req() req,
    @Query('timeRange') timeRange?: string,
  ) {
    return this.adminService.getLogisticsAnalyticsForStaff(req.user.sub, timeRange || '24h');
  }

  /**
   * Get all riders
   * GET /admin/logistics/riders
   * Requires: view_riders permission
   */
  @Get('riders')
  @UseGuards(PermissionsGuard)
  @Permissions('view_riders')
  async getRiders(
    @Req() req,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getRidersForStaff(req.user.sub, {
      status: status as any,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Get rider by ID
   * GET /admin/logistics/riders/:id
   * Requires: view_riders permission
   */
  @Get('riders/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_riders')
  async getRiderById(@Req() req, @Param('id') id: string) {
    return this.adminService.getRiderByIdForStaff(req.user.sub, id);
  }

  /**
   * Get all deliveries
   * GET /admin/logistics/deliveries
   * Requires: view_deliveries permission
   */
  @Get('deliveries')
  @UseGuards(PermissionsGuard)
  @Permissions('view_deliveries')
  async getDeliveries(
    @Req() req,
    @Query('status') status?: string,
    @Query('riderId') riderId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getDeliveriesForStaff(req.user.sub, {
      status: status as any,
      riderId,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Get delivery by ID
   * GET /admin/logistics/deliveries/:id
   * Requires: view_deliveries permission
   */
  @Get('deliveries/:id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_deliveries')
  async getDeliveryById(@Req() req, @Param('id') id: string) {
    return this.adminService.getDeliveryByIdForStaff(req.user.sub, id);
  }

  /**
   * Assign rider to delivery
   * POST /admin/logistics/deliveries/:id/assign
   * Requires: assign_deliveries permission
   */
  @Post('deliveries/:id/assign')
  @UseGuards(PermissionsGuard)
  @Permissions('assign_deliveries')
  async assignRider(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { riderId: string },
  ) {
    return this.adminService.assignRiderToDeliveryForStaff(req.user.sub, id, body.riderId);
  }

  /**
   * Update delivery status
   * PATCH /admin/logistics/deliveries/:id/status
   * Requires: view_deliveries permission
   */
  @Patch('deliveries/:id/status')
  @UseGuards(PermissionsGuard)
  @Permissions('view_deliveries')
  async updateDeliveryStatus(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.adminService.updateDeliveryStatusForStaff(req.user.sub, id, body.status);
  }
}

