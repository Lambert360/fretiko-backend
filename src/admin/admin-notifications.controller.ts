/**
 * ADMIN NOTIFICATIONS CONTROLLER
 * REST API endpoints for admin panel notifications
 * Used by the frontend notification hook for initial data fetch
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { StaffJwtAuthGuard } from '../staff/guards/staff-jwt-auth.guard';
import { PermissionsGuard } from '../staff/guards/permissions.guard';
import { Permissions } from '../staff/decorators/permissions.decorator';
import { AdminNotificationsService } from './admin-notifications.service';

@Controller('admin/notifications')
@UseGuards(StaffJwtAuthGuard)
export class AdminNotificationsController {
  constructor(
    private readonly adminNotificationsService: AdminNotificationsService,
  ) {}

  /**
   * Get staff notifications with pagination
   * GET /admin/notifications?page=1&limit=20&type=&is_read=&priority=
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('view_dashboard')
  async getNotifications(
    @Req() req,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('is_read') isRead?: string,
    @Query('priority') priority?: string,
  ) {
    const staffId = req.user.sub;
    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedLimit = limit ? parseInt(limit, 10) : 20;

    const filters: any = {};
    if (type) filters.type = type;
    if (isRead !== undefined) filters.is_read = isRead === 'true';
    if (priority) filters.priority = priority;

    return this.adminNotificationsService.getNotifications(
      staffId,
      parsedPage,
      parsedLimit,
      filters,
    );
  }

  /**
   * Get notification stats for current staff
   * GET /admin/notifications/stats
   */
  @Get('stats')
  @UseGuards(PermissionsGuard)
  @Permissions('view_dashboard')
  async getStats(@Req() req) {
    const staffId = req.user.sub;
    return this.adminNotificationsService.getStats(staffId);
  }

  /**
   * Mark notification as read
   * PUT /admin/notifications/:id/read
   */
  @Put(':id/read')
  @UseGuards(PermissionsGuard)
  @Permissions('view_dashboard')
  async markAsRead(
    @Param('id') notificationId: string,
    @Req() req,
  ) {
    const staffId = req.user.sub;
    await this.adminNotificationsService.markAsRead(staffId, notificationId);
    return { success: true, message: 'Notification marked as read' };
  }

  /**
   * Mark all notifications as read
   * PUT /admin/notifications/mark-all-read
   */
  @Put('mark-all-read')
  @UseGuards(PermissionsGuard)
  @Permissions('view_dashboard')
  async markAllAsRead(@Req() req) {
    const staffId = req.user.sub;
    await this.adminNotificationsService.markAllAsRead(staffId);
    return { success: true, message: 'All notifications marked as read' };
  }

  /**
   * Delete a notification (soft delete)
   * DELETE /admin/notifications/:id
   */
  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('view_dashboard')
  async deleteNotification(
    @Param('id') notificationId: string,
    @Req() req,
  ) {
    const staffId = req.user.sub;
    await this.adminNotificationsService.deleteNotification(staffId, notificationId);
    return { success: true, message: 'Notification deleted' };
  }
}
