import { Controller, Get, Post, Param, Query, UseGuards, Req, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { WalletReconciliationService } from '../wallet/wallet-reconciliation.service';

/**
 * Finance Controller (Staff)
 * Handles finance-related endpoints for staff admin panel
 * Requires staff authentication and view_revenue permission
 */
@Controller('admin/finance')
@UseGuards(StaffJwtAuthGuard)
export class FinanceController {
  constructor(
    private readonly adminService: AdminService,
    private readonly walletReconciliationService: WalletReconciliationService,
  ) {}

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

  /**
   * Get reconciliation alerts (exchange rate fallback usage)
   * GET /admin/finance/reconciliation-alerts
   * Requires: view_revenue permission
   */
  @Get('reconciliation-alerts')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getReconciliationAlerts(
    @Req() req,
    @Query('status') status?: 'pending' | 'reviewed' | 'resolved' | 'dismissed',
    @Query('severity') severity?: 'low' | 'medium' | 'high' | 'critical',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.adminService.getReconciliationAlertsForStaff(req.user.sub, {
      status,
      severity,
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      startDate,
      endDate,
    });
  }

  /**
   * Update reconciliation alert status
   * PATCH /admin/finance/reconciliation-alerts/:id/status
   * Requires: view_revenue permission
   */
  @Post('reconciliation-alerts/:id/status')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async updateReconciliationAlertStatus(
    @Req() req,
    @Param('id') id: string,
    @Query('status') status: 'reviewed' | 'resolved' | 'dismissed',
    @Query('notes') notes?: string,
  ) {
    return this.adminService.updateReconciliationAlertStatus(
      req.user.sub,
      id,
      status,
      notes,
    );
  }

  /**
   * Manually refund a failed withdrawal
   * POST /admin/finance/withdrawals/:payoutId/refund
   * Requires: process_payouts permission (Finance staff only)
   */
  @Post('withdrawals/:payoutId/refund')
  @UseGuards(PermissionsGuard)
  @Permissions('process_payouts')
  async refundWithdrawal(
    @Req() req,
    @Param('payoutId') payoutId: string,
    @Body() body: { reason: string },
  ) {
    if (!body.reason || body.reason.trim().length === 0) {
      throw new Error('Refund reason is required');
    }
    return this.adminService.refundWithdrawalManually(
      req.user.sub,
      payoutId,
      body.reason,
    );
  }

  /**
   * Trigger wallet balance reconciliation manually
   * POST /admin/finance/reconcile-wallets
   * Requires: view_revenue permission (Finance staff only)
   */
  @Post('reconcile-wallets')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async triggerReconciliation(@Req() req) {
    return this.walletReconciliationService.triggerReconciliation();
  }

  /**
   * Reconcile specific user's wallet
   * POST /admin/finance/reconcile-wallets/:userId
   * Requires: view_revenue permission (Finance staff only)
   */
  @Post('reconcile-wallets/:userId')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async reconcileUserWallet(@Req() req, @Param('userId') userId: string) {
    return this.walletReconciliationService.reconcileUserWallet(userId);
  }
}

