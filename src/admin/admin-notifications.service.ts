/**
 * FRETIKO ADMIN NOTIFICATIONS SERVICE
 * Business logic for admin panel notifications - CRUD, targeting, real-time delivery
 */

import { Injectable, Logger, BadRequestException, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { AdminNotificationsGateway } from './admin-notifications.gateway';
import { AdminNotificationEventType } from './events/admin-notification.events';
import type {
  AdminNotificationEvent,
  DisputeEscalatedEvent,
  ContentReportCreatedEvent,
  MemoSentEvent,
} from './events/admin-notification.events';

export enum AdminNotificationType {
  NEW_ORDER = 'new_order',
  DISPUTE_OPENED = 'dispute_opened',
  DISPUTE_ESCALATED = 'dispute_escalated',
  REPORT_SUBMITTED = 'report_submitted',
  PAYOUT_REQUESTED = 'payout_requested',
  USER_SUSPENDED = 'user_suspended',
  HIGH_VALUE_TRANSACTION = 'high_value_transaction',
  ESCROW_STUCK = 'escrow_stuck',
  SYSTEM_ALERT = 'system_alert',
  CONTENT_FLAGGED = 'content_flagged',
  RIDER_ISSUE = 'rider_issue',
  VENDOR_VERIFICATION = 'vendor_verification',
  PAYMENT_FAILED = 'payment_failed',
}

export enum AdminNotificationCategory {
  INFO = 'info',
  WARNING = 'warning',
  ALERT = 'alert',
  SUCCESS = 'success',
}

export enum AdminNotificationPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

interface CreateAdminNotificationDto {
  staffId: string;
  type: AdminNotificationType;
  title: string;
  message: string;
  data?: any;
  link?: string;
  priority?: AdminNotificationPriority;
  category?: AdminNotificationCategory;
  icon?: string;
  expiresAt?: string;
}

@Injectable()
export class AdminNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationsService.name);
  private supabase;
  private serviceSupabase;

  // Will be injected by the gateway
  private gateway: AdminNotificationsGateway | null = null;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
    this.logger.log('🔧 AdminNotificationsService constructor called');
  }

  onModuleInit() {
    this.logger.log('🎧 AdminNotificationsService event listeners initialized');
  }

  // Method for gateway to inject itself
  setGateway(gateway: AdminNotificationsGateway) {
    this.gateway = gateway;
    this.logger.log('🔗 Gateway reference set in service');
  }

  // ============================================
  // NOTIFICATION CREATION
  // ============================================

  /**
   * Create notification for specific staff member
   */
  async notifyStaff(
    staffId: string,
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: any,
    link?: string,
  ) {
    try {
      const { data: notification, error } = await this.serviceSupabase
        .from('admin_notifications')
        .insert({
          staff_id: staffId,
          type,
          title,
          message,
          data: data || {},
          link,
          priority: this.getPriority(type),
          category: this.getCategory(type),
          icon: this.getIcon(type),
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create notification for staff ${staffId}:`, error);
        throw new BadRequestException('Failed to create notification');
      }

      this.logger.log(`✅ Created ${type} notification for staff ${staffId}`);

      // Emit via WebSocket (if gateway is available)
      if (this.gateway) {
        this.gateway.notifyStaff(staffId, notification);

        // Update notification count
        const unreadCount = await this.getUnreadCount(staffId);
        this.gateway.emitNotificationCount(staffId, unreadCount, unreadCount);
      } else {
        this.logger.warn('⚠️ Gateway not available - notification created but not emitted via WebSocket');
      }

      return notification;
    } catch (error) {
      this.logger.error('Error in notifyStaff:', error);
      throw error;
    }
  }

  /**
   * Notify all super admins
   */
  async notifySuperAdmins(
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: any,
    link?: string,
  ) {
    try {
      // Get all active super admin IDs
      const { data: superAdmins, error } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('role', 'super_admin')
        .eq('is_active', true);

      if (error || !superAdmins || superAdmins.length === 0) {
        this.logger.warn('No super admins found');
        return [];
      }

      this.logger.log(`📢 Notifying ${superAdmins.length} super admins: ${title}`);

      // Create notification for each super admin
      const notifications = await Promise.all(
        superAdmins.map((admin) =>
          this.notifyStaff(admin.id, type, title, message, data, link),
        ),
      );

      // Also emit via WebSocket to all super admins room (if gateway is available)
      if (this.gateway) {
        this.gateway.notifySuperAdmins({
          type,
          title,
          message,
          data,
          link,
          priority: this.getPriority(type),
          category: this.getCategory(type),
          icon: this.getIcon(type),
          timestamp: new Date().toISOString(),
        });
      }

      return notifications;
    } catch (error) {
      this.logger.error('Error in notifySuperAdmins:', error);
      throw error;
    }
  }

  /**
   * Notify all department heads
   */
  async notifyDepartmentHeads(
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: any,
    link?: string,
  ) {
    try {
      const { data: departmentHeads, error } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('role', 'department_head')
        .eq('is_active', true);

      if (error || !departmentHeads || departmentHeads.length === 0) {
        this.logger.warn('No department heads found');
        return [];
      }

      this.logger.log(`📢 Notifying ${departmentHeads.length} department heads: ${title}`);

      const notifications = await Promise.all(
        departmentHeads.map((head) =>
          this.notifyStaff(head.id, type, title, message, data, link),
        ),
      );

      // Emit via WebSocket (if gateway is available)
      if (this.gateway) {
        this.gateway.notifyDepartmentHeads({
          type,
          title,
          message,
          data,
          link,
          timestamp: new Date().toISOString(),
        });
      }

      return notifications;
    } catch (error) {
      this.logger.error('Error in notifyDepartmentHeads:', error);
      throw error;
    }
  }

  /**
   * Notify all staff in a specific department
   */
  async notifyDepartment(
    departmentSlug: string,
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: any,
    link?: string,
  ) {
    try {
      // Get department ID
      const { data: department, error: deptError } = await this.supabase
        .from('departments')
        .select('id')
        .eq('slug', departmentSlug)
        .single();

      if (deptError || !department) {
        this.logger.warn(`Department ${departmentSlug} not found`);
        return [];
      }

      // Get all active staff in department
      const { data: staff, error: staffError } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('department_id', department.id)
        .eq('is_active', true);

      if (staffError || !staff || staff.length === 0) {
        this.logger.warn(`No staff found in department ${departmentSlug}`);
        return [];
      }

      this.logger.log(`📢 Notifying ${staff.length} staff in ${departmentSlug} department: ${title}`);

      const notifications = await Promise.all(
        staff.map((member) =>
          this.notifyStaff(member.id, type, title, message, data, link),
        ),
      );

      // Emit via WebSocket (if gateway is available)
      if (this.gateway) {
        this.gateway.notifyDepartment(department.id, {
          type,
          title,
          message,
          data,
          link,
          timestamp: new Date().toISOString(),
        });
      }

      return notifications;
    } catch (error) {
      this.logger.error('Error in notifyDepartment:', error);
      throw error;
    }
  }

  /**
   * Broadcast to all active staff
   */
  async broadcastToAll(
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: any,
    link?: string,
  ) {
    try {
      const { data: allStaff, error } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('is_active', true);

      if (error || !allStaff || allStaff.length === 0) {
        this.logger.warn('No active staff found');
        return [];
      }

      this.logger.log(`📣 Broadcasting to ${allStaff.length} staff: ${title}`);

      const notifications = await Promise.all(
        allStaff.map((staff) =>
          this.notifyStaff(staff.id, type, title, message, data, link),
        ),
      );

      // Emit via WebSocket (if gateway is available)
      if (this.gateway) {
        this.gateway.broadcastToAll({
          type,
          title,
          message,
          data,
          link,
          timestamp: new Date().toISOString(),
        });
      }

      return notifications;
    } catch (error) {
      this.logger.error('Error in broadcastToAll:', error);
      throw error;
    }
  }

  // ============================================
  // NOTIFICATION RETRIEVAL
  // ============================================

  /**
   * Get staff notifications with pagination
   */
  async getNotifications(
    staffId: string,
    page: number = 1,
    limit: number = 20,
    filters?: { type?: string; is_read?: boolean; priority?: string },
  ) {
    try {
      const offset = (page - 1) * limit;

      let query = this.serviceSupabase
        .from('admin_notifications')
        .select('*', { count: 'exact' })
        .eq('staff_id', staffId)
        .eq('is_deleted', false);

      // Apply filters
      if (filters?.type) {
        query = query.eq('type', filters.type);
      }
      if (filters?.is_read !== undefined) {
        query = query.eq('is_read', filters.is_read);
      }
      if (filters?.priority) {
        query = query.eq('priority', filters.priority);
      }

      // Check for expired notifications
      query = query.or('expires_at.is.null,expires_at.gte.now()');

      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        this.logger.error(`Failed to fetch notifications for staff ${staffId}:`, error);
        throw new BadRequestException('Failed to fetch notifications');
      }

      return {
        data: data || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit),
          hasMore: offset + limit < (count || 0),
        },
      };
    } catch (error) {
      this.logger.error('Error in getNotifications:', error);
      throw error;
    }
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(staffId: string): Promise<number> {
    try {
      const { count, error } = await this.serviceSupabase
        .from('admin_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('staff_id', staffId)
        .eq('is_read', false)
        .eq('is_deleted', false)
        .or('expires_at.is.null,expires_at.gte.now()');

      if (error) {
        this.logger.error(`Failed to get unread count for staff ${staffId}:`, error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      this.logger.error('Error in getUnreadCount:', error);
      return 0;
    }
  }

  /**
   * Get total notification count for staff (both read and unread)
   */
  async getTotalCount(staffId: string): Promise<number> {
    try {
      const { count, error } = await this.serviceSupabase
        .from('admin_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('staff_id', staffId)
        .eq('is_deleted', false)
        .or('expires_at.is.null,expires_at.gte.now()');

      if (error) {
        this.logger.error(`Failed to get total count for staff ${staffId}:`, error);
        return 0;
      }

      return count || 0;
    } catch (error) {
      this.logger.error('Error in getTotalCount:', error);
      return 0;
    }
  }

  /**
   * Get notification stats
   */
  async getStats(staffId: string) {
    try {
      const [unreadCount, totalCount] = await Promise.all([
        this.getUnreadCount(staffId),
        this.serviceSupabase
          .from('admin_notifications')
          .select('*', { count: 'exact', head: true })
          .eq('staff_id', staffId)
          .eq('is_deleted', false)
          .then((res) => res.count || 0),
      ]);

      return {
        unread: unreadCount,
        total: totalCount,
        read: totalCount - unreadCount,
      };
    } catch (error) {
      this.logger.error('Error in getStats:', error);
      throw error;
    }
  }

  // ============================================
  // NOTIFICATION ACTIONS
  // ============================================

  /**
   * Mark notification as read
   */
  async markAsRead(staffId: string, notificationId: string) {
    try {
      const { error } = await this.serviceSupabase
        .from('admin_notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', notificationId)
        .eq('staff_id', staffId);

      if (error) {
        this.logger.error(`Failed to mark notification ${notificationId} as read:`, error);
        throw new BadRequestException('Failed to mark notification as read');
      }

      this.logger.log(`Notification ${notificationId} marked as read by staff ${staffId}`);

      // Update notification count (if gateway is available)
      if (this.gateway) {
        const unreadCount = await this.getUnreadCount(staffId);
        this.gateway.emitNotificationCount(staffId, unreadCount, unreadCount);
      }
    } catch (error) {
      this.logger.error('Error in markAsRead:', error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(staffId: string) {
    try {
      const { error } = await this.serviceSupabase
        .from('admin_notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('staff_id', staffId)
        .eq('is_read', false);

      if (error) {
        this.logger.error(`Failed to mark all notifications as read for staff ${staffId}:`, error);
        throw new BadRequestException('Failed to mark all notifications as read');
      }

      this.logger.log(`All notifications marked as read by staff ${staffId}`);

      // Update notification count (if gateway is available)
      if (this.gateway) {
        this.gateway.emitNotificationCount(staffId, 0, 0);
      }
    } catch (error) {
      this.logger.error('Error in markAllAsRead:', error);
      throw error;
    }
  }

  /**
   * Delete notification (soft delete)
   */
  async deleteNotification(staffId: string, notificationId: string) {
    try {
      const { error } = await this.serviceSupabase
        .from('admin_notifications')
        .update({ is_deleted: true })
        .eq('id', notificationId)
        .eq('staff_id', staffId);

      if (error) {
        this.logger.error(`Failed to delete notification ${notificationId}:`, error);
        throw new BadRequestException('Failed to delete notification');
      }

      this.logger.log(`Notification ${notificationId} deleted by staff ${staffId}`);
    } catch (error) {
      this.logger.error('Error in deleteNotification:', error);
      throw error;
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private getPriority(type: AdminNotificationType): AdminNotificationPriority {
    const highPriority = [
      AdminNotificationType.DISPUTE_ESCALATED,
      AdminNotificationType.SYSTEM_ALERT,
      AdminNotificationType.ESCROW_STUCK,
      AdminNotificationType.PAYMENT_FAILED,
    ];
    const urgentPriority = [AdminNotificationType.SYSTEM_ALERT];

    if (urgentPriority.includes(type)) return AdminNotificationPriority.URGENT;
    if (highPriority.includes(type)) return AdminNotificationPriority.HIGH;
    return AdminNotificationPriority.MEDIUM;
  }

  private getCategory(type: AdminNotificationType): AdminNotificationCategory {
    const warnings = [
      AdminNotificationType.DISPUTE_ESCALATED,
      AdminNotificationType.ESCROW_STUCK,
      AdminNotificationType.HIGH_VALUE_TRANSACTION,
    ];
    const alerts = [
      AdminNotificationType.SYSTEM_ALERT,
      AdminNotificationType.PAYMENT_FAILED,
    ];
    const success = [AdminNotificationType.PAYOUT_REQUESTED];

    if (alerts.includes(type)) return AdminNotificationCategory.ALERT;
    if (warnings.includes(type)) return AdminNotificationCategory.WARNING;
    if (success.includes(type)) return AdminNotificationCategory.SUCCESS;
    return AdminNotificationCategory.INFO;
  }

  private getIcon(type: AdminNotificationType): string {
    const iconMap = {
      [AdminNotificationType.NEW_ORDER]: 'ShoppingCart',
      [AdminNotificationType.DISPUTE_OPENED]: 'AlertCircle',
      [AdminNotificationType.DISPUTE_ESCALATED]: 'AlertTriangle',
      [AdminNotificationType.REPORT_SUBMITTED]: 'Flag',
      [AdminNotificationType.PAYOUT_REQUESTED]: 'DollarSign',
      [AdminNotificationType.USER_SUSPENDED]: 'UserX',
      [AdminNotificationType.HIGH_VALUE_TRANSACTION]: 'TrendingUp',
      [AdminNotificationType.ESCROW_STUCK]: 'Clock',
      [AdminNotificationType.SYSTEM_ALERT]: 'AlertTriangle',
      [AdminNotificationType.CONTENT_FLAGGED]: 'Flag',
      [AdminNotificationType.RIDER_ISSUE]: 'Truck',
      [AdminNotificationType.VENDOR_VERIFICATION]: 'CheckCircle',
      [AdminNotificationType.PAYMENT_FAILED]: 'XCircle',
    };
    return iconMap[type] || 'Bell';
  }

  // ============================================
  // EVENT LISTENERS
  // ============================================

  @OnEvent(AdminNotificationEventType.DISPUTE_ESCALATED)
  async handleDisputeEscalated(event: DisputeEscalatedEvent) {
    try {
      this.logger.log(`📨 Handling dispute escalated event: ${event.disputeId}`);

      await this.notifySuperAdmins(
        AdminNotificationType.DISPUTE_ESCALATED,
        'Dispute Escalated',
        `Dispute #${event.disputeId.substring(0, 8)} has been escalated${event.departmentId ? ' to another department' : ''}`,
        {
          disputeId: event.disputeId,
          escalatedBy: event.escalatedBy,
          departmentId: event.departmentId,
          reportCreated: event.reportCreated,
          reportNumber: event.reportNumber,
        },
        `/dashboard/disputes?id=${event.disputeId}`
      );
    } catch (error) {
      this.logger.error(`Failed to handle dispute escalated event: ${error.message}`);
    }
  }

  @OnEvent(AdminNotificationEventType.CONTENT_REPORT_CREATED)
  async handleContentReportCreated(event: ContentReportCreatedEvent) {
    try {
      this.logger.log(`📨 Handling content report created event: ${event.reportId}`);

      await this.notifyDepartment(
        'admin_moderators',
        AdminNotificationType.CONTENT_FLAGGED,
        'Content Flagged for Review',
        `New ${event.category} report: ${event.reportType}`,
        {
          reportId: event.reportId,
          category: event.category,
          reportType: event.reportType,
          reporterId: event.reporterId,
        },
        `/dashboard/content?report=${event.reportId}`
      );
    } catch (error) {
      this.logger.error(`Failed to handle content report created event: ${error.message}`);
    }
  }

  @OnEvent(AdminNotificationEventType.MEMO_SENT)
  async handleMemoSent(event: MemoSentEvent) {
    try {
      this.logger.log(`📨 Handling memo sent event: ${event.memoId}`);

      if (event.recipientType === 'staff' && event.recipientId) {
        // Notify individual staff member
        await this.notifyStaff(
          event.recipientId,
          AdminNotificationType.SYSTEM_ALERT,
          'New Memo Received',
          `Memo from ${event.senderName}`,
          {
            memoId: event.memoId,
            senderId: event.senderId,
            senderName: event.senderName,
            priority: event.priority,
          },
          `/dashboard/memos?id=${event.memoId}`
        );
      } else if (event.recipientType === 'department' && event.recipientId) {
        // Get department slug and notify department
        const { data: dept } = await this.supabase
          .from('departments')
          .select('slug')
          .eq('id', event.recipientId)
          .single();

        if (dept?.slug) {
          await this.notifyDepartment(
            dept.slug,
            AdminNotificationType.SYSTEM_ALERT,
            'New Department Memo',
            `Memo from ${event.senderName}`,
            {
              memoId: event.memoId,
              senderId: event.senderId,
              senderName: event.senderName,
              priority: event.priority,
            },
            `/dashboard/memos?id=${event.memoId}`
          );
        }
      } else if (event.recipientType === 'all') {
        // Broadcast to all staff
        await this.broadcastToAll(
          AdminNotificationType.SYSTEM_ALERT,
          'New Platform-Wide Memo',
          `Memo from ${event.senderName}`,
          {
            memoId: event.memoId,
            senderId: event.senderId,
            senderName: event.senderName,
            priority: event.priority,
          },
          `/dashboard/memos?id=${event.memoId}`
        );
      }
    } catch (error) {
      this.logger.error(`Failed to handle memo sent event: ${error.message}`);
    }
  }
}

