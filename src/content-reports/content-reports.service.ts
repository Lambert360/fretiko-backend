import { Injectable, Logger, HttpException, HttpStatus, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority, ActionButtonType } from '../notifications/dto/notification.dto';
import { AdminService } from '../admin/admin.service';
import { AdminNotificationsService, AdminNotificationType } from '../admin/admin-notifications.service';
import { AdminNotificationEventType, ContentReportCreatedEvent } from '../admin/events/admin-notification.events';

export interface CreateContentReportDto {
  reportCategory: 'product' | 'service' | 'chat' | 'user' | 'post';
  
  // Reference to reported content (one of these required)
  productId?: string;
  serviceId?: string;
  chatId?: string;
  postId?: string;
  reportedUserId?: string;
  
  reportType: 
    | 'inappropriate_content' | 'spam' | 'fraudulent_listing' | 'copyright_violation' | 'misleading_information'
    | 'harassment' | 'spam_messages' | 'inappropriate_language' | 'threats'
    | 'suspicious_activity' | 'fake_account' | 'scam_attempt'
    | 'other';
  
  reason: string;
  description?: string;
  evidence?: Array<{ type: 'image' | 'document'; url: string; description: string }>;
}

export interface ReviewContentReportDto {
  status: 'approved' | 'action_taken' | 'dismissed';
  actionTaken?: 'no_action' | 'content_removed' | 'user_warned' | 'user_suspended';
  actionReason: string;
}

export interface ContentReport {
  id: string;
  reporterId: string;
  reportCategory: 'product' | 'service' | 'chat' | 'user' | 'post';
  productId?: string;
  serviceId?: string;
  chatId?: string;
  postId?: string;
  reportedUserId?: string;
  reportType: string;
  status: 'pending' | 'under_review' | 'approved' | 'action_taken' | 'dismissed';
  reason: string;
  description?: string;
  evidence?: any[];
  actionTaken?: string;
  actionReason?: string;
  moderatedBy?: string;
  moderatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ContentReportsService {
  private readonly logger = new Logger(ContentReportsService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    private notificationsService: NotificationsService,
    private eventEmitter: EventEmitter2, // For event-based notifications
    @Inject(forwardRef(() => AdminService))
    private adminService: AdminService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create a new content report
   */
  async createContentReport(userId: string, createDto: CreateContentReportDto): Promise<ContentReport> {
    try {
      this.logger.log(`Creating ${createDto.reportCategory} report by user ${userId}`);

      // Validate that at least one reference ID is provided
      const hasReference =
        createDto.productId ||
        createDto.serviceId ||
        createDto.chatId ||
        createDto.postId ||
        createDto.reportedUserId;

      if (!hasReference) {
        throw new HttpException(
          'At least one reference ID (productId, serviceId, chatId, postId, or reportedUserId) is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Validate category matches reference
      if (createDto.reportCategory === 'product' && !createDto.productId) {
        throw new HttpException('productId is required for product reports', HttpStatus.BAD_REQUEST);
      }
      if (createDto.reportCategory === 'service' && !createDto.serviceId) {
        throw new HttpException('serviceId is required for service reports', HttpStatus.BAD_REQUEST);
      }
      if (createDto.reportCategory === 'chat' && !createDto.chatId) {
        throw new HttpException('chatId is required for chat reports', HttpStatus.BAD_REQUEST);
      }
      if (createDto.reportCategory === 'user' && !createDto.reportedUserId) {
        throw new HttpException('reportedUserId is required for user reports', HttpStatus.BAD_REQUEST);
      }
      if (createDto.reportCategory === 'post' && !createDto.postId) {
        throw new HttpException('postId is required for post reports', HttpStatus.BAD_REQUEST);
      }

      // Check if user is trying to report themselves
      if (createDto.reportCategory === 'user' && createDto.reportedUserId === userId) {
        throw new HttpException('You cannot report yourself', HttpStatus.BAD_REQUEST);
      }

      // Check if chat report - verify user is participant
      if (createDto.reportCategory === 'chat' && createDto.chatId) {
        const { data: participant } = await this.supabase
          .from('chat_participants')
          .select('id')
          .eq('conversation_id', createDto.chatId)
          .eq('user_id', userId)
          .single();

        if (!participant) {
          throw new HttpException('You are not a participant in this chat', HttpStatus.FORBIDDEN);
        }
      }

      // Check for duplicate pending reports
      let duplicateQuery = this.supabase
        .from('content_reports')
        .select('id')
        .eq('reporter_id', userId)
        .eq('status', 'pending');

      if (createDto.productId) {
        duplicateQuery = duplicateQuery.eq('product_id', createDto.productId);
      } else if (createDto.serviceId) {
        duplicateQuery = duplicateQuery.eq('service_id', createDto.serviceId);
      } else if (createDto.chatId) {
        duplicateQuery = duplicateQuery.eq('chat_id', createDto.chatId);
      } else if (createDto.postId) {
        duplicateQuery = duplicateQuery.eq('post_id', createDto.postId);
      } else if (createDto.reportedUserId) {
        duplicateQuery = duplicateQuery.eq('reported_user_id', createDto.reportedUserId);
      }

      const { data: existingReport } = await duplicateQuery.single();

      if (existingReport) {
        throw new HttpException('You have already reported this content. Please wait for moderator review.', HttpStatus.CONFLICT);
      }

      // Create the report
      const { data: report, error } = await this.supabase
        .from('content_reports')
        .insert({
          reporter_id: userId,
          report_category: createDto.reportCategory,
          product_id: createDto.productId || null,
          service_id: createDto.serviceId || null,
          post_id: createDto.postId || null,
          chat_id: createDto.chatId || null,
          reported_user_id: createDto.reportedUserId || null,
          report_type: createDto.reportType,
          reason: createDto.reason,
          description: createDto.description || null,
          evidence: createDto.evidence || [],
          status: 'pending',
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create content report: ${error.message}`);
        throw new HttpException('Failed to create content report', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // Notify the reporter that their report was received
      try {
        await this.notificationHelper.notifySystemUpdate(
          userId,
          'Content Report Submitted',
          `Your ${createDto.reportCategory} report has been received and will be reviewed by our moderation team.`,
          { reportId: report.id, category: createDto.reportCategory }
        );
      } catch (notifError) {
        this.logger.warn('Failed to send notification to reporter', notifError);
      }

      // 🔔 Emit content report created event for notifications
      try {
        const event: ContentReportCreatedEvent = {
          reportId: report.id,
          category: createDto.reportCategory,
          reportType: createDto.reportType,
          reporterId: userId,
        };

        this.eventEmitter.emit(AdminNotificationEventType.CONTENT_REPORT_CREATED, event);
        this.logger.log(`📢 Emitted content report created event for report ${report.id}`);
      } catch (eventError) {
        this.logger.warn('Failed to emit content report created event', eventError);
      }

      // Notify moderators about the new content report
      try {
        await this.notifyModerators(report.id, createDto.reportCategory, createDto.reportType);
      } catch (notifError) {
        this.logger.warn('Failed to notify moderators', notifError);
      }

      this.logger.log(`Content report created: ${report.id}`);

      return this.mapToContentReport(report);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error creating content report:', error);
      throw new HttpException('Failed to create content report', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get user's content reports
   */
  async getUserReports(userId: string): Promise<ContentReport[]> {
    try {
      const { data: reports, error } = await this.supabase
        .from('content_reports')
        .select('*')
        .eq('reporter_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error(`Failed to fetch user reports: ${error.message}`);
        throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return (reports || []).map(report => this.mapToContentReport(report));
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error fetching user reports:', error);
      throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get content report details
   */
  async getContentReport(userId: string, reportId: string): Promise<ContentReport> {
    try {
      const { data: report, error } = await this.supabase
        .from('content_reports')
        .select('*')
        .eq('id', reportId)
        .single();

      if (error || !report) {
        throw new HttpException('Content report not found', HttpStatus.NOT_FOUND);
      }

      // Check access: user must be reporter or moderator
      const isReporter = report.reporter_id === userId;
      const isModerator = await this.isModerator(userId);

      if (!isReporter && !isModerator) {
        throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
      }

      return this.mapToContentReport(report);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error fetching content report:', error);
      throw new HttpException('Failed to fetch report', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get all pending reports (moderators only)
   */
  async getAllPendingReports(): Promise<ContentReport[]> {
    try {
      const { data: reports, error } = await this.supabase
        .from('content_reports')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error(`Failed to fetch pending reports: ${error.message}`);
        throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return (reports || []).map(report => this.mapToContentReport(report));
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error fetching pending reports:', error);
      throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get all reports with filters (moderators only)
   */
  async getAllReports(filters?: {
    status?: 'pending' | 'under_review' | 'approved' | 'action_taken' | 'dismissed';
    category?: 'product' | 'service' | 'chat' | 'user' | 'post';
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ reports: ContentReport[]; total: number }> {
    try {
      let query = this.supabase
        .from('content_reports')
        .select('*', { count: 'exact' });

      if (filters?.status) {
        query = query.eq('status', filters.status);
      }

      if (filters?.category) {
        query = query.eq('report_category', filters.category);
      }

      if (filters?.search) {
        query = query.or(`reason.ilike.%${filters.search}%,description.ilike.%${filters.search}%`);
      }

      const page = filters?.page || 1;
      const limit = filters?.limit || 20;
      const offset = (page - 1) * limit;

      query = query.order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      const { data: reports, error, count } = await query;

      if (error) {
        this.logger.error(`Failed to fetch reports: ${error.message}`);
        throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return {
        reports: (reports || []).map(report => this.mapToContentReport(report)),
        total: count || 0,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error fetching reports:', error);
      throw new HttpException('Failed to fetch reports', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Get content report statistics (moderators only)
   */
  async getContentReportStats(): Promise<{
    totalReports: number;
    pendingReports: number;
    underReviewReports: number;
    actionTakenReports: number;
    dismissedReports: number;
    byCategory: {
      product: number;
      service: number;
      chat: number;
      user: number;
      post: number;
    };
  }> {
    try {
      // Get all reports for stats
      const { data: allReports, error } = await this.supabase
        .from('content_reports')
        .select('status, report_category');

      if (error) {
        this.logger.error(`Failed to fetch stats: ${error.message}`);
        throw new HttpException('Failed to fetch stats', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      const reports = allReports || [];

      // Calculate stats
      const stats = {
        totalReports: reports.length,
        pendingReports: reports.filter(r => r.status === 'pending').length,
        underReviewReports: reports.filter(r => r.status === 'under_review').length,
        actionTakenReports: reports.filter(r => r.status === 'action_taken').length,
        dismissedReports: reports.filter(r => r.status === 'dismissed').length,
        byCategory: {
          product: reports.filter(r => r.report_category === 'product').length,
          service: reports.filter(r => r.report_category === 'service').length,
          chat: reports.filter(r => r.report_category === 'chat').length,
          user: reports.filter(r => r.report_category === 'user').length,
          post: reports.filter(r => r.report_category === 'post').length,
        },
      };

      return stats;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error fetching stats:', error);
      throw new HttpException('Failed to fetch stats', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Review content report (staff with content moderation permissions)
   */
  async reviewContentReport(moderatorId: string, reportId: string, reviewDto: ReviewContentReportDto): Promise<ContentReport> {
    try {
      // Verify staff has permission (super admin can always review, others need content moderation permissions)
      const hasPermission = await this.hasContentModerationPermission(moderatorId);
      if (!hasPermission) {
        throw new HttpException('You do not have permission to review content reports', HttpStatus.FORBIDDEN);
      }

      // Get report
      const { data: report, error: fetchError } = await this.supabase
        .from('content_reports')
        .select('*')
        .eq('id', reportId)
        .single();

      if (fetchError || !report) {
        throw new HttpException('Content report not found', HttpStatus.NOT_FOUND);
      }

      // Update report
      // Note: After migration 125, moderated_by can store staff_accounts IDs
      // The foreign key constraint has been removed to allow staff moderators
      const updateData: any = {
        status: reviewDto.status,
        moderated_by: moderatorId, // Staff ID from staff_accounts
        moderated_at: new Date().toISOString(),
      };

      if (reviewDto.actionTaken) {
        updateData.action_taken = reviewDto.actionTaken;
        updateData.action_reason = reviewDto.actionReason;
      }

      const { data: updatedReport, error: updateError } = await this.supabase
        .from('content_reports')
        .update(updateData)
        .eq('id', reportId)
        .select()
        .single();

      if (updateError) {
        this.logger.error(`Failed to review content report: ${updateError.message}`);
        throw new HttpException('Failed to review report', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // Implement actual moderation actions
      if (reviewDto.actionTaken && reviewDto.actionTaken !== 'no_action') {
        try {
          if (reviewDto.actionTaken === 'content_removed') {
            // Reject the reported content (set status to inactive)
            if (report.product_id) {
              await this.adminService.rejectProduct(moderatorId, report.product_id, reviewDto.actionReason || 'Content removed due to report');
              this.logger.log(`Product ${report.product_id} rejected as part of report review`);
            } else if (report.service_id) {
              await this.adminService.rejectService(moderatorId, report.service_id, reviewDto.actionReason || 'Content removed due to report');
              this.logger.log(`Service ${report.service_id} rejected as part of report review`);
            } else {
              this.logger.warn(`Content removal requested but no product_id or service_id found in report ${reportId}`);
            }
          } else if (reviewDto.actionTaken === 'user_warned') {
            // Warn the reported user
            const userIdToWarn = report.reported_user_id || (report.product_id ? await this.getProductOwnerId(report.product_id) : null) || (report.service_id ? await this.getServiceOwnerId(report.service_id) : null);
            
            if (userIdToWarn) {
              // Determine severity based on report type
              let severity: 'low' | 'medium' | 'high' = 'low';
              if (['fraudulent_listing', 'harassment', 'threats'].includes(report.report_type)) {
                severity = 'high';
              } else if (['spam', 'inappropriate_language'].includes(report.report_type)) {
                severity = 'medium';
              }
              
              await this.adminService.warnUser(
                moderatorId,
                userIdToWarn,
                severity,
                reviewDto.actionReason || `Warning due to content report: ${report.reason}`,
                report.product_id || report.service_id || undefined,
                (report.product_id ? 'product' : report.service_id ? 'service' : undefined) as 'product' | 'service' | 'chat' | 'user' | undefined,
              );
              this.logger.log(`User ${userIdToWarn} warned as part of report review with ${severity} severity`);
            } else {
              this.logger.warn(`User warning requested but no user ID found in report ${reportId}`);
            }
          } else if (reviewDto.actionTaken === 'user_suspended') {
            // Suspend the reported user
            const userIdToSuspend = report.reported_user_id || (report.product_id ? await this.getProductOwnerId(report.product_id) : null) || (report.service_id ? await this.getServiceOwnerId(report.service_id) : null);
            
            if (userIdToSuspend) {
              await this.adminService.suspendUser(moderatorId, userIdToSuspend, reviewDto.actionReason || 'User suspended due to content report');
              this.logger.log(`User ${userIdToSuspend} suspended as part of report review`);
            } else {
              this.logger.warn(`User suspension requested but no user ID found in report ${reportId}`);
            }
          }
        } catch (actionError: any) {
          // Log the error but don't fail the review - the report is still updated
          this.logger.error(`Failed to execute moderation action ${reviewDto.actionTaken}: ${actionError.message}`, actionError.stack);
          // Optionally, you could throw here if you want the review to fail if the action fails
          // throw new HttpException(`Failed to execute moderation action: ${actionError.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      this.logger.log(`Content report ${reportId} reviewed by ${moderatorId}`);

      return this.mapToContentReport(updatedReport);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error reviewing content report:', error);
      throw new HttpException('Failed to review report', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Add message to content report
   */
  async addReportMessage(userId: string, reportId: string, message: string, attachments?: Array<{ type: string; url: string }>): Promise<any> {
    try {
      // Verify access
      const { data: report } = await this.supabase
        .from('content_reports')
        .select('reporter_id')
        .eq('id', reportId)
        .single();

      if (!report || report.reporter_id !== userId) {
        throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
      }

      const { data: reportMessage, error } = await this.supabase
        .from('content_report_messages')
        .insert({
          report_id: reportId,
          sender_id: userId,
          message,
          attachments: attachments || [],
          is_moderator_message: false,
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to add message: ${error.message}`);
        throw new HttpException('Failed to add message', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return reportMessage;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error('Error adding message:', error);
      throw new HttpException('Failed to add message', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Check if staff has content moderation permission
   * Super admins can always moderate, others need appropriate permissions
   */
  private async hasContentModerationPermission(staffId: string): Promise<boolean> {
    try {
      // Check if staff exists and is active
      const { data: staff, error } = await this.supabase
        .from('staff_accounts')
        .select(`
          id,
          role,
          is_active,
          department_id,
          department:departments(
            id,
            name,
            permissions
          )
        `)
        .eq('id', staffId)
        .single();

      if (error || !staff || !staff.is_active) {
        return false;
      }

      // Super admin can always moderate
      if (staff.role === 'super_admin') {
        return true;
      }

      // Check if staff's department has content moderation permissions
      if (staff.department && staff.department.permissions) {
        const permissions = Array.isArray(staff.department.permissions) 
          ? staff.department.permissions 
          : [];
        // Check for any content moderation related permissions
        const contentModerationPermissions = [
          'view_products',
          'approve_products',
          'remove_products',
          'view_services',
          'approve_services',
          'remove_services',
          'view_stories',
          'remove_stories',
          'view_live_streams',
          'end_live_streams'
        ];
        
        if (contentModerationPermissions.some(perm => permissions.includes(perm))) {
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error('Error checking content moderation permission:', error);
      return false;
    }
  }

  /**
   * Check if user is a moderator (for user-reported content, checks user_profiles)
   * @deprecated Use hasContentModerationPermission for staff accounts
   */
  private async isModerator(userId: string): Promise<boolean> {
    try {
      const { data: profile } = await this.supabase
        .from('user_profiles')
        .select('role, preferences')
        .eq('id', userId)
        .single();

      if (!profile) return false;

      // Check if user is admin or moderator
      const isAdmin = profile.preferences?.isAdmin === true || profile.preferences?.isModerator === true;
      return isAdmin;
    } catch (error) {
      return false;
    }
  }

  /**
   * Notify all moderators about a new content report
   */
  private async notifyModerators(reportId: string, category: string, reportType: string): Promise<void> {
    try {
      // Query for all moderators (users with isAdmin or isModerator in preferences)
      const { data: moderators, error } = await this.supabase
        .from('user_profiles')
        .select('id')
        .or('preferences->>isAdmin.eq.true,preferences->>isModerator.eq.true');

      if (error) {
        this.logger.error('Failed to fetch moderators:', error);
        return;
      }

      if (!moderators || moderators.length === 0) {
        this.logger.warn('No moderators found to notify');
        return;
      }

      this.logger.log(`Notifying ${moderators.length} moderators about content report ${reportId}`);

      // Send notification to each moderator
      const notificationPromises = moderators.map(moderator =>
        this.notificationsService.createNotification({
          user_id: moderator.id,
          type: NotificationType.SYSTEM,
          title: 'New Content Report',
          message: `A new ${category} report has been submitted: ${reportType.replace(/_/g, ' ')}`,
          priority: NotificationPriority.HIGH,
          badge: 'CONTENT_REPORT',
          has_actions: true,
          action_buttons: [
            { label: 'Review Report', type: ActionButtonType.PRIMARY },
          ],
          data: {
            reportId,
            category,
            reportType,
            type: 'content_report',
          },
        }).catch(err => {
          this.logger.warn(`Failed to notify moderator ${moderator.id}:`, err);
          return null;
        })
      );

      await Promise.all(notificationPromises);
      this.logger.log(`Successfully notified moderators about content report ${reportId}`);
    } catch (error) {
      this.logger.error('Error notifying moderators:', error);
    }
  }

  /**
   * Get product owner ID
   */
  private async getProductOwnerId(productId: string): Promise<string | null> {
    try {
      const { data: product, error } = await this.supabase
        .from('products')
        .select('user_id')
        .eq('id', productId)
        .single();

      if (error || !product) {
        this.logger.warn(`Failed to get product owner for ${productId}: ${error?.message}`);
        return null;
      }

      return product.user_id;
    } catch (error) {
      this.logger.error(`Error getting product owner: ${error}`);
      return null;
    }
  }

  /**
   * Get service owner ID
   */
  private async getServiceOwnerId(serviceId: string): Promise<string | null> {
    try {
      const { data: service, error } = await this.supabase
        .from('services')
        .select('user_id')
        .eq('id', serviceId)
        .single();

      if (error || !service) {
        this.logger.warn(`Failed to get service owner for ${serviceId}: ${error?.message}`);
        return null;
      }

      return service.user_id;
    } catch (error) {
      this.logger.error(`Error getting service owner: ${error}`);
      return null;
    }
  }

  /**
   * Map database record to ContentReport interface
   */
  private mapToContentReport(record: any): ContentReport {
    return {
      id: record.id,
      reporterId: record.reporter_id,
      reportCategory: record.report_category,
      productId: record.product_id,
      serviceId: record.service_id,
      postId: record.post_id,
      chatId: record.chat_id,
      reportedUserId: record.reported_user_id,
      reportType: record.report_type,
      status: record.status,
      reason: record.reason,
      description: record.description,
      evidence: record.evidence || [],
      actionTaken: record.action_taken,
      actionReason: record.action_reason,
      moderatedBy: record.moderated_by,
      moderatedAt: record.moderated_at,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }
}

