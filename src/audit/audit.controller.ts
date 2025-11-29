import { Controller, Get, Query, Param, Req, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { AuditLogFilterDto, AuditEntityType } from './dto/audit.dto';

/**
 * Audit Controller
 * Endpoints for viewing audit logs
 */
@Controller('audit')
@UseGuards(StaffJwtAuthGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Get audit logs (filtered by permissions)
   * GET /audit/logs
   * Requires: view_staff_logs permission (or super_admin)
   */
  @Get('logs')
  @UseGuards(PermissionsGuard)
  @Permissions('view_staff_logs')
  async getAuditLogs(@Query() filters: AuditLogFilterDto, @Req() req) {
    return this.auditService.getAuditLogs(req.user.sub, filters);
  }

  /**
   * Get audit statistics
   * GET /audit/stats
   * Requires: view_staff_logs permission (or super_admin)
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_staff_logs')
  async getAuditStats(@Req() req) {
    return this.auditService.getAuditStats(req.user.sub);
  }

  /**
   * Get audit logs for a specific staff member
   * GET /audit/staff/:staffId
   * Requires: view_staff_logs permission
   */
  @Get('staff/:staffId')
  @UseGuards(PermissionsGuard)
  @Permissions('view_staff_logs')
  async getStaffAuditLogs(@Param('staffId') staffId: string) {
    return this.auditService.getStaffAuditLogs(staffId);
  }

  /**
   * Get audit logs for a specific entity
   * GET /audit/entity/:entityType/:entityId
   * Example: /audit/entity/user/123-456-789
   */
  @Get('entity/:entityType/:entityId')
  async getEntityAuditLogs(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
  ) {
    return this.auditService.getEntityAuditLogs(entityType, entityId);
  }
}
