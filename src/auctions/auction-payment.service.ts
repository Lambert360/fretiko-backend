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
  async processWinningBidPayment(auctionId: string): Promise<{ success: boolean; message: string }> {
    try {
      // Get auction details
      const { data: auction, error: auctionError } = await this.supabase
        .from('auctions')
        .select('*')
        .eq('id', auctionId)
        .single();

      if (auctionError || !auction) {
        return { success: false, message: 'Auction not found' };
      }

      if (!auction.winner_id || !auction.winning_bid) {
        return { success: false, message: 'No winner to process payment for' };
      }

      // Check if already processed
      const { data: existingSale } = await this.supabase
        .from('auction_sales')
        .select('payment_status')
        .eq('auction_id', auctionId)
        .single();

      if (existingSale?.payment_status === 'completed') {
        return { success: true, message: 'Payment already processed' };
      }

      // Check if order already exists for this auction (prevent duplicate)
      const { data: existingOrder } = await this.supabase
        .from('orders')
        .select('id, status, order_number')
        .eq('source', 'auction')
        .eq('metadata->>auction_id', auctionId)
        .single();

      if (existingOrder) {
        console.log(`Order already exists for auction ${auctionId}: ${existingOrder.order_number}`);
        // Update auction_sales to link to existing order if not already linked
        if (existingSale && !existingSale.payment_transaction_id) {
          await this.supabase
            .from('auction_sales')
            .update({
              payment_status: existingOrder.status === 'paid' ? 'completed' : 'pending',
              payment_transaction_id: existingOrder.id,
            })
            .eq('auction_id', auctionId);
        }
        return { success: true, message: 'Order already exists for this auction' };
      }

      // Calculate amounts
      const commissionAmount = auction.winning_bid * (auction.commission_rate / 100);

      console.log(`📋 Creating pending sale for auction ${auctionId} - Winner must complete checkout`);

      // Create/update auction sale record with PENDING status (not completed)
      // This allows the winner to go through checkout to provide delivery details
      const { data: saleData, error: saleError } = await this.supabase
        .from('auction_sales')
        .upsert({
          auction_id: auctionId,
          seller_id: auction.seller_id,
          buyer_id: auction.winner_id,
          final_bid_amount: auction.winning_bid,
          commission_amount: commissionAmount,
          total_amount: auction.winning_bid,
          payment_status: 'pending', // PENDING - will be completed after checkout
          payment_transaction_id: null, // Will be set when order is created during checkout
        })
        .select()
        .single();

      if (saleError) {
        console.error('Error creating pending sale record:', saleError);
        return { success: false, message: 'Failed to create sale record' };
      }

      // Notify buyer that they won and need to complete checkout
      try {
        await this.notificationHelper.notifyOrderCreated(auction.winner_id, {
          id: null, // No order yet
          order_number: null,
          total_amount: auction.winning_bid,
        });

        console.log(`✅ Buyer ${auction.winner_id} notified to complete checkout for auction win`);
      } catch (notifyError) {
        console.error('⚠️  Failed to notify buyer (non-critical):', notifyError);
      }

      // Notify seller that auction sold (but payment pending)
      try {
        await this.notificationHelper.notifyVendorNewOrder(auction.seller_id, {
          id: null, // No order yet
          orderNumber: null,
          totalAmount: auction.winning_bid,
          itemCount: 1,
          buyerName: 'Auction Winner',
        });

        console.log(`✅ Seller ${auction.seller_id} notified of auction sale (awaiting checkout)`);
      } catch (notifyError) {
        console.error('⚠️  Failed to notify seller (non-critical):', notifyError);
      }

      console.log(`✅ Auction ${auctionId} - Pending sale created. Winner must complete checkout.`);
      return { success: true, message: 'Pending sale created - winner must complete checkout' };

    } catch (error) {
      console.error('Error creating pending sale:', error);
      return { success: false, message: 'Failed to create pending sale' };
    }
  }

  /**
   * Process commission payment to platform
   */
  async processCommissionPayment(auctionId: string): Promise<{ success: boolean; amount: number }> {
    try {
      const { data: sale } = await this.supabase
        .from('auction_sales')
        .select('commission_amount, payment_status')
        .eq('auction_id', auctionId)
        .single();

      if (!sale || sale.payment_status !== 'completed') {
        return { success: false, amount: 0 };
      }

      // TODO: Transfer commission to platform wallet
      // This would integrate with your existing wallet system

      return { success: true, amount: sale.commission_amount };

    } catch (error) {
      console.error('Error processing commission payment:', error);
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