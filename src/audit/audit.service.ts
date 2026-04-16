import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import {
  LogAuditDto,
  AuditLogResponseDto,
  AuditLogFilterDto,
  AuditStatsDto,
  AuditAction,
  AuditEntityType,
  AuditStatus,
} from './dto/audit.dto';

/**
 * Audit Service
 * Logs and tracks all staff actions in the internal tool
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Log an audit entry
   * This is called automatically by other services when critical actions are performed
   */
  async logAction(logDto: LogAuditDto): Promise<{ id: string | null }> {
    try {
      const { data, error } = await this.supabase
        .from('staff_audit_logs')
        .insert({
          staff_id: logDto.staffId,
          action: logDto.action,
          entity_type: logDto.entityType,
          entity_id: logDto.entityId || null,
          details: logDto.details || {},
          ip_address: logDto.ipAddress || null,
          user_agent: logDto.userAgent || null,
          status: logDto.status || AuditStatus.SUCCESS,
          error_message: logDto.errorMessage || null,
        })
        .select('id')
        .single();

      if (error) {
        this.logger.error(`Failed to log audit: ${error.message}`);
        return { id: null };
      }

      return { id: data.id };
    } catch (error) {
      this.logger.error(`Audit logging error: ${error.message}`);
      return { id: null };
    }
  }

  /**
   * Alias for logAction to match the interface used in logistics services
   */
  async log(logDto: LogAuditDto): Promise<{ id: string | null }> {
    return this.logAction(logDto);
  }

  /**
   * Get audit logs (filtered by permissions)
   */
  async getAuditLogs(requestingStaffId: string, filters?: AuditLogFilterDto): Promise<AuditLogResponseDto[]> {
    // Get requesting staff details
    const { data: requestingStaff } = await this.supabase
      .from('staff_accounts')
      .select('id, role, department_id')
      .eq('id', requestingStaffId)
      .single();

    let query = this.supabase
      .from('staff_audit_logs')
      .select(`
        *,
        staff:staff_accounts!staff_id(id, full_name, staff_id)
      `)
      .order('created_at', { ascending: false })
      .limit(100); // Limit to recent 100 logs

    // Filter based on role
    if (requestingStaff.role === 'department_head') {
      // Department heads can only see logs from their department staff
      const { data: departmentStaff } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('department_id', requestingStaff.department_id);

      const staffIds = departmentStaff?.map(s => s.id) || [];
      query = query.in('staff_id', staffIds);
    }
    // Super admin and HR see all logs

    // Apply filters
    if (filters?.staffId) {
      query = query.eq('staff_id', filters.staffId);
    }

    if (filters?.action) {
      query = query.eq('action', filters.action);
    }

    if (filters?.entityType) {
      query = query.eq('entity_type', filters.entityType);
    }

    if (filters?.entityId) {
      query = query.eq('entity_id', filters.entityId);
    }

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    if (filters?.startDate) {
      query = query.gte('created_at', filters.startDate);
    }

    if (filters?.endDate) {
      query = query.lte('created_at', filters.endDate);
    }

    const { data: logs, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch audit logs: ${error.message}`);
      throw new BadRequestException('Failed to fetch audit logs');
    }

    return logs.map(log => this.mapToResponseDto(log));
  }

  /**
   * Get audit statistics
   */
  async getAuditStats(requestingStaffId: string): Promise<AuditStatsDto> {
    // Get requesting staff details
    const { data: requestingStaff } = await this.supabase
      .from('staff_accounts')
      .select('id, role, department_id')
      .eq('id', requestingStaffId)
      .single();

    let query = this.supabase
      .from('staff_audit_logs')
      .select(`
        *,
        staff:staff_accounts!staff_id(id, full_name, staff_id)
      `);

    // Filter based on role
    if (requestingStaff.role === 'department_head') {
      const { data: departmentStaff } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('department_id', requestingStaff.department_id);

      const staffIds = departmentStaff?.map(s => s.id) || [];
      query = query.in('staff_id', staffIds);
    }

    const { data: logs } = await query;

    const totalActions = logs?.length || 0;
    const successfulActions = logs?.filter(l => l.status === AuditStatus.SUCCESS).length || 0;
    const failedActions = logs?.filter(l => l.status === AuditStatus.FAILED).length || 0;

    // Count by action
    const byAction: Record<string, number> = {};
    logs?.forEach(log => {
      byAction[log.action] = (byAction[log.action] || 0) + 1;
    });

    // Count by entity type
    const byEntityType: Record<string, number> = {};
    logs?.forEach(log => {
      byEntityType[log.entity_type] = (byEntityType[log.entity_type] || 0) + 1;
    });

    // Top staff by action count
    const staffActionCounts: Record<string, { name: string; staffId: string; count: number }> = {};
    logs?.forEach(log => {
      if (!staffActionCounts[log.staff_id]) {
        staffActionCounts[log.staff_id] = {
          name: log.staff?.full_name || 'Unknown',
          staffId: log.staff?.staff_id || log.staff_id,
          count: 0,
        };
      }
      staffActionCounts[log.staff_id].count++;
    });

    const topStaff = Object.values(staffActionCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(s => ({
        staffId: s.staffId,
        staffName: s.name,
        actionCount: s.count,
      }));

    // Recent actions (last 20)
    const recentActions = logs
      ?.slice(0, 20)
      .map(log => this.mapToResponseDto(log)) || [];

    return {
      totalActions,
      successfulActions,
      failedActions,
      byAction,
      byEntityType,
      topStaff,
      recentActions,
    };
  }

  /**
   * Get audit logs for a specific staff member
   */
  async getStaffAuditLogs(staffId: string, limit: number = 50): Promise<AuditLogResponseDto[]> {
    const { data: logs, error } = await this.supabase
      .from('staff_audit_logs')
      .select(`
        *,
        staff:staff_accounts!staff_id(id, full_name, staff_id)
      `)
      .eq('staff_id', staffId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.error(`Failed to fetch staff audit logs: ${error.message}`);
      throw new BadRequestException('Failed to fetch staff audit logs');
    }

    return logs.map(log => this.mapToResponseDto(log));
  }

  /**
   * Get audit logs for a specific entity
   */
  async getEntityAuditLogs(entityType: AuditEntityType, entityId: string): Promise<AuditLogResponseDto[]> {
    const { data: logs, error } = await this.supabase
      .from('staff_audit_logs')
      .select(`
        *,
        staff:staff_accounts!staff_id(id, full_name, staff_id)
      `)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch entity audit logs: ${error.message}`);
      throw new BadRequestException('Failed to fetch entity audit logs');
    }

    return logs.map(log => this.mapToResponseDto(log));
  }

  /**
   * Convenience method: Log user action
   */
  async logUserAction(
    staffId: string,
    action: AuditAction,
    userId: string,
    details?: any,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.logAction({
      staffId,
      action,
      entityType: AuditEntityType.USER,
      entityId: userId,
      details,
      ipAddress,
      userAgent,
    });
  }

  /**
   * Convenience method: Log content moderation action
   */
  async logContentAction(
    staffId: string,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId: string,
    details?: any,
  ): Promise<void> {
    await this.logAction({
      staffId,
      action,
      entityType,
      entityId,
      details,
    });
  }

  /**
   * Convenience method: Log financial action
   */
  async logFinancialAction(
    staffId: string,
    action: AuditAction,
    entityId: string,
    amount: number,
    details?: any,
  ): Promise<void> {
    await this.logAction({
      staffId,
      action,
      entityType: AuditEntityType.WALLET,
      entityId,
      details: { amount, ...details },
    });
  }

  /**
   * Map database record to response DTO
   */
  private mapToResponseDto(log: any): AuditLogResponseDto {
    return {
      id: log.id,
      staffId: log.staff_id,
      staffName: log.staff?.full_name || 'Unknown',
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      details: log.details || {},
      ipAddress: log.ip_address,
      userAgent: log.user_agent,
      status: log.status,
      errorMessage: log.error_message,
      createdAt: log.created_at,
    };
  }
}
