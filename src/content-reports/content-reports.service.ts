import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType, NotificationPriority, ActionButtonType } from '../notifications/dto/notification.dto';

export interface CreateContentReportDto {
  reportCategory: 'product' | 'service' | 'chat' | 'user';
  
  // Reference to reported content (one of these required)
  productId?: string;
  serviceId?: string;
  chatId?: string;
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
  actionTaken?: 'no_action' | 'content_removed' | 'content_hidden' | 'user_warned' | 'user_suspended' | 'user_banned';
  actionReason: string;
}

export interface ContentReport {
  id: string;
  reporterId: string;
  reportCategory: 'product' | 'service' | 'chat' | 'user';
  productId?: string;
  serviceId?: string;
  chatId?: string;
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
      const hasReference = createDto.productId || createDto.serviceId || createDto.chatId || createDto.reportedUserId;
      if (!hasReference) {
        throw new HttpException('At least one reference ID (productId, serviceId, chatId, or reportedUserId) is required', HttpStatus.BAD_REQUEST);
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
    category?: 'product' | 'service' | 'chat' | 'user';
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
   * Review content report (moderators only)
   */
  async reviewContentReport(moderatorId: string, reportId: string, reviewDto: ReviewContentReportDto): Promise<ContentReport> {
    try {
      // Verify moderator
      const isModerator = await this.isModerator(moderatorId);
      if (!isModerator) {
        throw new HttpException('Only moderators can review content reports', HttpStatus.FORBIDDEN);
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
      const updateData: any = {
        status: reviewDto.status,
        moderated_by: moderatorId,
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

      // TODO: Implement actual moderation actions (remove content, warn user, etc.)

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
   * Check if user is a moderator
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
   * Map database record to ContentReport interface
   */
  private mapToContentReport(record: any): ContentReport {
    return {
      id: record.id,
      reporterId: record.reporter_id,
      reportCategory: record.report_category,
      productId: record.product_id,
      serviceId: record.service_id,
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

