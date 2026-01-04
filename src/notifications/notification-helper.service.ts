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
        type: NotificationType.CONNECTION_REQUEST,
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
        type: NotificationType.CONNECTION_ACCEPTED,
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
  // VENDOR/RIDER/ESCROW NOTIFICATIONS
  // ============================================

  /**
   * Notify vendor of new order
   */
  async notifyVendorNewOrder(vendorId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.ORDER,
        title: 'New Order! 🎉',
        message: `You received a new order #${orderData.orderNumber} for ₣${orderData.totalAmount.toFixed(2)}`,
        priority: NotificationPriority.HIGH,
        badge: 'NEW_ORDER',
        has_actions: true,
        action_buttons: [
          { label: 'Accept Order', type: ActionButtonType.PRIMARY },
          { label: 'View Details', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          total_amount: orderData.totalAmount,
          item_count: orderData.itemCount,
          buyer_name: orderData.buyerName
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified vendor ${vendorId} of new order ${orderData.orderNumber}`);
    } catch (error) {
      this.logger.error('Failed to notify vendor of new order:', error);
    }
  }

  /**
   * Notify vendor that payment is held in escrow
   */
  async notifyVendorOrderPaid(vendorId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.PAYMENT,
        title: 'Payment Confirmed ✅',
        message: `₣${orderData.vendorAmount.toFixed(2)} is held in escrow for order #${orderData.orderNumber}`,
        priority: NotificationPriority.MEDIUM,
        badge: 'ESCROW',
        data: {
          order_id: orderData.orderId,
          order_number: orderData.orderNumber,
          vendor_amount: orderData.vendorAmount,
          escrow_id: orderData.escrowId
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified vendor ${vendorId} of payment in escrow`);
    } catch (error) {
      this.logger.error('Failed to notify vendor of payment:', error);
    }
  }

  /**
   * Notify vendor that escrow funds have been released
   */
  async notifyVendorEscrowReleased(vendorId: string, amount: number, orderNumber: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.PAYMENT,
        title: 'Payment Released! 💰',
        message: `₣${amount.toFixed(2)} has been added to your wallet for order #${orderNumber}`,
        priority: NotificationPriority.HIGH,
        badge: 'PAID',
        has_actions: true,
        action_buttons: [
          { label: 'View Wallet', type: ActionButtonType.PRIMARY },
          { label: 'Withdraw', type: ActionButtonType.SECONDARY }
        ],
        data: {
          amount: amount,
          order_number: orderNumber,
          transaction_type: 'escrow_release'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified vendor ${vendorId} of escrow release`);
    } catch (error) {
      this.logger.error('Failed to notify vendor of escrow release:', error);
    }
  }

  /**
   * Notify rider of payment released
   */
  async notifyRiderPaymentReleased(riderId: string, amount: number, orderNumber: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: riderId,
        type: NotificationType.PAYMENT,
        title: 'Delivery Fee Received! 💰',
        message: `₣${amount.toFixed(2)} delivery fee has been added to your wallet for order #${orderNumber}`,
        priority: NotificationPriority.HIGH,
        badge: 'PAID',
        has_actions: true,
        action_buttons: [
          { label: 'View Wallet', type: ActionButtonType.PRIMARY },
          { label: 'Withdraw', type: ActionButtonType.SECONDARY }
        ],
        data: {
          amount: amount,
          order_number: orderNumber,
          transaction_type: 'delivery_payment'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified rider ${riderId} of payment release`);
    } catch (error) {
      this.logger.error('Failed to notify rider of payment release:', error);
    }
  }

  /**
   * Notify rider of new delivery assignment
   */
  async notifyRiderNewAssignment(riderId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: riderId,
        type: NotificationType.ORDER,
        title: 'New Delivery Assignment 🏍️',
        message: `Pickup at ${orderData.pickupAddress}. Delivery fee: ₣${orderData.deliveryFee.toFixed(2)}`,
        priority: NotificationPriority.HIGH,
        badge: 'DELIVERY',
        has_actions: true,
        action_buttons: [
          { label: 'Start Delivery', type: ActionButtonType.PRIMARY },
          { label: 'View Route', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          delivery_fee: orderData.deliveryFee,
          pickup_address: orderData.pickupAddress,
          delivery_address: orderData.deliveryAddress,
          estimated_earnings: orderData.estimatedEarnings
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified rider ${riderId} of new assignment`);
    } catch (error) {
      this.logger.error('Failed to notify rider of assignment:', error);
    }
  }

  /**
   * Notify buyer that order has been refunded
   */
  async notifyOrderRefunded(buyerId: string, amount: number, orderNumber: string, reason: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.PAYMENT,
        title: 'Order Refunded 💵',
        message: `₣${amount.toFixed(2)} has been refunded to your wallet for order #${orderNumber}`,
        priority: NotificationPriority.HIGH,
        badge: 'REFUND',
        data: {
          amount: amount,
          order_number: orderNumber,
          reason: reason,
          transaction_type: 'refund'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified buyer ${buyerId} of refund`);
    } catch (error) {
      this.logger.error('Failed to notify buyer of refund:', error);
    }
  }

  /**
   * Notify buyer that order has been accepted by vendor
   */
  async notifyOrderAccepted(buyerId: string, orderData: any): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.ORDER,
        title: 'Order Accepted! 👍',
        message: `Your order #${orderData.orderNumber} has been accepted and is being prepared`,
        priority: NotificationPriority.MEDIUM,
        badge: 'ACCEPTED',
        has_actions: true,
        action_buttons: [
          { label: 'Track Order', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.orderId,
          order_number: orderData.orderNumber,
          vendor_id: orderData.vendorId
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified buyer ${buyerId} of order acceptance`);
    } catch (error) {
      this.logger.error('Failed to notify buyer of order acceptance:', error);
    }
  }

  // ============================================
  // DISPUTE NOTIFICATIONS
  // ============================================

  /**
   * Notify user that a dispute has been filed against them
   */
  async notifyDisputeFiled(userId: string, orderNumber: string, disputeType: string, disputeId: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SYSTEM,
        title: 'Dispute Filed ⚠️',
        message: `A dispute has been filed for order #${orderNumber}. Please review and respond.`,
        priority: NotificationPriority.HIGH,
        badge: 'DISPUTE',
        has_actions: true,
        action_buttons: [
          { label: 'View Dispute', type: ActionButtonType.PRIMARY },
          { label: 'Respond', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_number: orderNumber,
          dispute_type: disputeType,
          dispute_id: disputeId
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified user ${userId} of dispute filing`);
    } catch (error) {
      this.logger.error('Failed to notify user of dispute:', error);
    }
  }

  /**
   * Notify user that a dispute has been resolved
   */
  async notifyDisputeResolved(userId: string, orderNumber: string, resolution: string, disputeId: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.SYSTEM,
        title: 'Dispute Resolved ✅',
        message: `The dispute for order #${orderNumber} has been resolved: ${resolution.replace('_', ' ')}`,
        priority: NotificationPriority.HIGH,
        badge: 'RESOLVED',
        has_actions: true,
        action_buttons: [
          { label: 'View Details', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_number: orderNumber,
          resolution: resolution,
          dispute_id: disputeId
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified user ${userId} of dispute resolution`);
    } catch (error) {
      this.logger.error('Failed to notify user of dispute resolution:', error);
    }
  }

  /**
   * Notify user of new message in dispute thread
   */
  async notifyDisputeMessage(userId: string, disputeId: string): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.CHAT,
        title: 'New Dispute Message 💬',
        message: `You have a new message in your dispute case`,
        priority: NotificationPriority.MEDIUM,
        has_actions: true,
        action_buttons: [
          { label: 'View Message', type: ActionButtonType.PRIMARY }
        ],
        data: {
          dispute_id: disputeId
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified user ${userId} of dispute message`);
    } catch (error) {
      this.logger.error('Failed to notify user of dispute message:', error);
    }
  }

  // ============================================
  // PIN NOTIFICATIONS
  // ============================================

  /**
   * Notify rider with pickup PIN
   */
  async notifyRiderPickupPin(riderId: string, orderData: { id: string; orderNumber: string; pickupPin: string; vendorName?: string }): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: riderId,
        type: NotificationType.DELIVERY,
        title: '🔐 Pickup PIN for Order',
        message: `Pickup PIN for order #${orderData.orderNumber}: ${orderData.pickupPin}. Show this to the vendor when collecting the order.`,
        priority: NotificationPriority.HIGH,
        badge: 'PICKUP_PIN',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          pickup_pin: orderData.pickupPin,
          vendor_name: orderData.vendorName
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Sent pickup PIN to rider ${riderId} for order ${orderData.orderNumber}`);
    } catch (error) {
      this.logger.error('Failed to send pickup PIN to rider:', error);
    }
  }

  /**
   * Notify buyer with delivery PIN
   */
  async notifyBuyerDeliveryPin(buyerId: string, orderData: { id: string; orderNumber: string; deliveryPin: string }): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.DELIVERY,
        title: '🔐 Delivery PIN for Your Order',
        message: `Delivery PIN for order #${orderData.orderNumber}: ${orderData.deliveryPin}. Give this to the rider when they deliver your order.`,
        priority: NotificationPriority.HIGH,
        badge: 'DELIVERY_PIN',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          delivery_pin: orderData.deliveryPin
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Sent delivery PIN to buyer ${buyerId} for order ${orderData.orderNumber}`);
    } catch (error) {
      this.logger.error('Failed to send delivery PIN to buyer:', error);
    }
  }

  /**
   * Notify vendor with self-pickup PIN (for verification when buyer arrives)
   */
  async notifyVendorSelfPickupPin(vendorId: string, orderData: { id: string; orderNumber: string; deliveryPin: string; buyerName?: string }): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.ORDER,
        title: '🔐 Self-Pickup PIN for Order',
        message: `Pickup PIN for order #${orderData.orderNumber}: ${orderData.deliveryPin}. Ask the buyer to provide this PIN when they arrive to collect the order.`,
        priority: NotificationPriority.HIGH,
        badge: 'PICKUP_PIN',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY },
          { label: 'Mark Ready', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          delivery_pin: orderData.deliveryPin,
          buyer_name: orderData.buyerName,
          delivery_type: 'pickup'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Sent self-pickup PIN to vendor ${vendorId} for order ${orderData.orderNumber}`);
    } catch (error) {
      this.logger.error('Failed to send self-pickup PIN to vendor:', error);
    }
  }

  /**
   * Notify buyer with self-pickup PIN (to provide to vendor)
   */
  async notifyBuyerSelfPickupPin(buyerId: string, orderData: { id: string; orderNumber: string; deliveryPin: string; vendorName?: string }): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.ORDER,
        title: '🔐 Your Pickup PIN',
        message: `Your pickup PIN for order #${orderData.orderNumber}: ${orderData.deliveryPin}. Provide this PIN to ${orderData.vendorName || 'the vendor'} when collecting your order.`,
        priority: NotificationPriority.HIGH,
        badge: 'PICKUP_PIN',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY },
          { label: 'Get Directions', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          delivery_pin: orderData.deliveryPin,
          vendor_name: orderData.vendorName,
          delivery_type: 'pickup'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Sent self-pickup PIN to buyer ${buyerId} for order ${orderData.orderNumber}`);
    } catch (error) {
      this.logger.error('Failed to send self-pickup PIN to buyer:', error);
    }
  }

  /**
   * Notify buyer that self-pickup order is ready
   */
  async notifyBuyerOrderReadyForPickup(buyerId: string, orderData: { id: string; orderNumber: string; vendorName?: string; deliveryPin?: string }): Promise<void> {
    try {
      const notification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.ORDER,
        title: '✅ Order Ready for Pickup!',
        message: `Your order #${orderData.orderNumber} is ready! Visit ${orderData.vendorName || 'the vendor'} to collect it. Your PIN: ${orderData.deliveryPin}`,
        priority: NotificationPriority.HIGH,
        badge: 'READY',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY },
          { label: 'Get Directions', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          vendor_name: orderData.vendorName,
          delivery_pin: orderData.deliveryPin,
          delivery_type: 'pickup'
        }
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Notified buyer ${buyerId} that order is ready for pickup`);
    } catch (error) {
      this.logger.error('Failed to notify buyer of ready order:', error);
    }
  }

  /**
   * Notify rider and buyer that order is ready for pickup
   */
  async notifyOrderReadyForPickup(riderId: string | null, buyerId: string, orderData: { id: string; orderNumber: string; vendorName?: string }): Promise<void> {
    try {
      // Notify rider (only if rider exists, skip for self-pickup orders)
      if (riderId) {
        const riderNotification: CreateNotificationDto = {
          user_id: riderId,
          type: NotificationType.DELIVERY,
          title: '📦 Order Ready for Pickup!',
          message: `Order #${orderData.orderNumber} is ready for pickup${orderData.vendorName ? ` from ${orderData.vendorName}` : ''}. Head to the pickup location.`,
          priority: NotificationPriority.HIGH,
          badge: 'READY_FOR_PICKUP',
          has_actions: true,
          action_buttons: [
            { label: 'View Details', type: ActionButtonType.PRIMARY },
            { label: 'Navigate', type: ActionButtonType.SECONDARY }
          ],
          data: {
            order_id: orderData.id,
            order_number: orderData.orderNumber
          }
        };

        await this.createAndSendNotification(riderNotification);
      }

      // Notify buyer
      const buyerNotification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.ORDER,
        title: '✅ Order Ready!',
        message: `Your order #${orderData.orderNumber} is ready and awaiting pickup by the rider.`,
        priority: NotificationPriority.MEDIUM,
        badge: 'READY',
        has_actions: true,
        action_buttons: [
          { label: 'Track Order', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber
        }
      };

      await this.createAndSendNotification(buyerNotification);
      if (riderId) {
        this.logger.log(`Notified rider ${riderId} and buyer ${buyerId} that order ${orderData.orderNumber} is ready`);
      } else {
        this.logger.log(`Notified buyer ${buyerId} that order ${orderData.orderNumber} is ready (self-pickup)`);
      }
    } catch (error) {
      this.logger.error('Failed to notify order ready for pickup:', error);
    }
  }

  /**
   * Notify buyer and vendor that order has been delivered
   */
  async notifyOrderDelivered(buyerId: string, vendorId: string, orderData: { id: string; orderNumber: string; totalAmount: number }): Promise<void> {
    try {
      // Notify buyer
      const buyerNotification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.DELIVERY,
        title: '🎉 Order Delivered!',
        message: `Your order #${orderData.orderNumber} has been delivered! You have 24 hours to report any issues, or funds will be released automatically.`,
        priority: NotificationPriority.HIGH,
        badge: 'DELIVERED',
        has_actions: true,
        action_buttons: [
          { label: 'Confirm & Release Funds', type: ActionButtonType.PRIMARY },
          { label: 'Report Issue', type: ActionButtonType.SECONDARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber,
          total_amount: orderData.totalAmount
        }
      };

      await this.createAndSendNotification(buyerNotification);

      // Notify vendor
      const vendorNotification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.ORDER,
        title: '📬 Order Delivered',
        message: `Order #${orderData.orderNumber} has been delivered to the customer. Funds will be released in 24 hours.`,
        priority: NotificationPriority.MEDIUM,
        badge: 'DELIVERED',
        has_actions: true,
        action_buttons: [
          { label: 'View Order', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber
        }
      };

      await this.createAndSendNotification(vendorNotification);
      this.logger.log(`Notified buyer ${buyerId} and vendor ${vendorId} that order ${orderData.orderNumber} was delivered`);
    } catch (error) {
      this.logger.error('Failed to notify order delivered:', error);
    }
  }

  /**
   * Notify all parties that order pickup was confirmed
   */
  async notifyOrderPickedUp(buyerId: string, vendorId: string, orderData: { id: string; orderNumber: string; riderName?: string }): Promise<void> {
    try {
      // Notify buyer
      const buyerNotification: CreateNotificationDto = {
        user_id: buyerId,
        type: NotificationType.DELIVERY,
        title: '🚴 Order Picked Up!',
        message: `Your order #${orderData.orderNumber} has been picked up${orderData.riderName ? ` by ${orderData.riderName}` : ''} and is on the way!`,
        priority: NotificationPriority.HIGH,
        badge: 'OUT_FOR_DELIVERY',
        has_actions: true,
        action_buttons: [
          { label: 'Track Live', type: ActionButtonType.PRIMARY }
        ],
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber
        }
      };

      await this.createAndSendNotification(buyerNotification);

      // Notify vendor
      const vendorNotification: CreateNotificationDto = {
        user_id: vendorId,
        type: NotificationType.ORDER,
        title: '✅ Order Picked Up',
        message: `Order #${orderData.orderNumber} has been picked up by the rider and is now out for delivery.`,
        priority: NotificationPriority.MEDIUM,
        badge: 'OUT_FOR_DELIVERY',
        data: {
          order_id: orderData.id,
          order_number: orderData.orderNumber
        }
      };

      await this.createAndSendNotification(vendorNotification);
      this.logger.log(`Notified buyer ${buyerId} and vendor ${vendorId} that order ${orderData.orderNumber} was picked up`);
    } catch (error) {
      this.logger.error('Failed to notify order picked up:', error);
    }
  }

  // ============================================
  // USER WARNING NOTIFICATIONS
  // ============================================

  /**
   * Notify user when they receive a warning
   */
  async notifyUserWarning(userId: string, warningData: {
    warningId: string;
    severity: 'low' | 'medium' | 'high';
    reason: string;
    warningCount: number;
    relatedContentId?: string;
    relatedContentType?: string;
  }): Promise<void> {
    try {
      const severityLabels = {
        low: 'Low',
        medium: 'Medium',
        high: 'High',
      };

      const notification: CreateNotificationDto = {
        user_id: userId,
        type: NotificationType.USER_WARNING,
        title: `Warning: ${severityLabels[warningData.severity]} Severity`,
        message: warningData.reason,
        priority: warningData.severity === 'high' ? NotificationPriority.HIGH : NotificationPriority.MEDIUM,
        badge: 'WARNING',
        has_actions: true,
        action_buttons: [
          { label: 'View Account Status', type: ActionButtonType.PRIMARY },
        ],
        data: {
          warning_id: warningData.warningId,
          severity: warningData.severity,
          warning_count: warningData.warningCount,
          reason: warningData.reason,
          related_content_id: warningData.relatedContentId,
          related_content_type: warningData.relatedContentType,
        },
      };

      await this.createAndSendNotification(notification);
      this.logger.log(`Created warning notification for user ${userId}`);
    } catch (error) {
      this.logger.error('Failed to create warning notification:', error);
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