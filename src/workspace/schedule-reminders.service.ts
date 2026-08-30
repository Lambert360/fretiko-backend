import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createServiceSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';

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
  private supabase;

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  /**
   * Daily digest reminder - runs at 8 AM daily
   * Sends vendors a summary of all orders scheduled for today
   */
  @Cron('0 8 * * *', {
    timeZone: 'Africa/Lagos', // Adjust to your timezone
  })
  async sendDailyDigest() {
    this.logger.log('📅 Running daily digest reminder...');
    
    try {
      const today = new Date().toISOString().split('T')[0];
      const startTime = `${today}T00:00:00.000Z`;
      const endTime = `${today}T23:59:59.999Z`;

      // Fetch all service orders scheduled for today
      const { data: orders, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total_amount,
          buyer_id,
          vendor_id,
          delivery_address,
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
        .not('status', 'eq.cancelled')
        .not('status', 'eq.rejected')
        .gte('created_at', startTime)
        .lte('created_at', endTime);

      if (error) {
        this.logger.error(`Failed to fetch daily digest orders: ${error.message}`);
        return;
      }

      if (!orders || orders.length === 0) {
        this.logger.log('No orders scheduled for today');
        return;
      }

      // Filter for service orders with scheduled dates today
      const todayServiceOrders = orders.filter(order => {
        const serviceItem = order.order_items?.find(item => item.service_id || item.scheduled_date);
        const isLiveStreamService = order.source === 'live_stream' && order.metadata?.booking_type === 'service';
        const scheduledDate = serviceItem?.scheduled_date || order.metadata?.scheduled_date;
        
        if (!scheduledDate) return false;
        return scheduledDate.startsWith(today);
      });

      this.logger.log(`Found ${todayServiceOrders.length} service orders for today`);

      // Group orders by vendor
      const ordersByVendor = new Map<string, ScheduledOrder[]>();
      
      for (const order of todayServiceOrders) {
        const serviceItem = order.order_items?.find(item => item.service_id || item.scheduled_date);
        const isLiveStreamService = order.source === 'live_stream' && order.metadata?.booking_type === 'service';
        
        const scheduledOrder: ScheduledOrder = {
          id: order.id,
          orderNumber: order.order_number,
          serviceId: serviceItem?.service_id || null,
          serviceName: serviceItem?.product_name || 'Service',
          scheduledDate: serviceItem?.scheduled_date || order.metadata?.scheduled_date || null,
          scheduledTime: serviceItem?.scheduled_time || order.metadata?.scheduled_time || null,
          status: order.status,
          customerName: 'Customer', // Will be populated from profiles
          customerPhone: undefined,
          location: order.delivery_address,
          vendorId: order.vendor_id,
          buyerId: order.buyer_id,
          total: order.total_amount,
        };

        if (!ordersByVendor.has(order.vendor_id)) {
          ordersByVendor.set(order.vendor_id, []);
        }
        ordersByVendor.get(order.vendor_id)?.push(scheduledOrder);
      }

      // Fetch buyer profiles and enrich orders
      const buyerIds = [...new Set(todayServiceOrders.map(o => o.buyer_id).filter(Boolean))];
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

      // Enrich orders with customer names
      ordersByVendor.forEach((orders, vendorId) => {
        orders.forEach(order => {
          order.customerName = buyerProfiles[order.buyerId]?.username || 
                               buyerProfiles[order.buyerId]?.display_name || 
                               'Customer';
          order.customerPhone = buyerProfiles[order.buyerId]?.phone || undefined;
        });
      });

      // Send daily digest to each vendor
      for (const [vendorId, vendorOrders] of ordersByVendor) {
        try {
          await this.notificationHelper.notifyVendorDailyDigest(vendorId, vendorOrders);
          this.logger.log(`✅ Sent daily digest to vendor ${vendorId} (${vendorOrders.length} orders)`);
          
          // Create reminder records
          for (const order of vendorOrders) {
            await this.createReminderRecord(order, 'daily_digest', vendorId, order.buyerId);
          }
        } catch (notifyError) {
          this.logger.error(`Failed to send daily digest to vendor ${vendorId}:`, notifyError);
        }
      }

      this.logger.log(`✅ Daily digest complete: ${ordersByVendor.size} vendors notified`);
    } catch (error) {
      this.logger.error('Error in daily digest:', error);
    }
  }

  /**
   * Hourly reminder - runs every hour
   * Sends reminders 1 hour before scheduled service time
   */
  @Cron('0 * * * *')
  async sendHourlyReminders() {
    this.logger.log('⏰ Running hourly reminder check...');
    
    try {
      const now = new Date();
      const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
      const oneHourLaterISO = oneHourLater.toISOString();
      const oneHourFromNow = oneHourLaterISO.slice(0, 16); // YYYY-MM-DDTHH:MM

      // Fetch service orders scheduled 1 hour from now
      const { data: orders, error } = await this.supabase
        .from('orders')
        .select(`
          id,
          order_number,
          status,
          total_amount,
          buyer_id,
          vendor_id,
          delivery_address,
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
        .not('status', 'eq.cancelled')
        .not('status', 'eq.rejected')
        .in('status', ['pending', 'processing', 'ready_for_pickup']);

      if (error) {
        this.logger.error(`Failed to fetch hourly reminder orders: ${error.message}`);
        return;
      }

      if (!orders || orders.length === 0) {
        this.logger.log('No orders for hourly reminder check');
        return;
      }

      // Filter for orders scheduled 1 hour from now
      const upcomingOrders = orders.filter(order => {
        const serviceItem = order.order_items?.find(item => item.service_id || item.scheduled_date);
        const isLiveStreamService = order.source === 'live_stream' && order.metadata?.booking_type === 'service';
        const scheduledDate = serviceItem?.scheduled_date || order.metadata?.scheduled_date;
        const scheduledTime = serviceItem?.scheduled_time || order.metadata?.scheduled_time;
        
        if (!scheduledDate || !scheduledTime) return false;
        
        const scheduledDateTime = `${scheduledDate}T${scheduledTime}`;
        const scheduledHour = scheduledDateTime.slice(0, 16); // YYYY-MM-DDTHH:MM
        
        // Check if scheduled time is within 1 hour from now
        const scheduledDateObj = new Date(scheduledDateTime);
        const timeDiff = scheduledDateObj.getTime() - now.getTime();
        const isWithinOneHour = timeDiff > 0 && timeDiff <= 60 * 60 * 1000;
        const isExactHour = scheduledHour === oneHourFromNow;
        
        return isWithinOneHour || isExactHour;
      });

      this.logger.log(`Found ${upcomingOrders.length} orders for hourly reminder`);

      // Fetch buyer profiles
      const buyerIds = [...new Set(upcomingOrders.map(o => o.buyer_id).filter(Boolean))];
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

      // Send hourly reminders
      for (const order of upcomingOrders) {
        const serviceItem = order.order_items?.find(item => item.service_id || item.scheduled_date);
        const isLiveStreamService = order.source === 'live_stream' && order.metadata?.booking_type === 'service';
        
        const scheduledOrder: ScheduledOrder = {
          id: order.id,
          orderNumber: order.order_number,
          serviceId: serviceItem?.service_id || null,
          serviceName: serviceItem?.product_name || 'Service',
          scheduledDate: serviceItem?.scheduled_date || order.metadata?.scheduled_date || null,
          scheduledTime: serviceItem?.scheduled_time || order.metadata?.scheduled_time || null,
          status: order.status,
          customerName: buyerProfiles[order.buyerId]?.username || 
                       buyerProfiles[order.buyerId]?.display_name || 
                       'Customer',
          customerPhone: buyerProfiles[order.buyerId]?.phone || undefined,
          location: order.delivery_address,
          vendorId: order.vendor_id,
          buyerId: order.buyer_id,
          total: order.total_amount,
        };

        try {
          // Notify vendor
          await this.notificationHelper.notifyVendorHourlyReminder(order.vendorId, scheduledOrder);
          this.logger.log(`✅ Sent hourly reminder to vendor for order ${order.orderNumber}`);
          
          // Notify buyer
          await this.notificationHelper.notifyBuyerHourlyReminder(order.buyerId, scheduledOrder);
          this.logger.log(`✅ Sent hourly reminder to buyer for order ${order.orderNumber}`);
          
          // Create reminder record
          await this.createReminderRecord(scheduledOrder, 'hourly_reminder', order.vendor_id, order.buyerId);
        } catch (notifyError) {
          this.logger.error(`Failed to send hourly reminder for order ${order.orderNumber}:`, notifyError);
        }
      }

      this.logger.log(`✅ Hourly reminders complete: ${upcomingOrders.length} orders processed`);
    } catch (error) {
      this.logger.error('Error in hourly reminders:', error);
    }
  }

  /**
   * Create a reminder record in the database
   */
  private async createReminderRecord(
    order: ScheduledOrder,
    reminderType: 'daily_digest' | 'hourly_reminder',
    vendorId: string,
    buyerId: string,
  ): Promise<void> {
    try {
      const scheduledFor = reminderType === 'daily_digest' 
        ? `${order.scheduledDate}T08:00:00Z`
        : new Date(`${order.scheduledDate}T${order.scheduledTime}`).toISOString();

      const { error } = await this.supabase
        .from('schedule_reminders')
        .insert({
          order_id: order.id,
          vendor_id: vendorId,
          buyer_id: buyerId,
          reminder_type: reminderType,
          scheduled_for: scheduledFor,
          status: 'pending',
          metadata: {
            orderNumber: order.orderNumber,
            serviceName: order.serviceName,
            scheduledDate: order.scheduledDate,
            scheduledTime: order.scheduledTime,
          },
        });

      if (error) {
        this.logger.error(`Failed to create reminder record for order ${order.id}:`, error);
      }
    } catch (error) {
      this.logger.error('Error creating reminder record:', error);
    }
  }

  /**
   * Create reminders when a service order is accepted
   * Called from workspace service when order status changes to 'processing'
   */
  async createRemindersForAcceptedOrder(orderId: string): Promise<void> {
    try {
      // Fetch order details
      const { data: order } = await this.supabase
        .from('orders')
        .select('id, order_number, vendor_id, buyer_id, created_at, metadata')
        .eq('id', orderId)
        .single();

      if (!order) {
        this.logger.warn(`Order ${orderId} not found, skipping reminder creation`);
        return;
      }

      // Fetch service item to get scheduled date/time
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

      // Calculate reminder times
      const dailyDigestTime = `${scheduledDate}T08:00:00Z`;
      const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}`);
      const hourlyReminderTime = new Date(scheduledDateTime.getTime() - 60 * 60 * 1000).toISOString();

      // Create daily digest reminder
      await this.supabase
        .from('schedule_reminders')
        .insert({
          order_id: order.id,
          vendor_id: order.vendor_id,
          buyer_id: order.buyer_id,
          reminder_type: 'daily_digest',
          scheduled_for: dailyDigestTime,
          status: 'pending',
          metadata: {
            orderNumber: order.order_number,
            serviceName: serviceItem?.product_name || 'Service',
            scheduledDate,
            scheduledTime,
          },
        });

      // Create hourly reminder
      await this.supabase
        .from('schedule_reminders')
        .insert({
          order_id: order.id,
          vendor_id: order.vendor_id,
          buyer_id: order.buyer_id,
          reminder_type: 'hourly_reminder',
          scheduled_for: hourlyReminderTime,
          status: 'pending',
          metadata: {
            orderNumber: order.order_number,
            serviceName: serviceItem?.product_name || 'Service',
            scheduledDate,
            scheduledTime,
          },
        });

      this.logger.log(`✅ Created reminders for accepted order ${order.orderNumber}`);
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
