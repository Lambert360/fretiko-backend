import { Injectable, Logger, HttpException, HttpStatus, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface CreateDisputeDto {
  // Dispute category (customer care only)
  disputeCategory: 'order_dispute' | 'bug_report' | 'general';
  
  // Order dispute fields (optional)
  orderId?: string;
  
  // Dispute type (varies by category)
  disputeType: 
    // Order dispute types
    | 'item_not_received' | 'item_not_as_described' | 'damaged_item' | 'wrong_item' | 'refund_request' | 'quality_issue' | 'delivery_issue'
    // Bug report types
    | 'app_crash' | 'payment_issue' | 'login_issue' | 'feature_not_working' | 'performance_issue'
    // General
    | 'other';
  
  reason: string;
  description?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  evidence?: Array<{ type: 'image' | 'document'; url: string; description: string }>;
}

export interface ResolveDisputeDto {
  resolution: 'refund_buyer' | 'partial_refund' | 'release_to_vendor' | 'split_amount' | 'no_action';
  resolutionReason: string;
  resolutionAmount?: number;
}

export interface Dispute {
  id: string;
  disputeCategory: 'order_dispute' | 'bug_report' | 'general';
  orderId?: string;
  escrowId?: string;
  disputantId: string;
  respondentId?: string;
  disputeType: string;
  status: string;
  reason: string;
  description?: string;
  evidence?: any[];
  resolution?: string;
  resolutionReason?: string;
  resolutionAmount?: number;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create a new dispute (customer care: orders, bugs, general support)
   */
  async createDispute(userId: string, createDisputeDto: CreateDisputeDto): Promise<Dispute> {
    try {
      this.logger.log(`Creating ${createDisputeDto.disputeCategory} dispute by user ${userId}`);

      let order: any = null;
      let escrow: any = null;
      let respondentId: string | null = null;
      let orderNumber: string | null = null;

      // Handle order disputes (existing logic)
      if (createDisputeDto.disputeCategory === 'order_dispute') {
        if (!createDisputeDto.orderId) {
          throw new HttpException('Order ID is required for order disputes', HttpStatus.BAD_REQUEST);
        }

        // 1. Fetch order details
        const { data: orderData, error: orderError } = await this.supabase
          .from('orders')
          .select('id, order_number, status, buyer_id, vendor_id, rider_id, created_at, updated_at')
          .eq('id', createDisputeDto.orderId)
          .single();

        if (orderError || !orderData) {
          throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
        }

        order = orderData;
        orderNumber = order.order_number;

        // 2. Verify user is involved in the order
        if (![order.buyer_id, order.vendor_id, order.rider_id].includes(userId)) {
          throw new HttpException('You are not authorized to dispute this order', HttpStatus.FORBIDDEN);
        }

        // 3. Check if dispute window is still open (7 days from delivery/completion)
        const orderCompletedAt = new Date(order.updated_at);
        const daysSinceCompletion = (Date.now() - orderCompletedAt.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceCompletion > 7) {
          throw new HttpException(
            'Dispute window has closed. Disputes can only be filed within 7 days of order completion.',
            HttpStatus.BAD_REQUEST,
          );
        }

        // 4. Check if dispute already exists for this order
        const { data: existingDispute } = await this.supabase
          .from('disputes')
          .select('id, status')
          .eq('order_id', createDisputeDto.orderId)
          .in('status', ['open', 'under_review', 'awaiting_info'])
          .single();

        if (existingDispute) {
          throw new HttpException('A dispute is already open for this order', HttpStatus.CONFLICT);
        }

        // 5. Find escrow for this order
        const { data: escrowData, error: escrowError } = await this.supabase
          .from('escrows')
          .select('id, status, total_amount')
          .eq('order_id', createDisputeDto.orderId)
          .single();

        if (escrowError || !escrowData) {
          throw new HttpException('No escrow found for this order', HttpStatus.NOT_FOUND);
        }

        escrow = escrowData;

        if (escrow.status !== 'held') {
          throw new HttpException(
            `Escrow has already been ${escrow.status}. Disputes can only be filed for held escrows.`,
            HttpStatus.BAD_REQUEST,
          );
        }

        // 6. Determine respondent (the other party)
        if (userId === order.buyer_id) {
          respondentId = order.vendor_id;
        } else if (userId === order.vendor_id) {
          respondentId = order.buyer_id;
        } else {
          respondentId = order.vendor_id; // Rider disputes vendor
        }
      }
      // Bug reports and general - no respondent needed

      // 7. Create dispute record
      const disputeData: any = {
        dispute_category: createDisputeDto.disputeCategory,
        disputant_id: userId,
        dispute_type: createDisputeDto.disputeType,
        status: 'open',
        reason: createDisputeDto.reason,
        description: createDisputeDto.description,
        priority: createDisputeDto.priority || 'medium',
        evidence: createDisputeDto.evidence || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Add optional fields based on category
      if (createDisputeDto.orderId) disputeData.order_id = createDisputeDto.orderId;
      if (escrow?.id) disputeData.escrow_id = escrow.id;
      if (respondentId) disputeData.respondent_id = respondentId;

      const { data: dispute, error: disputeError } = await this.supabase
        .from('disputes')
        .insert(disputeData)
        .select()
        .single();

      if (disputeError) {
        this.logger.error('Failed to create dispute:', disputeError);
        throw new HttpException('Failed to create dispute', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // 8. Update escrow status if order dispute
      if (createDisputeDto.disputeCategory === 'order_dispute' && escrow?.id) {
        await this.escrowService.disputeEscrow(escrow.id, createDisputeDto.reason, userId);
      }

      // 9. Send notifications
      try {
        if (respondentId) {
          await this.notificationHelper.notifyDisputeFiled(
            respondentId,
            orderNumber || 'Support Request',
            createDisputeDto.disputeType,
            dispute.id,
          );
        }

        // Notify admin for all disputes
        this.logger.log(`Admin notification needed for dispute ${dispute.id}`);
      } catch (notifyError) {
        this.logger.warn('Failed to send dispute notifications (non-critical):', notifyError);
      }

      this.logger.log(`✅ Dispute ${dispute.id} created (category: ${createDisputeDto.disputeCategory})`);

      return {
        id: dispute.id,
        disputeCategory: dispute.dispute_category,
        orderId: dispute.order_id || undefined,
        escrowId: dispute.escrow_id || undefined,
        disputantId: dispute.disputant_id,
        respondentId: dispute.respondent_id || undefined,
        disputeType: dispute.dispute_type,
        status: dispute.status,
        reason: dispute.reason,
        description: dispute.description,
        evidence: dispute.evidence,
        createdAt: dispute.created_at,
        updatedAt: dispute.updated_at,
      };
    } catch (error) {
      this.logger.error('Error creating dispute:', error);
      throw error;
    }
  }

  /**
   * Get dispute details
   */
  async getDispute(userId: string, disputeId: string): Promise<Dispute & { order?: any; messages: any[] }> {
    try {
      this.logger.log(`Fetching dispute ${disputeId} for user ${userId}`);
      
      // First, get the dispute without nested relations to avoid issues with optional foreign keys
      const { data: dispute, error: disputeError } = await this.supabase
        .from('disputes')
        .select('*')
        .eq('id', disputeId)
        .single();

      if (disputeError || !dispute) {
        this.logger.error(`Dispute not found: ${disputeError?.message || 'No data returned'}`);
        throw new HttpException('Dispute not found', HttpStatus.NOT_FOUND);
      }

      this.logger.log(`Dispute found: ${dispute.id}, category: ${dispute.dispute_category}, order_id: ${dispute.order_id}`);

      // Fetch order separately if order_id exists
      let order = null;
      if (dispute.order_id) {
        const { data: orderData, error: orderError } = await this.supabase
          .from('orders')
          .select('id, order_number, status, total_amount, buyer_id, vendor_id, rider_id')
          .eq('id', dispute.order_id)
          .single();
        
        if (!orderError && orderData) {
          order = orderData;
        }
      }

      // Fetch messages separately
      // Select only base columns that definitely exist, provide defaults for optional ones
      const { data: disputeMessages, error: messagesError } = await this.supabase
        .from('dispute_messages')
        .select('id, message, sender_id, staff_id, is_admin, attachments, created_at')
        .eq('dispute_id', disputeId)
        .order('created_at', { ascending: true });

      if (messagesError) {
        this.logger.warn(`Error fetching messages: ${messagesError.message}`);
      }

      // Add default values for optional columns that may not exist
      const messagesWithDefaults = (disputeMessages || []).map((msg: any) => ({
        ...msg,
        staff_id: msg.staff_id ?? null,
        is_admin: msg.is_admin ?? false,
      }));

      // Combine the data
      const disputeWithRelations = {
        ...dispute,
        orders: order ? [order] : [],
        dispute_messages: messagesWithDefaults,
      };

      // Verify user is involved (or is admin)
      const isInvolved = disputeWithRelations.disputant_id === userId || 
                        (disputeWithRelations.respondent_id && disputeWithRelations.respondent_id === userId);
      
      if (!isInvolved) {
        // Check if user is admin
        const { data: profile } = await this.supabase
          .from('user_profiles')
          .select('role, preferences')
          .eq('id', userId)
          .single();
        
        const isAdmin = profile?.role === 'admin' || profile?.preferences?.isAdmin === true;
        
        if (!isAdmin) {
          throw new HttpException('You are not authorized to view this dispute', HttpStatus.FORBIDDEN);
        }
      }

      // Map messages with sender information
      const messages = disputeWithRelations.dispute_messages || [];
      const messageSenderIds = messages
        .filter((msg: any) => msg.sender_id)
        .map((msg: any) => msg.sender_id);
      
      const userProfilesMap: Record<string, any> = {};
      if (messageSenderIds.length > 0) {
        const { data: profiles } = await this.supabase
          .from('user_profiles')
          .select('id, username, preferences')
          .in('id', messageSenderIds);
        
        profiles?.forEach((profile) => {
          userProfilesMap[profile.id] = profile;
        });
      }

      // Fetch staff information for staff messages
      const staffIds = messages
        .filter((msg: any) => msg.staff_id)
        .map((msg: any) => msg.staff_id);
      
      const staffMap: Record<string, any> = {};
      if (staffIds.length > 0) {
        const { data: staffMembers } = await this.supabase
          .from('staff_accounts')
          .select('id, full_name, email')
          .in('id', staffIds);
        
        staffMembers?.forEach((staff) => {
          staffMap[staff.id] = staff;
        });
      }

      const mappedMessages = messages.map((msg: any) => {
        if (msg.staff_id) {
          // Staff message
          const staff = staffMap[msg.staff_id];
          return {
            id: msg.id,
            message: msg.message,
            senderId: msg.staff_id,
            senderName: staff?.full_name || 'Customer Care',
            isAdminMessage: true,
            isStaffMessage: true,
            attachments: msg.attachments || [],
            createdAt: msg.created_at,
          };
        } else {
          // User message
          const senderProfile = userProfilesMap[msg.sender_id];
          return {
            id: msg.id,
            message: msg.message,
            senderId: msg.sender_id,
            senderName: senderProfile?.preferences?.fullName || senderProfile?.username || 'Unknown',
            isAdminMessage: msg.is_admin || false,
            isStaffMessage: false,
            attachments: msg.attachments || [],
            createdAt: msg.created_at,
          };
        }
      });

      return {
        id: disputeWithRelations.id,
        disputeCategory: disputeWithRelations.dispute_category,
        orderId: disputeWithRelations.order_id || undefined,
        escrowId: disputeWithRelations.escrow_id || undefined,
        disputantId: disputeWithRelations.disputant_id,
        respondentId: disputeWithRelations.respondent_id || undefined,
        disputeType: disputeWithRelations.dispute_type,
        status: disputeWithRelations.status,
        reason: disputeWithRelations.reason,
        description: disputeWithRelations.description,
        evidence: disputeWithRelations.evidence,
        resolution: disputeWithRelations.resolution,
        resolutionReason: disputeWithRelations.resolution_reason,
        resolutionAmount: disputeWithRelations.resolution_amount ? parseFloat(disputeWithRelations.resolution_amount) : undefined,
        resolvedBy: disputeWithRelations.resolved_by,
        resolvedAt: disputeWithRelations.resolved_at,
        createdAt: disputeWithRelations.created_at,
        updatedAt: disputeWithRelations.updated_at,
        order: order,
        messages: mappedMessages,
      };
    } catch (error) {
      this.logger.error('Error fetching dispute:', error);
      throw error;
    }
  }

  /**
   * Get all disputes for a user
   */
  async getUserDisputes(userId: string): Promise<Dispute[]> {
    try {
      const { data: disputes, error } = await this.supabase
        .from('disputes')
        .select(`
          *,
          orders(order_number)
        `)
        .or(`disputant_id.eq.${userId},respondent_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error('Failed to fetch user disputes:', error);
        return [];
      }

      return disputes?.map((d) => ({
        id: d.id,
        disputeCategory: d.dispute_category,
        orderId: d.order_id || undefined,
        escrowId: d.escrow_id || undefined,
        disputantId: d.disputant_id,
        respondentId: d.respondent_id || undefined,
        disputeType: d.dispute_type,
        status: d.status,
        reason: d.reason,
        description: d.description,
        evidence: d.evidence,
        resolution: d.resolution,
        resolutionReason: d.resolution_reason,
        resolutionAmount: d.resolution_amount ? parseFloat(d.resolution_amount) : undefined,
        resolvedBy: d.resolved_by,
        resolvedAt: d.resolved_at,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })) || [];
    } catch (error) {
      this.logger.error('Error fetching user disputes:', error);
      return [];
    }
  }

  /**
   * Resolve a dispute (admin action)
   */
  async resolveDispute(
    adminId: string,
    disputeId: string,
    resolveDisputeDto: ResolveDisputeDto,
  ): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log(`Admin ${adminId} resolving dispute ${disputeId}`);

      // 1. Fetch dispute with order details
      const { data: dispute, error: fetchError } = await this.supabase
        .from('disputes')
        .select(`
          *,
          orders!inner(
            id,
            order_number,
            buyer_id,
            vendor_id,
            rider_id
          ),
          escrows!inner(
            id,
            total_amount,
            vendor_amount,
            rider_amount,
            status
          )
        `)
        .eq('id', disputeId)
        .single();

      if (fetchError || !dispute) {
        throw new HttpException('Dispute not found', HttpStatus.NOT_FOUND);
      }

      if (dispute.status === 'resolved') {
        throw new HttpException('Dispute has already been resolved', HttpStatus.BAD_REQUEST);
      }

      const order = dispute.orders;
      const escrow = dispute.escrows;

      // 2. Execute resolution based on decision
      switch (resolveDisputeDto.resolution) {
        case 'refund_buyer':
          // Full refund to buyer
          await this.escrowService.refundEscrow(escrow.id, resolveDisputeDto.resolutionReason);
          break;

        case 'partial_refund':
          // Partial refund logic (credit buyer partial amount, release rest to vendor)
          if (!resolveDisputeDto.resolutionAmount) {
            throw new HttpException('Resolution amount required for partial refund', HttpStatus.BAD_REQUEST);
          }
          await this.escrowService.partialRefundEscrow(
            escrow.id,
            resolveDisputeDto.resolutionAmount,
            resolveDisputeDto.resolutionReason,
          );
          break;

        case 'release_to_vendor':
          // Release escrow to vendor
          await this.escrowService.releaseEscrow(escrow.id, resolveDisputeDto.resolutionReason);
          break;

        case 'split_amount':
          // Split escrow between parties (buyer gets resolutionAmount, vendor gets rest)
          if (!resolveDisputeDto.resolutionAmount) {
            throw new HttpException('Resolution amount required for split amount', HttpStatus.BAD_REQUEST);
          }
          await this.escrowService.splitEscrowAmount(
            escrow.id,
            resolveDisputeDto.resolutionAmount,
            resolveDisputeDto.resolutionReason,
          );
          break;

        case 'no_action':
          // Keep escrow held, requires manual intervention
          this.logger.log('No action taken on escrow, awaiting further review');
          break;
      }

      // 3. Update dispute status
      const { error: updateError } = await this.supabase
        .from('disputes')
        .update({
          status: 'resolved',
          resolution: resolveDisputeDto.resolution,
          resolution_reason: resolveDisputeDto.resolutionReason,
          resolution_amount: resolveDisputeDto.resolutionAmount,
          resolved_by: adminId,
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', disputeId);

      if (updateError) {
        this.logger.error('Failed to update dispute status:', updateError);
      }

      // 4. Notify all parties
      try {
        await this.notificationHelper.notifyDisputeResolved(
          dispute.disputant_id,
          order.order_number,
          resolveDisputeDto.resolution,
          dispute.id,
        );

        await this.notificationHelper.notifyDisputeResolved(
          dispute.respondent_id,
          order.order_number,
          resolveDisputeDto.resolution,
          dispute.id,
        );
      } catch (notifyError) {
        this.logger.warn('Failed to send resolution notifications (non-critical):', notifyError);
      }

      this.logger.log(`✅ Dispute ${disputeId} resolved: ${resolveDisputeDto.resolution}`);

      return {
        success: true,
        message: `Dispute resolved: ${resolveDisputeDto.resolution}`,
      };
    } catch (error) {
      this.logger.error('Error resolving dispute:', error);
      throw error;
    }
  }

  /**
   * Add a message to a dispute thread
   */
  async addDisputeMessage(
    userId: string,
    disputeId: string,
    message: string,
    attachments?: Array<{ type: string; url: string }>,
  ): Promise<{ success: boolean; messageId: string }> {
    try {
      // Verify user is involved in dispute
      const { data: dispute } = await this.supabase
        .from('disputes')
        .select('disputant_id, respondent_id')
        .eq('id', disputeId)
        .single();

      if (!dispute) {
        throw new HttpException('Dispute not found', HttpStatus.NOT_FOUND);
      }

      const isInvolved = dispute.disputant_id === userId || 
                        (dispute.respondent_id && dispute.respondent_id === userId);
      
      if (!isInvolved) {
        // Check if user is admin
        const { data: profile } = await this.supabase
          .from('user_profiles')
          .select('role, preferences')
          .eq('id', userId)
          .single();
        
        const isAdmin = profile?.role === 'admin' || profile?.preferences?.isAdmin === true;
        
        if (!isAdmin) {
          throw new HttpException('You are not authorized to message this dispute', HttpStatus.FORBIDDEN);
        }
      }

      // Create message
      const { data: messageData, error } = await this.supabase
        .from('dispute_messages')
        .insert({
          dispute_id: disputeId,
          sender_id: userId,
          message,
          attachments: attachments || [],
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        throw new HttpException('Failed to send message', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // Notify the other party (if respondent exists)
      if (dispute.respondent_id) {
        const recipientId = userId === dispute.disputant_id ? dispute.respondent_id : dispute.disputant_id;
        try {
          await this.notificationHelper.notifyDisputeMessage(recipientId, disputeId);
        } catch (notifyError) {
          this.logger.warn('Failed to send message notification (non-critical):', notifyError);
        }
      }

      // Broadcast real-time message update
      try {
        const messagePayload = {
          id: messageData.id,
          disputeId: disputeId,
          senderId: userId,
          message: message,
          attachments: attachments || [],
          createdAt: messageData.created_at,
        };
        await this.realtimeGateway.notifyDisputeMessage(disputeId, messagePayload, userId);
      } catch (realtimeError) {
        this.logger.warn('Failed to broadcast real-time message update (non-critical):', realtimeError);
      }

      return {
        success: true,
        messageId: messageData.id,
      };
    } catch (error) {
      this.logger.error('Error adding dispute message:', error);
      throw error;
    }
  }

  /**
   * Get all open disputes (admin view)
   */
  async getAllOpenDisputes(): Promise<Dispute[]> {
    try {
      const { data: disputes, error } = await this.supabase
        .from('disputes')
        .select(`
          *,
          orders(order_number, status, total_amount)
        `)
        .in('status', ['open', 'under_review', 'awaiting_info'])
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error('Failed to fetch open disputes:', error);
        return [];
      }

      return disputes?.map((d) => ({
        id: d.id,
        disputeCategory: d.dispute_category,
        orderId: d.order_id || undefined,
        escrowId: d.escrow_id || undefined,
        disputantId: d.disputant_id,
        respondentId: d.respondent_id || undefined,
        disputeType: d.dispute_type,
        status: d.status,
        reason: d.reason,
        description: d.description,
        evidence: d.evidence,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      })) || [];
    } catch (error) {
      this.logger.error('Error fetching open disputes:', error);
      return [];
    }
  }
}

