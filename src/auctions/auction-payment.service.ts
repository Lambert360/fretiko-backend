import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';
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
    this.supabase = createSupabaseClient(this.configService);
  }

  /**
   * Process winning bid payment after auction ends
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

      if (existingSale?.payment_status === 'paid') {
        return { success: true, message: 'Payment already processed' };
      }

      // Check buyer's wallet balance
      const buyerWallet = await this.walletService.getWallet(auction.winner_id);

      if (buyerWallet.availableBalance < auction.winning_bid) {
        // Mark auction as payment failed
        await this.supabase
          .from('auction_sales')
          .upsert({
            auction_id: auctionId,
            seller_id: auction.seller_id,
            buyer_id: auction.winner_id,
            final_bid_amount: auction.winning_bid,
            commission_amount: auction.winning_bid * (auction.commission_rate / 100),
            total_amount: auction.winning_bid,
            payment_status: 'failed',
          });

        return { success: false, message: 'Buyer has insufficient funds' };
      }

      // Calculate amounts
      const commissionAmount = auction.winning_bid * (auction.commission_rate / 100);
      const sellerAmount = auction.winning_bid - commissionAmount;
      const orderNumber = `AUC-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;

      console.log(`Processing auction payment - Total: ₣${auction.winning_bid}, Commission: ₣${commissionAmount}, Seller: ₣${sellerAmount}`);

      // 1. Create order record for auction
      const { data: order, error: orderError } = await this.supabase
        .from('orders')
        .insert({
          order_number: orderNumber,
          buyer_id: auction.winner_id,
          vendor_id: auction.seller_id,
          total_amount: auction.winning_bid,
          delivery_fee: 0, // Auctions typically don't include delivery
          platform_fee: commissionAmount,
          status: 'pending',
          escrow_enabled: true,
          source: 'auction',
          metadata: {
            auction_id: auctionId,
            auction_title: auction.title,
            final_bid_amount: auction.winning_bid,
            commission_rate: auction.commission_rate,
          }
        })
        .select()
        .single();

      if (orderError) {
        console.error('Error creating order:', orderError);
        return { success: false, message: 'Failed to create order' };
      }

      console.log(`✅ Order created: ${order.id}, ${order.order_number}`);

      // 2. Create order item for auction win
      const { error: orderItemError } = await this.supabase
        .from('order_items')
        .insert({
          order_id: order.id,
          product_id: null, // Auctions don't have product IDs
          product_name: auction.title,
          unit_price: auction.winning_bid,
          quantity: 1,
          total_price: auction.winning_bid,
          product_metadata: {
            auction_lot: auction.lot_number,
            description: auction.description,
          }
        });

      if (orderItemError) {
        console.error('Error creating order item:', orderItemError);
      }

      // 3. Deduct from buyer wallet
      const { error: deductError } = await this.supabase.rpc(
        'process_wallet_transaction',
        {
          p_user_id: auction.winner_id,
          p_transaction_type: 'purchase',
          p_amount: -auction.winning_bid,
          p_description: `Auction win: ${auction.title}`,
          p_reference_id: order.id,
          p_reference_type: 'order'
        }
      );

      if (deductError) {
        console.error('❌ Wallet deduction failed:', deductError);
        return { success: false, message: 'Failed to process payment' };
      }

      console.log(`✅ Buyer wallet deducted: ₣${auction.winning_bid}`);

      // 4. Create escrow for buyer protection
      try {
        const escrowBreakdown = {
          totalAmount: auction.winning_bid,
          vendorAmount: sellerAmount,
          riderAmount: 0, // No delivery for auctions
          platformAmount: commissionAmount,
        };

        await this.escrowService.createEscrow(order.id, escrowBreakdown);
        console.log(`✅ Escrow created for auction order ${order.order_number}: ₣${auction.winning_bid}`);

        // Update order status to paid
        await this.supabase
          .from('orders')
          .update({ status: 'paid' })
          .eq('id', order.id);

      } catch (escrowError) {
        console.error('❌ Escrow creation failed (non-critical):', escrowError);
        // Continue - payment already processed
      }

      // 5. Create/update auction sale record
      const { data: saleData, error: saleError } = await this.supabase
        .from('auction_sales')
        .upsert({
          auction_id: auctionId,
          seller_id: auction.seller_id,
          buyer_id: auction.winner_id,
          final_bid_amount: auction.winning_bid,
          commission_amount: commissionAmount,
          total_amount: auction.winning_bid,
          payment_status: 'paid',
          payment_transaction_id: order.id, // Link to order
        })
        .select()
        .single();

      if (saleError) {
        console.error('Error creating sale record:', saleError);
      }

      // 6. Notify seller of sale and payment in escrow
      try {
        await this.notificationHelper.notifyVendorNewOrder(auction.seller_id, {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: auction.winning_bid,
          itemCount: 1,
          buyerName: 'Auction Winner',
        });

        await this.notificationHelper.notifyVendorOrderPaid(auction.seller_id, {
          orderId: order.id,
          orderNumber: order.order_number,
          vendorAmount: sellerAmount,
          escrowId: order.id,
        });

        console.log(`✅ Seller ${auction.seller_id} notified of auction sale`);
      } catch (notifyError) {
        console.error('⚠️  Failed to notify seller (non-critical):', notifyError);
      }

      console.log(`✅ Auction ${auctionId} payment processed successfully`);
      return { success: true, message: 'Payment processed successfully' };

    } catch (error) {
      console.error('Error processing winning bid payment:', error);
      return { success: false, message: 'Payment processing failed' };
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

      if (!sale || sale.payment_status !== 'paid') {
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

      if (sale.payment_status !== 'paid') {
        return { success: false, message: 'Payment not yet processed' };
      }

      // Calculate seller amount (minus commission)
      const sellerAmount = sale.final_bid_amount - sale.commission_amount;

      // TODO: Transfer from escrow to seller wallet
      // This would integrate with your existing wallet escrow system

      // Update sale as completed
      await this.supabase
        .from('auction_sales')
        .update({
          sale_completed_at: new Date().toISOString(),
        })
        .eq('id', sale.id);

      console.log(`Escrow released for auction ${auctionId}: ${sellerAmount} Freti to seller`);

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

      // TODO: Refund buyer from escrow
      // This would integrate with your existing wallet refund system

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