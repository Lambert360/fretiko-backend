import { Controller, Get, Post, Delete, Put, Patch, Query, Request, Body, Param, UseGuards, ValidationPipe, ForbiddenException, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminNotificationsService } from './admin-notifications.service';
import type { CreateBankAccountDto, UpdateBankAccountDto } from '../wallet/bank-account.service';
import { WithdrawRequestDto } from '../wallet/dto/wallet.dto';
import { AdminForgotPasswordDto, AdminConfirmResetPasswordDto } from './dto/admin-forgot-password.dto';

/**
 * Admin Controller
 * Platform admin endpoints for revenue tracking and analytics
 * Supports both regular admin users and staff users
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly notificationsService: AdminNotificationsService,
  ) {}

  /**
   * Admin forgot password - send reset token to admin email
   * POST /admin/forgot-password
   * No authentication required for password reset
   */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async adminForgotPassword(@Body(new ValidationPipe()) forgotPasswordDto: AdminForgotPasswordDto) {
    try {
      const result = await this.adminService.adminForgotPassword(forgotPasswordDto);

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Confirm admin password reset with token
   * POST /admin/confirm-reset-password
   * No authentication required for password reset confirmation
   */
  @Post('confirm-reset-password')
  @HttpCode(HttpStatus.OK)
  async adminConfirmResetPassword(@Body(new ValidationPipe()) confirmResetDto: AdminConfirmResetPasswordDto) {
    try {
      const result = await this.adminService.adminConfirmResetPassword(confirmResetDto);

      return {
        success: result.success,
        message: result.message,
      };
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Validate ISO date string format (YYYY-MM-DDTHH:mm:ss.sssZ)
   */
  private validateDateString(dateStr: string, fieldName: string): void {
    if (!dateStr) return;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid ${fieldName} date format. Expected ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)`);
    }
  }

  /**
   * Get platform-wide revenue analytics
   * GET /admin/revenue?start=2024-01-01&end=2024-12-31
   * Supports both regular admin users and staff users
   */
  @Get('revenue')
    async getPlatformRevenue(
    @Request() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    // Validate date parameters if provided
    if (start) this.validateDateString(start, 'start');
    if (end) this.validateDateString(end, 'end');

    // Validate date range if both dates are provided
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (startDate >= endDate) {
        throw new BadRequestException('Start date must be before end date');
      }
    }

    const dateRange = start && end ? { start, end } : undefined;

    // Route to appropriate service method based on auth type
    if (req.authType === 'staff') {
      return this.adminService.getPlatformRevenueForStaff(req.user.sub, dateRange);
    } else {
      // Regular admin user
      return this.adminService.getPlatformRevenue(req.user.sub, dateRange);
    }
  }

  /**
   * Get escrow health metrics
   * GET /admin/escrow-health
   */
  @Get('escrow-health')
  async getEscrowHealth(@Request() req) {
    if (req.authType === 'staff') {
      return this.adminService.getEscrowHealthForStaff(req.user.sub);
    } else {
      return this.adminService.getEscrowHealth(req.user.sub);
    }
  }

  // NOTE: Disputes routes are handled by DisputesController at /admin/disputes/*
  // Staff users should use /admin/finance/* endpoints for staff-specific features

  /**
   * Get platform-wide statistics
   * GET /admin/stats
   */
  @Get('stats')
  async getPlatformStats(@Request() req) {
    if (req.authType === 'staff') {
      return this.adminService.getPlatformStatsForStaff(req.user.sub);
    } else {
      return this.adminService.getPlatformStats(req.user.sub);
    }
  }

  /**
   * Get auction analytics summary
   * GET /admin/analytics/auctions/summary?start=...&end=...
   */
  @Get('analytics/auctions/summary')
  async getAuctionAnalyticsSummary(
    @Request() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    // Validate date parameters if provided
    if (start) this.validateDateString(start, 'start');
    if (end) this.validateDateString(end, 'end');

    // Validate date range if both dates are provided
    if (start && end) {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (startDate >= endDate) {
        throw new BadRequestException('Start date must be before end date');
      }
    }

    const dateRange = start && end ? { start, end } : undefined;
    return this.adminService.getAuctionAnalyticsSummary(req.user.sub, dateRange);
  }

  /**
   * Get platform wallet balance
   * GET /admin/platform/wallet
   * Restricted to staff users only
   */
  @Get('platform/wallet')
  async getPlatformWallet(@Request() req) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Platform wallet access restricted to staff users only');
    }
    return this.adminService.getPlatformWallet(req.user.sub);
  }

  /**
   * Get platform bank accounts
   * GET /admin/platform/bank-accounts
   * Restricted to staff users only
   */
  @Get('platform/bank-accounts')
  async getPlatformBankAccounts(@Request() req) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Platform bank accounts access restricted to staff users only');
    }
    return this.adminService.getPlatformBankAccounts(req.user.sub);
  }

  /**
   * Add bank account for platform user
   * POST /admin/platform/bank-accounts
   */
  @Post('platform/bank-accounts')
  async addPlatformBankAccount(
    @Request() req,
    @Body(ValidationPipe) dto: CreateBankAccountDto,
  ) {
    return this.adminService.addPlatformBankAccount(req.user.sub, dto);
  }

  /**
   * Update platform bank account
   * PUT /admin/platform/bank-accounts/:accountId
   */
  @Put('platform/bank-accounts/:accountId')
  async updatePlatformBankAccount(
    @Request() req,
    @Param('accountId') accountId: string,
    @Body(ValidationPipe) dto: UpdateBankAccountDto,
  ) {
    return this.adminService.updatePlatformBankAccount(req.user.sub, accountId, dto);
  }

  /**
   * Delete platform bank account
   * DELETE /admin/platform/bank-accounts/:accountId
   */
  @Delete('platform/bank-accounts/:accountId')
  async deletePlatformBankAccount(
    @Request() req,
    @Param('accountId') accountId: string,
  ) {
    return this.adminService.deletePlatformBankAccount(req.user.sub, accountId);
  }

  /**
   * Create withdrawal request for platform wallet
   * POST /admin/platform/withdraw
   */
  @Post('platform/withdraw')
  async createPlatformWithdrawal(
    @Request() req,
    @Body(ValidationPipe) dto: WithdrawRequestDto,
  ) {
    return this.adminService.createPlatformWithdrawal(req.user.sub, dto);
  }

  /**
   * Get platform withdrawal requests
   * GET /admin/platform/withdrawals?page=1&limit=50
   * Restricted to staff users only
   */
  @Get('platform/withdrawals')
  async getPlatformWithdrawals(
    @Request() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Platform withdrawal history access restricted to staff users only');
    }
    
    const pageNum = Math.max(1, parseInt(page || '1', 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit || '50', 10)), 100); // Min 1, Max 100
    
    return this.adminService.getPlatformWithdrawals(req.user.sub, pageNum, limitNum);
  }

  /**
   * Get navigation badge counts
   * GET /admin/nav-badges
   * Returns unread counts for sidebar navigation items
   */
  @Get('nav-badges')
  async getNavBadges(@Request() req) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Badge access restricted to staff users only');
    }

    return this.adminService.getNavBadges(req.user.sub);
  }
}

