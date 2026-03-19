import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('stats')
  async getAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('date') date?: string,
  ) {
    return await this.analyticsService.getAnalytics(
      req.user.sub,
      period,
      date,
      req.supabaseToken,
    );
  }

  @Get('summary')
  async getAnalyticsSummary(@Request() req) {
    return await this.analyticsService.getAnalyticsSummary(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('revenue')
  async getRevenueAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return await this.analyticsService.getRevenueAnalytics(
      req.user.sub,
      period,
      startDate,
      endDate,
      req.supabaseToken,
    );
  }

  @Get('customers')
  async getCustomerAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
  ) {
    return await this.analyticsService.getCustomerAnalytics(
      req.user.sub,
      period,
      req.supabaseToken,
    );
  }

  @Get('products')
  async getProductAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
  ) {
    return await this.analyticsService.getProductAnalytics(
      req.user.sub,
      period,
      req.supabaseToken,
    );
  }

  @Post('reports/generate')
  async generateReport(
    @Request() req,
    @Body() reportData: {
      type: 'daily' | 'weekly' | 'monthly' | 'custom';
      startDate?: string;
      endDate?: string;
      format?: 'pdf' | 'excel';
    },
  ) {
    return await this.analyticsService.generateReport(
      req.user.sub,
      reportData,
      req.supabaseToken,
    );
  }

  @Get('reports')
  async getReports(@Request() req) {
    return await this.analyticsService.getReports(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('reports/:reportId/download')
  async downloadReport(
    @Request() req,
    @Param('reportId') reportId: string,
  ) {
    return await this.analyticsService.downloadReport(
      req.user.sub,
      reportId,
      req.supabaseToken,
    );
  }

  @Get('realtime')
  async getRealTimeAnalytics(@Request() req) {
    return await this.analyticsService.getRealTimeAnalytics(
      req.user.sub,
      req.supabaseToken,
    );
  }

  @Get('comparison')
  async getAnalyticsComparison(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('currentDate') currentDate: string,
    @Query('comparisonDate') comparisonDate: string,
  ) {
    return await this.analyticsService.getAnalyticsComparison(
      req.user.sub,
      period,
      currentDate,
      comparisonDate,
      req.supabaseToken,
    );
  }

  /**
   * GET /analytics/live-streaming
   * Get comprehensive live streaming analytics
   */
  @Get('live-streaming')
  async getLiveStreamingAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('date') date?: string,
  ) {
    return await this.analyticsService.getLiveStreamingAnalytics(
      req.user.sub,
      period,
      date,
      req.supabaseToken,
    );
  }

  /**
   * GET /analytics/auctions
   * Get comprehensive auction analytics
   */
  @Get('auctions')
  async getAuctionAnalytics(
    @Request() req,
    @Query('period') period: 'daily' | 'weekly' | 'monthly' = 'daily',
    @Query('date') date?: string,
  ) {
    return await this.analyticsService.getAuctionAnalytics(
      req.user.sub,
      period,
      date,
      req.supabaseToken,
    );
  }

  /**
   * GET /analytics/live-streaming/:streamId/realtime
   * Get real-time analytics for a specific live stream
   */
  @Get('live-streaming/:streamId/realtime')
  async getRealTimeLiveStreamAnalytics(
    @Request() req,
    @Param('streamId') streamId: string,
  ) {
    return await this.analyticsService.getRealTimeLiveStreamAnalytics(streamId);
  }

  /**
   * GET /analytics/vendor/realtime
   * Get real-time metrics for vendor dashboard
   */
  @Get('vendor/realtime')
  async getVendorRealTimeMetrics(@Request() req) {
    return await this.analyticsService.getVendorRealTimeMetrics(req.user.sub);
  }

  /**
   * POST /analytics/events
   * Record analytics event for real-time tracking
   */
  @Post('events')
  async recordAnalyticsEvent(
    @Request() req,
    @Body() eventData: {
      streamId?: string;
      eventType: 'stream_start' | 'stream_end' | 'viewer_join' | 'viewer_leave' |
                 'comment' | 'reaction' | 'gift_sent' | 'product_purchased' | 'service_booked';
      metadata?: Record<string, any>;
    },
  ) {
    return await this.analyticsService.recordAnalyticsEvent({
      ...eventData,
      userId: req.user.sub,
    });
  }

  /**
   * PUT /analytics/live-streaming/:streamId
   * Update live stream analytics in real-time
   */
  @Post('live-streaming/:streamId/update')
  async updateLiveStreamAnalytics(
    @Request() req,
    @Param('streamId') streamId: string,
    @Body() analyticsData: {
      viewerJoin?: boolean;
      viewerLeave?: boolean;
      comment?: boolean;
      reaction?: boolean;
      gift?: { amount: number };
      purchase?: { amount: number };
      engagement?: string;
    },
  ) {
    return await this.analyticsService.updateLiveStreamAnalytics(streamId, analyticsData);
  }
}

@Controller('admin/analytics')
@UseGuards(JwtAuthGuard)
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /admin/analytics/live-streaming
   * Platform-wide live streaming analytics for administrators
   */
  @Get('live-streaming')
  async getPlatformLiveStreamAnalytics(
    @Request() req,
    @Query('period') period: 'today' | 'week' | 'month' | 'quarter' = 'week',
    @Query('category') category: string = 'all',
  ) {
    // Verify admin role
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.getPlatformLiveStreamAnalytics(
      period,
      category,
      req.supabaseToken,
    );
  }

  /**
   * GET /admin/analytics/vendors
   * Get vendor performance analytics
   */
  @Get('vendors')
  async getVendorAnalytics(
    @Request() req,
    @Query('period') period: 'today' | 'week' | 'month' | 'quarter' = 'week',
    @Query('limit') limit: number = 50,
    @Query('offset') offset: number = 0,
  ) {
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.getVendorAnalytics(
      period,
      limit,
      offset,
      req.supabaseToken,
    );
  }

  /**
   * GET /admin/analytics/platform-overview
   * Get comprehensive platform analytics overview
   */
  @Get('platform-overview')
  async getPlatformOverview(
    @Request() req,
    @Query('period') period: 'today' | 'week' | 'month' | 'quarter' = 'week',
  ) {
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.getPlatformOverview(
      period,
      req.supabaseToken,
    );
  }

  /**
   * GET /admin/analytics/geographic
   * Get geographic analytics data
   */
  @Get('geographic')
  async getGeographicAnalytics(
    @Request() req,
    @Query('period') period: 'today' | 'week' | 'month' | 'quarter' = 'week',
  ) {
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.getGeographicAnalytics(
      period,
      req.supabaseToken,
    );
  }

  /**
   * GET /admin/analytics/real-time
   * Get real-time platform metrics
   */
  @Get('real-time')
  async getRealTimePlatformMetrics(
    @Request() req,
  ) {
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.getRealTimePlatformMetrics(req.supabaseToken);
  }

  /**
   * POST /admin/analytics/export
   * Export analytics data
   */
  @Post('export')
  async exportAnalyticsData(
    @Request() req,
    @Body() exportRequest: {
      type: 'platform' | 'vendors' | 'live-streaming' | 'geographic';
      period: 'today' | 'week' | 'month' | 'quarter';
      format: 'csv' | 'excel' | 'json';
      filters?: Record<string, any>;
    },
  ) {
    await this.verifyAdminRole(req.user.sub, req.supabaseToken);

    return await this.analyticsService.exportAnalyticsData(
      exportRequest,
      req.supabaseToken,
    );
  }

  /**
   * Helper method to verify admin role
   */
  private async verifyAdminRole(userId: string, supabaseToken: string) {
    // This would check if the user has admin privileges
    // Implementation depends on your role management system
    const userRole = await this.analyticsService.getUserRole(userId, supabaseToken);

    if (userRole !== 'admin' && userRole !== 'super_admin') {
      throw new Error('Insufficient permissions. Admin access required.');
    }
  }
}