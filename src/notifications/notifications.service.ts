/**
 * FRETIKO NOTIFICATIONS SERVICE
 * Core business logic for notification system - handles CRUD, real-time delivery, and push notifications
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createSupabaseClient, createServiceSupabaseClient } from '../shared/supabase.client';
import {
  CreateNotificationDto,
  UpdateNotificationDto,
  BulkUpdateNotificationsDto,
  NotificationQueryDto,
  UpdateNotificationSettingsDto,
  NotificationResponseDto,
  NotificationStatsResponseDto,
  NotificationSettingsResponseDto,
  PaginatedNotificationsResponseDto,
  NotificationType,
  NotificationPriority
} from './dto/notification.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly supabase: SupabaseClient;
  private readonly serviceSupabase: SupabaseClient;

  constructor(private readonly configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  // ============================================
  // CORE NOTIFICATION CRUD
  // ============================================

  /**
   * Create a new notification for a user
   */
  async createNotification(createDto: CreateNotificationDto): Promise<NotificationResponseDto | null> {
    try {
      this.logger.log(`Creating ${createDto.type} notification for user ${createDto.user_id}`);

      // Validate user exists
      const { data: userExists } = await this.supabase
        .from('user_profiles')
        .select('id')
        .eq('id', createDto.user_id)
        .single();

      if (!userExists) {
        throw new NotFoundException('User not found');
      }

      // Check user's notification preferences
      const userSettings = await this.getUserSettings(createDto.user_id);
      const notificationTypeEnabled = this.isNotificationTypeEnabled(createDto.type, userSettings);

      if (!userSettings.in_app_enabled || !notificationTypeEnabled) {
        this.logger.log(`Notification ${createDto.type} disabled for user ${createDto.user_id}`);
        return null; // Don't create notification if disabled
      }

      // Insert notification using service role client to bypass RLS
      const { data: notification, error } = await this.serviceSupabase
        .from('notifications')
        .insert({
          user_id: createDto.user_id,
          type: createDto.type,
          title: createDto.title,
          message: createDto.message,
          data: createDto.data || {},
          avatar_url: createDto.avatar_url,
          badge: createDto.badge,
          priority: createDto.priority || NotificationPriority.MEDIUM,
          has_actions: createDto.has_actions || false,
          action_buttons: createDto.action_buttons || [],
          expires_at: createDto.expires_at
        })
        .select()
        .single();

      if (error) {
        this.logger.error('Failed to create notification:', error);
        throw new BadRequestException('Failed to create notification');
      }

      this.logger.log(`Created notification ${notification.id} for user ${createDto.user_id}`);

      // TODO: Trigger real-time update via WebSocket
      // TODO: Send push notification if enabled

      return this.mapToResponseDto(notification);
    } catch (error) {
      this.logger.error('Error creating notification:', error);
      throw error;
    }
  }

  /**
   * Get user's notifications with filtering and pagination
   */
  async getUserNotifications(userId: string, query: NotificationQueryDto): Promise<PaginatedNotificationsResponseDto> {
    try {
      const limit = parseInt(query.limit || '50') || 50;
      const offset = parseInt(query.offset || '0') || 0;

      // Build query using service role client to bypass RLS
      let supabaseQuery = this.serviceSupabase
        .from('notifications')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .eq('is_deleted', false);

      // Apply filters
      if (query.type) {
        supabaseQuery = supabaseQuery.eq('type', query.type);
      }

      if (query.is_read !== undefined) {
        supabaseQuery = supabaseQuery.eq('is_read', query.is_read);
      }

      if (query.priority) {
        supabaseQuery = supabaseQuery.eq('priority', query.priority);
      }

      // Check for expired notifications
      supabaseQuery = supabaseQuery.or('expires_at.is.null,expires_at.gte.now()');

      // Apply sorting
      const sortField = query.sort_by || 'created_at';
      const sortDirection = query.sort_order === 'asc' ? true : false;
      supabaseQuery = supabaseQuery.order(sortField, { ascending: sortDirection });

      // Apply pagination
      supabaseQuery = supabaseQuery.range(offset, offset + limit - 1);

      const { data: notifications, error, count } = await supabaseQuery;

      if (error) {
        this.logger.error('Error fetching notifications:', error);
        throw new BadRequestException('Failed to fetch notifications');
      }

      // Debug logging
      this.logger.log(`Found ${notifications?.length || 0} notifications for user ${userId}, total count: ${count}`);
      if (notifications && notifications.length > 0) {
        this.logger.log(`First notification: ${JSON.stringify(notifications[0])}`);
      }
      this.logger.log(`Query parameters: limit=${limit}, offset=${offset}, filters applied`);

      const hasMore = (offset + limit) < (count || 0);

      return {
        notifications: notifications.map(n => this.mapToResponseDto(n)),
        total: count || 0,
        limit,
        offset,
        has_more: hasMore
      };
    } catch (error) {
      this.logger.error('Error fetching user notifications:', error);
      throw error;
    }
  }

  /**
   * Update a single notification (mark as read/deleted)
   */
  async updateNotification(notificationId: string, userId: string, updateDto: UpdateNotificationDto): Promise<NotificationResponseDto> {
    try {
      this.logger.log(`Attempting to update notification ${notificationId} for user ${userId}`);

      // First check if notification exists
      const { data: existingNotification, error: checkError } = await this.serviceSupabase
        .from('notifications')
        .select('*')
        .eq('id', notificationId)
        .eq('user_id', userId)
        .single();

      if (checkError) {
        if (checkError.code === 'PGRST116') {
          this.logger.warn(`Notification ${notificationId} not found for user ${userId} - may have been deleted or doesn't exist`);
          throw new NotFoundException('Notification not found');
        }
        this.logger.error('Error checking notification existence:', checkError);
        throw new BadRequestException('Failed to check notification');
      }

      if (!existingNotification) {
        throw new NotFoundException('Notification not found');
      }

      // Now update it
      const { data: notification, error } = await this.serviceSupabase
        .from('notifications')
        .update(updateDto)
        .eq('id', notificationId)
        .eq('user_id', userId) // Ensure user can only update their own notifications
        .select()
        .single();

      if (error) {
        this.logger.error('Error updating notification:', error);
        throw new BadRequestException('Failed to update notification');
      }

      if (!notification) {
        throw new NotFoundException('Notification not found after update');
      }

      this.logger.log(`Updated notification ${notificationId} for user ${userId}`);
      return this.mapToResponseDto(notification);
    } catch (error) {
      this.logger.error('Error updating notification:', error);
      throw error;
    }
  }

  /**
   * Bulk update multiple notifications (mark all as read)
   */
  async bulkUpdateNotifications(userId: string, bulkUpdateDto: BulkUpdateNotificationsDto): Promise<{ updated_count: number }> {
    try {
      const { data, error } = await this.serviceSupabase
        .from('notifications')
        .update({
          is_read: bulkUpdateDto.is_read,
          is_deleted: bulkUpdateDto.is_deleted
        })
        .eq('user_id', userId)
        .in('id', bulkUpdateDto.notification_ids)
        .select('id');

      if (error) {
        this.logger.error('Error bulk updating notifications:', error);
        throw new BadRequestException('Failed to bulk update notifications');
      }

      const updatedCount = data?.length || 0;
      this.logger.log(`Bulk updated ${updatedCount} notifications for user ${userId}`);

      return { updated_count: updatedCount };
    } catch (error) {
      this.logger.error('Error bulk updating notifications:', error);
      throw error;
    }
  }

  /**
   * Mark all user notifications as read
   */
  async markAllAsRead(userId: string): Promise<{ updated_count: number }> {
    try {
      this.logger.log(`Starting markAllAsRead for user ${userId}`);

      // First check how many unread notifications exist
      const { data: unreadNotifications, error: countError } = await this.serviceSupabase
        .from('notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('is_read', false)
        .eq('is_deleted', false);

      if (countError) {
        this.logger.error('Error counting unread notifications:', countError);
      } else {
        this.logger.log(`Found ${unreadNotifications?.length || 0} unread notifications for user ${userId}`);
      }

      const { data, error } = await this.serviceSupabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('is_read', false)
        .eq('is_deleted', false)
        .select('id');

      if (error) {
        this.logger.error('Error marking all notifications as read:', error);
        this.logger.error('Error details:', JSON.stringify(error));
        throw new BadRequestException('Failed to mark all as read');
      }

      const updatedCount = data?.length || 0;
      this.logger.log(`Successfully marked ${updatedCount} notifications as read for user ${userId}`);

      return { updated_count: updatedCount };
    } catch (error) {
      this.logger.error('Error in markAllAsRead method:', error);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to mark all notifications as read');
    }
  }

  // ============================================
  // NOTIFICATION STATS
  // ============================================

  /**
   * Get user notification statistics
   */
  async getUserNotificationStats(userId: string): Promise<NotificationStatsResponseDto> {
    try {
      const { data: stats, error } = await this.supabase
        .from('user_notification_stats')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        // If no stats exist, return zeros
        if (error.code === 'PGRST116') {
          this.logger.log(`No stats found for user ${userId}, returning zeros`);
          return {
            total_notifications: 0,
            unread_count: 0,
            unread_orders: 0,
            unread_social: 0,
            unread_live: 0,
            unread_delivery: 0,
            unread_payment: 0,
            unread_chat: 0,
            latest_notification_at: undefined
          };
        }

        this.logger.error('Error fetching notification stats:', error);
        throw new BadRequestException('Failed to fetch notification stats');
      }

      this.logger.log(`Stats for user ${userId}: total=${stats.total_notifications}, unread=${stats.unread_count}, unread_chat=${stats.unread_chat}`);
      return stats;
    } catch (error) {
      this.logger.error('Error fetching user notification stats:', error);
      throw error;
    }
  }

  // ============================================
  // NOTIFICATION SETTINGS
  // ============================================

  /**
   * Get user notification settings
   */
  async getUserSettings(userId: string): Promise<NotificationSettingsResponseDto> {
    try {
      // First try with service role client to bypass any RLS issues
      const { data: settings, error } = await this.serviceSupabase
        .from('notification_settings')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Settings don't exist, create default ones
          return await this.createDefaultSettings(userId);
        }

        this.logger.error('Error fetching notification settings:', error);
        throw new BadRequestException('Failed to fetch notification settings');
      }

      return settings;
    } catch (error) {
      this.logger.error('Error fetching user notification settings:', error);
      throw error;
    }
  }

  /**
   * Update user notification settings
   */
  async updateUserSettings(userId: string, updateDto: UpdateNotificationSettingsDto): Promise<NotificationSettingsResponseDto> {
    try {
      const { data: settings, error } = await this.supabase
        .from('notification_settings')
        .update(updateDto)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        this.logger.error('Error updating notification settings:', error);
        throw new BadRequestException('Failed to update notification settings');
      }

      if (!settings) {
        throw new NotFoundException('Notification settings not found');
      }

      this.logger.log(`Updated notification settings for user ${userId}`);
      return settings;
    } catch (error) {
      this.logger.error('Error updating notification settings:', error);
      throw error;
    }
  }

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  /**
   * Create default notification settings for a user
   */
  private async createDefaultSettings(userId: string): Promise<NotificationSettingsResponseDto> {
    // Use service role client to bypass RLS for system-level operations
    const { data: settings, error } = await this.serviceSupabase
      .from('notification_settings')
      .insert({ user_id: userId })
      .select()
      .single();

    if (error) {
      // If settings already exist (duplicate key error), fetch existing settings
      if (error.code === '23505') {
        this.logger.log(`Notification settings already exist for user ${userId}, fetching existing`);
        const { data: existingSettings, error: fetchError } = await this.serviceSupabase
          .from('notification_settings')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (fetchError) {
          this.logger.error('Error fetching existing notification settings:', fetchError);
          throw new BadRequestException('Failed to fetch notification settings');
        }

        return existingSettings;
      }

      this.logger.error('Error creating default notification settings:', error);
      throw new BadRequestException('Failed to create notification settings');
    }

    return settings;
  }

  /**
   * Check if a notification type is enabled for user
   */
  private isNotificationTypeEnabled(type: NotificationType, settings: NotificationSettingsResponseDto): boolean {
    switch (type) {
      case NotificationType.ORDER:
        return settings.order_notifications;
      case NotificationType.SOCIAL:
        return settings.social_notifications;
      case NotificationType.PROMOTION:
        return settings.promotion_notifications;
      case NotificationType.SYSTEM:
        return settings.system_notifications;
      case NotificationType.DELIVERY:
        return settings.delivery_notifications;
      case NotificationType.LIVE:
        return settings.live_notifications;
      case NotificationType.PAYMENT:
        return settings.payment_notifications;
      case NotificationType.CHAT:
        return settings.chat_notifications;
      default:
        return true;
    }
  }

  /**
   * Map database record to response DTO
   */
  private mapToResponseDto(notification: any): NotificationResponseDto {
    return {
      id: notification.id,
      user_id: notification.user_id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      avatar_url: notification.avatar_url,
      badge: notification.badge,
      priority: notification.priority,
      is_read: notification.is_read,
      is_deleted: notification.is_deleted,
      has_actions: notification.has_actions,
      action_buttons: notification.action_buttons,
      created_at: notification.created_at,
      updated_at: notification.updated_at,
      expires_at: notification.expires_at
    };
  }

  // ============================================
  // CLEANUP OPERATIONS
  // ============================================

  /**
   * Clean up expired notifications (called by cron job)
   */
  async cleanupExpiredNotifications(): Promise<{ deleted_count: number }> {
    try {
      const { data, error } = await this.supabase
        .rpc('cleanup_expired_notifications');

      if (error) {
        this.logger.error('Error cleaning up expired notifications:', error);
        return { deleted_count: 0 };
      }

      this.logger.log(`Cleaned up ${data} expired notifications`);
      return { deleted_count: data };
    } catch (error) {
      this.logger.error('Error during cleanup:', error);
      return { deleted_count: 0 };
    }
  }

  /**
   * Test service role client functionality (debug only)
   */
  async testServiceRoleClient(): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      this.logger.log('Testing service role client...');

      // Try to read from notification_settings with service role client
      const { data, error } = await this.serviceSupabase
        .from('notification_settings')
        .select('*')
        .limit(5);

      if (error) {
        this.logger.error('Service role client test failed:', error);
        return {
          success: false,
          message: `Service role test failed: ${error.message}`,
          data: error
        };
      }

      this.logger.log(`Service role client test successful, found ${data?.length || 0} settings`);
      return {
        success: true,
        message: `Service role client working correctly. Found ${data?.length || 0} notification settings.`,
        data: data?.slice(0, 2) // Return first 2 for debugging
      };
    } catch (error) {
      this.logger.error('Service role client test error:', error);
      return {
        success: false,
        message: `Service role test error: ${error.message}`,
        data: error
      };
    }
  }
}