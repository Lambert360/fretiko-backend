import { Controller, Get, Post, Param, Query, Body, UseGuards, Req } from '@nestjs/common';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { BackgroundProcessingService } from '../wallet/background-processing.service';

/**
 * Monitoring Controller (Staff)
 * Handles system monitoring, health checks, and background task management
 */
@Controller('admin/monitoring')
@UseGuards(StaffJwtAuthGuard)
export class MonitoringController {
  constructor(
    private readonly backgroundProcessingService: BackgroundProcessingService,
  ) {}

  /**
   * Get system health metrics
   * GET /admin/monitoring/health
   * Requires: view_revenue permission
   */
  @Get('health')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getHealthMetrics(@Req() req) {
    return this.backgroundProcessingService.getHealthMetrics();
  }

  /**
   * Get cached analytics reports
   * GET /admin/monitoring/analytics/:type
   * Requires: view_revenue permission
   */
  @Get('analytics/:type')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getCachedAnalytics(@Req() req) {
    // This would be implemented to get the type from params
    return this.backgroundProcessingService.getCachedAnalytics('weekly');
  }

  /**
   * Manual trigger for exchange rate update
   * POST /admin/monitoring/update-rates
   * Requires: process_payouts permission (for system operations)
   */
  @Post('update-rates')
  @UseGuards(PermissionsGuard)
  @Permissions('process_payouts')
  async manualRateUpdate(@Req() req) {
    return this.backgroundProcessingService.manualRateUpdate();
  }

  /**
   * Manual trigger for wallet reconciliation
   * POST /admin/monitoring/reconcile
   * Requires: process_payouts permission (for system operations)
   */
  @Post('reconcile')
  @UseGuards(PermissionsGuard)
  @Permissions('process_payouts')
  async manualReconciliation(@Req() req) {
    return this.backgroundProcessingService.manualReconciliation();
  }

  /**
   * Get recent system alerts
   * GET /admin/monitoring/alerts?limit=50&severity=&resolved=
   * Requires: view_revenue permission
   */
  @Get('alerts')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async getAlerts(
    @Query('limit') limit?: string,
    @Query('severity') severity?: string,
    @Query('resolved') resolved?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const parsedResolved = resolved !== undefined ? resolved === 'true' : undefined;
    
    return this.backgroundProcessingService.getAlerts(parsedLimit, severity, parsedResolved);
  }

  /**
   * Dismiss an alert
   * POST /admin/monitoring/alerts/:id/dismiss
   * Requires: view_revenue permission
   */
  @Post('alerts/:id/dismiss')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async dismissAlert(
    @Param('id') alertId: string,
    @Req() req,
  ) {
    const resolvedBy = req.user?.staffId || req.user?.sub || 'staff';
    return this.backgroundProcessingService.dismissAlert(alertId, resolvedBy);
  }

  /**
   * Resolve an alert with optional notes
   * POST /admin/monitoring/alerts/:id/resolve
   * Requires: view_revenue permission
   */
  @Post('alerts/:id/resolve')
  @UseGuards(PermissionsGuard)
  @Permissions('view_revenue')
  async resolveAlert(
    @Param('id') alertId: string,
    @Body() body: { notes?: string },
    @Req() req,
  ) {
    const resolvedBy = req.user?.staffId || req.user?.sub || 'staff';
    return this.backgroundProcessingService.resolveAlert(alertId, body?.notes, resolvedBy);
  }
}
