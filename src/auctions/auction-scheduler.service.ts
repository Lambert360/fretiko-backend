import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { AuctionGateway } from './auction.gateway';
import { PushNotificationService } from '../notifications/push-notification.service';
import { EmailNotificationService } from '../notifications/email-notification.service';
import {
  auctionWonEmail,
  auctionWinExpiredEmail,
  auctionWinForfeitedEmail,
  auctionSaleFailedEmail,
} from '../notifications/email-templates';

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
    private pushNotificationService: PushNotificationService,
    private emailNotificationService: EmailNotificationService,
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

      // Find TIMED auctions that should end
      // Exclude live auctions - they end when auctioneer closes the stream
      const { data: auctionsToEnd, error } = await this.supabase
        .from('auctions')
        .select('id, title, seller_id, winner_id, winning_bid, current_bid, reserve_price, unique_bidders, auction_type')
        .eq('status', 'active')
        .eq('auction_type', 'timed') // Only auto-end timed auctions
        .lte('end_time', now.toISOString());

      if (error) {
        console.error('Error fetching auctions to end:', error);
        return;
      }

      for (const auction of auctionsToEnd || []) {
        console.log(`[Auction ${auction.id}] End time reached for timed auction. Ending...`);
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

      // Find auctions ending within 30 minutes (timed only — live auctions
      // carry a nominal end_time but only end via the host flow)
      const { data: endingSoonAuctions, error } = await this.supabase
        .from('auctions')
        .select('id, title, end_time')
        .eq('status', 'active')
        .eq('auction_type', 'timed')
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
   * Anti-snipe system: Extends auction end time if bids are placed near the end time
   */
  @Cron('*/30 * * * * *')
  async processSoftCloseExtensions() {
    try {
      const now = new Date();
      const extensionWindowSeconds = 300; // 5 minutes window
      const extensionThreshold = new Date(now.getTime() + extensionWindowSeconds * 1000);
      const minTimeSinceLastExtension = 60; // Don't extend again if extended within last 60 seconds

      // Find active auctions with soft close enabled that are about to end
      // and have bids within the extension window
      const { data: activeAuctions, error: auctionsError } = await this.supabase
        .from('auctions')
        .select(`
          id,
          end_time,
          soft_close_enabled,
          soft_close_extension,
          last_extended_at
        `)
        .eq('status', 'active')
        .eq('soft_close_enabled', true)
        .eq('auction_type', 'timed')
        .gte('end_time', now.toISOString()) // Not ended yet
        .lte('end_time', extensionThreshold.toISOString()); // Within extension window

      if (auctionsError) {
        console.error('Error fetching auctions for soft close:', auctionsError);
        return;
      }

      if (!activeAuctions || activeAuctions.length === 0) {
        return;
      }

      // For each auction, check if there's a recent bid within the extension window
      for (const auction of activeAuctions) {
        const endTime = new Date(auction.end_time);
        const extensionWindowStart = new Date(endTime.getTime() - extensionWindowSeconds * 1000);
        
        // Check if auction was extended recently (within last 60 seconds)
        // This prevents duplicate extensions from multiple cron runs.
        // NOTE: uses last_extended_at — NOT updated_at, which the bid trigger
        // bumps on every bid (a sniping bid would otherwise suppress the
        // extension it should trigger).
        if (auction.last_extended_at) {
          const lastExtended = new Date(auction.last_extended_at);
          const secondsSinceLastExtension = (now.getTime() - lastExtended.getTime()) / 1000;

          if (secondsSinceLastExtension < minTimeSinceLastExtension) {
            continue;
          }
        }
        
        // Check for bids within the extension window (5 minutes before end time)
        const { data: recentBids, error: bidsError } = await this.supabase
          .from('auction_bids')
          .select('id, created_at')
          .eq('auction_id', auction.id)
          .gte('created_at', extensionWindowStart.toISOString())
          .lte('created_at', endTime.toISOString())
          .limit(1);

        if (bidsError) {
          console.error(`Error checking bids for auction ${auction.id}:`, bidsError);
          continue;
        }

        // If there's a recent bid, extend the auction
        if (recentBids && recentBids.length > 0) {
          console.log(`🔄 Extending auction ${auction.id} due to recent bid`);
        await this.extendAuction(auction.id, auction.soft_close_extension);
        }
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
        seller_id: updatedAuction.seller_id,
        auction_type: updatedAuction.auction_type,
      });

      // Notify watchers — the auction they bookmarked just went live
      await this.notifyWatchers(
        auctionId,
        'auction_started',
        '🔔 Watched Auction Started',
        `"${updatedAuction.title}" is now live — bidding is open.`,
        {
          auction_id: auctionId,
          auction_title: updatedAuction.title,
          auction_type: updatedAuction.auction_type,
        },
      );

    } catch (error) {
      console.error(`Error starting auction ${auctionId}:`, error);
    }
  }

  /**
   * End an individual auction
   * All state transitions and sale/win creation now happen inside the
   * end_auction_atomic Postgres function to avoid the stale-winner race.
   */
  private async endAuction(auction: any) {
    try {
      const { data: result, error } = await this.supabase
        .rpc('end_auction_atomic', {
          p_auction_id: auction.id,
        });

      if (error) {
        console.error(`Error ending auction ${auction.id}:`, error);
        return;
      }

      if (!result || !result.success) {
        console.warn(`end_auction_atomic returned failure for ${auction.id}:`, result?.error || 'Unknown error');
        return;
      }

      const newStatus = result.new_status;
      const eventMessage = result.message;
      const finalBid = result.winning_bid;
      const winnerId = result.winner_id;
      const sellerId = result.seller_id;

      // Public broadcast carries the winner's alias, not the real user id —
      // the winner learns of their win via the targeted auction_won
      // notification sent by sendWinnerNotification below.
      let winnerDisplayId: string | null = null;
      if (newStatus === 'sold' && winnerId) {
        const { data: winningBidRow } = await this.supabase
          .from('auction_bids')
          .select('bidder_display_id')
          .eq('auction_id', auction.id)
          .eq('is_valid', true)
          .eq('is_winning', true)
          .limit(1)
          .maybeSingle();
        winnerDisplayId = winningBidRow?.bidder_display_id || null;
      }

      // Broadcast auction end
      await this.auctionGateway.broadcastAuctionStatusChange(auction.id, newStatus, {
        message: eventMessage,
        final_bid: finalBid,
        bidder_display_id: winnerDisplayId,
        seller_id: sellerId,
      });

      // Send notifications if auction was sold
      if (newStatus === 'sold' && winnerId) {
        try {
          await this.sendWinnerNotification(auction.id, winnerId, auction.title, finalBid, auction.auction_type);
          await this.sendSellerNotification(auction.id, sellerId, auction.title, finalBid, auction.auction_type);
        } catch (error) {
          console.error(`Failed to send auction end notifications for ${auction.id}:`, error);
        }
      }

      // Bidders whose winner-time hold failed during settlement
      for (const entry of result.forfeited || []) {
        await this.sendForfeitNotification(auction.id, entry.bidder_id, auction.title, entry.amount);
      }

      // Notify watchers the auction ended — skip winner/seller (they get their own)
      await this.notifyWatchers(
        auction.id,
        'auction_ended',
        '🏁 Watched Auction Ended',
        newStatus === 'sold' && finalBid
          ? `"${auction.title}" ended — sold for ₣${finalBid.toFixed(2)}.`
          : `"${auction.title}" has ended.`,
        {
          auction_id: auction.id,
          auction_title: auction.title,
          auction_type: auction.auction_type,
          final_bid: finalBid,
          status: newStatus,
        },
        [winnerId, sellerId].filter(Boolean) as string[],
      );

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

      const now = new Date().toISOString();
      const { error } = await this.supabase
        .from('auctions')
        .update({
          end_time: newEndTime.toISOString(),
          last_extended_at: now,
          updated_at: now,
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
   * Send a notification to every user watching an auction who has
   * notification_enabled on their watchlist row.
   */
  private async notifyWatchers(
    auctionId: string,
    type: string,
    title: string,
    message: string,
    data: Record<string, any>,
    excludeUserIds: string[] = [],
  ) {
    try {
      const { data: watchers, error } = await this.supabase
        .from('auction_watchlist')
        .select('user_id')
        .eq('auction_id', auctionId)
        .eq('notification_enabled', true);

      if (error) {
        console.error(`Failed to load watchers for auction ${auctionId}:`, error);
        return;
      }

      const recipients = [...new Set<string>((watchers || []).map(w => w.user_id))]
        .filter(id => !excludeUserIds.includes(id));

      if (recipients.length === 0) return;

      await this.supabase.from('notifications').insert(
        recipients.map(userId => ({
          user_id: userId,
          type,
          title,
          message,
          data,
          created_at: new Date().toISOString(),
        }))
      );

      await Promise.all(
        recipients.map(userId =>
          this.pushNotificationService.sendPushNotification(userId, {
            title,
            body: message,
            data: { type, ...data },
          }),
        ),
      );

      console.log(`Notified ${recipients.length} watcher(s) for auction ${auctionId} (${type})`);
    } catch (error) {
      console.error(`Failed to notify watchers for auction ${auctionId}:`, error);
    }
  }

  /**
   * Send notification to auction winner
   */
  private async sendWinnerNotification(auctionId: string, winnerId: string, auctionTitle: string, winningBid: number, auctionType?: string) {
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
            auction_type: auctionType,
            winning_bid: winningBid,
            action: 'checkout',
          },
          created_at: new Date().toISOString(),
        });

      // Broadcast to winner's socket if connected
      await this.auctionGateway.notifyAuctionWinner(winnerId, auctionId, auctionTitle, winningBid);

      await this.pushNotificationService.sendPushNotification(winnerId, {
        title: 'Congratulations! You Won the Auction!',
        body: `You've won "${auctionTitle}" with a bid of ₣${winningBid.toFixed(2)}. Proceed to checkout to complete your purchase.`,
        data: { type: 'auction_won', auction_id: auctionId, auction_type: auctionType, action: 'checkout' },
      });

      await this.emailNotificationService.sendUserEmail(winnerId, {
        subject: `You won "${auctionTitle}"!`,
        category: 'auction',
        reminder: { type: 'auction_won', entityType: 'auction', entityId: auctionId },
        buildHtml: ({ name }) => auctionWonEmail({
          name,
          title: auctionTitle,
          amount: winningBid,
          // Timed-auction wins carry a 7-day checkout window (migration 228)
          expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });

      console.log(`Sent winner notification to user ${winnerId} for auction ${auctionId}`);
    } catch (error) {
      console.error(`Error sending winner notification:`, error);
    }
  }

  /**
   * Send notification to auction seller
   */
  private async sendSellerNotification(auctionId: string, sellerId: string, auctionTitle: string, finalBid: number, auctionType?: string) {
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
            auction_type: auctionType,
            final_bid: finalBid,
          },
          created_at: new Date().toISOString(),
        });

      await this.pushNotificationService.sendPushNotification(sellerId, {
        title: 'Your Auction Has Sold!',
        body: `"${auctionTitle}" sold for ₣${finalBid.toFixed(2)}. Await payment and prepare for delivery.`,
        data: { type: 'auction_sold', auction_id: auctionId, auction_type: auctionType },
      });

      console.log(`Sent seller notification to user ${sellerId} for auction ${auctionId}`);
    } catch (error) {
      console.error(`Error sending seller notification:`, error);
    }
  }

  /**
   * Notify a bidder whose winning bid could not be funded at settlement
   * or during runner-up promotion.
   */
  private async sendForfeitNotification(auctionId: string, bidderId: string, title: string | undefined, amount: number) {
    try {
      await this.supabase.from('notifications').insert({
        user_id: bidderId,
        type: 'auction_win_forfeited',
        title: 'Auction Win Forfeited',
        message: `Your winning bid of ₣${Number(amount).toFixed(2)} on "${title || 'an auction'}" could not be completed — insufficient wallet balance. The item went to the next bidder.`,
        data: { auction_id: auctionId, amount },
        created_at: new Date().toISOString(),
      });

      await this.pushNotificationService.sendPushNotification(bidderId, {
        title: 'Auction Win Forfeited',
        body: `Your winning bid of ₣${Number(amount).toFixed(2)} on "${title || 'an auction'}" could not be completed — insufficient wallet balance.`,
        data: { type: 'auction_win_forfeited', auction_id: auctionId },
      });

      await this.emailNotificationService.sendUserEmail(bidderId, {
        subject: `Auction win forfeited — "${title || 'an auction'}"`,
        category: 'auction',
        buildHtml: ({ name }) => auctionWinForfeitedEmail({
          name,
          title: title || 'an auction',
          amount,
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Error sending forfeit notification to ${bidderId}:`, error);
    }
  }

  /**
   * Notify a winner whose checkout window expired (their hold was released
   * and the win passed to a runner-up or the sale failed).
   */
  private async sendExpiredWinNotification(userId: string, auctionTitle: string | undefined) {
    try {
      await this.supabase.from('notifications').insert({
        user_id: userId,
        type: 'auction_win_expired',
        title: 'Auction Win Expired',
        message: `Your checkout window for "${auctionTitle || 'an auction item'}" has expired. The held funds were released back to your wallet.`,
        data: {},
        created_at: new Date().toISOString(),
      });

      await this.pushNotificationService.sendPushNotification(userId, {
        title: 'Auction Win Expired',
        body: `Your checkout window for "${auctionTitle || 'an auction item'}" has expired. The held funds were released back to your wallet.`,
        data: { type: 'auction_win_expired' },
      });

      await this.emailNotificationService.sendUserEmail(userId, {
        subject: `Your win on "${auctionTitle || 'an auction item'}" expired`,
        category: 'auction',
        buildHtml: ({ name }) => auctionWinExpiredEmail({
          name,
          title: auctionTitle || 'an auction item',
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Error sending expired-win notification to ${userId}:`, error);
    }
  }

  /**
   * Notify a runner-up promoted to winner after the previous winner's win
   * expired — same shape as the normal winner notification so the app
   * routes them to checkout.
   */
  private async sendPromotedWinnerNotification(
    userId: string, auctionId: string, itemId: string | null, title: string | undefined, amount: number,
  ) {
    try {
      const isItem = !!itemId;
      await this.supabase.from('notifications').insert({
        user_id: userId,
        type: 'auction_won',
        title: '🎉 You Won!',
        message: `You won "${title || 'an auction item'}" for ₣${Number(amount).toFixed(2)} — the previous buyer did not complete checkout. Proceed to checkout to complete your purchase.`,
        data: { auction_id: auctionId, item_id: itemId, winning_bid: amount, action: 'checkout', promoted: true },
        created_at: new Date().toISOString(),
      });

      await this.auctionGateway.sendUserNotification(userId, {
        type: isItem ? 'auction_item_won' : 'auction_won',
        title: '🎉 You Won!',
        message: `You won "${title || 'an item'}" for ₣${Number(amount).toFixed(2)}`,
        auction_id: auctionId,
        item_id: itemId,
        amount,
      });

      await this.pushNotificationService.sendPushNotification(userId, {
        title: 'Congratulations! You Won!',
        body: `You won "${title || 'an auction item'}" for ₣${Number(amount).toFixed(2)}. Proceed to checkout to complete your purchase.`,
        data: { type: isItem ? 'auction_item_won' : 'auction_won', auction_id: auctionId, item_id: itemId, action: 'checkout' },
      });

      await this.emailNotificationService.sendUserEmail(userId, {
        subject: `You won "${title || 'an auction item'}"!`,
        category: 'auction',
        buildHtml: ({ name }) => auctionWonEmail({
          name,
          title: title || 'an auction item',
          amount,
          promoted: true,
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Error sending promoted-winner notification to ${userId}:`, error);
    }
  }

  /**
   * Notify a seller that a sale failed — the winner and every runner-up
   * could not complete payment.
   */
  private async sendSaleFailedNotification(sellerId: string | null, auctionTitle: string | undefined) {
    if (!sellerId) return;
    try {
      await this.supabase.from('notifications').insert({
        user_id: sellerId,
        type: 'auction_sale_failed',
        title: 'Auction Sale Failed',
        message: `The sale of "${auctionTitle || 'an auction item'}" could not be completed — the winning bidders did not pay. The item was marked as passed.`,
        data: {},
        created_at: new Date().toISOString(),
      });

      await this.pushNotificationService.sendPushNotification(sellerId, {
        title: 'Auction Sale Failed',
        body: `The sale of "${auctionTitle || 'an auction item'}" could not be completed — the winning bidders did not pay.`,
        data: { type: 'auction_sale_failed' },
      });

      await this.emailNotificationService.sendUserEmail(sellerId, {
        subject: `Sale failed for "${auctionTitle || 'an auction item'}"`,
        category: 'auction',
        buildHtml: ({ name }) => auctionSaleFailedEmail({
          name,
          title: auctionTitle || 'an auction item',
          appUrl: this.configService.get('FRONTEND_URL') || 'https://fretiko.com',
        }),
      });
    } catch (error) {
      console.error(`Error sending sale-failed notification to ${sellerId}:`, error);
    }
  }

  /**
   * Expire pending auction wins that passed their checkout window (hourly).
   * expire_and_promote_auction_wins expires stale wins, releases the
   * winner-time wallet hold, promotes the next bidder who can fund a hold,
   * or fails the sale when nobody qualifies. Notifications are sent here
   * since the RPC cannot emit socket events or pushes.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireOldAuctionWins() {
    try {
      // Revert abandoned checkout claims ('checked_out' with no order_id)
      // so they re-enter the normal expiry flow below. Tolerate the RPC
      // missing on pre-229 deploys.
      const { data: reverted, error: revertError } = await this.supabase
        .rpc('revert_stale_auction_win_claims');
      if (revertError && revertError.code !== 'PGRST202') {
        console.warn('revert_stale_auction_win_claims error:', revertError.message);
      } else if (reverted > 0) {
        console.log(`Reverted ${reverted} stale auction win claim(s)`);
      }

      const { data, error } = await this.supabase.rpc('expire_and_promote_auction_wins');

      if (error) {
        console.error('Error expiring old auction wins:', error);
        return;
      }

      const result = data as any;
      const expired = result?.expired || [];
      const promoted = result?.promoted || [];
      const forfeited = result?.forfeited || [];
      const failed = result?.failed || [];

      if (expired.length === 0 && promoted.length === 0) return;

      console.log(
        `Auction wins: ${expired.length} expired, ${promoted.length} promoted, ` +
        `${forfeited.length} forfeited, ${failed.length} failed`,
      );

      // Fetch titles for notification copy
      const auctionIds = [...new Set<string>([
        ...expired.map((e: any) => e.auction_id),
        ...promoted.map((e: any) => e.auction_id),
        ...forfeited.map((e: any) => e.auction_id),
        ...failed.map((e: any) => e.auction_id),
      ].filter(Boolean))];
      const itemIds = [...new Set<string>([
        ...promoted.map((e: any) => e.item_id),
        ...forfeited.map((e: any) => e.item_id),
      ].filter(Boolean))];

      const auctionTitles = new Map<string, string>();
      const itemTitles = new Map<string, string>();

      if (auctionIds.length) {
        const { data: auctions } = await this.supabase
          .from('auctions').select('id, title, auction_type').in('id', auctionIds);
        (auctions || []).forEach((a: any) => auctionTitles.set(a.id, a.title));
      }
      if (itemIds.length) {
        const { data: items } = await this.supabase
          .from('auction_items').select('id, title').in('id', itemIds);
        (items || []).forEach((i: any) => itemTitles.set(i.id, i.title));
      }

      for (const e of expired) {
        await this.sendExpiredWinNotification(e.user_id, auctionTitles.get(e.auction_id));
      }
      for (const e of forfeited) {
        await this.sendForfeitNotification(
          e.auction_id, e.bidder_id,
          e.item_id ? (itemTitles.get(e.item_id) || auctionTitles.get(e.auction_id)) : auctionTitles.get(e.auction_id),
          e.amount,
        );
      }
      for (const e of promoted) {
        await this.sendPromotedWinnerNotification(
          e.user_id, e.auction_id, e.item_id,
          e.item_id ? itemTitles.get(e.item_id) : auctionTitles.get(e.auction_id),
          e.amount,
        );
      }
      for (const e of failed) {
        await this.sendSaleFailedNotification(e.seller_id, auctionTitles.get(e.auction_id));
      }
    } catch (error) {
      console.error('Error in expireOldAuctionWins cron:', error);
    }
  }

  /**
   * Promote items stuck in 'countdown' to 'active' (every 30 seconds).
   * The normal countdown → open transition runs on an in-process setTimeout
   * in startItemCountdown; if the process restarts mid-countdown the item
   * would stay 'countdown' forever. Any countdown item older than 10s is
   * swept here instead.
   */
  @Cron('*/30 * * * * *')
  async promoteStuckCountdownItems() {
    try {
      const threshold = new Date(Date.now() - 10 * 1000).toISOString();

      const { data: stuckItems, error } = await this.supabase
        .from('auction_items')
        .select('id, auction_id, title, starting_price, bid_increment, bidding_duration, auctions!auction_items_auction_id_fkey!inner(status)')
        .eq('bidding_status', 'countdown')
        .eq('auctions.status', 'active')
        .lt('countdown_started_at', threshold);

      if (error) {
        console.error('Error fetching stuck countdown items:', error);
        return;
      }

      for (const item of stuckItems || []) {
        const { data: openedItem } = await this.supabase
          .from('auction_items')
          .update({
            bidding_status: 'active',
            bidding_started_at: new Date().toISOString(),
          })
          .eq('id', item.id)
          .eq('bidding_status', 'countdown')
          .select('id')
          .maybeSingle();

        if (!openedItem) continue; // already resolved by the normal path

        await this.auctionGateway.broadcastItemEvent(item.auction_id, item.id, 'bidding_open', {
          item_id: item.id,
          item_title: item.title,
          starting_price: item.starting_price,
          minimum_bid: item.starting_price + item.bid_increment,
          bid_increment: item.bid_increment,
          duration: item.bidding_duration,
          timestamp: new Date().toISOString(),
        });

        console.log(`Promoted stuck countdown item ${item.id} in auction ${item.auction_id}`);
      }
    } catch (error) {
      console.error('Error in promoteStuckCountdownItems:', error);
    }
  }
}