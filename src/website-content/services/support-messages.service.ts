import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../../shared/supabase.client';
import { CreateSupportMessageDto, UpdateSupportMessageDto, SupportMessageReplyDto, SupportMessageQueryDto, SupportMessageType, SupportMessageStatus } from '../dto/support-message.dto';

@Injectable()
export class SupportMessagesService {
  private serviceSupabase;

  constructor(private configService: ConfigService) {
    this.serviceSupabase = createServiceSupabaseClient(this.configService);
  }

  async findAll(query: SupportMessageQueryDto) {
    const { type, status, assignedTo, search, page = 1, limit = 10 } = query;
    
    let queryBuilder = this.serviceSupabase
      .from('support_messages')
      .select('*', { count: 'exact' });

    // Apply filters
    if (type) {
      queryBuilder = queryBuilder.eq('type', type);
    }

    if (status) {
      queryBuilder = queryBuilder.eq('status', status);
    }

    if (assignedTo) {
      queryBuilder = queryBuilder.eq('assigned_to', assignedTo);
    }

    if (search) {
      queryBuilder = queryBuilder.or(`name.ilike.%${search}%,email.ilike.%${search}%,subject.ilike.%${search}%,message.ilike.%${search}%`);
    }

    // Apply pagination
    const offset = (page - 1) * limit;
    queryBuilder = queryBuilder
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to fetch support messages: ${error.message}`);
    }

    return {
      data: data || [],
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    };
  }

  async findOne(id: string) {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Support message with ID ${id} not found`);
    }

    return data;
  }

  async create(createSupportMessageDto: CreateSupportMessageDto) {
    console.log('Backend received DTO:', createSupportMessageDto);
    
    const { attachmentUrl, ...restOfDto } = createSupportMessageDto;
    
    const insertData = {
      ...restOfDto,
      attachment_url: attachmentUrl, // Map camelCase to snake_case
      status: createSupportMessageDto.status || 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    console.log('Inserting into database:', insertData);
    
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create support message: ${error.message}`);
    }

    return data;
  }

  async update(id: string, updateSupportMessageDto: UpdateSupportMessageDto) {
    // Check if support message exists
    await this.findOne(id);

    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .update({
        ...updateSupportMessageDto,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update support message: ${error.message}`);
    }

    return data;
  }

  async remove(id: string) {
    await this.findOne(id);

    const { error } = await this.serviceSupabase
      .from('support_messages')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to delete support message: ${error.message}`);
    }
  }

  async reply(id: string, replyDto: SupportMessageReplyDto, staffId?: string) {
    // Check if support message exists
    await this.findOne(id);

    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .update({
        status: SupportMessageStatus.RESOLVED,
        admin_notes: replyDto.adminNotes,
        replied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(staffId && { assigned_to: staffId }),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to reply to support message: ${error.message}`);
    }

    // TODO: Send email notification to user if sendEmail is true
    // This would integrate with an email service

    return data;
  }

  async assignTo(id: string, staffId: string) {
    // Check if support message exists
    await this.findOne(id);

    // Verify staff member exists and is active
    const { data: staff } = await this.serviceSupabase
      .from('staff_accounts')
      .select('id, full_name')
      .eq('id', staffId)
      .eq('is_active', true)
      .single();

    if (!staff) {
      throw new BadRequestException('Staff member not found or inactive');
    }

    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .update({
        assigned_to: staffId,
        status: 'assigned',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to assign support message: ${error.message}`);
    }

    return data;
  }

  async updateStatus(id: string, status: SupportMessageStatus) {
    return this.update(id, { status });
  }

  async getStatistics() {
    const [
      totalResult,
      pendingResult,
      assignedResult,
      resolvedResult,
      closedResult,
    ] = await Promise.all([
      this.serviceSupabase.from('support_messages').select('*', { count: 'exact', head: true }),
      this.serviceSupabase.from('support_messages').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      this.serviceSupabase.from('support_messages').select('*', { count: 'exact', head: true }).in('status', ['assigned', 'in_progress']),
      this.serviceSupabase.from('support_messages').select('*', { count: 'exact', head: true }).eq('status', 'resolved'),
      this.serviceSupabase.from('support_messages').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
    ]);

    return {
      total: totalResult.count || 0,
      pending: pendingResult.count || 0,
      assigned: assignedResult.count || 0,
      in_progress: 0, // Not directly queried, included in assigned
      resolved: resolvedResult.count || 0,
      closed: closedResult.count || 0,
    };
  }

  async getMessagesByType() {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('type')
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to fetch messages by type: ${error.message}`);
    }

    const typeCounts = data?.reduce((acc, msg) => {
      const type = msg.type;
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {}) || {};

    return typeCounts;
  }

  async getMessagesByStatus() {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('status')
      .in('status', ['pending', 'assigned', 'in_progress', 'resolved', 'closed']);

    if (error) {
      throw new Error(`Failed to fetch messages by status: ${error.message}`);
    }

    const statusCounts = data?.reduce((acc, msg) => {
      const status = msg.status;
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    return statusCounts;
  }

  async getMessagesByPriority() {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('priority')
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to fetch messages by priority: ${error.message}`);
    }

    const priorityCounts = data?.reduce((acc, msg) => {
      const priority = msg.priority || 'medium';
      acc[priority] = (acc[priority] || 0) + 1;
      return acc;
    }, {}) || {};

    return priorityCounts;
  }

  async getUnassignedCount() {
    const { count, error } = await this.serviceSupabase
      .from('support_messages')
      .select('*', { count: 'exact', head: true })
      .is('assigned_to', null)
      .eq('status', 'pending');

    if (error) {
      throw new Error(`Failed to fetch unassigned count: ${error.message}`);
    }

    return count || 0;
  }

  async getRecentMessages(limit: number = 5) {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch recent messages: ${error.message}`);
    }

    return data || [];
  }

  async getOverdueMessages() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('*')
      .lt('created_at', threeDaysAgo)
      .in('status', ['pending', 'assigned'])
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch overdue messages: ${error.message}`);
    }

    return data || [];
  }

  async getStaffWorkload(staffId: string) {
    const { data, error } = await this.serviceSupabase
      .from('support_messages')
      .select('status')
      .eq('assigned_to', staffId)
      .in('status', ['assigned', 'in_progress', 'resolved', 'closed']);

    if (error) {
      throw new Error(`Failed to fetch staff workload: ${error.message}`);
    }

    const workloadCounts = data?.reduce((acc, msg) => {
      const status = msg.status;
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}) || {};

    return workloadCounts;
  }

  async closeMessage(id: string) {
    return this.updateStatus(id, SupportMessageStatus.CLOSED);
  }

  async reopenMessage(id: string) {
    return this.updateStatus(id, SupportMessageStatus.PENDING);
  }

  // Alias method for controller compatibility
  async getSupportStats() {
    return this.getStatistics();
  }

  // Additional alias methods for controller compatibility
  async getTypeStats() {
    return this.getMessagesByType();
  }

  async getStaffStats() {
    return this.getMessagesByStatus();
  }

  async findById(id: string) {
    return this.findOne(id);
  }

  // Additional alias method for controller compatibility
  async assignToStaff(messageId: string, staffId: string) {
    return this.assignTo(messageId, staffId);
  }
}
