import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface NotificationPayload {
  type: 'assignment_created' | 'assignment_accepted' | 'assignment_rejected' | 'assignment_timeout' | 
        'replacement_started' | 'replacement_completed' | 'broadcast_sent' | 'broadcast_accepted' | 
        'broadcast_expired' | 'vendor_selection_needed' | 'rider_location_update';
  orderId: string;
  orderNumber: string;
  riderId?: string;
  vendorId: string;
  buyerId: string;
  timestamp: string;
  data?: any;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface NotificationTemplate {
  title: string;
  body: string;
  data?: any;
  actions?: Array<{
    id: string;
    title: string;
    url?: string;
    action?: string;
  }>;
}

export interface NotificationChannel {
  type: 'push' | 'websocket' | 'email' | 'sms';
  enabled: boolean;
  priority: number;
}

@Injectable()
export class RiderNotificationService {
  private readonly logger = new Logger(RiderNotificationService.name);
  private supabase: SupabaseClient;
  private notificationQueue: Map<string, NotificationPayload[]> = new Map();
  private processingQueue: boolean = false;

  constructor(private configService: ConfigService) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_KEY')!,
    );
  }

  // ===== MAIN NOTIFICATION METHODS =====

  async sendNotification(
    userId: string,
    payload: NotificationPayload,
    channels: NotificationChannel[] = []
  ): Promise<{ success: boolean; sent: string[]; failed: string[] }> {
    try {
      console.log(`📤 Sending notification to user ${userId}:`, payload.type);

      // Get user notification preferences
      const userPreferences = await this.getUserNotificationPreferences(userId);
      
      // Determine which channels to use
      const activeChannels = this.getActiveChannels(channels, userPreferences);
      
      // Generate notification template
      const template = this.generateNotificationTemplate(payload);
      
      // Send to each channel
      const results = await Promise.allSettled(
        activeChannels.map(channel => this.sendToChannel(userId, template, channel))
      );

      const sent = results
        .filter((result, index) => result.status === 'fulfilled')
        .map((_, index) => activeChannels[index].type);

      const failed = results
        .filter((result, index) => result.status === 'rejected')
        .map((_, index) => activeChannels[index].type);

      // Log notification for analytics
      await this.logNotification(userId, payload, sent, failed);

      return {
        success: sent.length > 0,
        sent,
        failed,
      };

    } catch (error) {
      console.error('❌ Error sending notification:', error);
      return { success: false, sent: [], failed: ['all'] };
    }
  }

  async sendBulkNotification(
    userIds: string[],
    payload: NotificationPayload,
    channels: NotificationChannel[] = []
  ): Promise<{ success: boolean; totalSent: number; totalFailed: number }> {
    try {
      console.log(`📤 Sending bulk notification to ${userIds.length} users:`, payload.type);

      const results = await Promise.allSettled(
        userIds.map(userId => this.sendNotification(userId, payload, channels))
      );

      const totalSent = results.reduce((sum, result) => {
        return sum + (result.status === 'fulfilled' ? result.value.sent.length : 0);
      }, 0);

      const totalFailed = results.reduce((sum, result) => {
        return sum + (result.status === 'fulfilled' ? result.value.failed.length : 1);
      }, 0);

      return {
        success: totalSent > 0,
        totalSent,
        totalFailed,
      };

    } catch (error) {
      console.error('❌ Error sending bulk notification:', error);
      return { success: false, totalSent: 0, totalFailed: userIds.length };
    }
  }

  // ===== SPECIALIZED NOTIFICATION METHODS =====

  async notifyRiderNewAssignment(
    riderId: string,
    assignmentData: {
      id: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      estimatedEarnings: number;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'assignment_created',
      orderId: assignmentData.id,
      orderNumber: assignmentData.orderNumber,
      riderId,
      vendorId: '', // Will be filled by database query
      buyerId: '', // Will be filled by database query
      timestamp: new Date().toISOString(),
      data: assignmentData,
      priority: 'high',
    };

    const channels: NotificationChannel[] = [
      { type: 'push', enabled: true, priority: 1 },
      { type: 'websocket', enabled: true, priority: 2 },
    ];

    await this.sendNotification(riderId, payload, channels);
  }

  async notifyRiderAssignmentAccepted(
    vendorId: string,
    buyerId: string,
    assignmentData: {
      orderId: string;
      orderNumber: string;
      riderId: string;
      riderName: string;
      estimatedPickup: string;
      estimatedDelivery: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'assignment_accepted',
      orderId: assignmentData.orderId,
      orderNumber: assignmentData.orderNumber,
      riderId: assignmentData.riderId,
      vendorId,
      buyerId,
      timestamp: new Date().toISOString(),
      data: assignmentData,
      priority: 'medium',
    };

    // Notify both vendor and buyer
    await Promise.all([
      this.sendNotification(vendorId, payload),
      this.sendNotification(buyerId, payload),
    ]);
  }

  async notifyRiderAssignmentRejected(
    vendorId: string,
    rejectionData: {
      orderId: string;
      orderNumber: string;
      riderId: string;
      reason?: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'assignment_rejected',
      orderId: rejectionData.orderId,
      orderNumber: rejectionData.orderNumber,
      riderId: rejectionData.riderId,
      vendorId,
      buyerId: '', // Will be filled by database query
      timestamp: new Date().toISOString(),
      data: rejectionData,
      priority: 'medium',
    };

    const channels: NotificationChannel[] = [
      { type: 'push', enabled: true, priority: 1 },
      { type: 'websocket', enabled: true, priority: 2 },
    ];

    await this.sendNotification(vendorId, payload, channels);
  }

  async notifyRiderAssignmentTimeout(
    vendorId: string,
    timeoutData: {
      orderId: string;
      orderNumber: string;
      riderId: string;
      replacementAttempts: number;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'assignment_timeout',
      orderId: timeoutData.orderId,
      orderNumber: timeoutData.orderNumber,
      riderId: timeoutData.riderId,
      vendorId,
      buyerId: '', // Will be filled by database query
      timestamp: new Date().toISOString(),
      data: timeoutData,
      priority: 'high',
    };

    await this.sendNotification(vendorId, payload);
  }

  async notifyVendorReplacementNeeded(
    vendorId: string,
    replacementData: {
      orderId: string;
      orderNumber: string;
      availableRiders: any[];
      deadline: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'vendor_selection_needed',
      orderId: replacementData.orderId,
      orderNumber: replacementData.orderNumber,
      vendorId,
      buyerId: '', // Will be filled by database query
      timestamp: new Date().toISOString(),
      data: replacementData,
      priority: 'urgent',
    };

    const channels: NotificationChannel[] = [
      { type: 'push', enabled: true, priority: 1 },
      { type: 'websocket', enabled: true, priority: 2 },
      { type: 'email', enabled: true, priority: 3 },
    ];

    await this.sendNotification(vendorId, payload, channels);
  }

  async notifyRiderBroadcastAssignment(
    riderId: string,
    broadcastData: {
      orderId: string;
      orderNumber: string;
      deliveryFee: number;
      pickupAddress: string;
      deliveryAddress: string;
      broadcastId: string;
      expiresAt: string;
      estimatedEarnings: number;
      distance: number;
      estimatedArrival: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'broadcast_sent',
      orderId: broadcastData.orderId,
      orderNumber: broadcastData.orderNumber,
      riderId,
      vendorId: '', // Will be filled by database query
      buyerId: '', // Will be filled by database query
      timestamp: new Date().toISOString(),
      data: broadcastData,
      priority: 'urgent',
    };

    const channels: NotificationChannel[] = [
      { type: 'push', enabled: true, priority: 1 },
      { type: 'websocket', enabled: true, priority: 2 },
    ];

    await this.sendNotification(riderId, payload, channels);
  }

  async notifyBroadcastAccepted(
    vendorId: string,
    buyerId: string,
    acceptedData: {
      orderId: string;
      orderNumber: string;
      riderId: string;
      riderName: string;
      broadcastId: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'broadcast_accepted',
      orderId: acceptedData.orderId,
      orderNumber: acceptedData.orderNumber,
      riderId: acceptedData.riderId,
      vendorId,
      buyerId,
      timestamp: new Date().toISOString(),
      data: acceptedData,
      priority: 'medium',
    };

    // Notify both vendor and buyer
    await Promise.all([
      this.sendNotification(vendorId, payload),
      this.sendNotification(buyerId, payload),
    ]);
  }

  async notifyReplacementLimitReached(
    userId: string,
    limitData: {
      orderId: string;
      orderNumber: string;
      maxAttempts: number;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'replacement_completed',
      orderId: limitData.orderId,
      orderNumber: limitData.orderNumber,
      vendorId: userId,
      buyerId: userId,
      timestamp: new Date().toISOString(),
      data: { ...limitData, status: 'limit_reached' },
      priority: 'high',
    };

    const channels: NotificationChannel[] = [
      { type: 'push', enabled: true, priority: 1 },
      { type: 'websocket', enabled: true, priority: 2 },
      { type: 'email', enabled: true, priority: 3 },
    ];

    await this.sendNotification(userId, payload, channels);
  }

  async notifyNoRidersAvailable(
    userId: string,
    noRidersData: {
      orderId: string;
      orderNumber: string;
    }
  ): Promise<void> {
    const payload: NotificationPayload = {
      type: 'replacement_completed',
      orderId: noRidersData.orderId,
      orderNumber: noRidersData.orderNumber,
      vendorId: userId,
      buyerId: userId,
      timestamp: new Date().toISOString(),
      data: { ...noRidersData, status: 'no_riders' },
      priority: 'high',
    };

    await this.sendNotification(userId, payload);
  }

  // ===== NOTIFICATION TEMPLATES =====

  private generateNotificationTemplate(payload: NotificationPayload): NotificationTemplate {
    switch (payload.type) {
      case 'assignment_created':
        return {
          title: '🚀 New Assignment Available',
          body: `Order #${payload.orderNumber.slice(-6)} - ₣${payload.data?.deliveryFee || 0} delivery fee`,
          data: payload.data,
          actions: [
            { id: 'view', title: 'View Details', action: 'view_assignment' },
            { id: 'accept', title: 'Accept', action: 'accept_assignment' },
          ],
        };

      case 'assignment_accepted':
        return {
          title: '✅ Assignment Accepted',
          body: `${payload.data?.riderName || 'Rider'} accepted Order #${payload.orderNumber.slice(-6)}`,
          data: payload.data,
          actions: [
            { id: 'track', title: 'Track Delivery', action: 'track_delivery' },
          ],
        };

      case 'assignment_rejected':
        return {
          title: '❌ Assignment Rejected',
          body: `Rider rejected Order #${payload.orderNumber.slice(-6)}${payload.data?.reason ? `: ${payload.data.reason}` : ''}`,
          data: payload.data,
          actions: [
            { id: 'find_rider', title: 'Find New Rider', action: 'find_rider' },
          ],
        };

      case 'assignment_timeout':
        return {
          title: '⏰ Assignment Timeout',
          body: `Rider assignment timed out for Order #${payload.orderNumber.slice(-6)}`,
          data: payload.data,
          actions: [
            { id: 'find_rider', title: 'Find New Rider', action: 'find_rider' },
          ],
        };

      case 'vendor_selection_needed':
        return {
          title: '🔄 Rider Replacement Needed',
          body: `Select a replacement rider for Order #${payload.orderNumber.slice(-6)} - 5 minutes remaining`,
          data: payload.data,
          actions: [
            { id: 'select_rider', title: 'Select Rider', action: 'select_rider' },
          ],
        };

      case 'broadcast_sent':
        return {
          title: '🚀 Fast-Finger Assignment',
          body: `Order #${payload.orderNumber.slice(-6)} - ₣${payload.data?.deliveryFee || 0} - First to accept wins!`,
          data: payload.data,
          actions: [
            { id: 'accept', title: 'Accept Now', action: 'accept_broadcast' },
          ],
        };

      case 'broadcast_accepted':
        return {
          title: '✅ Rider Assigned',
          body: `${payload.data?.riderName || 'Rider'} accepted Order #${payload.orderNumber.slice(-6)}`,
          data: payload.data,
          actions: [
            { id: 'track', title: 'Track Delivery', action: 'track_delivery' },
          ],
        };

      case 'replacement_completed':
        if (payload.data?.status === 'limit_reached') {
          return {
            title: '⚠️ Replacement Limit Reached',
            body: `Maximum replacement attempts (${payload.data?.maxAttempts}) reached for Order #${payload.orderNumber.slice(-6)}`,
            data: payload.data,
            actions: [
              { id: 'contact_support', title: 'Contact Support', action: 'contact_support' },
            ],
          };
        } else if (payload.data?.status === 'no_riders') {
          return {
            title: '❌ No Riders Available',
            body: `No riders available for Order #${payload.orderNumber.slice(-6)}`,
            data: payload.data,
            actions: [
              { id: 'contact_support', title: 'Contact Support', action: 'contact_support' },
            ],
          };
        }
        break;

      default:
        return {
          title: '📢 Notification',
          body: `Update for Order #${payload.orderNumber.slice(-6)}`,
          data: payload.data,
        };
    }

    return {
      title: '📢 Notification',
      body: `Update for Order #${payload.orderNumber.slice(-6)}`,
      data: payload.data,
    };
  }

  // ===== CHANNEL HANDLERS =====

  private async sendToChannel(
    userId: string,
    template: NotificationTemplate,
    channel: NotificationChannel
  ): Promise<void> {
    try {
      switch (channel.type) {
        case 'push':
          await this.sendPushNotification(userId, template);
          break;
        case 'websocket':
          await this.sendWebSocketNotification(userId, template);
          break;
        case 'email':
          await this.sendEmailNotification(userId, template);
          break;
        case 'sms':
          await this.sendSMSNotification(userId, template);
          break;
      }
    } catch (error) {
      console.error(`❌ Error sending ${channel.type} notification:`, error);
      throw error;
    }
  }

  private async sendPushNotification(userId: string, template: NotificationTemplate): Promise<void> {
    // This would integrate with a push notification service like Firebase FCM
    console.log(`📱 Sending push notification to ${userId}:`, template.title);
    
    // Mock implementation - would integrate with actual push service
    const { error } = await this.supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'push',
        title: template.title,
        body: template.body,
        data: template.data,
        created_at: new Date().toISOString(),
      });

    if (error) {
      throw new Error(`Failed to send push notification: ${error.message}`);
    }
  }

  private async sendWebSocketNotification(userId: string, template: NotificationTemplate): Promise<void> {
    // This would integrate with the WebSocket gateway
    console.log(`🔌 Sending WebSocket notification to ${userId}:`, template.title);
    
    // The actual WebSocket emission would be handled by the gateway
    // This is just logging for now
  }

  private async sendEmailNotification(userId: string, template: NotificationTemplate): Promise<void> {
    // This would integrate with an email service like SendGrid
    console.log(`📧 Sending email notification to ${userId}:`, template.title);
    
    // Mock implementation - would integrate with actual email service
    const { error } = await this.supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'email',
        title: template.title,
        body: template.body,
        data: template.data,
        created_at: new Date().toISOString(),
      });

    if (error) {
      throw new Error(`Failed to send email notification: ${error.message}`);
    }
  }

  private async sendSMSNotification(userId: string, template: NotificationTemplate): Promise<void> {
    // This would integrate with an SMS service like Twilio
    console.log(`📱 Sending SMS notification to ${userId}:`, template.title);
    
    // Mock implementation - would integrate with actual SMS service
    const { error } = await this.supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'sms',
        title: template.title,
        body: template.body,
        data: template.data,
        created_at: new Date().toISOString(),
      });

    if (error) {
      throw new Error(`Failed to send SMS notification: ${error.message}`);
    }
  }

  // ===== HELPER METHODS =====

  private async getUserNotificationPreferences(userId: string): Promise<any> {
    try {
      const { data, error } = await this.supabase
        .from('user_notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error || !data) {
        // Return default preferences
        return {
          push_enabled: true,
          websocket_enabled: true,
          email_enabled: false,
          sms_enabled: false,
          assignment_notifications: true,
          replacement_notifications: true,
          broadcast_notifications: true,
        };
      }

      return data;
    } catch (error) {
      console.error('❌ Error getting user notification preferences:', error);
      return {};
    }
  }

  private getActiveChannels(
    requestedChannels: NotificationChannel[],
    userPreferences: any
  ): NotificationChannel[] {
    const defaultChannels: NotificationChannel[] = [
      { type: 'push', enabled: userPreferences.push_enabled ?? true, priority: 1 },
      { type: 'websocket', enabled: userPreferences.websocket_enabled ?? true, priority: 2 },
      { type: 'email', enabled: userPreferences.email_enabled ?? false, priority: 3 },
      { type: 'sms', enabled: userPreferences.sms_enabled ?? false, priority: 4 },
    ];

    // If specific channels requested, filter and prioritize
    if (requestedChannels.length > 0) {
      return requestedChannels
        .filter(channel => {
          const pref = defaultChannels.find(c => c.type === channel.type);
          return pref && pref.enabled;
        })
        .sort((a, b) => a.priority - b.priority);
    }

    // Return all enabled channels sorted by priority
    return defaultChannels
      .filter(channel => channel.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  private async logNotification(
    userId: string,
    payload: NotificationPayload,
    sent: string[],
    failed: string[]
  ): Promise<void> {
    try {
      await this.supabase
        .from('notification_logs')
        .insert({
          user_id: userId,
          notification_type: payload.type,
          order_id: payload.orderId,
          sent_channels: sent,
          failed_channels: failed,
          priority: payload.priority || 'medium',
          created_at: new Date().toISOString(),
        });
    } catch (error) {
      console.error('❌ Error logging notification:', error);
    }
  }

  // ===== QUEUE MANAGEMENT =====

  async queueNotification(userId: string, payload: NotificationPayload): Promise<void> {
    if (!this.notificationQueue.has(userId)) {
      this.notificationQueue.set(userId, []);
    }
    
    this.notificationQueue.get(userId)!.push(payload);
    
    if (!this.processingQueue) {
      this.processNotificationQueue();
    }
  }

  private async processNotificationQueue(): Promise<void> {
    if (this.processingQueue) return;
    
    this.processingQueue = true;
    
    try {
      for (const [userId, notifications] of this.notificationQueue.entries()) {
        for (const notification of notifications) {
          await this.sendNotification(userId, notification);
        }
      }
      
      this.notificationQueue.clear();
    } catch (error) {
      console.error('❌ Error processing notification queue:', error);
    } finally {
      this.processingQueue = false;
    }
  }

  // ===== ANALYTICS METHODS =====

  async getNotificationStats(timeRange: string = '24h'): Promise<{
    totalSent: number;
    totalDelivered: number;
    totalFailed: number;
    deliveryRate: number;
    channelStats: Array<{
      channel: string;
      sent: number;
      delivered: number;
      failed: number;
    }>;
    typeStats: Array<{
      type: string;
      sent: number;
      delivered: number;
      failed: number;
    }>;
  }> {
    try {
      const timeFilter = this.getTimeFilter(timeRange);
      
      const { data, error } = await this.supabase
        .from('notification_logs')
        .select('*')
        .gte('created_at', timeFilter);

      if (error || !data) {
        return {
          totalSent: 0,
          totalDelivered: 0,
          totalFailed: 0,
          deliveryRate: 0,
          channelStats: [],
          typeStats: [],
        };
      }

      const stats = data.reduce((acc, log) => {
        acc.totalSent += 1;
        
        if (log.sent_channels.length > 0) {
          acc.totalDelivered += 1;
        }
        
        if (log.failed_channels.length > 0) {
          acc.totalFailed += 1;
        }

        // Channel stats
        log.sent_channels.forEach(channel => {
          const existing = acc.channelStats.find(s => s.channel === channel);
          if (existing) {
            existing.sent += 1;
            existing.delivered += 1;
          } else {
            acc.channelStats.push({
              channel,
              sent: 1,
              delivered: 1,
              failed: 0,
            });
          }
        });

        log.failed_channels.forEach(channel => {
          const existing = acc.channelStats.find(s => s.channel === channel);
          if (existing) {
            existing.failed += 1;
          } else {
            acc.channelStats.push({
              channel,
              sent: 0,
              delivered: 0,
              failed: 1,
            });
          }
        });

        // Type stats
        const existing = acc.typeStats.find(s => s.type === log.notification_type);
        if (existing) {
          existing.sent += 1;
          if (log.sent_channels.length > 0) existing.delivered += 1;
          if (log.failed_channels.length > 0) existing.failed += 1;
        } else {
          acc.typeStats.push({
            type: log.notification_type,
            sent: 1,
            delivered: log.sent_channels.length > 0 ? 1 : 0,
            failed: log.failed_channels.length > 0 ? 1 : 0,
          });
        }

        return acc;
      }, {
        totalSent: 0,
        totalDelivered: 0,
        totalFailed: 0,
        channelStats: [] as any[],
        typeStats: [] as any[],
      });

      return {
        ...stats,
        deliveryRate: stats.totalSent > 0 ? (stats.totalDelivered / stats.totalSent) * 100 : 0,
      };

    } catch (error) {
      console.error('❌ Error getting notification stats:', error);
      return {
        totalSent: 0,
        totalDelivered: 0,
        totalFailed: 0,
        deliveryRate: 0,
        channelStats: [],
        typeStats: [],
      };
    }
  }

  private getTimeFilter(timeRange: string): string {
    const now = new Date();
    switch (timeRange) {
      case '1h':
        return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    }
  }
}
