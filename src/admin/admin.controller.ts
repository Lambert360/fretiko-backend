import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Admin Controller
 * Platform admin endpoints for revenue tracking and analytics
 * All endpoints require admin authentication
 */
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Get platform-wide revenue analytics
   * GET /admin/revenue?start=2024-01-01&end=2024-12-31
   */
  @Get('revenue')
  async getPlatformRevenue(
    @Request() req,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const dateRange = start && end ? { start, end } : undefined;
    return this.adminService.getPlatformRevenue(req.user.sub, dateRange);
  }

  /**
   * Get escrow health metrics
   * GET /admin/escrow-health
   */
  @Get('escrow-health')
  async getEscrowHealth(@Request() req) {
    return this.adminService.getEscrowHealth(req.user.sub);
  }

  // NOTE: Disputes routes are handled by DisputesController at /admin/disputes/*
  // This prevents route conflicts between AdminController (JwtAuthGuard) and DisputesController (StaffJwtAuthGuard)

  /**
   * Get platform-wide statistics
   * GET /admin/stats
   */
  @Get('stats')
  async getPlatformStats(@Request() req) {
    return this.adminService.getPlatformStats(req.user.sub);
  }
}

