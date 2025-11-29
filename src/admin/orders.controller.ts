import { Controller, Get, Query, Param, UseGuards, Req, Patch, Post, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Orders Controller (Staff)
 * Handles order management endpoints for staff admin panel
 * Requires staff authentication and view_orders permission
 */
@Controller('admin/orders')
@UseGuards(StaffJwtAuthGuard)
export class OrdersController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get order statistics
   * GET /admin/orders/stats
   * Requires: view_orders permission
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_orders')
  async getOrderStats(@Req() req) {
    return this.adminService.getOrderStatsForStaff(req.user.sub);
  }

  /**
   * Get all orders
   * GET /admin/orders
   * Requires: view_orders permission
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('view_orders')
  async getOrders(
    @Req() req,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getOrdersForStaff(req.user.sub, {
      status: status !== 'all' ? status : undefined,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Get order by ID
   * GET /admin/orders/:id
   * Requires: view_orders permission
   */
  @Get(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_orders')
  async getOrderById(@Req() req, @Param('id') id: string) {
    return this.adminService.getOrderByIdForStaff(req.user.sub, id);
  }

  /**
   * Update order status
   * PATCH /admin/orders/:id/status
   * Requires: view_orders permission
   */
  @Patch(':id/status')
  @UseGuards(PermissionsGuard)
  @Permissions('view_orders')
  async updateOrderStatus(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { status: 'pending' | 'processing' | 'completed' | 'cancelled' },
  ) {
    return this.adminService.updateOrderStatusForStaff(req.user.sub, id, body.status);
  }

  /**
   * Cancel order
   * POST /admin/orders/:id/cancel
   * Requires: view_orders permission
   */
  @Post(':id/cancel')
  @UseGuards(PermissionsGuard)
  @Permissions('view_orders')
  async cancelOrder(
    @Req() req,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.adminService.cancelOrderForStaff(req.user.sub, id, body.reason);
  }
}

