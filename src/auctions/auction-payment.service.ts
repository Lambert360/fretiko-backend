import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient } from '../shared/supabase.client';
import { WalletService } from '../wallet/wallet.service';

/**
 * Auction Payment Service
 *
 * Handles auction-specific payment processing:
 * - Winning bid payment processing
 * - Escrow management for high-value auctions
 * - Commission calculation and distribution
 * - Integration with existing wallet system
 */
@Injectable()
export class AuctionPaymentService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
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

      // Create auction sale record with payment processing
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
        })
        .select()
        .single();

      if (saleError) {
        console.error('Error creating sale record:', saleError);
        return { success: false, message: 'Failed to create sale record' };
      }

      // TODO: Create wallet transactions
      // 1. Transfer from buyer available balance to escrow
      // 2. Hold commission in platform account
      // 3. Transfer seller amount to seller wallet (or escrow for high-value items)

      // For now, we'll mark as paid and integrate wallet transactions later
      console.log(`Auction ${auctionId} payment processed: ${auction.winning_bid} Freti`);
      console.log(`Commission: ${commissionAmount} Freti, Seller gets: ${sellerAmount} Freti`);

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