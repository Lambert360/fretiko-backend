import { Controller, Get, Post, Delete, Put, Patch, Query, Request, Body, Param, UseGuards, ValidationPipe, ForbiddenException, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { HybridAdminGuard } from '../auth/hybrid-admin.guard';
import type { CreateBankAccountDto, UpdateBankAccountDto } from '../wallet/bank-account.service';
import { WithdrawRequestDto } from '../wallet/dto/wallet.dto';

/**
 * Admin Controller
 * Platform admin endpoints for revenue tracking and analytics
 * Supports both regular admin users and staff users
 */
@Controller('admin')
@UseGuards(HybridAdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly notificationsService: AdminNotificationsService,
  ) {}

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

  // ============================================
  // ADMIN NOTIFICATIONS ENDPOINTS
  // ============================================

  /**
   * Get staff notifications
   * GET /admin/notifications?page=1&limit=20&type=new_order&is_read=false
   */
  @Get('notifications')
  async getNotifications(
    @Request() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('is_read') isRead?: string,
    @Query('priority') priority?: string,
  ) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Notifications access restricted to staff users only');
    }

    const pageNum = Math.max(1, parseInt(page || '1', 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit || '20', 10)), 100);

    const filters: any = {};
    if (type) filters.type = type;
    if (isRead !== undefined) filters.is_read = isRead === 'true';
    if (priority) filters.priority = priority;

    return this.notificationsService.getNotifications(req.user.sub, pageNum, limitNum, filters);
  }

  /**
   * Get notification stats
   * GET /admin/notifications/stats
   */
  @Get('notifications/stats')
  async getNotificationStats(@Request() req) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Notifications access restricted to staff users only');
    }

    return this.notificationsService.getStats(req.user.sub);
  }

  /**
   * Mark notification as read
   * PATCH /admin/notifications/:id/read
   */
  @Patch('notifications/:id/read')
  async markNotificationAsRead(
    @Request() req,
    @Param('id') notificationId: string,
  ) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Notifications access restricted to staff users only');
    }

    await this.notificationsService.markAsRead(req.user.sub, notificationId);
    return { success: true, message: 'Notification marked as read' };
  }

  /**
   * Mark all notifications as read
   * PATCH /admin/notifications/read-all
   */
  @Patch('notifications/read-all')
  async markAllNotificationsAsRead(@Request() req) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Notifications access restricted to staff users only');
    }

    await this.notificationsService.markAllAsRead(req.user.sub);
    return { success: true, message: 'All notifications marked as read' };
  }

  /**
   * Delete notification
   * DELETE /admin/notifications/:id
   */
  @Delete('notifications/:id')
  async deleteNotification(
    @Request() req,
    @Param('id') notificationId: string,
  ) {
    if (req.authType !== 'staff') {
      throw new ForbiddenException('Notifications access restricted to staff users only');
    }

    await this.notificationsService.deleteNotification(req.user.sub, notificationId);
    return { success: true, message: 'Notification deleted' };
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

