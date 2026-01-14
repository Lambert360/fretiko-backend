import { Injectable, Logger, HttpException, HttpStatus, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ConnectionsService } from '../connections/connections.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletTransactionType } from '../wallet/constants/transaction-types';

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
    private walletService: WalletService,
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
        
        this.logger.warn(`Escrow release failed: ${errorMessage} (code: ${errorCode})`);
        
        // Map error codes to appropriate HTTP status codes
        if (errorCode === 'ESCROW_NOT_FOUND') {
          throw new HttpException(errorMessage, HttpStatus.NOT_FOUND);
        } else if (errorCode === 'UNAUTHORIZED') {
          throw new HttpException(errorMessage, HttpStatus.FORBIDDEN);
        } else if (errorCode === 'ORDER_CANCELLED' || errorCode === 'ORDER_NOT_DELIVERED') {
          throw new HttpException(errorMessage, HttpStatus.BAD_REQUEST);
        } else if (errorCode === 'STATUS_CHANGED') {
          throw new HttpException(errorMessage, HttpStatus.CONFLICT);
        } else {
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      }

      // Extract escrow and order data from atomic function result
      const escrowData = atomicResult.escrow;
      const orderData = atomicResult.order;

      this.logger.log(`✅ Escrow ${escrowId} locked and status updated atomically`);

      // ✅ PHASE 2: Process wallet transactions (escrow is already released, preventing duplicate processing)
      // Even if called concurrently, only one will succeed due to atomic lock, others will get ESCROW_NOT_FOUND

      // 1. Credit vendor wallet using RPC function (escrow release)
      this.logger.log(`Crediting vendor ${orderData.vendor_id} with ₣${escrowData.vendor_amount}`);
      const vendorResult = await this.walletService.processWalletTransaction(
        orderData.vendor_id,
        WalletTransactionType.ESCROW_RELEASE,
        parseFloat(escrowData.vendor_amount),
        `Escrow release for order ${orderData.order_number}`,
        orderData.id,
        'order',
      );

      if (!vendorResult.success) {
        this.logger.error('❌ CRITICAL: Failed to credit vendor wallet after escrow status update:', vendorResult.error);
        // ⚠️ Escrow status is already 'released', but vendor payment failed
        // This requires manual reconciliation - log critical alert
        this.logger.error(`🚨 CRITICAL RECONCILIATION REQUIRED: Escrow ${escrowId} status is 'released' but vendor payment failed. Manual intervention required.`);
        throw new HttpException(
          `Escrow released but vendor payment failed: ${vendorResult.error}. Manual reconciliation required.`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // ✅ PHASE 2: Log idempotent transaction detection (shouldn't happen with atomic lock, but log for monitoring)
      if (vendorResult.idempotent) {
        this.logger.warn(
          `⚠️ IDEMPOTENT: Vendor payment for escrow ${escrowId} was idempotent (duplicate prevented). This suggests a concurrent release attempt was detected and prevented.`
        );
      }

      // Note: Sales tracking is already handled internally by 'escrow_release' transaction type
      // in the process_wallet_transaction RPC function (see add-sales-tracking.sql migration)

      // 2. Credit rider wallet (if applicable)
      if (orderData.rider_id && escrowData.rider_amount > 0) {
        this.logger.log(`Crediting rider ${orderData.rider_id} with ₣${escrowData.rider_amount}`);
        const riderResult = await this.walletService.processWalletTransaction(
          orderData.rider_id,
          WalletTransactionType.DELIVERY_PAYMENT,
          parseFloat(escrowData.rider_amount),
          `Delivery fee for order ${orderData.order_number}`,
          orderData.id,
          'order',
        );

        if (!riderResult.success) {
          this.logger.error('⚠️ CRITICAL: Failed to credit rider wallet after escrow release:', riderResult.error);
          // ⚠️ Vendor already paid, but rider payment failed - requires reconciliation
          this.logger.error(`🚨 RECONCILIATION REQUIRED: Escrow ${escrowId} released and vendor paid, but rider payment failed. Manual intervention required.`);
          // Don't throw - vendor already paid, but log critical alert for reconciliation
        } else if (riderResult.idempotent) {
          // ✅ PHASE 2: Log idempotent transaction detection
          this.logger.warn(
            `⚠️ IDEMPOTENT: Rider payment for escrow ${escrowId} was idempotent (duplicate prevented).`
          );
        }
      }

      // 2b. Credit platform wallet with commission (if applicable)
      const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';
      if (escrowData.platform_amount > 0) {
        this.logger.log(`Crediting platform wallet with ₣${escrowData.platform_amount}`);
        const platformResult = await this.walletService.processWalletTransaction(
          PLATFORM_USER_ID,
          WalletTransactionType.PLATFORM_COMMISSION,
          parseFloat(escrowData.platform_amount),
          `Platform commission for order ${orderData.order_number}`,
          orderData.id,
          'order',
        );

        if (!platformResult.success) {
          this.logger.error('⚠️ CRITICAL: Failed to credit platform wallet after escrow release:', platformResult.error);
          // ⚠️ Vendor/rider already paid, but platform commission failed - requires reconciliation
          this.logger.error(`🚨 RECONCILIATION REQUIRED: Escrow ${escrowId} released and vendor/rider paid, but platform commission failed. Manual intervention required.`);
          // Don't throw - vendor/rider already paid, but log critical alert
        } else if (platformResult.idempotent) {
          // ✅ PHASE 2: Log idempotent transaction detection
          this.logger.warn(
            `⚠️ IDEMPOTENT: Platform commission for escrow ${escrowId} was idempotent (duplicate prevented).`
          );
        }
      }

      // ✅ Escrow status is already updated by atomic function, no need to update again

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
  async refundEscrow(escrowId: string, reason: string, userId?: string): Promise<void> {
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

      // ✅ FIX Bug 17: Validate authorization if userId provided
      if (userId) {
        const isBuyer = order.buyer_id === userId;
        const isVendor = order.vendor_id === userId;
        
        // TODO: Check if user is admin (implement admin check when admin system is added)
        // const isAdmin = await this.isAdmin(userId);
        
        // Only buyer or vendor (or admin) can request refund
        if (!isBuyer && !isVendor) {
          throw new HttpException('Unauthorized - only buyer or vendor can refund escrow', HttpStatus.FORBIDDEN);
        }
      }

      // Credit buyer wallet (refund)
      this.logger.log(`Refunding buyer ${order.buyer_id} with ₣${escrow.total_amount}`);
      const refundResult = await this.walletService.processWalletTransaction(
        order.buyer_id,
        WalletTransactionType.ESCROW_REFUND,
        parseFloat(escrow.total_amount),
        `Refund for order ${order.order_number}`,
        order.id,
        'order',
      );

      if (!refundResult.success) {
        this.logger.error('Failed to refund buyer wallet:', refundResult.error);
        throw new HttpException(
          `Failed to process refund: ${refundResult.error}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Update escrow status (with status check to prevent double-refund)
      const { error: updateError } = await this.supabase
        .from('escrows')
        .update({
          status: 'refunded',
          refund_reason: reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId)
        .eq('status', 'held'); // ✅ Prevent double-refund race condition

      if (updateError) {
        this.logger.error('Failed to update escrow status:', updateError);
        // ⚠️ Refund already processed, but escrow status update failed
        throw new HttpException('Escrow refund partially completed - refund succeeded but status update failed. Manual intervention required.', HttpStatus.INTERNAL_SERVER_ERROR);
      }

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
   * Partial refund - refund buyer partial amount, release rest to vendor
   */
  async partialRefundEscrow(
    escrowId: string,
    refundAmount: number,
    reason: string,
  ): Promise<void> {
    try {
      this.logger.log(`Processing partial refund for escrow ${escrowId}: ₣${refundAmount}`);

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
        .in('status', ['held', 'dispute'])
        .single();

      if (fetchError || !escrow) {
        throw new HttpException('Escrow not found or already processed', HttpStatus.NOT_FOUND);
      }

      const totalAmount = parseFloat(escrow.total_amount);
      if (refundAmount > totalAmount || refundAmount <= 0) {
        throw new HttpException('Invalid refund amount', HttpStatus.BAD_REQUEST);
      }

      const order = escrow.orders;
      const remainingAmount = totalAmount - refundAmount;

      // Helper function to round to 6 decimal places (matching DECIMAL(18,6) precision)
      const round6 = (value: number): number => Math.round(value * 1000000) / 1000000;

      // 1. Refund buyer partial amount
      this.logger.log(`Refunding buyer ${order.buyer_id} with ₣${refundAmount}`);
      const refundResult = await this.walletService.processWalletTransaction(
        order.buyer_id,
        WalletTransactionType.ESCROW_REFUND,
        round6(refundAmount),
        `Partial refund for order ${order.order_number}: ${reason}`,
        order.id,
        'order',
      );

      if (!refundResult.success) {
        this.logger.error('Failed to refund buyer wallet:', refundResult.error);
        throw new HttpException(
          `Failed to process partial refund: ${refundResult.error}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // 2. Calculate vendor and rider amounts proportionally (with rounding fix)
      const vendorProportion = parseFloat(escrow.vendor_amount) / totalAmount;
      const riderProportion = parseFloat(escrow.rider_amount) / totalAmount;
      const platformProportion = parseFloat(escrow.platform_amount) / totalAmount;

      // ✅ FIX: Round amounts and ensure sum equals remainingAmount exactly
      const vendorAmount = round6(remainingAmount * vendorProportion);
      const riderAmount = round6(remainingAmount * riderProportion);
      // Platform amount gets any remainder to ensure sum equals remainingAmount exactly
      const platformAmount = round6(remainingAmount - vendorAmount - riderAmount);

      // Validate sum equals remainingAmount (within floating point tolerance)
      const sum = round6(vendorAmount + riderAmount + platformAmount);
      const difference = Math.abs(sum - remainingAmount);
      if (difference > 0.000001) {
        this.logger.warn(`⚠️ Partial refund calculation rounding adjustment: ${difference} difference`);
      }

      // 3. Release remaining amount to vendor
      this.logger.log(`Releasing remaining ₣${vendorAmount} to vendor ${order.vendor_id}`);
      const vendorResult = await this.walletService.processWalletTransaction(
        order.vendor_id,
        WalletTransactionType.ESCROW_RELEASE,
        vendorAmount,
        `Partial escrow release for order ${order.order_number} (after partial refund)`,
        escrowId,
        'escrow',
      );

      if (!vendorResult.success) {
        this.logger.error('Failed to credit vendor wallet:', vendorResult.error);
        // Don't throw - buyer already refunded, log and continue
      }

      // 4. Release rider amount if applicable
      if (order.rider_id && riderAmount > 0) {
        this.logger.log(`Releasing ₣${riderAmount} to rider ${order.rider_id}`);
        const riderResult = await this.walletService.processWalletTransaction(
          order.rider_id,
          WalletTransactionType.DELIVERY_PAYMENT,
          riderAmount,
          `Delivery fee for order ${order.order_number} (partial)`,
          order.id,
          'order',
        );

        if (!riderResult.success) {
          this.logger.error('Failed to credit rider wallet:', riderResult.error);
          // Don't throw - log and continue
        }
      }

      // 4b. Credit platform wallet with commission (if applicable) - ✅ FIX Bug 11
      const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';
      if (platformAmount > 0) {
        this.logger.log(`Crediting platform wallet with ₣${platformAmount} (partial refund)`);
        const platformResult = await this.walletService.processWalletTransaction(
          PLATFORM_USER_ID,
          WalletTransactionType.PLATFORM_COMMISSION,
          platformAmount,
          `Platform commission for order ${order.order_number} (partial refund)`,
          order.id,
          'order',
        );

        if (!platformResult.success) {
          this.logger.error('⚠️ CRITICAL: Failed to credit platform wallet:', platformResult.error);
          this.logger.warn(`Platform commission ${platformAmount} for order ${order.order_number} failed - requires manual reconciliation`);
          // Don't throw - buyer/vendor/rider already paid, but log as critical
        }
      }

      // 5. Update escrow status to released (partial refund completed)
      const { error: updateError } = await this.supabase
        .from('escrows')
        .update({
          status: 'released',
          released_at: new Date().toISOString(),
          release_reason: `Partial refund: ${reason}. Refunded ₣${refundAmount}, released ₣${remainingAmount}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId)
        .in('status', ['held', 'dispute']); // ✅ Status check prevents updating if already processed

      if (updateError) {
        this.logger.error('Failed to update escrow status:', updateError);
        // ⚠️ Wallet transactions already succeeded, but escrow status update failed
        throw new HttpException('Partial refund partially completed - wallet transactions succeeded but status update failed. Manual intervention required.', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // 6. Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      // 7. Send notifications
      await this.notificationHelper.notifyOrderRefunded(
        order.buyer_id,
        refundAmount,
        order.order_number,
        `Partial refund: ${reason}`,
      );

      await this.notificationHelper.notifyVendorEscrowReleased(
        order.vendor_id,
        vendorAmount,
        order.order_number,
      );

      // 8. Broadcast real-time updates
      await this.realtimeGateway.notifyWalletBalanceUpdate(order.buyer_id, {
        availableBalance: 0,
        escrowBalance: 0,
        pendingWithdrawal: 0,
        totalBalance: 0,
        transactionType: 'refund',
      });

      await this.realtimeGateway.notifyWalletBalanceUpdate(order.vendor_id, {
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
   */
  async splitEscrowAmount(
    escrowId: string,
    buyerAmount: number,
    reason: string,
  ): Promise<void> {
    try {
      this.logger.log(`Splitting escrow ${escrowId}: Buyer gets ₣${buyerAmount}`);

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
        .in('status', ['held', 'dispute'])
        .single();

      if (fetchError || !escrow) {
        throw new HttpException('Escrow not found or already processed', HttpStatus.NOT_FOUND);
      }

      const totalAmount = parseFloat(escrow.total_amount);
      if (buyerAmount > totalAmount || buyerAmount < 0) {
        throw new HttpException('Invalid split amount', HttpStatus.BAD_REQUEST);
      }

      const order = escrow.orders;
      const vendorAmount = totalAmount - buyerAmount;

      // Helper function to round to 6 decimal places (matching DECIMAL(18,6) precision)
      const round6 = (value: number): number => Math.round(value * 1000000) / 1000000;

      // 1. Refund buyer their portion
      if (buyerAmount > 0) {
        this.logger.log(`Refunding buyer ${order.buyer_id} with ₣${buyerAmount}`);
        const refundResult = await this.walletService.processWalletTransaction(
          order.buyer_id,
          WalletTransactionType.ESCROW_REFUND,
          round6(buyerAmount),
          `Split resolution for order ${order.order_number}: ${reason}`,
          order.id,
          'order',
        );

        if (!refundResult.success) {
          this.logger.error('Failed to refund buyer wallet:', refundResult.error);
          throw new HttpException(
            `Failed to process buyer refund: ${refundResult.error}`,
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }
      }

      // 2. Calculate vendor, rider, and platform amounts proportionally from vendor portion (with rounding fix) - ✅ FIX Bug 12
      const vendorProportion = parseFloat(escrow.vendor_amount) / totalAmount;
      const riderProportion = parseFloat(escrow.rider_amount) / totalAmount;
      const platformProportion = parseFloat(escrow.platform_amount) / totalAmount;

      // Calculate proportions from the vendor portion (vendorAmount = totalAmount - buyerAmount)
      // Platform fee comes from vendor's share, so we need to allocate vendorAmount proportionally
      const totalProportion = vendorProportion + riderProportion + platformProportion;
      
      // ✅ FIX: Round amounts and ensure sum equals vendorAmount exactly
      const vendorFinalAmount = round6(vendorAmount * (vendorProportion / totalProportion));
      const riderFinalAmount = round6(vendorAmount * (riderProportion / totalProportion));
      // Platform amount gets any remainder to ensure sum equals vendorAmount exactly
      const platformFinalAmount = round6(vendorAmount - vendorFinalAmount - riderFinalAmount);

      // Validate sum equals vendorAmount (within floating point tolerance)
      const sum = round6(vendorFinalAmount + riderFinalAmount + platformFinalAmount);
      const difference = Math.abs(sum - vendorAmount);
      if (difference > 0.000001) {
        this.logger.warn(`⚠️ Split escrow calculation rounding adjustment: ${difference} difference`);
      }

      // 3. Release vendor portion
      if (vendorFinalAmount > 0) {
        this.logger.log(`Releasing ₣${vendorFinalAmount} to vendor ${order.vendor_id}`);
        const vendorResult = await this.walletService.processWalletTransaction(
          order.vendor_id,
          WalletTransactionType.ESCROW_RELEASE,
          vendorFinalAmount,
          `Split escrow release for order ${order.order_number}: ${reason}`,
          escrowId,
          'escrow',
        );

        if (!vendorResult.success) {
          this.logger.error('Failed to credit vendor wallet:', vendorResult.error);
          // Don't throw - buyer already refunded
        }
      }

      // 4. Release rider amount if applicable
      if (order.rider_id && riderFinalAmount > 0) {
        this.logger.log(`Releasing ₣${riderFinalAmount} to rider ${order.rider_id}`);
        const riderResult = await this.walletService.processWalletTransaction(
          order.rider_id,
          WalletTransactionType.DELIVERY_PAYMENT,
          riderFinalAmount,
          `Delivery fee for order ${order.order_number} (split resolution)`,
          order.id,
          'order',
        );

        if (!riderResult.success) {
          this.logger.error('Failed to credit rider wallet:', riderResult.error);
          // Don't throw - log and continue
        }
      }

      // 4b. Credit platform wallet with commission (if applicable) - ✅ FIX Bug 12
      const PLATFORM_USER_ID = '00000000-0000-4000-8000-000000000002';
      if (platformFinalAmount > 0) {
        this.logger.log(`Crediting platform wallet with ₣${platformFinalAmount} (split resolution)`);
        const platformResult = await this.walletService.processWalletTransaction(
          PLATFORM_USER_ID,
          WalletTransactionType.PLATFORM_COMMISSION,
          platformFinalAmount,
          `Platform commission for order ${order.order_number} (split resolution)`,
          order.id,
          'order',
        );

        if (!platformResult.success) {
          this.logger.error('⚠️ CRITICAL: Failed to credit platform wallet:', platformResult.error);
          this.logger.warn(`Platform commission ${platformFinalAmount} for order ${order.order_number} failed - requires manual reconciliation`);
          // Don't throw - buyer/vendor/rider already paid, but log as critical
        }
      }

      // 5. Update escrow status
      const { error: updateError } = await this.supabase
        .from('escrows')
        .update({
          status: 'released',
          released_at: new Date().toISOString(),
          release_reason: `Split resolution: ${reason}. Buyer: ₣${buyerAmount}, Vendor: ₣${vendorFinalAmount}, Platform: ₣${platformFinalAmount || 0}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', escrowId)
        .in('status', ['held', 'dispute']); // ✅ Status check prevents updating if already processed

      if (updateError) {
        this.logger.error('Failed to update escrow status:', updateError);
        // ⚠️ Wallet transactions already succeeded, but escrow status update failed
        throw new HttpException('Split resolution partially completed - wallet transactions succeeded but status update failed. Manual intervention required.', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      // 6. Update order status
      await this.supabase
        .from('orders')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      // 7. Send notifications
      if (buyerAmount > 0) {
        await this.notificationHelper.notifyOrderRefunded(
          order.buyer_id,
          buyerAmount,
          order.order_number,
          `Split resolution: ${reason}`,
        );
      }

      if (vendorFinalAmount > 0) {
        await this.notificationHelper.notifyVendorEscrowReleased(
          order.vendor_id,
          vendorFinalAmount,
          order.order_number,
        );
      }

      // 8. Broadcast real-time updates
      if (buyerAmount > 0) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(order.buyer_id, {
          availableBalance: 0,
          escrowBalance: 0,
          pendingWithdrawal: 0,
          totalBalance: 0,
          transactionType: 'refund',
        });
      }

      if (vendorFinalAmount > 0) {
        await this.realtimeGateway.notifyWalletBalanceUpdate(order.vendor_id, {
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

