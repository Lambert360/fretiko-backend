import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { AuctionGateway } from './auction.gateway';
import { AuctionPaymentService } from './auction-payment.service';

/**
 * Auction Scheduler Service
 *
 * Handles automated auction lifecycle management:
 * - Start scheduled auctions
 * - End active auctions
 * - Process soft close extensions
 * - Send ending soon notifications
 * - Clean up old data
 */
@Injectable()
export class AuctionSchedulerService {
  private supabase;

  constructor(
    private configService: ConfigService,
    private auctionGateway: AuctionGateway,
    private auctionPaymentService: AuctionPaymentService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Check for auctions that should start (every minute)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async startScheduledAuctions() {
    try {
      const now = new Date();

      // Find auctions that should start (include end_time to check if already expired)
      const { data: auctionsToStart, error } = await this.supabase
        .from('auctions')
        .select('id, title, seller_id, start_time, end_time')
        .eq('status', 'scheduled')
        .lte('start_time', now.toISOString());

      if (error) {
        console.error('Error fetching auctions to start:', error);
        return;
      }

      for (const auction of auctionsToStart || []) {
        // Check if end_time has also passed - if so, skip starting and mark as ended directly
        const startTime = new Date(auction.start_time);
        const endTime = new Date(auction.end_time);
        
        console.log(`[Auction ${auction.id}] Checking: start_time=${startTime.toISOString()}, end_time=${endTime.toISOString()}, now=${now.toISOString()}`);
        
        if (endTime <= now) {
          console.log(`[Auction ${auction.id}] Already expired (end_time: ${endTime.toISOString()}). Marking as ended.`);
          await this.markAuctionAsExpired(auction.id);
        } else if (startTime <= now && endTime > now) {
          console.log(`[Auction ${auction.id}] Should start now. start_time passed, end_time in future. Starting auction...`);
          await this.startAuction(auction.id);
        } else {
          console.log(`[Auction ${auction.id}] Unexpected state: start_time=${startTime.toISOString()}, end_time=${endTime.toISOString()}`);
        }
      }

    } catch (error) {
      console.error('Error in startScheduledAuctions:', error);
    }
  }

  /**
   * Check for auctions that should end (every minute)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async endActiveAuctions() {
    try {
      const now = new Date();

      // Find auctions that should end
      const { data: auctionsToEnd, error } = await this.supabase
        .from('auctions')
        .select('id, title, seller_id, winner_id, winning_bid, current_bid, reserve_price')
        .eq('status', 'active')
        .lte('end_time', now.toISOString());

      if (error) {
        console.error('Error fetching auctions to end:', error);
        return;
      }

      for (const auction of auctionsToEnd || []) {
        await this.endAuction(auction);
      }

    } catch (error) {
      console.error('Error in endActiveAuctions:', error);
    }
  }

  /**
   * Send ending soon notifications (every 5 minutes)
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendEndingSoonNotifications() {
    try {
      const now = new Date();
      const warningTime = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes from now

      // Find auctions ending within 30 minutes
      const { data: endingSoonAuctions, error } = await this.supabase
        .from('auctions')
        .select('id, title, end_time')
        .eq('status', 'active')
        .gte('end_time', now.toISOString())
        .lte('end_time', warningTime.toISOString());

      if (error) {
        console.error('Error fetching ending soon auctions:', error);
        return;
      }

      for (const auction of endingSoonAuctions || []) {
        const endTime = new Date(auction.end_time);
        const minutesRemaining = Math.floor((endTime.getTime() - now.getTime()) / (1000 * 60));

        // Send warning at 30, 15, 5, and 1 minute marks
        if ([30, 15, 5, 1].includes(minutesRemaining)) {
          await this.auctionGateway.broadcastAuctionEndingWarning(auction.id, minutesRemaining);
        }
      }

    } catch (error) {
      console.error('Error in sendEndingSoonNotifications:', error);
    }
  }

  /**
   * Check for soft close extensions (every 30 seconds)
   */
  @Cron('*/30 * * * * *')
  async processSoftCloseExtensions() {
    try {
      const now = new Date();
      const extensionWindow = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago

      // Find auctions with recent bids near end time that might need extension
      const { data: auctionsWithRecentBids, error } = await this.supabase
        .from('auctions')
        .select(`
          id, end_time, soft_close_enabled, soft_close_extension,
          auction_bids!inner(created_at)
        `)
        .eq('status', 'active')
        .eq('soft_close_enabled', true)
        .gte('auction_bids.created_at', extensionWindow.toISOString())
        .lte('end_time', now.toISOString());

      if (error) {
        console.error('Error fetching auctions for soft close:', error);
        return;
      }

      for (const auction of auctionsWithRecentBids || []) {
        await this.extendAuction(auction.id, auction.soft_close_extension);
      }

    } catch (error) {
      console.error('Error in processSoftCloseExtensions:', error);
    }
  }

  /**
   * Clean up old auction data (daily at midnight)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldData() {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Clean up old auction events
      await this.supabase
        .from('auction_events')
        .delete()
        .lte('timestamp', thirtyDaysAgo.toISOString());

      console.log('Cleaned up old auction data');

    } catch (error) {
      console.error('Error in cleanupOldData:', error);
    }
  }

  /**
   * Start an individual auction
   */
  private async startAuction(auctionId: string) {
    try {
      // First verify the auction is still scheduled (prevent race conditions)
      const { data: auction, error: fetchError } = await this.supabase
        .from('auctions')
        .select('id, status, start_time, end_time')
        .eq('id', auctionId)
        .single();

      if (fetchError || !auction) {
        console.error(`Error fetching auction ${auctionId} for start:`, fetchError);
        return;
      }

      // Double-check status to prevent duplicate processing
      if (auction.status !== 'scheduled') {
        console.log(`[Auction ${auctionId}] Skipping start - status is already '${auction.status}'`);
        return;
      }

      // Verify end_time is still in the future
      const endTime = new Date(auction.end_time);
      const now = new Date();
      if (endTime <= now) {
        console.log(`[Auction ${auctionId}] End time has passed, marking as expired instead`);
        await this.markAuctionAsExpired(auctionId);
        return;
      }

      // Update auction status to active
      // Using service client which bypasses RLS, so we can update directly
      const { data: updatedAuction, error: updateError } = await this.supabase
        .from('auctions')
        .update({ status: 'active' })
        .eq('id', auctionId)
        .eq('status', 'scheduled') // Atomic check: only update if still scheduled
        .select()
        .single();

      if (updateError) {
        // Check if error is because no rows matched (status already changed)
        if (updateError.code === 'PGRST116') {
          const { data: currentAuction } = await this.supabase
            .from('auctions')
            .select('id, status')
            .eq('id', auctionId)
            .single();
          
          if (currentAuction) {
            console.log(`[Auction ${auctionId}] Update failed - current status is: '${currentAuction.status}'. Likely already processed by another instance.`);
            if (currentAuction.status === 'active') {
              console.log(`[Auction ${auctionId}] Already active - no action needed.`);
            }
          }
          return;
        }
        
        console.error(`[Auction ${auctionId}] Error starting auction:`, updateError);
        return;
      }

      if (!updatedAuction) {
        console.log(`[Auction ${auctionId}] Update returned no data. Checking current status...`);
        const { data: currentAuction } = await this.supabase
          .from('auctions')
          .select('id, status')
          .eq('id', auctionId)
          .single();
        
        if (currentAuction) {
          console.log(`[Auction ${auctionId}] Current status: '${currentAuction.status}'`);
        }
        return;
      }

      console.log(`✅ [Auction ${auctionId}] Successfully started - status changed from 'scheduled' to 'active'`);

      // Log auction start event
      await this.supabase
        .from('auction_events')
        .insert({
          auction_id: auctionId,
          event_type: 'auction_started',
          event_data: { timestamp: new Date().toISOString() },
          auctioneer_message: 'Welcome to this auction! Bidding is now open.',
        });

      // Broadcast auction start
      await this.auctionGateway.broadcastAuctionStatusChange(auctionId, 'active', {
        message: 'Auction has started! Bidding is now open.',
      });

    } catch (error) {
      console.error(`Error starting auction ${auctionId}:`, error);
    }
  }

  /**
   * End an individual auction
   */
  private async endAuction(auction: any) {
    try {
      let newStatus = 'ended';
      let eventMessage = 'Auction has ended.';

      // Check if auction has bids and reserve price is met
      if (auction.current_bid > 0) {
        const reserveMet = !auction.reserve_price || auction.current_bid >= auction.reserve_price;

        if (reserveMet) {
          newStatus = 'sold';
          eventMessage = `Auction sold! Winning bid: ${auction.current_bid} Freti`;

          // Create sale record
          await this.supabase
            .from('auction_sales')
            .insert({
              auction_id: auction.id,
              seller_id: auction.seller_id,
              buyer_id: auction.winner_id,
              final_bid_amount: auction.current_bid,
              commission_amount: auction.current_bid * 0.05, // 5% commission
              total_amount: auction.current_bid,
              payment_status: 'pending',
            });
        } else {
          eventMessage = `Auction ended. Reserve price not met.`;
        }
      }

      // Update auction status
      const { error } = await this.supabase
        .from('auctions')
        .update({
          status: newStatus,
          winning_bid: auction.current_bid,
          updated_at: new Date().toISOString(),
        })
        .eq('id', auction.id);

      if (error) {
        console.error(`Error ending auction ${auction.id}:`, error);
        return;
      }

      // Log auction end event
      await this.supabase
        .from('auction_events')
        .insert({
          auction_id: auction.id,
          event_type: newStatus === 'sold' ? 'sold' : 'auction_ended',
          event_data: {
            final_bid: auction.current_bid,
            winner_id: auction.winner_id,
            reserve_met: newStatus === 'sold',
          },
          auctioneer_message: eventMessage,
        });

      // Broadcast auction end
      await this.auctionGateway.broadcastAuctionStatusChange(auction.id, newStatus, {
        message: eventMessage,
        final_bid: auction.current_bid,
        winner_id: auction.winner_id,
      });

      // Send notifications if auction was sold
      if (newStatus === 'sold' && auction.winner_id) {
        try {
          // Notify winner
          await this.sendWinnerNotification(auction.id, auction.winner_id, auction.title, auction.current_bid);

          // Notify seller
          await this.sendSellerNotification(auction.id, auction.seller_id, auction.title, auction.current_bid);
        } catch (error) {
          console.error(`Failed to send auction end notifications for ${auction.id}:`, error);
        }
      }

      // Process payment if auction was sold
      if (newStatus === 'sold') {
        try {
          const paymentResult = await this.auctionPaymentService.processWinningBidPayment(auction.id);
          console.log(`Payment processing for auction ${auction.id}:`, paymentResult.message);
        } catch (error) {
          console.error(`Failed to process payment for auction ${auction.id}:`, error);
        }
      }

      console.log(`Ended auction: ${auction.id} with status: ${newStatus}`);

    } catch (error) {
      console.error(`Error ending auction ${auction.id}:`, error);
    }
  }

  /**
   * Mark an auction as ended without going through active state
   * Used for auctions that were never started on time
   */
  private async markAuctionAsExpired(auctionId: string) {
    try {
      const { error } = await this.supabase
        .from('auctions')
        .update({ 
          status: 'ended', 
          updated_at: new Date().toISOString() 
        })
        .eq('id', auctionId);

      if (error) {
        console.error(`Error marking auction ${auctionId} as expired:`, error);
        return;
      }

      // Log the expiration
      await this.supabase
        .from('auction_events')
        .insert({
          auction_id: auctionId,
          event_type: 'auction_expired',
          event_data: { 
            timestamp: new Date().toISOString(),
            reason: 'Auction expired before it could start'
          },
          auctioneer_message: 'This auction has expired.',
        });

      console.log(`Marked auction as expired: ${auctionId}`);

    } catch (error) {
      console.error(`Error marking auction ${auctionId} as expired:`, error);
    }
  }

  /**
   * Extend auction due to soft close
   */
  private async extendAuction(auctionId: string, extensionSeconds: number) {
    try {
      const { data: auction, error: fetchError } = await this.supabase
        .from('auctions')
        .select('end_time')
        .eq('id', auctionId)
        .single();

      if (fetchError || !auction) {
        return;
      }

      const newEndTime = new Date(new Date(auction.end_time).getTime() + extensionSeconds * 1000);

      const { error } = await this.supabase
        .from('auctions')
        .update({
          end_time: newEndTime.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', auctionId);

      if (error) {
        console.error(`Error extending auction ${auctionId}:`, error);
        return;
      }

      // Log extension event
      await this.supabase
        .from('auction_events')
        .insert({
          auction_id: auctionId,
          event_type: 'auction_extended',
          event_data: {
            extension_seconds: extensionSeconds,
            new_end_time: newEndTime.toISOString(),
          },
          auctioneer_message: `Auction extended due to recent bidding activity. New end time: ${newEndTime.toLocaleString()}`,
        });

      // Broadcast extension
      await this.auctionGateway.broadcastAuctionStatusChange(auctionId, 'extended', {
        message: 'Auction extended due to recent bidding activity',
        new_end_time: newEndTime.toISOString(),
        extension_seconds: extensionSeconds,
      });

      console.log(`Extended auction: ${auctionId} by ${extensionSeconds} seconds`);

    } catch (error) {
      console.error(`Error extending auction ${auctionId}:`, error);
    }
  }

  /**
   * Send notification to auction winner
   */
  private async sendWinnerNotification(auctionId: string, winnerId: string, auctionTitle: string, winningBid: number) {
    try {
      await this.supabase
        .from('notifications')
        .insert({
          user_id: winnerId,
          type: 'auction_won',
          title: '🎉 Congratulations! You Won the Auction!',
          message: `You've won "${auctionTitle}" with a bid of ₣${winningBid.toFixed(2)}. Proceed to checkout to complete your purchase.`,
          data: {
            auction_id: auctionId,
            auction_title: auctionTitle,
            winning_bid: winningBid,
            action: 'checkout',
          },
          created_at: new Date().toISOString(),
        });

      // Broadcast to winner's socket if connected
      await this.auctionGateway.notifyAuctionWinner(winnerId, auctionId, auctionTitle, winningBid);

      console.log(`Sent winner notification to user ${winnerId} for auction ${auctionId}`);
    } catch (error) {
      console.error(`Error sending winner notification:`, error);
    }
  }

  /**
   * Send notification to auction seller
   */
  private async sendSellerNotification(auctionId: string, sellerId: string, auctionTitle: string, finalBid: number) {
    try {
      await this.supabase
        .from('notifications')
        .insert({
          user_id: sellerId,
          type: 'auction_sold',
          title: '✅ Your Auction Has Sold!',
          message: `"${auctionTitle}" sold for ₣${finalBid.toFixed(2)}. Await payment and prepare for delivery.`,
          data: {
            auction_id: auctionId,
            auction_title: auctionTitle,
            final_bid: finalBid,
          },
          created_at: new Date().toISOString(),
        });

      console.log(`Sent seller notification to user ${sellerId} for auction ${auctionId}`);
    } catch (error) {
      console.error(`Error sending seller notification:`, error);
    }
  }
}