import { Controller, Get, Post, Delete, Put, Query, Request, Body, Param, UseGuards, ValidationPipe } from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { CreateBankAccountDto, UpdateBankAccountDto } from '../wallet/bank-account.service';
import { WithdrawRequestDto } from '../wallet/dto/wallet.dto';

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

  /**
   * Get platform wallet balance
   * GET /admin/platform/wallet
   */
  @Get('platform/wallet')
  async getPlatformWallet(@Request() req) {
    return this.adminService.getPlatformWallet(req.user.sub);
  }

  /**
   * Get platform bank accounts
   * GET /admin/platform/bank-accounts
   */
  @Get('platform/bank-accounts')
  async getPlatformBankAccounts(@Request() req) {
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
}

