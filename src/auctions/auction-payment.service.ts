import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { WalletService } from '../wallet/wallet.service';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationHelperService } from '../notifications/notification-helper.service';

/**
 * Auction Payment Service
 *
 * Handles auction-specific payment processing:
 * - Winning bid payment processing with escrow protection
 * - Order creation for auction winners
 * - Commission calculation and distribution
 * - Integration with wallet and escrow systems
 */
@Injectable()
export class AuctionPaymentService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
    @Inject(forwardRef(() => EscrowService))
    private escrowService: EscrowService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Process winning bid payment after auction ends
   * NEW: Creates a pending sale record instead of processing payment immediately
   * Payment will be processed when winner completes checkout
   */
  /**
   * DEPRECATED: Timed auction end now creates sale records inside end_auction_atomic.
   * Left as a no-op for compatibility. Safe to remove after live testing.
   */
  async processWinningBidPayment(auctionId: string): Promise<{ success: boolean; message: string }> {
    console.log(`[DEPRECATED] processWinningBidPayment called for auction ${auctionId} - no action taken`);
    return { success: true, message: 'Deprecated - sale records are created by end_auction_atomic' };
  }

  /**
   * DEPRECATED: Commission is now transferred to the platform wallet inside release_escrow_atomic.
   * Left as a read-only no-op for compatibility. Safe to remove after live testing.
   */
  async processCommissionPayment(auctionId: string): Promise<{ success: boolean; amount: number }> {
    try {
      const { data: sale } = await this.supabase
        .from('auction_sales')
        .select('commission_amount, payment_status')
        .eq('auction_id', auctionId)
        .maybeSingle();

      if (!sale || sale.payment_status !== 'completed') {
        return { success: false, amount: 0 };
      }

      console.log(`[DEPRECATED] processCommissionPayment called for auction ${auctionId} - no separate transfer; commission already moved via escrow release`);
      return { success: true, amount: sale.commission_amount };

    } catch (error: any) {
      console.error('Error reading auction sale for commission:', error);
      return { success: false, amount: 0 };
    }
  }

  /**
   * Release escrow funds to seller after delivery confirmation
   */
  async releaseEscrowToSeller(auctionId: string): Promise<{ success: boolean; message: string }> {
    try {
      const { data: sale } = await this.supabase
        .from('auction_sales')
        .select('*')
        .eq('auction_id', auctionId)
        .single();

      if (!sale) {
        return { success: false, message: 'Sale record not found' };
      }

      if (sale.payment_status !== 'completed') {
        return { success: false, message: 'Payment not yet processed' };
      }

      if (!sale.payment_transaction_id) {
        return { success: false, message: 'Order ID not found in sale record' };
      }

      // Get escrow ID from order
      const { data: escrow } = await this.supabase
        .from('escrows')
        .select('id')
        .eq('order_id', sale.payment_transaction_id)
        .single();

      if (!escrow) {
        return { success: false, message: 'Escrow not found for this order' };
      }

      // Use EscrowService to release escrow
      await this.escrowService.releaseEscrow(
        escrow.id,
        'Auction sale completed - seller delivered item'
      );

      // Update sale as completed
      await this.supabase
        .from('auction_sales')
        .update({
          completed_at: new Date().toISOString(),
        })
        .eq('id', sale.id);

      const sellerAmount = sale.final_bid_amount - sale.commission_amount;
      console.log(`Escrow released for auction ${auctionId}: ₣${sellerAmount} Freti to seller`);

      return { success: true, message: 'Escrow released to seller' };

    } catch (error) {
      console.error('Error releasing escrow:', error);
      return { success: false, message: 'Failed to release escrow' };
    }
  }

  /**
   * Handle refund for cancelled auctions or failed sales
   */
  async processAuctionRefund(auctionId: string, reason: string): Promise<{ success: boolean; message: string }> {
    try {
      const { data: sale } = await this.supabase
        .from('auction_sales')
        .select('*')
        .eq('auction_id', auctionId)
        .single();

      if (!sale) {
        return { success: false, message: 'Sale record not found' };
      }

      if (!sale.payment_transaction_id) {
        return { success: false, message: 'Order ID not found in sale record' };
      }

      // Get escrow ID from order
      const { data: escrow } = await this.supabase
        .from('escrows')
        .select('id')
        .eq('order_id', sale.payment_transaction_id)
        .single();

      if (!escrow) {
        return { success: false, message: 'Escrow not found for this order' };
      }

      // Use EscrowService to refund buyer
      await this.escrowService.refundEscrow(escrow.id, reason);

      // Update sale status
      await this.supabase
        .from('auction_sales')
        .update({
          payment_status: 'refunded',
        })
        .eq('id', sale.id);

      console.log(`Auction ${auctionId} refunded: ${sale.total_amount} Freti. Reason: ${reason}`);

      return { success: true, message: 'Refund processed successfully' };

    } catch (error) {
      console.error('Error processing refund:', error);
      return { success: false, message: 'Failed to process refund' };
    }
  }

  /**
   * Get auction payment status
   */
  async getAuctionPaymentStatus(auctionId: string): Promise<{
    hasSale: boolean;
    paymentStatus?: string;
    totalAmount?: number;
    commissionAmount?: number;
    saleCompletedAt?: string;
  }> {
    try {
      const { data: sale } = await this.supabase
        .from('auction_sales')
        .select('*')
        .eq('auction_id', auctionId)
        .single();

      if (!sale) {
        return { hasSale: false };
      }

      return {
        hasSale: true,
        paymentStatus: sale.payment_status,
        totalAmount: sale.total_amount,
        commissionAmount: sale.commission_amount,
        saleCompletedAt: sale.sale_completed_at,
      };

    } catch (error) {
      console.error('Error getting payment status:', error);
      return { hasSale: false };
    }
  }
}