import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { DateTime } from 'luxon';

interface ScheduledOrder {
  id: string;
  orderNumber: string;
  serviceId: string;
  serviceName: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  customerName: string;
  customerPhone?: string;
  location?: string;
  vendorId: string;
  buyerId: string;
  total: number;
}

@Injectable()
export class ScheduleRemindersService {
  private readonly logger = new Logger(ScheduleRemindersService.name);
  private readonly DEFAULT_TIMEZONE = 'Africa/Lagos';
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  private async getVendorTimezone(vendorId: string): Promise<string> {
    try {
      const { data, error } = await this.supabase
        .from('user_profiles')
        .select('preferences')
        .eq('id', vendorId)
        .single();

      if (error) throw error;

      const tz = data?.preferences?.timezone;
      if (tz && typeof tz === 'string' && tz.length > 0) {
        return tz;
      }
    } catch (error) {
      this.logger.warn(`Could not load timezone for vendor ${vendorId}: ${error instanceof Error ? error.message : error}`);
    }
    return this.DEFAULT_TIMEZONE;
  }

  /**
   * Recompute a reminder's trigger time in a vendor's *current* timezone.
   * Vendors' timezone can change (e.g. they travel) between when an order
   * was accepted (when the reminder row was first created) and when the
   * reminder is actually due, so we can't trust a timezone baked in at
   * creation time - we have to re-derive it from the local wall-clock
   * scheduledDate/scheduledTime every time.
   */
  private computeTriggerTime(
    reminderType: 'daily_digest' | 'hourly_reminder',
    scheduledDate: string,
    scheduledTime: string,
    timezone: string,
  ): DateTime | null {
    const scheduledDateTime = DateTime.fromISO(`${scheduledDate}T${scheduledTime}`, { zone: timezone });
    if (!scheduledDateTime.isValid) return null;

    return reminderType === 'daily_digest'
      ? scheduledDateTime.startOf('day').set({ hour: 8 })
      : scheduledDateTime.minus({ hours: 1 });
  }

  /**
   * Re-sync any not-yet-due reminders' `scheduled_for` against each
   * vendor's *current* timezone, so a vendor who travels before their
   * appointment still gets reminders at the right new local time instead
   * of the time that was correct when they accepted the order.
   */
  private async resyncPendingReminderTimes(): Promise<void> {
    const nowIso = new Date().toISOString();

    const { data: upcoming, error } = await this.supabase
      .from('schedule_reminders')
      .select('id, vendor_id, reminder_type, scheduled_for, metadata')
      .eq('status', 'pending')
      .gt('scheduled_for', nowIso);

    if (error) {
      this.logger.error(`Failed to fetch upcoming reminders for timezone resync: ${error.message}`);
      return;
    }

    if (!upcoming || upcoming.length === 0) return;

    const vendorIds = [...new Set<string>(upcoming.map(r => r.vendor_id))];
    const vendorTimezones = new Map<string, string>();
    await Promise.all(vendorIds.map(async vendorId => {
      vendorTimezones.set(vendorId, await this.getVendorTimezone(vendorId));
    }));

    for (const reminder of upcoming) {
      const scheduledDate = reminder.metadata?.scheduledDate;
      const scheduledTime = reminder.metadata?.scheduledTime;
      if (!scheduledDate || !scheduledTime) continue;

      const timezone = vendorTimezones.get(reminder.vendor_id) || this.DEFAULT_TIMEZONE;
      const recomputed = this.computeTriggerTime(
        reminder.reminder_type,
        scheduledDate,
        scheduledTime,
        timezone,
      );
      if (!recomputed) continue;

      const existing = DateTime.fromISO(reminder.scheduled_for);
      // Only write back if the recomputed time actually moved (i.e. the
      // vendor's timezone changed) - avoids a pointless write every minute.
      if (Math.abs(recomputed.toUTC().diff(existing.toUTC()).as('seconds')) > 60) {
        const { error: updateError } = await this.supabase
          .from('schedule_reminders')
          .update({ scheduled_for: recomputed.toUTC().toISO() })
          .eq('id', reminder.id);

        if (updateError) {
          this.logger.error(`Failed to resync reminder ${reminder.id} to new timezone: ${updateError.message}`);
        } else {
          this.logger.log(`🌍 Resynced reminder ${reminder.id} to vendor's current timezone (${timezone})`);
        }
      }
    }
  }

  /**
   * Process all pending reminders that are due
   * Runs every minute so each vendor gets their notification at the right local time
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledReminders() {
    this.logger.log('⏰ Running scheduled reminders check...');

    try {
      await this.resyncPendingReminderTimes();

      const now = new Date().toISOString();

      const { data: reminders, error } = await this.supabase
        .from('schedule_reminders')
        .select('id, order_id, vendor_id, buyer_id, reminder_type, scheduled_for, metadata')
        .eq('status', 'pending')
        .lte('scheduled_for', now);

      if (error) {
        this.logger.error(`Failed to fetch scheduled reminders: ${error.message}`);
        return;
      }

      if (!reminders || reminders.length === 0) {
        this.logger.log('No pending reminders due');
        return;
      }

      const orderIds = [...new Set(reminders.map(r => r.order_id))];

      const { data: orders, error: ordersError } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total_amount,
          buyer_id,
          vendor_id,
          delivery_address,
          source,
          metadata,
          order_items(
            id,
            service_id,
            product_name,
            scheduled_date,
            scheduled_time,
            service_notes
          )
        `)
        .in('id', orderIds);

      if (ordersError) {
        this.logger.error(`Failed to fetch orders for reminders: ${ordersError.message}`);
        return;
      }

      const buyerIds = [...new Set((orders || []).map(o => o.buyer_id).filter(Boolean))];
      const buyerProfiles: Record<string, any> = {};

      if (buyerIds.length > 0) {
        const { data: profiles } = await this.supabase
          .from('user_profiles')
          .select('id, username, display_name, phone')
          .in('id', buyerIds);

        profiles?.forEach(p => {
          buyerProfiles[p.id] = p;
        });
      }

      const orderMap = new Map<string, ScheduledOrder>();
      for (const order of orders || []) {
        const serviceItem = order.order_items?.find(item => item.service_id || item.scheduled_date);
        const rawScheduledDate = serviceItem?.scheduled_date || order.metadata?.scheduled_date || null;
        const rawScheduledTime = serviceItem?.scheduled_time || order.metadata?.scheduled_time || null;

        if (!rawScheduledDate) continue;

        orderMap.set(order.id, {
          id: order.id,
          orderNumber: order.order_number,
          serviceId: serviceItem?.service_id || null,
          serviceName: serviceItem?.product_name || 'Service',
          scheduledDate: rawScheduledDate.split('T')[0],
          scheduledTime: rawScheduledTime,
          status: order.status,
          customerName: buyerProfiles[order.buyer_id]?.username || buyerProfiles[order.buyer_id]?.display_name || 'Unknown Customer',
          customerPhone: buyerProfiles[order.buyer_id]?.phone || undefined,
          location: order.delivery_address,
          vendorId: order.vendor_id,
          buyerId: order.buyer_id,
          total: order.total_amount,
        });
      }

      const dailyGroups = new Map<string, { vendorId: string; orders: ScheduledOrder[]; ids: string[] }>();
      const sentIds: string[] = [];
      const failedIds: string[] = [];

      for (const reminder of reminders) {
        const scheduledOrder = orderMap.get(reminder.order_id);
        if (!scheduledOrder) {
          failedIds.push(reminder.id);
          continue;
        }

        if (reminder.reminder_type === 'daily_digest') {
          const key = `${reminder.vendor_id}:${scheduledOrder.scheduledDate}`;
          const group: { vendorId: string; orders: ScheduledOrder[]; ids: string[] } =
            dailyGroups.get(key) || { vendorId: reminder.vendor_id, orders: [], ids: [] };
          group.orders.push(scheduledOrder);
          group.ids.push(reminder.id);
          dailyGroups.set(key, group);
        } else if (reminder.reminder_type === 'hourly_reminder') {
          try {
            await this.notificationHelper.notifyVendorHourlyReminder(reminder.vendor_id, scheduledOrder);
            await this.notificationHelper.notifyBuyerHourlyReminder(reminder.buyer_id, scheduledOrder);
            this.logger.log(`✅ Sent hourly reminder for order ${scheduledOrder.orderNumber}`);
            sentIds.push(reminder.id);
          } catch (error) {
            this.logger.error(`Failed to send hourly reminder for order ${scheduledOrder.orderNumber}:`, error);
            failedIds.push(reminder.id);
          }
        }
      }

      for (const group of dailyGroups.values()) {
        try {
          await this.notificationHelper.notifyVendorDailyDigest(group.vendorId, group.orders);
          this.logger.log(`✅ Sent daily digest to vendor ${group.vendorId} (${group.orders.length} orders)`);
          sentIds.push(...group.ids);
        } catch (error) {
          this.logger.error(`Failed to send daily digest to vendor ${group.vendorId}:`, error);
          failedIds.push(...group.ids);
        }
      }

      if (sentIds.length > 0) {
        const { error: updateError } = await this.supabase
          .from('schedule_reminders')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .in('id', sentIds);

        if (updateError) {
          this.logger.error(`Failed to mark reminders as sent: ${updateError.message}`);
        }
      }

      if (failedIds.length > 0) {
        const { error: updateError } = await this.supabase
          .from('schedule_reminders')
          .update({ status: 'failed' })
          .in('id', failedIds);

        if (updateError) {
          this.logger.error(`Failed to mark reminders as failed: ${updateError.message}`);
        }
      }

      this.logger.log(`✅ Reminder processing complete: ${sentIds.length} sent, ${failedIds.length} failed`);
    } catch (error) {
      this.logger.error('Error in scheduled reminders:', error);
    }
  }

  /**
   * Create reminders when a service order is accepted
   * Called from workspace service when order status changes to 'processing'
   */
  async createRemindersForAcceptedOrder(orderId: string): Promise<void> {
    try {
      const { data: order } = await this.supabase
        .from('orders')
        .select('id, order_number, vendor_id, buyer_id, created_at, source, metadata')
        .eq('id', orderId)
        .single();

      if (!order) {
        this.logger.warn(`Order ${orderId} not found, skipping reminder creation`);
        return;
      }

      const { data: orderItems } = await this.supabase
        .from('order_items')
        .select('scheduled_date, scheduled_time, service_id, product_name')
        .eq('order_id', orderId);

      const serviceItem = orderItems?.find(item => item.service_id || item.scheduled_date);
      const isLiveStreamService = order.source === 'live_stream' && order.metadata?.booking_type === 'service';

      if (!serviceItem && !isLiveStreamService) {
        this.logger.log(`Order ${orderId} is not a service order, skipping reminder creation`);
        return;
      }

      const scheduledDate = serviceItem?.scheduled_date || order.metadata?.scheduled_date;
      const scheduledTime = serviceItem?.scheduled_time || order.metadata?.scheduled_time;

      if (!scheduledDate || !scheduledTime) {
        this.logger.warn(`Order ${orderId} has no scheduled date/time, skipping reminder creation`);
        return;
      }

      const vendorTimezone = await this.getVendorTimezone(order.vendor_id);

      const dailyDigestTime = this.computeTriggerTime('daily_digest', scheduledDate, scheduledTime, vendorTimezone);
      const hourlyReminderTime = this.computeTriggerTime('hourly_reminder', scheduledDate, scheduledTime, vendorTimezone);

      if (!dailyDigestTime || !hourlyReminderTime) {
        this.logger.warn(`Order ${orderId} has invalid scheduled date/time in ${vendorTimezone}: ${scheduledDate}T${scheduledTime}`);
        return;
      }

      // NOTE: scheduled_for is re-synced every minute against the vendor's
      // *current* timezone (see resyncPendingReminderTimes) in case they
      // travel between now and when the reminder is due, so this initial
      // computation only needs to be correct as of right now.
      const now = DateTime.now().toUTC();

      const serviceName = serviceItem?.product_name || 'Service';

      if (dailyDigestTime > now) {
        await this.supabase
          .from('schedule_reminders')
          .insert({
            order_id: order.id,
            vendor_id: order.vendor_id,
            buyer_id: order.buyer_id,
            reminder_type: 'daily_digest',
            scheduled_for: dailyDigestTime.toISO(),
            status: 'pending',
            metadata: {
              orderNumber: order.order_number,
              serviceName,
              scheduledDate,
              scheduledTime,
            },
          });
      }

      if (hourlyReminderTime > now) {
        await this.supabase
          .from('schedule_reminders')
          .insert({
            order_id: order.id,
            vendor_id: order.vendor_id,
            buyer_id: order.buyer_id,
            reminder_type: 'hourly_reminder',
            scheduled_for: hourlyReminderTime.toISO(),
            status: 'pending',
            metadata: {
              orderNumber: order.order_number,
              serviceName,
              scheduledDate,
              scheduledTime,
            },
          });
      }

      this.logger.log(`✅ Created reminders for accepted order ${order.order_number} in ${vendorTimezone} (daily: ${dailyDigestTime.toISO()}, hourly: ${hourlyReminderTime.toISO()})`);
    } catch (error) {
      this.logger.error(`Error creating reminders for order ${orderId}:`, error);
    }
  }

  /**
   * Cancel reminders when order is cancelled
   */
  async cancelRemindersForOrder(orderId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('schedule_reminders')
        .update({ status: 'cancelled' })
        .eq('order_id', orderId)
        .eq('status', 'pending');

      if (error) {
        this.logger.error(`Failed to cancel reminders for order ${orderId}:`, error);
      } else {
        this.logger.log(`✅ Cancelled reminders for order ${orderId}`);
      }
    } catch (error) {
      this.logger.error(`Error cancelling reminders for order ${orderId}:`, error);
    }
  }
}
