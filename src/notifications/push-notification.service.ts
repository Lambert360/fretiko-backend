/**
 * FRETIKO PUSH NOTIFICATION SERVICE
 * Handles sending push notifications via Expo Push Notifications
 */

import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket, ExpoPushReceiptId } from 'expo-server-sdk';
import { NotificationsService } from './notifications.service';

@Injectable()
export class PushNotificationService {
  private expo: Expo;
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(private notificationsService: NotificationsService) {
    // Create a new Expo SDK client
    this.expo = new Expo();
  }

  /**
   * Send push notification to a user
   */
  async sendPushNotification(
    userId: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      badge?: number;
      sound?: 'default' | null;
      priority?: 'default' | 'normal' | 'high';
      channelId?: string;
    }
  ): Promise<boolean> {
    try {
      // Get user's push tokens from notification settings
      const settings = await this.notificationsService.getUserSettings(userId);
      const pushTokens = settings.expo_push_tokens || [];

      if (pushTokens.length === 0) {
        this.logger.log(`No push tokens found for user ${userId}`);
        return false;
      }

      // Filter valid push tokens
      const validTokens = pushTokens.filter(token => Expo.isExpoPushToken(token));
      
      if (validTokens.length === 0) {
        this.logger.warn(`No valid push tokens for user ${userId}`);
        return false;
      }

      // Create push messages
      const messages: ExpoPushMessage[] = validTokens.map(token => ({
        to: token,
        sound: notification.sound || 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        badge: notification.badge,
        priority: notification.priority || 'default',
        channelId: notification.channelId,
      }));

      // Send push notifications
      const ticketChunks = this.expo.chunkPushNotifications(messages);
      const tickets: ExpoPushTicket[] = [];

      for (const chunk of ticketChunks) {
        try {
          const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);
          tickets.push(...ticketChunk);
        } catch (error) {
          this.logger.error(`Failed to send push notification chunk:`, error);
        }
      }

      // Handle tickets and check for errors
      let successCount = 0;
      const invalidTokens: string[] = [];

      tickets.forEach((ticket, index) => {
        const token = validTokens[index];
        
        if (ticket.status === 'error') {
          this.logger.error(`Push notification error for token ${token}:`, ticket.message);
          
          // If token is invalid, mark it for removal
          if (ticket.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(token);
          }
        } else {
          successCount++;
        }
      });

      // Remove invalid tokens from user settings
      if (invalidTokens.length > 0) {
        await this.removeInvalidTokens(userId, invalidTokens);
      }

      this.logger.log(`Sent ${successCount}/${validTokens.length} push notifications to user ${userId}`);
      return successCount > 0;

    } catch (error) {
      this.logger.error(`Failed to send push notification to user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Send push notifications to multiple users
   */
  async sendBulkPushNotifications(
    notifications: Array<{
      userId: string;
      title: string;
      body: string;
      data?: any;
      badge?: number;
    }>
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    const sendPromises = notifications.map(async (notif) => {
      const success = await this.sendPushNotification(notif.userId, notif);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    });

    await Promise.all(sendPromises);

    this.logger.log(`Bulk push notifications: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }

  /**
   * Send notification based on notification type with appropriate formatting
   */
  async sendNotificationPush(userId: string, notification: any): Promise<boolean> {
    // Check user's notification settings first
    const settings = await this.notificationsService.getUserSettings(userId);
    
    if (!settings.push_enabled) {
      this.logger.log(`Push notifications disabled for user ${userId}`);
      return false;
    }

    // Check if this notification type is enabled
    if (!this.isNotificationTypeEnabled(notification.type, settings)) {
      this.logger.log(`Push notifications disabled for type ${notification.type} for user ${userId}`);
      return false;
    }

    // Check quiet hours
    if (this.isInQuietHours(settings)) {
      this.logger.log(`User ${userId} is in quiet hours, skipping push notification`);
      return false;
    }

    // Format notification based on type
    const pushData = this.formatNotificationForPush(notification);

    return await this.sendPushNotification(userId, pushData);
  }

  /**
   * Register a new push token for a user
   */
  async registerPushToken(userId: string, token: string): Promise<boolean> {
    try {
      if (!Expo.isExpoPushToken(token)) {
        this.logger.warn(`Invalid Expo push token: ${token}`);
        return false;
      }

      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings.expo_push_tokens || [];

      // Add token if not already exists
      if (!existingTokens.includes(token)) {
        const updatedTokens = [...existingTokens, token];
        
        await this.notificationsService.updateUserSettings(userId, {
          expo_push_tokens: updatedTokens
        });

        this.logger.log(`Registered push token for user ${userId}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to register push token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Unregister a push token for a user
   */
  async unregisterPushToken(userId: string, token: string): Promise<boolean> {
    try {
      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings.expo_push_tokens || [];
      const updatedTokens = existingTokens.filter(t => t !== token);

      if (updatedTokens.length !== existingTokens.length) {
        await this.notificationsService.updateUserSettings(userId, {
          expo_push_tokens: updatedTokens
        });

        this.logger.log(`Unregistered push token for user ${userId}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to unregister push token for user ${userId}:`, error);
      return false;
    }
  }

  // ============================================
  // PRIVATE HELPER METHODS
  // ============================================

  private async removeInvalidTokens(userId: string, invalidTokens: string[]): Promise<void> {
    try {
      const settings = await this.notificationsService.getUserSettings(userId);
      const validTokens = (settings.expo_push_tokens || []).filter(
        token => !invalidTokens.includes(token)
      );

      await this.notificationsService.updateUserSettings(userId, {
        expo_push_tokens: validTokens
      });

      this.logger.log(`Removed ${invalidTokens.length} invalid tokens for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to remove invalid tokens for user ${userId}:`, error);
    }
  }

  private isNotificationTypeEnabled(type: string, settings: any): boolean {
    switch (type) {
      case 'order':
        return settings.order_notifications;
      case 'social':
        return settings.social_notifications;
      case 'promotion':
        return settings.promotion_notifications;
      case 'system':
        return settings.system_notifications;
      case 'delivery':
        return settings.delivery_notifications;
      case 'live':
        return settings.live_notifications;
      case 'payment':
        return settings.payment_notifications;
      case 'chat':
        return settings.chat_notifications;
      default:
        return true;
    }
  }

  private isInQuietHours(settings: any): boolean {
    if (!settings.quiet_hours_enabled || !settings.quiet_start_time || !settings.quiet_end_time) {
      return false;
    }

    try {
      const now = new Date();
      const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
      
      const startTime = settings.quiet_start_time;
      const endTime = settings.quiet_end_time;

      // Handle overnight quiet hours (e.g., 22:00 to 08:00)
      if (startTime > endTime) {
        return currentTime >= startTime || currentTime <= endTime;
      } else {
        return currentTime >= startTime && currentTime <= endTime;
      }
    } catch (error) {
      this.logger.error('Error checking quiet hours:', error);
      return false;
    }
  }

  private formatNotificationForPush(notification: any): any {
    // Get appropriate emoji and formatting based on notification type
    const typeConfig = this.getNotificationTypeConfig(notification.type);
    
    // Calculate badge count (unread notifications)
    // Note: This would ideally be fetched from the database, but we'll use priority as a simple indicator
    const badge = notification.priority === 'high' ? 1 : undefined;

    return {
      title: `${typeConfig.emoji} ${notification.title}`,
      body: notification.message,
      data: {
        notificationId: notification.id,
        type: notification.type,
        userId: notification.user_id,
        ...notification.data
      },
      badge,
      sound: notification.priority === 'high' ? 'default' : 'default',
      priority: notification.priority === 'high' ? 'high' : 'normal',
      channelId: `fretiko_${notification.type}`
    };
  }

  private getNotificationTypeConfig(type: string): { emoji: string; channel: string } {
    switch (type) {
      case 'order':
        return { emoji: '📦', channel: 'orders' };
      case 'social':
        return { emoji: '👥', channel: 'social' };
      case 'promotion':
        return { emoji: '🎉', channel: 'promotions' };
      case 'system':
        return { emoji: '⚙️', channel: 'system' };
      case 'delivery':
        return { emoji: '🚚', channel: 'delivery' };
      case 'live':
        return { emoji: '🔴', channel: 'live' };
      case 'payment':
        return { emoji: '💳', channel: 'payments' };
      case 'chat':
        return { emoji: '💬', channel: 'messages' };
      case 'wallet':
        return { emoji: '💰', channel: 'wallet' };
      case 'deposit':
        return { emoji: '💵', channel: 'wallet' };
      case 'withdrawal':
        return { emoji: '💸', channel: 'wallet' };
      case 'escrow':
        return { emoji: '🔒', channel: 'wallet' };
      case 'rewards':
        return { emoji: '⭐', channel: 'wallet' };
      default:
        return { emoji: '🔔', channel: 'general' };
    }
  }

  /**
   * Send deposit completion notification
   */
  async sendDepositNotification(
    userId: string,
    data: {
      amount: number;
      currency: string;
      fretiAmount: number;
      paymentMethod: string;
    }
  ) {
    return this.sendPushNotification(userId, {
      title: 'Deposit Completed! 💰',
      body: `Your deposit of ${data.fretiAmount.toLocaleString()} FRETI has been processed successfully.`,
      data: {
        type: 'deposit',
        amount: data.amount,
        currency: data.currency,
        fretiAmount: data.fretiAmount,
        paymentMethod: data.paymentMethod,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send withdrawal confirmation notification
   */
  async sendWithdrawalNotification(
    userId: string,
    data: {
      amount: number;
      fretiAmount: number;
      bankName: string;
      estimatedTime: string;
    }
  ) {
    return this.sendPushNotification(userId, {
      title: 'Withdrawal Initiated 💸',
      body: `Your withdrawal of ${data.fretiAmount.toLocaleString()} FRETI to ${data.bankName} has been initiated. Estimated completion: ${data.estimatedTime}`,
      data: {
        type: 'withdrawal',
        amount: data.amount,
        fretiAmount: data.fretiAmount,
        bankName: data.bankName,
        estimatedTime: data.estimatedTime,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send escrow release notification
   */
  async sendEscrowReleaseNotification(
    userId: string,
    data: {
      amount: number;
      orderNumber: string;
      vendorName?: string;
      riderName?: string;
    }
  ) {
    const title = data.vendorName 
      ? `Payment Released! 🎉 (${data.orderNumber})`
      : `Delivery Earning Released! 🚚 (${data.orderNumber})`;

    const body = data.vendorName
      ? `₣${data.amount.toLocaleString()} has been credited to your wallet for order ${data.orderNumber}.`
      : `₣${data.amount.toLocaleString()} delivery earning has been credited to your wallet for order ${data.orderNumber}.`;

    return this.sendPushNotification(userId, {
      title,
      body,
      data: {
        type: 'escrow',
        amount: data.amount,
        orderNumber: data.orderNumber,
        vendorName: data.vendorName,
        riderName: data.riderName,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send rewards credit notification
   */
  async sendRewardsNotification(
    userId: string,
    data: {
      rewardsAmount: number;
      monthlyTotal: number;
      nextCreditDate: string;
    }
  ) {
    return this.sendPushNotification(userId, {
      title: 'Rewards Credited! ⭐',
      body: `You've earned ₣${data.rewardsAmount.toLocaleString()} in rewards! Monthly total: ₣${data.monthlyTotal.toLocaleString()}`,
      data: {
        type: 'rewards',
        rewardsAmount: data.rewardsAmount,
        monthlyTotal: data.monthlyTotal,
        nextCreditDate: data.nextCreditDate,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send wallet balance alert
   */
  async sendBalanceAlert(
    userId: string,
    data: {
      balance: number;
      alertType: 'low_balance' | 'high_balance' | 'threshold_reached';
      threshold?: number;
    }
  ) {
    const messages = {
      low_balance: `Your wallet balance is low: ₣${data.balance.toLocaleString()}`,
      high_balance: `Your wallet balance is high: ₣${data.balance.toLocaleString()}`,
      threshold_reached: `Your wallet has reached ₣${data.threshold?.toLocaleString()}!`,
    };

    return this.sendPushNotification(userId, {
      title: 'Wallet Alert 💰',
      body: messages[data.alertType],
      data: {
        type: 'wallet',
        alertType: data.alertType,
        balance: data.balance,
        threshold: data.threshold,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Send transaction sync notification (for offline transactions)
   */
  async sendTransactionSyncNotification(
    userId: string,
    data: {
      syncedCount: number;
      failedCount: number;
      transactionType: 'deposit' | 'withdrawal';
    }
  ) {
    const title = data.failedCount > 0 
      ? `Transactions Synced ⚠️`
      : `Transactions Synced ✅`;

    const body = data.failedCount > 0
      ? `${data.syncedCount} ${data.transactionType}s synced, ${data.failedCount} failed. Check your transaction history.`
      : `${data.syncedCount} ${data.transactionType}s synced successfully!`;

    return this.sendPushNotification(userId, {
      title,
      body,
      data: {
        type: 'wallet',
        subType: 'transaction_sync',
        syncedCount: data.syncedCount,
        failedCount: data.failedCount,
        transactionType: data.transactionType,
        timestamp: new Date().toISOString(),
      },
    });
  }
}