import { Controller, Get, Post, Param, Query, UseGuards, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';

/**
 * Finance Controller (Staff)
 * Handles finance-related endpoints for staff admin panel
 * Requires staff authentication and view_revenue permission
 */
@Controller('admin/finance')
@UseGuards(StaffJwtAuthGuard)
export class FinanceController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get platform revenue analytics
   * GET /admin/finance/revenue?start=2024-01-01&end=2024-12-31
   * Requires: view_revenue permission
   */
  @Get('revenue')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getPlatformRevenue(
    @Req() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const dateRange = start && end ? { start, end } : undefined;
    return this.adminService.getPlatformRevenueForStaff(req.user.sub, dateRange);
  }

  /**
   * Get escrow health metrics
   * GET /admin/finance/escrow-health
   * Requires: view_revenue permission
   */
  @Get('escrow-health')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getEscrowHealth(@Req() req) {
    return this.adminService.getEscrowHealthForStaff(req.user.sub);
  }

  /**
   * Get payouts
   * GET /admin/finance/payouts
   * Requires: view_revenue permission
   */
  @Get('payouts')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getPayouts(
    @Req() req,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getPayoutsForStaff(req.user.sub, {
      status: status as any,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Process payout
   * POST /admin/finance/payouts/:id/process
   * Requires: process_payouts permission
   */
  @Post('payouts/:id/process')
  @UseGuards(PermissionsGuard)
  @Permissions('process_payouts')
  async processPayout(@Req() req, @Param('id') id: string) {
    return this.adminService.processPayoutForStaff(req.user.sub, id);
  }

  /**
   * Get total platform funds
   * GET /admin/finance/total-funds
   * Requires: view_revenue permission
   */
  @Get('total-funds')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getTotalFunds(@Req() req) {
    return this.adminService.getTotalPlatformFundsForStaff(req.user.sub);
  }

  /**
   * Get deposits and transactions
   * GET /admin/finance/deposits
   * Requires: view_revenue permission
   */
  @Get('deposits')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getDeposits(
    @Req() req,
    @Query('paymentMethod') paymentMethod?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getDepositsForStaff(req.user.sub, {
      paymentMethod,
      status: status as any,
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }

  /**
   * Get user balances sorted by available funds
   * GET /admin/finance/user-balances
   * Requires: view_revenue permission
   */
  @Get('user-balances')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getUserBalances(
    @Req() req,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getUserBalancesForStaff(req.user.sub, {
      search,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
    });
  }
}

