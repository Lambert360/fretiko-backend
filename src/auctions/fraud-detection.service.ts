import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient } from '../shared/supabase.client';

export interface FraudAlert {
  type: 'shill_bidding_ip' | 'rapid_bidding' | 'seller_self_bid' | 'suspicious_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  auctionId: string;
  details?: any;
}

@Injectable()
export class AuctionFraudDetectionService {
  private readonly logger = new Logger(AuctionFraudDetectionService.name);
  private supabase;

  constructor(private configService: ConfigService) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Detect shill bidding and fraud patterns for a specific auction
   */
  async detectShillBidding(auctionId: string): Promise<FraudAlert[]> {
    const alerts: FraudAlert[] = [];

    try {
      // Get all bids for auction
      const { data: bids, error } = await this.supabase
        .from('auction_bids')
        .select('*, bidder_id, ip_address, created_at')
        .eq('auction_id', auctionId)
        .eq('is_valid', true)
        .order('created_at', { ascending: true });

      if (error || !bids || bids.length === 0) {
        return alerts;
      }

      // Check 1: Same IP addresses (potential shill bidding)
      const ipMap = new Map<string, number>();
      const bidderIpMap = new Map<string, Set<string>>();

      bids.forEach(bid => {
        if (bid.ip_address) {
          ipMap.set(bid.ip_address, (ipMap.get(bid.ip_address) || 0) + 1);

          if (!bidderIpMap.has(bid.ip_address)) {
            bidderIpMap.set(bid.ip_address, new Set());
          }
          bidderIpMap.get(bid.ip_address)!.add(bid.bidder_id);
        }
      });

      // Multiple bids from same IP
      ipMap.forEach((count, ip) => {
        if (count >= 3) {
          const uniqueBidders = bidderIpMap.get(ip)?.size || 0;
          alerts.push({
            type: 'shill_bidding_ip',
            severity: uniqueBidders > 1 ? 'high' : 'critical',
            message: `${count} bids from same IP (${uniqueBidders} different bidders)`,
            auctionId,
            details: { ip, bid_count: count, unique_bidders: uniqueBidders },
          });
        }
      });

      // Check 2: Rapid bidding (bids within 5 seconds of each other)
      const bidTimes = bids.map(b => ({
        time: new Date(b.created_at).getTime(),
        bidderId: b.bidder_id,
      }));

      for (let i = 1; i < bidTimes.length; i++) {
        const timeDiff = bidTimes[i].time - bidTimes[i - 1].time;
        if (timeDiff < 5000) {
          // Less than 5 seconds
          alerts.push({
            type: 'rapid_bidding',
            severity: 'medium',
            message: `Rapid bidding detected (${(timeDiff / 1000).toFixed(1)}s between bids)`,
            auctionId,
            details: { time_diff_ms: timeDiff },
          });
          break; // Only report once
        }
      }

      // Check 3: Seller bidding on own auction
      const { data: auction, error: auctionError } = await this.supabase
        .from('auctions')
        .select('seller_id, title')
        .eq('id', auctionId)
        .single();

      if (!auctionError && auction) {
        const sellerBids = bids.filter(b => b.bidder_id === auction.seller_id);
        if (sellerBids.length > 0) {
          alerts.push({
            type: 'seller_self_bid',
            severity: 'critical',
            message: `Seller is bidding on their own auction (${sellerBids.length} bids)`,
            auctionId,
            details: { seller_id: auction.seller_id, bid_count: sellerBids.length },
          });
        }
      }

      // Check 4: Suspicious bidding patterns (same bidders repeatedly outbidding)
      const bidderPairCounts = new Map<string, number>();
      for (let i = 1; i < bids.length; i++) {
        const currentBidder = bids[i].bidder_id;
        const previousBidder = bids[i - 1].bidder_id;

        if (currentBidder !== previousBidder) {
          const pairKey = [currentBidder, previousBidder].sort().join('|');
          bidderPairCounts.set(pairKey, (bidderPairCounts.get(pairKey) || 0) + 1);
        }
      }

      // Alert if same two bidders are back-and-forth more than 5 times
      bidderPairCounts.forEach((count, pairKey) => {
        if (count >= 5) {
          alerts.push({
            type: 'suspicious_pattern',
            severity: 'high',
            message: `Two bidders repeatedly outbidding each other (${count} times)`,
            auctionId,
            details: { bidder_pair: pairKey, interaction_count: count },
          });
        }
      });

      return alerts;
    } catch (error) {
      this.logger.error(`Error detecting fraud for auction ${auctionId}:`, error);
      return alerts;
    }
  }

  /**
   * Flag auction and create risk flag for seller
   */
  async flagAuction(auctionId: string, alerts: FraudAlert[]): Promise<void> {
    try {
      if (alerts.length === 0) {
        return;
      }

      // Get auction details
      const { data: auction, error: auctionError } = await this.supabase
        .from('auctions')
        .select('seller_id, title')
        .eq('id', auctionId)
        .single();

      if (auctionError || !auction) {
        this.logger.error(`Auction ${auctionId} not found for flagging`);
        return;
      }

      // Determine highest severity
      const severityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
      const maxSeverity = alerts.reduce((max, alert) => {
        const level = severityLevels[alert.severity] || 1;
        return level > severityLevels[max] ? alert.severity : max;
      }, 'low' as FraudAlert['severity']);

      // Create risk flag for seller
      const { error: flagError } = await this.supabase.from('risk_flags').insert({
        user_id: auction.seller_id,
        flag_type: 'fraud_investigation',
        flag_reason: `Auction fraud detected: ${alerts.map(a => a.type).join(', ')}`,
        severity: maxSeverity,
        metadata: {
          auction_id: auctionId,
          auction_title: auction.title,
          alerts: alerts.map(a => ({
            type: a.type,
            severity: a.severity,
            message: a.message,
            details: a.details,
          })),
          detected_at: new Date().toISOString(),
        },
        is_resolved: false,
      });

      if (flagError) {
        this.logger.error(`Failed to create risk flag: ${flagError.message}`);
      } else {
        this.logger.warn(
          `🚨 Auction ${auctionId} flagged for fraud (${maxSeverity}): ${alerts.length} alerts`,
        );
      }

      // Update auction status to flagged (if not already ended)
      await this.supabase
        .from('auctions')
        .update({ 
          metadata: this.supabase.raw(`metadata || '{"fraud_flagged": true}'::jsonb`),
        })
        .eq('id', auctionId);

      // Send notification to admin/support staff
      try {
        const { data: admins } = await this.supabase
          .from('staff')
          .select('user_id')
          .eq('role', 'super_admin')
          .limit(5);

        if (admins && admins.length > 0) {
          const notifications = admins.map(admin => ({
            user_id: admin.user_id,
            type: 'fraud_alert',
            title: '🚨 Fraud Alert',
            message: `Auction "${auction.title}" flagged for ${alerts.length} fraud patterns`,
            data: {
              auction_id: auctionId,
              severity: maxSeverity,
              alert_count: alerts.length,
            },
          }));

          await this.supabase.from('notifications').insert(notifications);
        }
      } catch (notifError) {
        this.logger.warn(`Failed to send admin fraud notifications: ${notifError}`);
      }
    } catch (error) {
      this.logger.error(`Error flagging auction ${auctionId}:`, error);
    }
  }

  /**
   * Nightly cron job to check active auctions for fraud
   * Runs at 2 AM every day
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyFraudDetection() {
    this.logger.log('🔍 Starting nightly fraud detection for active auctions...');

    try {
      // Get all active auctions with at least 3 bids
      const { data: auctions, error } = await this.supabase
        .from('auctions')
        .select('id, title, total_bids')
        .eq('status', 'active')
        .gte('total_bids', 3);

      if (error || !auctions || auctions.length === 0) {
        this.logger.log('No active auctions to check');
        return;
      }

      this.logger.log(`Checking ${auctions.length} active auctions...`);

      let flaggedCount = 0;
      let totalAlerts = 0;

      for (const auction of auctions) {
        const alerts = await this.detectShillBidding(auction.id);

        if (alerts.length > 0) {
          await this.flagAuction(auction.id, alerts);
          flaggedCount++;
          totalAlerts += alerts.length;
        }

        // Small delay to avoid overwhelming the database
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.logger.log(
        `✅ Nightly fraud detection complete: ${flaggedCount} auctions flagged with ${totalAlerts} total alerts`,
      );
    } catch (error) {
      this.logger.error('Error in nightly fraud detection:', error);
    }
  }

  /**
   * Manual fraud check (can be triggered by admin)
   */
  async runManualFraudCheck(auctionId: string): Promise<FraudAlert[]> {
    this.logger.log(`Running manual fraud check for auction ${auctionId}`);

    const alerts = await this.detectShillBidding(auctionId);

    if (alerts.length > 0) {
      await this.flagAuction(auctionId, alerts);
    }

    return alerts;
  }
}

