/**
 * FRETIKO EMAIL REMINDER SERVICE
 * Scheduled sweeps that email users about time-sensitive state:
 *
 * - auction_win_checkout_24h / _final — winners whose checkout window is
 *   expiring (48h live / 7d timed, per user_auction_wins.expires_at)
 * - auction_ending_soon — watchers + bidders of timed auctions ending <60min
 * - escrow_auto_release — buyers whose held escrow auto-releases <24h
 * - order_pending_vendor — sellers with orders pending >24h
 * - order_confirm_receipt — buyers whose delivered order is unconfirmed >24h
 *
 * All sends are deduped through the email_reminders table and gated on the
 * user's notification_settings email preferences.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { EmailNotificationService } from './email-notification.service';
import {
  auctionWinCheckoutReminderEmail,
  auctionEndingSoonEmail,
  escrowAutoReleaseEmail,
  orderPendingVendorEmail,
  orderConfirmReceiptEmail,
} from './email-templates';

const HOUR = 3600_000;
const BATCH_LIMIT = 200;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class EmailReminderService {
  private readonly logger = new Logger(EmailReminderService.name);
  private supabase;

  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailNotificationService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  private appUrl(): string {
    return this.configService.get<string>('FRONTEND_URL') || 'https://fretiko.com';
  }

  /**
   * Winners sitting in pending_checkout get a 24h reminder and a final
   * ~2h reminder before expires_at. After expiry the hold is released and
   * expire_and_promote_auction_wins moves the item to a runner-up.
   */
  @Cron('*/15 * * * *')
  async sendAuctionWinCheckoutReminders() {
    try {
      const now = Date.now();
      const in24h = new Date(now + 24 * HOUR).toISOString();

      const { data: wins, error } = await this.supabase
        .from('user_auction_wins')
        .select('id, user_id, auction_id, item_id, winning_bid, expires_at')
        .eq('status', 'pending_checkout')
        .gt('expires_at', new Date(now).toISOString())
        .lte('expires_at', in24h)
        .limit(BATCH_LIMIT);

      if (error) {
        this.logger.error(`Error fetching expiring wins: ${error.message}`);
        return;
      }
      if (!wins?.length) return;

      const titles = await this.resolveTitles(wins);

      for (const win of wins) {
        const expiresAt = new Date(win.expires_at);
        const hoursLeft = Math.max(1, Math.round((expiresAt.getTime() - now) / HOUR));
        const final = expiresAt.getTime() - now <= 2 * HOUR;
        const title = titles.get(win.item_id || win.auction_id) || 'an auction item';

        await this.emailService.sendUserEmail(win.user_id, {
          subject: final
            ? `Final reminder: your win on "${title}" expires soon`
            : `Reminder: complete checkout for "${title}"`,
          category: 'auction',
          reminder: {
            type: final ? 'auction_win_checkout_final' : 'auction_win_checkout_24h',
            entityType: 'auction_win',
            entityId: win.id,
          },
          buildHtml: ({ name }) =>
            auctionWinCheckoutReminderEmail({
              name,
              title,
              amount: win.winning_bid,
              expiresAt,
              hoursLeft,
              appUrl: this.appUrl(),
            }),
        });
      }
    } catch (error) {
      this.logger.error(`sendAuctionWinCheckoutReminders failed: ${errMsg(error)}`);
    }
  }

  /**
   * One email to watchers (auction_watchlist.notification_enabled) and
   * distinct bidders when a timed auction is inside its final hour.
   */
  @Cron('*/15 * * * *')
  async sendAuctionEndingSoonReminders() {
    try {
      const now = new Date();
      const in60m = new Date(now.getTime() + 60 * 60_000).toISOString();

      const { data: auctions, error } = await this.supabase
        .from('auctions')
        .select('id, title, seller_id, end_time, current_bid')
        .eq('status', 'active')
        .eq('auction_type', 'timed')
        .gt('end_time', now.toISOString())
        .lte('end_time', in60m)
        .limit(50);

      if (error) {
        this.logger.error(`Error fetching ending-soon auctions: ${error.message}`);
        return;
      }

      for (const auction of auctions || []) {
        const minutesLeft = Math.max(
          1,
          Math.round((new Date(auction.end_time).getTime() - now.getTime()) / 60_000),
        );

        const recipients = new Set<string>();

        const { data: watchers } = await this.supabase
          .from('auction_watchlist')
          .select('user_id')
          .eq('auction_id', auction.id)
          .eq('notification_enabled', true);
        (watchers || []).forEach(w => recipients.add(w.user_id));

        const { data: bids } = await this.supabase
          .from('auction_bids')
          .select('bidder_id')
          .eq('auction_id', auction.id)
          .eq('is_valid', true);
        (bids || []).forEach(b => recipients.add(b.bidder_id));

        recipients.delete(auction.seller_id);

        for (const userId of recipients) {
          await this.emailService.sendUserEmail(userId, {
            subject: `"${auction.title}" ends in ~${minutesLeft} minutes`,
            category: 'auction',
            reminder: {
              type: 'auction_ending_soon',
              entityType: 'auction',
              entityId: auction.id,
            },
            buildHtml: ({ name }) =>
              auctionEndingSoonEmail({
                name,
                title: auction.title,
                minutesLeft,
                currentBid: auction.current_bid,
                appUrl: this.appUrl(),
              }),
          });
        }
      }
    } catch (error) {
      this.logger.error(`sendAuctionEndingSoonReminders failed: ${errMsg(error)}`);
    }
  }

  /**
   * Buyers get one email ~24h before held escrow auto-releases — last call
   * to confirm receipt or open a dispute.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendEscrowAutoReleaseReminders() {
    try {
      const in24h = new Date(Date.now() + 24 * HOUR).toISOString();

      const { data: escrows, error } = await this.supabase
        .from('escrows')
        .select('id, total_amount, auto_release_at, orders!inner(id, buyer_id, order_number, status)')
        .eq('status', 'held')
        .not('auto_release_at', 'is', null)
        .lte('auto_release_at', in24h)
        .gt('auto_release_at', new Date().toISOString())
        .limit(BATCH_LIMIT);

      if (error) {
        this.logger.error(`Error fetching escrows near auto-release: ${error.message}`);
        return;
      }

      for (const escrow of escrows || []) {
        const order = Array.isArray(escrow.orders) ? escrow.orders[0] : escrow.orders;
        if (!order || ['cancelled', 'completed', 'refunded'].includes(order.status)) continue;

        await this.emailService.sendUserEmail(order.buyer_id, {
          subject: `Escrow for order #${order.order_number} releases in under 24 hours`,
          category: 'payment',
          reminder: {
            type: 'escrow_auto_release',
            entityType: 'escrow',
            entityId: escrow.id,
          },
          buildHtml: ({ name }) =>
            escrowAutoReleaseEmail({
              name,
              orderNumber: String(order.order_number ?? order.id),
              amount: escrow.total_amount,
              releaseAt: escrow.auto_release_at,
              appUrl: this.appUrl(),
            }),
        });
      }
    } catch (error) {
      this.logger.error(`sendEscrowAutoReleaseReminders failed: ${errMsg(error)}`);
    }
  }

  /**
   * Sellers get one email when an order has sat in 'pending' for over 24h.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendPendingOrderVendorReminders() {
    try {
      const cutoff = new Date(Date.now() - 24 * HOUR).toISOString();

      const { data: orders, error } = await this.supabase
        .from('orders')
        .select('id, order_number, vendor_id, total, total_amount, created_at')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .limit(BATCH_LIMIT);

      if (error) {
        this.logger.error(`Error fetching stale pending orders: ${error.message}`);
        return;
      }

      for (const order of orders || []) {
        if (!order.vendor_id) continue;

        await this.emailService.sendUserEmail(order.vendor_id, {
          subject: `Order #${order.order_number} is waiting for you`,
          category: 'order',
          reminder: {
            type: 'order_pending_vendor',
            entityType: 'order',
            entityId: order.id,
          },
          buildHtml: ({ name }) =>
            orderPendingVendorEmail({
              name,
              orderNumber: String(order.order_number ?? order.id),
              total: order.total ?? order.total_amount ?? 0,
              appUrl: this.appUrl(),
            }),
        });
      }
    } catch (error) {
      this.logger.error(`sendPendingOrderVendorReminders failed: ${errMsg(error)}`);
    }
  }

  /**
   * Buyers get one email when a delivered order is still unconfirmed 24h
   * later — ahead of the escrow auto-release reminder.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendDeliveredOrderReminders() {
    try {
      const cutoff = new Date(Date.now() - 24 * HOUR).toISOString();

      const { data: orders, error } = await this.supabase
        .from('orders')
        .select('id, order_number, buyer_id, delivered_at')
        .eq('status', 'delivered')
        .not('delivered_at', 'is', null)
        .lt('delivered_at', cutoff)
        .limit(BATCH_LIMIT);

      if (error) {
        this.logger.error(`Error fetching unconfirmed delivered orders: ${error.message}`);
        return;
      }

      for (const order of orders || []) {
        if (!order.buyer_id) continue;

        await this.emailService.sendUserEmail(order.buyer_id, {
          subject: `Did order #${order.order_number} arrive? Confirm receipt`,
          category: 'delivery',
          reminder: {
            type: 'order_confirm_receipt',
            entityType: 'order',
            entityId: order.id,
          },
          buildHtml: ({ name }) =>
            orderConfirmReceiptEmail({
              name,
              orderNumber: String(order.order_number ?? order.id),
              appUrl: this.appUrl(),
            }),
        });
      }
    } catch (error) {
      this.logger.error(`sendDeliveredOrderReminders failed: ${errMsg(error)}`);
    }
  }

  /**
   * Resolve display titles for a batch of wins — item title when the win is
   * item-scoped (live), auction title otherwise (timed).
   */
  private async resolveTitles(wins: any[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const auctionIds = [...new Set(wins.map(w => w.auction_id).filter(Boolean))];
    const itemIds = [...new Set(wins.map(w => w.item_id).filter(Boolean))];

    if (auctionIds.length) {
      const { data } = await this.supabase
        .from('auctions').select('id, title').in('id', auctionIds);
      (data || []).forEach((a: any) => titles.set(a.id, a.title));
    }
    if (itemIds.length) {
      const { data } = await this.supabase
        .from('auction_items').select('id, title').in('id', itemIds);
      (data || []).forEach((i: any) => titles.set(i.id, i.title));
    }
    return titles;
  }
}
