import { Injectable, Logger, HttpException, HttpStatus, forwardRef, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConnectionsService } from '../connections/connections.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';
import { PartnersWalletService } from '../partners/partners-wallet.service';
import { GiftCardService } from '../gift-cards/gift-cards.service';

export interface EscrowBreakdown {
  totalAmount: number;
  vendorAmount: number;
  riderAmount: number;
  platformAmount: number;
  paymentSource?: string;
  giftCardAmount?: number;
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
    private walletService: WalletService,
    private partnersWalletService: PartnersWalletService,
    @Optional()
    @Inject(forwardRef(() => GiftCardService))
    private giftCardService?: GiftCardService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Create escrow for an order
   */
  async createEscrow(orderId: string, breakdown: EscrowBreakdown): Promise<Escrow> {
    try {
      this.logger.log(`Creating escrow for order ${orderId}`);

      // ✅ FIX Bug 18: Validate breakdown amounts sum correctly
      const sum = breakdown.vendorAmount + breakdown.riderAmount + breakdown.platformAmount;
      const difference = Math.abs(sum - breakdown.totalAmount);
      if (difference > 0.000001) {
        this.logger.error(`Invalid escrow breakdown for order ${orderId}: amounts sum to ${sum} but total is ${breakdown.totalAmount}`);
        throw new HttpException(
          `Invalid escrow breakdown: amounts sum to ${sum.toFixed(6)} but total is ${breakdown.totalAmount.toFixed(6)}`,
          HttpStatus.BAD_REQUEST
        );
      }

      const { data: escrow, error } = await this.supabase
        .from('escrows')
        .insert({
          order_id: orderId,
          total_amount: breakdown.totalAmount,
          vendor_amount: breakdown.vendorAmount,
          rider_amount: breakdown.riderAmount,
          platform_amount: breakdown.platformAmount,
          payment_source: breakdown.paymentSource || 'wallet',
          gift_card_amount: breakdown.giftCardAmount || 0,
          status: 'held', // Immediately held after payment
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        // ✅ FIX Bug 21: Better duplicate escrow error handling
        if (error.code === '23505') { // PostgreSQL unique constraint violation
          this.logger.warn(`Escrow already exists for order ${orderId}`);
          throw new HttpException('Escrow already exists for this order', HttpStatus.CONFLICT);
        }
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
  async releaseEscrow(escrowId: string, reason: string, userId?: string): Promise<void> {
    try {
      this.logger.log(`Releasing escrow ${escrowId}: ${reason}`);

      // ✅ PHASE 1: Use atomic database function with row-level locking to prevent race conditions
      // This function locks the escrow row, validates authorization/status, and atomically updates status
      const { data: atomicResult, error: atomicError } = await this.supabase
        .rpc('release_escrow_atomic', {
          p_escrow_id: escrowId,
          p_reason: reason,
          p_user_id: userId || null,
        });

      if (atomicError) {
        this.logger.error('Atomic escrow release RPC error:', atomicError);
        throw new HttpException(
          `Failed to release escrow: ${atomicError.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!atomicResult || !atomicResult.success) {
        const errorCode = atomicResult?.error_code || 'UNKNOWN';
        const errorMessage = atomicResult?.error || 'Escrow release failed';
        const sqlErrorMessage = atomicResult?.error_message || null; // SQLERRM from database function
        
        // Log detailed error information
        this.logger.error(`Escrow release failed for ${escrowId}:`, {
          errorCode,
          errorMessage,
          sqlErrorMessage,
          userId: userId || 'system',
          reason,
          fullResult: atomicResult
        });
        
        // Map error codes to appropriate HTTP status codes
        if (errorCode === 'ESCROW_NOT_FOUND') {
          throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
        } else if (errorCode === 'UNAUTHORIZED') {
          throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
        } else if (errorCode === 'ORDER_CANCELLED' || errorCode === 'ORDER_NOT_DELIVERED') {
          throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
        } else if (errorCode === 'STATUS_CHANGED') {
          throw new HttpException(errorMessage, HttpStatus.CONFLICT);
        } else if (errorCode === 'INTERNAL_ERROR') {
          // INTERNAL_ERROR means an exception occurred in the database function
          // Include the SQL error message if available
          const detailedMessage = sqlErrorMessage 
            ? `${errorMessage}: ${sqlErrorMessage}`
            : errorMessage;
          this.logger.error(`Database error during escrow release: ${sqlErrorMessage || 'No SQL error details available'}`);
          throw new HttpException(detailedMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        } else {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      // Extract escrow and order data from atomic function result
      const escrowData = atomicResult.escrow;
      const orderData = atomicResult.order;

      this.logger.log(`✅ Escrow ${escrowId} locked and status updated atomically`);

      // ✅ ALL MONEY MOVED INSIDE release_escrow_atomic: vendor credit,
      // rider/partner credit, platform commission, and buyer escrow debit
      // are now all executed inside the same Postgres transaction as the
      // escrow status update. No multi-call saga remains here.

      // ✅ PHASE 3: Update order status and handle post-release tasks
      // 4. Update order status to completed (only if not already cancelled) - ✅ FIX Bug 14
      const { error: orderUpdateError } = await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderData.id)
        .neq('status', 'cancelled'); // Don't overwrite cancelled status

      if (orderUpdateError) {
        this.logger.warn(`⚠️ Failed to update order status to completed: ${orderUpdateError.message}`);
        // Don't throw - escrow release already succeeded
      }

      // 🔥 FIX: Update gift_orders status if this is a gift order
      // Fetch order source from the order we already have data for
      const { data: fullOrderData } = await this.supabase
        .from('orders')
        .select('source, metadata')
        .eq('id', orderData.id)
        .single();

      if (fullOrderData?.source === 'wishlist' && fullOrderData.metadata?.wishlist_item_id) {
        try {
          await this.supabase
            .from('gift_orders')
            .update({
              status: 'delivered',
              updated_at: new Date().toISOString(),
            })
            .eq('order_id', orderData.id);
          this.logger.log(`✅ Gift order status updated to delivered`);
        } catch (error) {
          this.logger.error('Failed to update gift_orders status (non-critical):', error);
          // Don't throw - gift_orders update is not critical to escrow release
        }
      }

      // 5. Send notifications
      await this.notificationHelper.notifyVendorEscrowReleased(
        orderData.vendor_id,
        parseFloat(escrowData.vendor_amount),
        orderData.order_number,
      );

      if (orderData.rider_id) {
        await this.notificationHelper.notifyRiderPaymentReleased(
          orderData.rider_id,
          parseFloat(escrowData.rider_amount),
          orderData.order_number,
        );
      }

      // 6. Broadcast real-time wallet updates (balance will be fetched by client)
      await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.vendor_id, {
        availableBalance: 0, // Client will fetch actual balance
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'escrow_release',
      });

      if (orderData.rider_id) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.rider_id, {
          availableBalance: 0,
          escrowBalance: 0,
          pendingWithdrawal: 0,
          totalBalance: 0,
          transactionType: 'delivery_payment',
        });
      }

      // 7. Update client relationship
      try {
        await this.connectionsService.createClientRelationship(orderData.vendor_id, {
          clientId: orderData.buyer_id,
          relationshipType: 'customer',
          totalOrders: 1,
          totalSpent: parseFloat(escrowData.total_amount),
        });
        this.logger.log(`✅ Updated client relationship for vendor ${orderData.vendor_id}`);
      } catch (error: any) {
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
   *
   * ✅ ATOMIC FIX: All wallet and gift-card reversal movements plus the
   * escrow status update are now handled inside refund_escrow_atomic() in
   * one Postgres transaction. This eliminates the previous race condition
   * where the wallet could be refunded and then the escrow status update
   * could fail, making a second refund possible.
   */
  async refundEscrow(escrowId: string, reason: string, userId?: string): Promise<void> {
    try {
      this.logger.log(`Refunding escrow ${escrowId}: ${reason}`);

      const adminGiftWalletId = this.configService.get<string>(
        'PLATFORM_GIFT_WALLET_USER_ID',
        '00000000-0000-4000-8000-000000000003'
      );

      const { data: refundResult, error: refundRpcError } = await this.supabase.rpc(
        'refund_escrow_atomic',
        {
          p_escrow_id: escrowId,
          p_reason: reason,
          p_admin_gift_user_id: adminGiftWalletId,
          p_user_id: userId || null,
        }
      );

      if (refundRpcError) {
        this.logger.error('refund_escrow_atomic RPC error:', refundRpcError);
        throw new HttpException(
          `Failed to refund escrow: ${refundRpcError.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!refundResult || !refundResult.success) {
        const errorCode = refundResult?.error_code || 'UNKNOWN';
        const errorMessage = refundResult?.error || 'Refund failed';

        if (errorCode === 'ESCROW_NOT_FOUND') {
          throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
        } else if (errorCode === 'UNAUTHORIZED') {
          throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
        } else if (errorCode === 'INTERNAL_ERROR') {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        } else {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      const orderData = refundResult.order;

      // Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderData.id);

      // Notify buyer
      await this.notificationHelper.notifyOrderRefunded(
        orderData.buyer_id,
        parseFloat(refundResult.escrow.total_amount),
        orderData.order_number,
        reason,
      );

      // Broadcast real-time update
      await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.buyer_id, {
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
   * Partial refund - refund buyer partial amount, release rest to vendor
   *
   * ✅ ATOMIC FIX: All wallet/partner credits, the buyer refund, and the
   * escrow status update are now handled in one Postgres transaction by
   * partial_refund_escrow_atomic().
   */
  async partialRefundEscrow(
    escrowId: string,
    refundAmount: number,
    reason: string,
  ): Promise<void> {
    try {
      this.logger.log(`Processing partial refund for escrow ${escrowId}: ₣${refundAmount}`);

      const { data: partialResult, error: partialRpcError } = await this.supabase.rpc(
        'partial_refund_escrow_atomic',
        {
          p_escrow_id: escrowId,
          p_refund_amount: refundAmount,
          p_reason: reason,
        }
      );

      if (partialRpcError) {
        this.logger.error('partial_refund_escrow_atomic RPC error:', partialRpcError);
        throw new HttpException(
          `Failed to process partial refund: ${partialRpcError.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!partialResult || !partialResult.success) {
        const errorCode = partialResult?.error_code || 'UNKNOWN';
        const errorMessage = partialResult?.error || 'Partial refund failed';

        if (errorCode === 'ESCROW_NOT_FOUND') {
          throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
        } else if (errorCode === 'UNAUTHORIZED') {
          throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
        } else if (errorCode === 'INVALID_REFUND_AMOUNT' || errorCode === 'REFUND_EXCEEDS_TOTAL') {
          throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
        } else {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      const orderData = partialResult.order;

      // Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderData.id);

      // Send notifications
      await this.notificationHelper.notifyOrderRefunded(
        orderData.buyer_id,
        partialResult.escrow.refunded_amount,
        orderData.order_number,
        `Partial refund: ${reason}`,
      );

      await this.notificationHelper.notifyVendorEscrowReleased(
        orderData.vendor_id,
        partialResult.escrow.vendor_released,
        orderData.order_number,
      );

      // Broadcast real-time updates
      await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.buyer_id, {
        availableBalance: 0,
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'refund',
      });

      await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.vendor_id, {
        availableBalance: 0,
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'escrow_release',
      });

      this.logger.log(`✅ Partial refund completed for escrow ${escrowId}`);
    } catch (error) {
      this.logger.error('Error processing partial refund:', error);
      throw error;
    }
  }

  /**
   * Split escrow amount between buyer and vendor
   *
   * ✅ ATOMIC FIX: All wallet/partner credits, the buyer refund, and the
   * escrow status update are now handled in one Postgres transaction by
   * split_escrow_amount_atomic().
   */
  async splitEscrowAmount(
    escrowId: string,
    buyerAmount: number,
    reason: string,
  ): Promise<void> {
    try {
      this.logger.log(`Splitting escrow ${escrowId}: Buyer gets ₣${buyerAmount}`);

      const { data: splitResult, error: splitRpcError } = await this.supabase.rpc(
        'split_escrow_amount_atomic',
        {
          p_escrow_id: escrowId,
          p_buyer_amount: buyerAmount,
          p_reason: reason,
        }
      );

      if (splitRpcError) {
        this.logger.error('split_escrow_amount_atomic RPC error:', splitRpcError);
        throw new HttpException(
          `Failed to split escrow: ${splitRpcError.message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      if (!splitResult || !splitResult.success) {
        const errorCode = splitResult?.error_code || 'UNKNOWN';
        const errorMessage = splitResult?.error || 'Split resolution failed';

        if (errorCode === 'ESCROW_NOT_FOUND') {
          throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
        } else if (errorCode === 'UNAUTHORIZED') {
          throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
        } else if (errorCode === 'INVALID_BUYER_AMOUNT' || errorCode === 'AMOUNT_EXCEEDS_TOTAL') {
          throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
        } else {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      const orderData = splitResult.order;

      // Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderData.id);

      // Send notifications
      if (splitResult.escrow.buyer_amount > 0) {
        await this.notificationHelper.notifyOrderRefunded(
          orderData.buyer_id,
          splitResult.escrow.buyer_amount,
          orderData.order_number,
          `Split resolution: ${reason}`,
        );
      }

      if (splitResult.escrow.vendor_released > 0) {
        await this.notificationHelper.notifyVendorEscrowReleased(
          orderData.vendor_id,
          splitResult.escrow.vendor_released,
          orderData.order_number,
        );
      }

      // Broadcast real-time updates
      if (splitResult.escrow.buyer_amount > 0) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.buyer_id, {
          availableBalance: 0,
          escrowBalance: 0,
          pendingWithdrawal: 0,
          totalBalance: 0,
          transactionType: 'refund',
        });
      }

      if (splitResult.escrow.vendor_released > 0) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(orderData.vendor_id, {
          availableBalance: 0,
          escrowBalance: 0,
          pendingWithdrawal: 0,
          totalBalance: 0,
          transactionType: 'escrow_release',
        });
      }

      this.logger.log(`✅ Split resolution completed for escrow ${escrowId}`);
    } catch (error) {
      this.logger.error('Error processing split resolution:', error);
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
          auto_release_at: null, // ✅ Clear auto-release timer when disputing
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

      // Check for escrows without auto_release_at (shouldn't happen after fix, but log for visibility)
      const { data: escrowsWithoutTimer, error: checkError } = await this.supabase
        .from('escrows')
        .select('id, order_id, created_at')
        .eq('status', 'held')
        .is('auto_release_at', null);

      if (!checkError && escrowsWithoutTimer && escrowsWithoutTimer.length > 0) {
        this.logger.warn(
          `⚠️ Found ${escrowsWithoutTimer.length} escrow(s) in 'held' status without auto_release_at. ` +
          `These may be older escrows created before the fix. Escrow IDs: ${escrowsWithoutTimer.map(e => e.id).join(', ')}`
        );
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

