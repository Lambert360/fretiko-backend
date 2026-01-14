import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { AdminNotificationsService, AdminNotificationType } from '../admin/admin-notifications.service';
import { AdminNotificationEventType, MemoSentEvent } from '../admin/events/admin-notification.events';
import {
  SendMemoDto,
  MemoResponseDto,
  MemoListFilterDto,
  MemoStatsDto,
  RecipientType,
  MemoPriority,
} from './dto/memo.dto';

/**
 * Memos Service
 * Internal communication system for staff and departments
 */
@Injectable()
export class MemosService {
  private readonly logger = new Logger(MemosService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private eventEmitter: EventEmitter2, // For event-based notifications
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Send a memo
   */
  async sendMemo(senderId: string, memoDto: SendMemoDto): Promise<MemoResponseDto> {
    // Get sender details
    const { data: sender } = await this.supabase
      .from('staff_accounts')
      .select('id, full_name, department_id')
      .eq('id', senderId)
      .single();

    if (!sender) {
      throw new BadRequestException('Sender not found');
    }

    // Validate recipient
    if (memoDto.recipientType !== RecipientType.ALL && !memoDto.recipientId) {
      throw new BadRequestException('Recipient ID is required for department or staff recipient type');
    }

    // Verify recipient exists
    if (memoDto.recipientType === RecipientType.DEPARTMENT) {
      const { data: dept } = await this.supabase
        .from('departments')
        .select('id')
        .eq('id', memoDto.recipientId)
        .single();

      if (!dept) {
        throw new BadRequestException('Department not found');
      }
    } else if (memoDto.recipientType === RecipientType.STAFF) {
      const { data: staff } = await this.supabase
        .from('staff_accounts')
        .select('id')
        .eq('id', memoDto.recipientId)
        .single();

      if (!staff) {
        throw new BadRequestException('Staff recipient not found');
      }
    }

    // Create memo
    const { data: memo, error } = await this.supabase
      .from('memos')
      .insert({
        subject: memoDto.subject,
        body: memoDto.body,
        sender_id: senderId,
        sender_department_id: sender.department_id,
        recipient_type: memoDto.recipientType,
        recipient_id: memoDto.recipientId || null,
        priority: memoDto.priority || MemoPriority.NORMAL,
        attachments: memoDto.attachments || [],
        parent_memo_id: memoDto.parentMemoId || null,
      })
      .select(`
        *,
        sender:staff_accounts!sender_id(id, full_name, department_id),
        sender_department:departments!sender_department_id(id, name)
      `)
      .single();

    if (error) {
      this.logger.error(`Failed to send memo: ${error.message}`);
      throw new BadRequestException('Failed to send memo');
    }

    this.logger.log(`Memo sent by ${sender.full_name} (${senderId})`);

    // 🔔 Emit memo sent event for notifications
    try {
      const event: MemoSentEvent = {
        memoId: memo.id,
        senderId: senderId,
        senderName: sender.full_name,
        recipientType: memoDto.recipientType.toLowerCase(),
        recipientId: memoDto.recipientId,
        priority: memoDto.priority || 'normal',
      };

      this.eventEmitter.emit(AdminNotificationEventType.MEMO_SENT, event);
      this.logger.log(`📢 Emitted memo sent event for memo ${memo.id}`);
    } catch (eventError) {
      this.logger.warn(`Failed to emit memo sent event: ${eventError.message}`);
      // Don't fail the memo send if event emission fails
    }

    return this.mapToResponseDto(memo);
  }

  /**
   * Get received memos for current staff
   */
  async getReceivedMemos(staffId: string, filters?: MemoListFilterDto): Promise<MemoResponseDto[]> {
    // Get staff details
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('id, department_id, role')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new NotFoundException('Staff not found');
    }

    // Build the OR condition based on staff's department
    let orCondition: string;
    if (staff.department_id) {
      // Staff has a department - include department memos
      orCondition = `recipient_type.eq.all,and(recipient_type.eq.staff,recipient_id.eq.${staffId}),and(recipient_type.eq.department,recipient_id.eq.${staff.department_id})`;
    } else {
      // Staff has no department - only include 'all' and direct staff memos
      orCondition = `recipient_type.eq.all,and(recipient_type.eq.staff,recipient_id.eq.${staffId})`;
    }

    let query = this.supabase
      .from('memos')
      .select(`
        *,
        sender:staff_accounts!sender_id(id, full_name, department_id),
        sender_department:departments!sender_department_id(id, name),
        memo_reads!left(staff_id, read_at)
      `)
      .or(orCondition)
      .is('parent_memo_id', null) // Only get top-level memos (not replies)
      .order('created_at', { ascending: false });

    // Apply filters
    if (filters?.recipientType) {
      query = query.eq('recipient_type', filters.recipientType);
    }

    if (filters?.priority) {
      query = query.eq('priority', filters.priority);
    }

    if (filters?.search) {
      query = query.or(`subject.ilike.%${filters.search}%,body.ilike.%${filters.search}%`);
    }

    const { data: memos, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch received memos: ${error.message}`);
      throw new BadRequestException('Failed to fetch memos');
    }

    // Map and check read status
    return memos.map(memo => {
      const memoDto = this.mapToResponseDto(memo);

      // Check if current staff has read this memo
      const readRecord = memo.memo_reads?.find(r => r.staff_id === staffId);
      if (readRecord) {
        memoDto.isRead = true;
        memoDto.readAt = readRecord.read_at;
        memoDto.readBy = staffId;
      }

      return memoDto;
    });
  }

  /**
   * Get sent memos for current staff
   */
  async getSentMemos(staffId: string, filters?: MemoListFilterDto): Promise<MemoResponseDto[]> {
    let query = this.supabase
      .from('memos')
      .select(`
        *,
        sender:staff_accounts!sender_id(id, full_name, department_id),
        sender_department:departments!sender_department_id(id, name)
      `)
      .eq('sender_id', staffId)
      .is('parent_memo_id', null) // Only get top-level memos
      .order('created_at', { ascending: false });

    // Apply filters
    if (filters?.recipientType) {
      query = query.eq('recipient_type', filters.recipientType);
    }

    if (filters?.priority) {
      query = query.eq('priority', filters.priority);
    }

    if (filters?.search) {
      query = query.or(`subject.ilike.%${filters.search}%,body.ilike.%${filters.search}%`);
    }

    const { data: memos, error } = await query;

    if (error) {
      this.logger.error(`Failed to fetch sent memos: ${error.message}`);
      throw new BadRequestException('Failed to fetch sent memos');
    }

    return memos.map(memo => this.mapToResponseDto(memo));
  }

  /**
   * Get memo by ID with replies
   */
  async getMemoById(memoId: string, staffId: string): Promise<MemoResponseDto> {
    const { data: memo, error } = await this.supabase
      .from('memos')
      .select(`
        *,
        sender:staff_accounts!sender_id(id, full_name, department_id),
        sender_department:departments!sender_department_id(id, name),
        memo_reads!left(staff_id, read_at)
      `)
      .eq('id', memoId)
      .single();

    if (error || !memo) {
      throw new NotFoundException('Memo not found');
    }

    // Verify staff has access to this memo
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('id, department_id, role')
      .eq('id', staffId)
      .single();

    const hasAccess =
      memo.sender_id === staffId || // Sent by this staff
      memo.recipient_type === RecipientType.ALL || // Sent to all
      (memo.recipient_type === RecipientType.STAFF && memo.recipient_id === staffId) || // Sent to this staff
      (memo.recipient_type === RecipientType.DEPARTMENT && memo.recipient_id === staff.department_id) || // Sent to this staff's department
      staff.role === 'super_admin'; // Super admin sees all

    if (!hasAccess) {
      throw new ForbiddenException('Access denied to this memo');
    }

    // Get replies
    const { data: replies } = await this.supabase
      .from('memos')
      .select(`
        *,
        sender:staff_accounts!sender_id(id, full_name, department_id),
        sender_department:departments!sender_department_id(id, name)
      `)
      .eq('parent_memo_id', memoId)
      .order('created_at', { ascending: true });

    const memoDto = this.mapToResponseDto(memo);

    // Check read status
    const readRecord = memo.memo_reads?.find(r => r.staff_id === staffId);
    if (readRecord) {
      memoDto.isRead = true;
      memoDto.readAt = readRecord.read_at;
      memoDto.readBy = staffId;
    }

    memoDto.replies = replies?.map(r => this.mapToResponseDto(r)) || [];
    memoDto.replyCount = replies?.length || 0;

    return memoDto;
  }

  /**
   * Mark memo as read
   */
  async markAsRead(memoId: string, staffId: string): Promise<{ message: string }> {
    // Check if already read
    const { data: existing } = await this.supabase
      .from('memo_reads')
      .select('id')
      .eq('memo_id', memoId)
      .eq('staff_id', staffId)
      .single();

    if (existing) {
      return { message: 'Memo already marked as read' };
    }

    // Mark as read
    const { error } = await this.supabase
      .from('memo_reads')
      .insert({
        memo_id: memoId,
        staff_id: staffId,
      });

    if (error) {
      this.logger.error(`Failed to mark memo as read: ${error.message}`);
      throw new BadRequestException('Failed to mark memo as read');
    }

    this.logger.log(`Memo ${memoId} marked as read by ${staffId}`);

    return { message: 'Memo marked as read' };
  }

  /**
   * Get memo statistics for current staff
   */
  async getMemoStats(staffId: string): Promise<MemoStatsDto> {
    // Get staff details
    const { data: staff } = await this.supabase
      .from('staff_accounts')
      .select('id, department_id')
      .eq('id', staffId)
      .single();

    if (!staff) {
      throw new NotFoundException('Staff not found');
    }

    // Build the OR condition for received memos
    let orCondition: string;
    if (staff.department_id) {
      orCondition = `recipient_type.eq.all,and(recipient_type.eq.staff,recipient_id.eq.${staffId}),and(recipient_type.eq.department,recipient_id.eq.${staff.department_id})`;
    } else {
      orCondition = `recipient_type.eq.all,and(recipient_type.eq.staff,recipient_id.eq.${staffId})`;
    }

    // Get all received memos (only top-level, not replies)
    const { data: receivedMemos } = await this.supabase
      .from('memos')
      .select(`
        id,
        priority,
        recipient_type,
        memo_reads!left(staff_id, read_at)
      `)
      .or(orCondition)
      .is('parent_memo_id', null);

    // Get all sent memos (only top-level, not replies)
    const { data: sentMemos } = await this.supabase
      .from('memos')
      .select('id, priority, recipient_type')
      .eq('sender_id', staffId)
      .is('parent_memo_id', null);

    const total = receivedMemos?.length || 0;
    const unread = receivedMemos?.filter(m => !m.memo_reads?.some(r => r.staff_id === staffId)).length || 0;
    const urgent = receivedMemos?.filter(m => m.priority === MemoPriority.URGENT).length || 0;

    const byPriority = {
      low: receivedMemos?.filter(m => m.priority === MemoPriority.LOW).length || 0,
      normal: receivedMemos?.filter(m => m.priority === MemoPriority.NORMAL).length || 0,
      high: receivedMemos?.filter(m => m.priority === MemoPriority.HIGH).length || 0,
      urgent: receivedMemos?.filter(m => m.priority === MemoPriority.URGENT).length || 0,
    };

    const byRecipientType = {
      department: sentMemos?.filter(m => m.recipient_type === RecipientType.DEPARTMENT).length || 0,
      staff: sentMemos?.filter(m => m.recipient_type === RecipientType.STAFF).length || 0,
      all: sentMemos?.filter(m => m.recipient_type === RecipientType.ALL).length || 0,
    };

    this.logger.log(`Memo stats for ${staffId}: total=${total}, unread=${unread}, urgent=${urgent}, sent=${(byRecipientType.all + byRecipientType.department + byRecipientType.staff)}`);

    return {
      total,
      unread,
      urgent,
      byPriority,
      byRecipientType,
    };
  }

  /**
   * Map database record to response DTO
   */
  private mapToResponseDto(memo: any): MemoResponseDto {
    return {
      id: memo.id,
      subject: memo.subject,
      body: memo.body,
      senderId: memo.sender_id,
      senderName: memo.sender?.full_name || 'Unknown',
      senderDepartmentId: memo.sender_department_id,
      senderDepartmentName: memo.sender_department?.name,
      recipientType: memo.recipient_type,
      recipientId: memo.recipient_id,
      priority: memo.priority,
      isRead: memo.is_read || false,
      readAt: memo.read_at,
      readBy: memo.read_by,
      attachments: memo.attachments || [],
      parentMemoId: memo.parent_memo_id,
      createdAt: memo.created_at,
    };
  }
}
