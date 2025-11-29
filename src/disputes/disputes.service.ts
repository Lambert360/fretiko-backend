import { Injectable, Logger, HttpException, HttpStatus, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface CreateDisputeDto {
  orderId: string;
  disputeType: 'item_not_received' | 'item_not_as_described' | 'damaged_item' | 'wrong_item' | 'refund_request' | 'quality_issue' | 'delivery_issue' | 'other';
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
  orderId: string;
  escrowId: string;
  disputantId: string;
  respondentId: string;
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
   * Create a new dispute for an order
   */
  async createDispute(userId: string, createDisputeDto: CreateDisputeDto): Promise<Dispute> {
    try {
      this.logger.log(`Creating dispute for order ${createDisputeDto.orderId} by user ${userId}`);

      // 1. Fetch order details
      const { data: order, error: orderError } = await this.supabase
        .from('orders')
        .select('id, order_number, status, buyer_id, vendor_id, rider_id, created_at, updated_at')
        .eq('id', createDisputeDto.orderId)
        .single();

      if (orderError || !order) {
        throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
      }

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
      const { data: escrow, error: escrowError } = await this.supabase
        .from('escrows')
        .select('id, status, total_amount')
        .eq('order_id', createDisputeDto.orderId)
        .single();

      if (escrowError || !escrow) {
        throw new HttpException('No escrow found for this order', HttpStatus.NOT_FOUND);
      }

      if (escrow.status !== 'held') {
        throw new HttpException(
          `Escrow has already been ${escrow.status}. Disputes can only be filed for held escrows.`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // 6. Determine respondent (the other party)
      let respondentId: string;
      if (userId === order.buyer_id) {
        respondentId = order.vendor_id;
      } else if (userId === order.vendor_id) {
        respondentId = order.buyer_id;
      } else {
        respondentId = order.vendor_id; // Rider disputes vendor
      }

      // 7. Create dispute record
      const { data: dispute, error: disputeError } = await this.supabase
        .from('disputes')
        .insert({
          order_id: createDisputeDto.orderId,
          escrow_id: escrow.id,
          disputant_id: userId,
          respondent_id: respondentId,
          dispute_type: createDisputeDto.disputeType,
          status: 'open',
          reason: createDisputeDto.reason,
          description: createDisputeDto.description,
          priority: createDisputeDto.priority || 'medium',
          evidence: createDisputeDto.evidence || [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (disputeError) {
        this.logger.error('Failed to create dispute:', disputeError);
        throw new HttpException('Failed to create dispute', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // 8. Update escrow status to 'dispute'
      await this.escrowService.disputeEscrow(escrow.id, createDisputeDto.reason, userId);

      // 9. Send notifications to all parties
      try {
        // Notify respondent
        await this.notificationHelper.notifyDisputeFiled(
          respondentId,
          order.order_number,
          createDisputeDto.disputeType,
          dispute.id,
        );

        // Notify admin (TODO: implement admin notification)
        this.logger.log(`Admin notification needed for dispute ${dispute.id}`);
      } catch (notifyError) {
        this.logger.warn('Failed to send dispute notifications (non-critical):', notifyError);
      }

      this.logger.log(`✅ Dispute ${dispute.id} created for order ${order.order_number}`);

      return {
        id: dispute.id,
        orderId: dispute.order_id,
        escrowId: dispute.escrow_id,
        disputantId: dispute.disputant_id,
        respondentId: dispute.respondent_id,
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
  async getDispute(userId: string, disputeId: string): Promise<Dispute & { order: any; messages: any[] }> {
    try {
      const { data: dispute, error } = await this.supabase
        .from('disputes')
        .select(`
          *,
          orders!inner(
            id,
            order_number,
            status,
            total_amount,
            buyer_id,
            vendor_id,
            rider_id
          ),
          dispute_messages(
            id,
            message,
            sender_id,
            staff_id,
            is_admin,
            attachments,
            created_at
          )
        `)
        .eq('id', disputeId)
        .single();

      if (error || !dispute) {
        throw new HttpException('Dispute not found', HttpStatus.NOT_FOUND);
      }

      // Verify user is involved
      if (![dispute.disputant_id, dispute.respondent_id].includes(userId)) {
        throw new HttpException('You are not authorized to view this dispute', HttpStatus.FORBIDDEN);
      }

      // Map messages with sender information
      const messageSenderIds = (dispute.dispute_messages || [])
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
      const staffIds = (dispute.dispute_messages || [])
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

      const mappedMessages = (dispute.dispute_messages || []).map((msg: any) => {
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
        id: dispute.id,
        orderId: dispute.order_id,
        escrowId: dispute.escrow_id,
        disputantId: dispute.disputant_id,
        respondentId: dispute.respondent_id,
        disputeType: dispute.dispute_type,
        status: dispute.status,
        reason: dispute.reason,
        description: dispute.description,
        evidence: dispute.evidence,
        resolution: dispute.resolution,
        resolutionReason: dispute.resolution_reason,
        resolutionAmount: dispute.resolution_amount ? parseFloat(dispute.resolution_amount) : undefined,
        resolvedBy: dispute.resolved_by,
        resolvedAt: dispute.resolved_at,
        createdAt: dispute.created_at,
        updatedAt: dispute.updated_at,
        order: dispute.orders,
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
          orders!inner(order_number)
        `)
        .or(`disputant_id.eq.${userId},respondent_id.eq.${userId}`)
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error('Failed to fetch user disputes:', error);
        return [];
      }

      return disputes?.map((d) => ({
        id: d.id,
        orderId: d.order_id,
        escrowId: d.escrow_id,
        disputantId: d.disputant_id,
        respondentId: d.respondent_id,
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
          // TODO: Implement partial refund logic
          this.logger.warn('Partial refund not yet fully implemented');
          break;

        case 'release_to_vendor':
          // Release escrow to vendor
          await this.escrowService.releaseEscrow(escrow.id, resolveDisputeDto.resolutionReason);
          break;

        case 'split_amount':
          // Split escrow between parties
          if (!resolveDisputeDto.resolutionAmount) {
            throw new HttpException('Resolution amount required for split amount', HttpStatus.BAD_REQUEST);
          }
          // TODO: Implement split amount logic
          this.logger.warn('Split amount not yet fully implemented');
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

      if (!dispute || ![dispute.disputant_id, dispute.respondent_id].includes(userId)) {
        throw new HttpException('You are not authorized to message this dispute', HttpStatus.FORBIDDEN);
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

      // Notify the other party
      const recipientId = userId === dispute.disputant_id ? dispute.respondent_id : dispute.disputant_id;
      try {
        await this.notificationHelper.notifyDisputeMessage(recipientId, disputeId);
      } catch (notifyError) {
        this.logger.warn('Failed to send message notification (non-critical):', notifyError);
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
          orders!inner(order_number, status, total_amount)
        `)
        .in('status', ['open', 'under_review', 'awaiting_info'])
        .order('created_at', { ascending: false });

      if (error) {
        this.logger.error('Failed to fetch open disputes:', error);
        return [];
      }

      return disputes?.map((d) => ({
        id: d.id,
        orderId: d.order_id,
        escrowId: d.escrow_id,
        disputantId: d.disputant_id,
        respondentId: d.respondent_id,
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

