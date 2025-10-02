/**
 * FRETIKO NOTIFICATION HELPER SERVICE
 * Convenience methods for creating notifications from other services
 */

import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto, NotificationType, NotificationPriority, ActionButtonType } from './dto/notification.dto';

// Forward declare to avoid circular dependency
let NotificationsGateway: any;
let PushNotificationService: any;

@Injectable()
export class NotificationHelperService {
  private readonly logger = new Logger(NotificationHelperService.name);
  private gateway: any; // Will be injected later to avoid circular dependency
  private pushNotificationService: any; // Will be injected later

  constructor(private readonly notificationsService: NotificationsService) {}

  // Method to set the gateway reference (called from the module)
  setGateway(gateway: any) {
    this.gateway = gateway;
  }

  // Method to set the push notification service reference (called from the module)
  setPushNotificationService(pushNotificationService: any) {
    this.pushNotificationService = pushNotificationService;
  }

  // ============================================
  // ORDER NOTIFICATIONS
  // ============================================

  /**
   * Notify user when order is created
   */
  async notifyOrderCreated(userId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.ORDER,
        title: 'Order Confirmed! 🛍️',
        message: `Your order #${orderData.order_number} has been confirmed. We're preparing it for shipping!`,
        priority: NotificationPriority.MEDIUM,
        badge: 'CONFIRMED',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY },
          { label: 'Track Package', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.order_number,
          total_amount: orderData.total_amount
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created order confirmation notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create order notification:', error);
    }
  }

  /**
   * Notify user when order is shipped
   */
  async notifyOrderShipped(userId: string, orderData: any, trackingData?: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.ORDER,
        title: 'Order Shipped! 📦',
        message: trackingData 
          ? `Great news! Your order #${orderData.order_number} is on the way. Tracking: ${trackingData.tracking_number}`
          : `Great news! Your order #${orderData.order_number} has been shipped and is on the way!`,
        priority: NotificationPriority.HIGH,
        badge: 'SHIPPED',
        has_actions: true,
        action_buttons: [
          { label: 'Track Package', type: ActionButtonType.PRIMARY },
          { label: 'View Order', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.order_number,
          tracking_number: trackingData?.tracking_number,
          estimated_delivery: trackingData?.estimated_delivery
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created order shipped notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create order shipped notification:', error);
    }
  }

  /**
   * Notify user when order is delivered
   */
  async notifyOrderDelivered(userId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.ORDER,
        title: 'Order Delivered! ✅',
        message: `Your order #${orderData.order_number} has been delivered. Hope you love it!`,
        priority: NotificationPriority.MEDIUM,
        badge: 'DELIVERED',
        has_actions: true,
        action_buttons: [
          { label: 'Rate Order', type: ActionButtonType.PRIMARY },
          { label: 'Order Again', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.order_number,
          delivered_at: new Date().toISOString()
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created order delivered notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create order delivered notification:', error);
    }
  }

  // ============================================
  // PAYMENT NOTIFICATIONS  
  // ============================================

  /**
   * Notify user of successful payment
   */
  async notifyPaymentSuccess(userId: string, paymentData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.PAYMENT,
        title: 'Payment Successful! 💳',
        message: `Payment of $${paymentData.amount} for order #${paymentData.order_number} was processed successfully.`,
        priority: NotificationPriority.MEDIUM,
        badge: 'PAID',
        data: {
          payment_id: paymentData.id,
          amount: paymentData.amount,
          order_id: paymentData.order_id,
          order_number: paymentData.order_number
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created payment success notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create payment notification:', error);
    }
  }

  /**
   * Notify user of payment failure
   */
  async notifyPaymentFailed(userId: string, paymentData: any, reason?: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.PAYMENT,
        title: 'Payment Failed ❌',
        message: `Payment for order #${paymentData.order_number} failed. ${reason || 'Please try again or update your payment method.'}`,
        priority: NotificationPriority.HIGH,
        badge: 'FAILED',
        has_actions: true,
        action_buttons: [
          { label: 'Retry Payment', type: ActionButtonType.PRIMARY },
          { label: 'Update Payment', type: ActionButtonType.SECONDARY }
        ],
        data: {
          payment_id: paymentData.id,
          order_id: paymentData.order_id,
          order_number: paymentData.order_number,
          failure_reason: reason
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created payment failed notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create payment failed notification:', error);
    }
  }

  // ============================================
  // DELIVERY NOTIFICATIONS
  // ============================================

  /**
   * Notify user that rider is on the way
   */
  async notifyRiderOnTheWay(userId: string, riderData: any, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.DELIVERY,
        title: `${riderData.name} is on the way! 🏍️`,
        message: `Your delivery is on the way! ${riderData.name} will arrive in approximately ${riderData.estimated_arrival_mins || '15'} minutes.`,
        priority: NotificationPriority.HIGH,
        badge: 'ON_THE_WAY',
        has_actions: true,
        action_buttons: [
          { label: 'Track Live', type: ActionButtonType.PRIMARY },
          { label: 'Call Rider', type: ActionButtonType.SECONDARY }
        ],
        data: {
          rider_id: riderData.id,
          rider_name: riderData.name,
          rider_phone: riderData.phone,
          order_id: orderData.id,
          estimated_arrival: riderData.estimated_arrival_mins
        },
        avatar_url: riderData.avatar_url
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created rider on the way notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create rider notification:', error);
    }
  }

  /**
   * Notify user that rider is nearby
   */
  async notifyRiderNearby(userId: string, riderData: any, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.DELIVERY,
        title: `${riderData.name} is nearby! 📍`,
        message: `Your delivery is almost here! ${riderData.name} is just 2-3 minutes away. Please be ready to receive your order.`,
        priority: NotificationPriority.HIGH,
        badge: 'NEARBY',
        has_actions: true,
        action_buttons: [
          { label: 'Call Rider', type: ActionButtonType.PRIMARY },
          { label: 'View Location', type: ActionButtonType.SECONDARY }
        ],
        data: {
          rider_id: riderData.id,
          rider_name: riderData.name,
          rider_phone: riderData.phone,
          order_id: orderData.id
        },
        avatar_url: riderData.avatar_url
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created rider nearby notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create rider nearby notification:', error);
    }
  }

  // ============================================
  // SOCIAL NOTIFICATIONS
  // ============================================

  /**
   * Notify user when they receive a new connection request
   */
  async notifyConnectionRequest(userId: string, requesterData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SOCIAL,
        title: `${requesterData.username} wants to connect! 🤝`,
        message: `${requesterData.username} sent you a connection request. Check out their profile!`,
        priority: NotificationPriority.MEDIUM,
        has_actions: true,
        action_buttons: [
          { label: 'View Profile', type: ActionButtonType.PRIMARY },
          { label: 'Accept Request', type: ActionButtonType.SECONDARY }
        ],
        data: {
          requester_id: requesterData.id,
          requester_username: requesterData.username,
          connection_request_id: requesterData.connection_request_id
        },
        avatar_url: requesterData.avatar_url
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created connection request notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create connection request notification:', error);
    }
  }

  /**
   * Notify user when connection request is accepted
   */
  async notifyConnectionAccepted(userId: string, acceptorData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SOCIAL,
        title: `${acceptorData.username} accepted your request! ✨`,
        message: `Great! You and ${acceptorData.username} are now connected. Start exploring what they have to offer!`,
        priority: NotificationPriority.MEDIUM,
        has_actions: true,
        action_buttons: [
          { label: 'View Profile', type: ActionButtonType.PRIMARY },
          { label: 'Send Message', type: ActionButtonType.SECONDARY }
        ],
        data: {
          connected_user_id: acceptorData.id,
          connected_username: acceptorData.username
        },
        avatar_url: acceptorData.avatar_url
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created connection accepted notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create connection accepted notification:', error);
    }
  }

  // ============================================
  // CHAT NOTIFICATIONS
  // ============================================

  /**
   * Notify user of new message
   */
  async notifyNewMessage(userId: string, senderData: any, messageData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.CHAT,
        title: `New message from ${senderData.username}`,
        message: messageData.content?.length > 50
          ? `${messageData.content.substring(0, 47)}...`
          : messageData.content || 'Sent you a message',
        priority: NotificationPriority.MEDIUM,
        has_actions: true,
        action_buttons: [
          { label: 'Reply', type: ActionButtonType.PRIMARY },
          { label: 'View Chat', type: ActionButtonType.SECONDARY }
        ],
        data: {
          sender_id: senderData.id,
          sender_username: senderData.username,
          message_id: messageData.id,
          conversation_id: messageData.conversation_id,
          conversation_name: messageData.conversation_name,
          message_type: messageData.message_type,
          is_group: messageData.is_group
        },
        avatar_url: senderData.avatar_url
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created new message notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create message notification:', error);
    }
  }

  // ============================================
  // SYSTEM NOTIFICATIONS
  // ============================================

  /**
   * Create a system notification
   */
  async notifySystemUpdate(userId: string, title: string, message: string, data?: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SYSTEM,
        title,
        message,
        priority: NotificationPriority.LOW,
        badge: 'SYSTEM',
        data: data || {}
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created system notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create system notification:', error);
    }
  }

  /**
   * Create weekly recap notification
   */
  async notifyWeeklyRecap(userId: string, statsData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SYSTEM,
        title: 'Weekly Recap Ready 📊',
        message: `Your week on Fretiko: ${statsData.orders || 0} orders, $${statsData.saved || 0} saved, ${statsData.connections || 0} new connections!`,
        priority: NotificationPriority.LOW,
        badge: 'RECAP',
        has_actions: true,
        action_buttons: [
          { label: 'View Report', type: ActionButtonType.PRIMARY },
          { label: 'Share Stats', type: ActionButtonType.SECONDARY }
        ],
        data: {
          week_start: statsData.week_start,
          week_end: statsData.week_end,
          orders: statsData.orders,
          saved: statsData.saved,
          connections: statsData.connections
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created weekly recap notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create weekly recap notification:', error);
    }
  }

  // ============================================
  // PROMOTION NOTIFICATIONS
  // ============================================

  /**
   * Notify user of personalized deals
   */
  async notifyPersonalizedDeals(userId: string, dealsData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.PROMOTION,
        title: 'Mo found deals for you! 💎',
        message: `Based on your wishlist, I found ${dealsData.deal_count || 5} items with major discounts. The ${dealsData.top_item || 'item you wanted'} is ${dealsData.discount || '60%'} off!`,
        priority: NotificationPriority.MEDIUM,
        badge: 'AI DEALS',
        has_actions: true,
        action_buttons: [
          { label: 'View Deals', type: ActionButtonType.PRIMARY },
          { label: 'Update Wishlist', type: ActionButtonType.SECONDARY }
        ],
        data: {
          deals: dealsData.deals,
          deal_count: dealsData.deal_count,
          expires_at: dealsData.expires_at
        },
        expires_at: dealsData.expires_at,
        avatar_url: require('../../assets/moses.jpeg') // Mo's avatar
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created personalized deals notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create deals notification:', error);
    }
  }

  // ============================================
  // LIVE NOTIFICATIONS (Time-sensitive)
  // ============================================

  /**
   * Notify user of live events
   */
  async notifyLiveEvent(userId: string, eventData: any): Promise<void> {
    try {
      // Set expiration time (e.g., 1 hour from now)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1);

      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.LIVE,
        title: `${eventData.host_name} is LIVE! 🔴`,
        message: eventData.description || `${eventData.event_type} happening NOW! Don't miss out on exclusive deals and content!`,
        priority: NotificationPriority.HIGH,
        badge: 'LIVE',
        has_actions: true,
        action_buttons: [
          { label: 'Join Live', type: ActionButtonType.PRIMARY },
          { label: 'Set Reminder', type: ActionButtonType.SECONDARY }
        ],
        data: {
          event_id: eventData.id,
          host_id: eventData.host_id,
          host_name: eventData.host_name,
          event_type: eventData.event_type,
          stream_url: eventData.stream_url
        },
        expires_at: expiresAt.toISOString(),
        avatar_url: eventData.host_avatar
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created live event notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create live event notification:', error);
    }
  }

  // ============================================
  // PRIVATE HELPER METHOD
  // ============================================

  /**
   * Create notification in database, send real-time via WebSocket, and send push notification
   */
  private async createAndSendNotification(notification: CreateNotificationDto): Promise<void> {
    // Create notification in database
    const createdNotification = await this.notificationsService.createNotification(notification);
    
    if (createdNotification) {
      // Send real-time notification if gateway is available
      if (this.gateway) {
        await this.gateway.notifyUser(notification.user_id, createdNotification);
      }

      // Send push notification if service is available
      if (this.pushNotificationService) {
        await this.pushNotificationService.sendNotificationPush(notification.user_id, createdNotification);
      }
    }
  }
}