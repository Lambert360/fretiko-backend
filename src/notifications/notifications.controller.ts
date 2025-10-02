/**
 * FRETIKO NOTIFICATIONS CONTROLLER
 * REST API endpoints for notification system
 */

import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Delete,
  Body, 
  Param, 
  Query, 
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PushNotificationService } from './push-notification.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CreateNotificationDto,
  UpdateNotificationDto,
  BulkUpdateNotificationsDto,
  NotificationQueryDto,
  UpdateNotificationSettingsDto,
  NotificationResponseDto,
  NotificationStatsResponseDto,
  NotificationSettingsResponseDto,
  PaginatedNotificationsResponseDto
} from './dto/notification.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushNotificationService: PushNotificationService
  ) {}

  // ============================================
  // NOTIFICATION CRUD ENDPOINTS
  // ============================================

  /**
   * GET /notifications - Get user's notifications with filtering
   * Query params: type, is_read, priority, limit, offset, sort_by, sort_order
   */
  @Get()
  async getUserNotifications(
    @Request() req: any,
    @Query() query: NotificationQueryDto
  ): Promise<PaginatedNotificationsResponseDto> {
    this.logger.log(`Getting notifications for user ${req.user.sub}`);
    return await this.notificationsService.getUserNotifications(req.user.sub, query);
  }

  /**
   * POST /notifications - Create a new notification (system use)
   * Note: In production, this would typically be called by internal services
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createNotification(
    @Body() createDto: CreateNotificationDto
  ): Promise<NotificationResponseDto | null> {
    this.logger.log(`Creating notification: ${createDto.type} for user ${createDto.user_id}`);
    return await this.notificationsService.createNotification(createDto);
  }

  /**
   * PUT /notifications/bulk - Bulk update multiple notifications
   */
  @Put('bulk')
  async bulkUpdateNotifications(
    @Request() req: any,
    @Body() bulkUpdateDto: BulkUpdateNotificationsDto
  ): Promise<{ updated_count: number }> {
    this.logger.log(`Bulk updating ${bulkUpdateDto.notification_ids.length} notifications for user ${req.user.sub}`);
    return await this.notificationsService.bulkUpdateNotifications(req.user.sub, bulkUpdateDto);
  }

  /**
   * PUT /notifications/mark-all-read - Mark all notifications as read
   */
  @Put('mark-all-read')
  async markAllAsRead(@Request() req: any): Promise<{ updated_count: number }> {
    this.logger.log(`Marking all notifications as read for user ${req.user.sub}`);
    return await this.notificationsService.markAllAsRead(req.user.sub);
  }

  /**
   * PUT /notifications/:id - Update a specific notification (mark as read/deleted)
   */
  @Put(':id')
  async updateNotification(
    @Param('id') notificationId: string,
    @Request() req: any,
    @Body() updateDto: UpdateNotificationDto
  ): Promise<NotificationResponseDto> {
    this.logger.log(`Updating notification ${notificationId} for user ${req.user.sub}`);
    return await this.notificationsService.updateNotification(notificationId, req.user.sub, updateDto);
  }

  // ============================================
  // NOTIFICATION STATS ENDPOINTS
  // ============================================

  /**
   * GET /notifications/stats - Get user's notification statistics
   * Returns counts of total, unread, and by type
   */
  @Get('stats')
  async getUserNotificationStats(@Request() req: any): Promise<NotificationStatsResponseDto> {
    this.logger.log(`Getting notification stats for user ${req.user.sub}`);
    return await this.notificationsService.getUserNotificationStats(req.user.sub);
  }

  // ============================================
  // NOTIFICATION SETTINGS ENDPOINTS
  // ============================================

  /**
   * GET /notifications/settings - Get user's notification preferences
   */
  @Get('settings')
  async getUserSettings(@Request() req: any): Promise<NotificationSettingsResponseDto> {
    this.logger.log(`Getting notification settings for user ${req.user.sub}`);
    return await this.notificationsService.getUserSettings(req.user.sub);
  }

  /**
   * PUT /notifications/settings - Update user's notification preferences
   */
  @Put('settings')
  async updateUserSettings(
    @Request() req: any,
    @Body() updateDto: UpdateNotificationSettingsDto
  ): Promise<NotificationSettingsResponseDto> {
    this.logger.log(`Updating notification settings for user ${req.user.sub}`);
    return await this.notificationsService.updateUserSettings(req.user.sub, updateDto);
  }

  // ============================================
  // UTILITY ENDPOINTS
  // ============================================

  /**
   * GET /notifications/unread-count - Quick endpoint to get just unread count
   * Useful for badge display in mobile app
   */
  @Get('unread-count')
  async getUnreadCount(@Request() req: any): Promise<{ unread_count: number }> {
    const stats = await this.notificationsService.getUserNotificationStats(req.user.sub);
    return { unread_count: stats.unread_count };
  }

  /**
   * GET /notifications/recent - Get recent notifications (last 24 hours)
   * Useful for quick dashboard display
   */
  @Get('recent')
  async getRecentNotifications(@Request() req: any): Promise<NotificationResponseDto[]> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const query: NotificationQueryDto = {
      limit: '20',
      sort_by: 'created_at',
      sort_order: 'desc'
    };

    const result = await this.notificationsService.getUserNotifications(req.user.sub, query);
    
    // Filter to only recent ones (last 24 hours)
    const recentNotifications = result.notifications.filter(
      n => new Date(n.created_at) >= new Date(oneDayAgo)
    );

    return recentNotifications;
  }

  /**
   * GET /notifications/urgent - Get high priority unread notifications
   * For critical alerts that need immediate attention
   */
  @Get('urgent')
  async getUrgentNotifications(@Request() req: any): Promise<NotificationResponseDto[]> {
    const query: NotificationQueryDto = {
      priority: 'high' as any,
      is_read: false,
      limit: '10',
      sort_by: 'created_at',
      sort_order: 'desc'
    };

    const result = await this.notificationsService.getUserNotifications(req.user.sub, query);
    return result.notifications;
  }

  // ============================================
  // PUSH NOTIFICATION ENDPOINTS
  // ============================================

  /**
   * POST /notifications/push-token - Register a push notification token
   */
  @Post('push-token')
  @HttpCode(HttpStatus.CREATED)
  async registerPushToken(
    @Request() req: any,
    @Body() body: { token: string }
  ): Promise<{ success: boolean }> {
    this.logger.log(`Registering push token for user ${req.user.sub}`);
    const success = await this.pushNotificationService.registerPushToken(req.user.sub, body.token);
    return { success };
  }

  /**
   * DELETE /notifications/push-token - Unregister a push notification token
   */
  @Delete('push-token')
  async unregisterPushToken(
    @Request() req: any,
    @Body() body: { token: string }
  ): Promise<{ success: boolean }> {
    this.logger.log(`Unregistering push token for user ${req.user.sub}`);
    const success = await this.pushNotificationService.unregisterPushToken(req.user.sub, body.token);
    return { success };
  }

  // ============================================
  // ADMIN/SYSTEM ENDPOINTS
  // ============================================

  /**
   * DELETE /notifications/cleanup - Clean up expired notifications
   * Should be called by cron job or admin
   */
  @Delete('cleanup')
  async cleanupExpiredNotifications(): Promise<{ deleted_count: number }> {
    this.logger.log('Running notification cleanup');
    return await this.notificationsService.cleanupExpiredNotifications();
  }

  /**
   * GET /notifications/debug/service-role-test - Test service role client functionality
   * Debug endpoint to verify service role client is working
   */
  @Get('debug/service-role-test')
  async testServiceRoleClient(): Promise<{ success: boolean; message: string; data?: any }> {
    this.logger.log('Testing service role client functionality');
    return await this.notificationsService.testServiceRoleClient();
  }
}