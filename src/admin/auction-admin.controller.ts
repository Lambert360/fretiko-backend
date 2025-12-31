import { Controller, Get, Post, Put, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { AdminService } from './admin.service';
import { AuctionFraudDetectionService } from '../auctions/fraud-detection.service';
import { AuctionsService } from '../auctions/auctions.service';

@Controller('admin/auctions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AuctionAdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly fraudDetectionService: AuctionFraudDetectionService,
    private readonly auctionsService: AuctionsService,
  ) {}

  /**
   * Get full bid history with real user identities (Admin only)
   * Used for fraud detection and dispute resolution
   */
  @Get(':id/bids/full')
  @Permissions('view_products')
  async getFullBidHistory(@Req() req, @Param('id') auctionId: string) {
    const staffId = req.user.sub;
    return this.adminService.getFullAuctionBidHistory(staffId, auctionId);
  }

  /**
   * Invalidate a fraudulent bid
   */
  @Post('bids/:bidId/invalidate')
  @Permissions('remove_products')
  async invalidateBid(
    @Req() req,
    @Param('bidId') bidId: string,
    @Body() body: { reason: string },
  ) {
    const staffId = req.user.sub;
    return this.adminService.invalidateAuctionBid(staffId, bidId, body.reason);
  }

  /**
   * Update auction category (Super Admin only)
   */
  @Put('categories/:id')
  @Permissions('super_admin')
  async updateCategory(
    @Req() req,
    @Param('id') categoryId: string,
    @Body() updates: { description?: string; display_order?: number; is_active?: boolean },
  ) {
    const staffId = req.user.sub;
    return this.adminService.updateAuctionCategory(staffId, categoryId, updates);
  }

  /**
   * Emergency extend auction (Super Admin only - for critical system failures)
   */
  @Post(':id/emergency-extend')
  @Permissions('super_admin')
  async emergencyExtend(
    @Req() req,
    @Param('id') auctionId: string,
    @Body() body: { extension_minutes: number; reason: string },
  ) {
    const adminId = req.user.sub;
    return this.auctionsService.emergencyExtendAuction(
      adminId,
      auctionId,
      body.extension_minutes,
      body.reason,
    );
  }

  /**
   * Run manual fraud check on auction
   */
  @Post(':id/fraud-check')
  @Permissions('view_products')
  async runFraudCheck(@Req() req, @Param('id') auctionId: string) {
    const alerts = await this.fraudDetectionService.runManualFraudCheck(auctionId);
    return {
      auction_id: auctionId,
      alerts_found: alerts.length,
      alerts,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Get fraud alerts for an auction
   */
  @Get(':id/fraud-alerts')
  @Permissions('view_products')
  async getFraudAlerts(@Req() req, @Param('id') auctionId: string) {
    // This would query risk_flags table for auction-related fraud flags
    const alerts = await this.fraudDetectionService.detectShillBidding(auctionId);
    return {
      auction_id: auctionId,
      current_alerts: alerts,
    };
  }
}

