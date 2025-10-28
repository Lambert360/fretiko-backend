import { Injectable, Logger, HttpException, HttpStatus, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConnectionsService } from '../connections/connections.service';

export interface EscrowBreakdown {
  totalAmount: number;
  vendorAmount: number;
  riderAmount: number;
  platformAmount: number;
}

export interface Escrow {
  id: string;
  orderId: string;
  totalAmount: number;
  vendorAmount: number;
  riderAmount: number;
  platformAmount: number;
  status: 'pending' | 'held' | 'released' | 'refunded' | 'cancelled' | 'dispute';
  autoReleaseAt?: string;
  releasedAt?: string;
  releaseReason?: string;
  refundReason?: string;
  disputeReason?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway,
    @Inject(forwardRef(() => ConnectionsService))
    private connectionsService: ConnectionsService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create escrow for an order
   */
  async createEscrow(orderId: string, breakdown: EscrowBreakdown): Promise<Escrow> {
    try {
      this.logger.log(`Creating escrow for order ${orderId}`);

      const { data: escrow, error } = await this.supabase
        .from('escrows')
        .insert({
          order_id: orderId,
          total_amount: breakdown.totalAmount,
          vendor_amount: breakdown.vendorAmount,
          rider_amount: breakdown.riderAmount,
          platform_amount: breakdown.platformAmount,
          status: 'held', // Immediately held after payment
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create escrow for order ${orderId}:`, error);
        throw new HttpException('Failed to create escrow', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      this.logger.log(`✅ Escrow created for order ${orderId}: ₣${breakdown.totalAmount}`);

      return {
        id: escrow.id,
        orderId: escrow.order_id,
        totalAmount: parseFloat(escrow.total_amount),
        vendorAmount: parseFloat(escrow.vendor_amount),
        riderAmount: parseFloat(escrow.rider_amount),
        platformAmount: parseFloat(escrow.platform_amount),
        status: escrow.status,
        autoReleaseAt: escrow.auto_release_at,
        releasedAt: escrow.released_at,
        releaseReason: escrow.release_reason,
        refundReason: escrow.refund_reason,
        disputeReason: escrow.dispute_reason,
        createdAt: escrow.created_at,
        updatedAt: escrow.updated_at,
      };
    } catch (error) {
      this.logger.error('Error creating escrow:', error);
      throw error;
    }
  }

  /**
   * Release escrow funds to vendor and rider
   */
  async releaseEscrow(escrowId: string, reason: string): Promise<void> {
    try {
      this.logger.log(`Releasing escrow ${escrowId}: ${reason}`);

      // Fetch escrow with order details
      const { data: escrow, error: fetchError } = await this.supabase
        .from('escrows')
        .select(`
          *,
          orders!inner(
            id,
            order_number,
            buyer_id,
            vendor_id,
            rider_id
          )
        `)
        .eq('id', escrowId)
        .eq('status', 'held')
        .single();

      if (fetchError || !escrow) {
        throw new HttpException('Escrow not found or already released', HttpStatus.NOT_FOUND);
      }

      const order = escrow.orders;

      // 1. Credit vendor wallet using RPC function (escrow release)
      this.logger.log(`Crediting vendor ${order.vendor_id} with ₣${escrow.vendor_amount}`);
      const { error: vendorError } = await this.supabase.rpc('process_wallet_transaction', {
        p_user_id: order.vendor_id,
        p_transaction_type: 'escrow_release',
        p_amount: parseFloat(escrow.vendor_amount),
        p_description: `Escrow release for order ${order.order_number}`,
        p_reference_id: escrowId,
        p_reference_type: 'escrow',
      });

      if (vendorError) {
        this.logger.error('Failed to credit vendor wallet:', vendorError);
        throw new HttpException('Failed to credit vendor wallet', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // 1b. Create vendor sale transaction for sales tracking
      const { error: vendorSaleError } = await this.supabase.rpc('process_wallet_transaction', {
        p_user_id: order.vendor_id,
        p_transaction_type: 'vendor_sale',
        p_amount: parseFloat(escrow.vendor_amount),
        p_description: `Sale for order ${order.order_number}`,
        p_reference_id: order.id,
        p_reference_type: 'order',
      });

      if (vendorSaleError) {
        this.logger.error('Failed to create vendor sale transaction:', vendorSaleError);
        // Don't throw error - this is for tracking, not critical
      }

      // 2. Credit rider wallet (if applicable)
      if (order.rider_id && escrow.rider_amount > 0) {
        this.logger.log(`Crediting rider ${order.rider_id} with ₣${escrow.rider_amount}`);
        const { error: riderError } = await this.supabase.rpc('process_wallet_transaction', {
          p_user_id: order.rider_id,
          p_transaction_type: 'delivery_payment',
          p_amount: parseFloat(escrow.rider_amount),
          p_description: `Delivery fee for order ${order.order_number}`,
          p_reference_id: order.id,
          p_reference_type: 'order',
        });

        if (riderError) {
          this.logger.error('Failed to credit rider wallet:', riderError);
          // Don't throw - vendor already paid, log and continue
        }
      }

      // 3. Update escrow status
      const { error: updateError } = await this.supabase
        .from('escrows')
        .update({
          status: 'released',
          released_at: new Date().toISOString(),
          release_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId);

      if (updateError) {
        this.logger.error('Failed to update escrow status:', updateError);
      }

      // 4. Update order status to completed
      await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      // 5. Send notifications
      await this.notificationHelper.notifyVendorEscrowReleased(
        order.vendor_id,
        parseFloat(escrow.vendor_amount),
        order.order_number,
      );

      if (order.rider_id) {
        await this.notificationHelper.notifyRiderPaymentReleased(
          order.rider_id,
          parseFloat(escrow.rider_amount),
          order.order_number,
        );
      }

      // 6. Broadcast real-time wallet updates (balance will be fetched by client)
      await this.realtimeGateway.notifyWalletBalanceUpdate(order.vendor_id, {
        availableBalance: 0, // Client will fetch actual balance
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'escrow_release',
      });

      if (order.rider_id) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(order.rider_id, {
          availableBalance: 0,
          escrowBalance: 0,
          pendingWithdrawal: 0,
          totalBalance: 0,
          transactionType: 'delivery_payment',
        });
      }

      // 7. Update client relationship
      try {
        await this.connectionsService.createClientRelationship(order.vendor_id, {
          clientId: order.buyer_id,
          relationshipType: 'customer',
          totalOrders: 1,
          totalSpent: parseFloat(escrow.total_amount),
        });
        this.logger.log(`✅ Updated client relationship for vendor ${order.vendor_id}`);
      } catch (error) {
        this.logger.warn('⚠️ Failed to update client relationship (non-critical):', error.message);
        // This is non-critical - escrow release still succeeded
      }

      this.logger.log(`✅ Escrow ${escrowId} released successfully`);
    } catch (error) {
      this.logger.error('Error releasing escrow:', error);
      throw error;
    }
  }

  /**
   * Refund escrow to buyer
   */
  async refundEscrow(escrowId: string, reason: string): Promise<void> {
    try {
      this.logger.log(`Refunding escrow ${escrowId}: ${reason}`);

      // Fetch escrow with order details
      const { data: escrow, error: fetchError } = await this.supabase
        .from('escrows')
        .select(`
          *,
          orders!inner(
            id,
            order_number,
            buyer_id,
            vendor_id,
            rider_id
          )
        `)
        .eq('id', escrowId)
        .eq('status', 'held')
        .single();

      if (fetchError || !escrow) {
        throw new HttpException('Escrow not found or already processed', HttpStatus.NOT_FOUND);
      }

      const order = escrow.orders;

      // Credit buyer wallet (refund)
      this.logger.log(`Refunding buyer ${order.buyer_id} with ₣${escrow.total_amount}`);
      const { error: refundError } = await this.supabase.rpc('process_wallet_transaction', {
        p_user_id: order.buyer_id,
        p_transaction_type: 'refund',
        p_amount: parseFloat(escrow.total_amount),
        p_description: `Refund for order ${order.order_number}`,
        p_reference_id: order.id,
        p_reference_type: 'order',
      });

      if (refundError) {
        this.logger.error('Failed to refund buyer wallet:', refundError);
        throw new HttpException('Failed to process refund', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // Update escrow status
      await this.supabase
        .from('escrows')
        .update({
          status: 'refunded',
          refund_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId);

      // Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      // Notify buyer
      await this.notificationHelper.notifyOrderRefunded(
        order.buyer_id,
        parseFloat(escrow.total_amount),
        order.order_number,
        reason,
      );

      // Broadcast real-time update
      await this.realtimeGateway.notifyWalletBalanceUpdate(order.buyer_id, {
        availableBalance: 0,
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'refund',
      });

      this.logger.log(`✅ Escrow ${escrowId} refunded successfully`);
    } catch (error) {
      this.logger.error('Error refunding escrow:', error);
      throw error;
    }
  }

  /**
   * Mark escrow as disputed
   */
  async disputeEscrow(escrowId: string, reason: string, disputantId: string): Promise<void> {
    try {
      this.logger.log(`Marking escrow ${escrowId} as disputed by ${disputantId}`);

      const { error } = await this.supabase
        .from('escrows')
        .update({
          status: 'dispute',
          dispute_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId)
        .eq('status', 'held');

      if (error) {
        throw new HttpException('Failed to mark escrow as disputed', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      this.logger.log(`✅ Escrow ${escrowId} marked as disputed`);
      // TODO: Create dispute record in disputes table
      // TODO: Notify admin for resolution
    } catch (error) {
      this.logger.error('Error disputing escrow:', error);
      throw error;
    }
  }

  /**
   * Auto-release escrows that have passed their auto-release time
   */
  async autoReleaseEscrows(): Promise<number> {
    try {
      this.logger.log('🕐 Checking for escrows ready for auto-release...');

      // Find escrows ready for auto-release
      const { data: escrows, error } = await this.supabase
        .from('escrows')
        .select('id, auto_release_at')
        .eq('status', 'held')
        .not('auto_release_at', 'is', null)
        .lte('auto_release_at', new Date().toISOString());

      if (error) {
        this.logger.error('Failed to fetch escrows for auto-release:', error);
        return 0;
      }

      if (!escrows || escrows.length === 0) {
        this.logger.log('No escrows ready for auto-release');
        return 0;
      }

      this.logger.log(`Found ${escrows.length} escrow(s) ready for auto-release`);

      // Release each escrow
      let releasedCount = 0;
      for (const escrow of escrows) {
        try {
          await this.releaseEscrow(escrow.id, 'Auto-released after delivery confirmation period');
          releasedCount++;
        } catch (error) {
          this.logger.error(`Failed to auto-release escrow ${escrow.id}:`, error);
        }
      }

      this.logger.log(`✅ Auto-released ${releasedCount}/${escrows.length} escrows`);
      return releasedCount;
    } catch (error) {
      this.logger.error('Error in auto-release process:', error);
      return 0;
    }
  }

  /**
   * Get pending escrows for a user (as vendor or rider)
   */
  async getEscrowsByUser(
    userId: string,
    role: 'vendor' | 'rider',
  ): Promise<{ escrows: Escrow[]; totalAmount: number }> {
    try {
      const column = role === 'vendor' ? 'vendor_id' : 'rider_id';
      const amountColumn = role === 'vendor' ? 'vendor_amount' : 'rider_amount';

      const { data: escrows, error } = await this.supabase
        .from('escrows')
        .select(`
          *,
          orders!inner(
            id,
            order_number,
            ${column}
          )
        `)
        .eq(`orders.${column}`, userId)
        .eq('status', 'held');

      if (error) {
        this.logger.error(`Failed to fetch ${role} escrows:`, error);
        return { escrows: [], totalAmount: 0 };
      }

      const formattedEscrows = escrows?.map((e) => ({
        id: e.id,
        orderId: e.order_id,
        totalAmount: parseFloat(e.total_amount),
        vendorAmount: parseFloat(e.vendor_amount),
        riderAmount: parseFloat(e.rider_amount),
        platformAmount: parseFloat(e.platform_amount),
        status: e.status,
        autoReleaseAt: e.auto_release_at,
        releasedAt: e.released_at,
        releaseReason: e.release_reason,
        refundReason: e.refund_reason,
        disputeReason: e.dispute_reason,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })) || [];

      const totalAmount = escrows?.reduce((sum, e) => sum + parseFloat(e[amountColumn] || 0), 0) || 0;

      return {
        escrows: formattedEscrows,
        totalAmount,
      };
    } catch (error) {
      this.logger.error('Error fetching user escrows:', error);
      return { escrows: [], totalAmount: 0 };
    }
  }
}

