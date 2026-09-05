/**
 * FRETIKO PUSH NOTIFICATION SERVICE
 * Handles sending push notifications via Expo Push Notifications
 */

import { Injectable, Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket, ExpoPushReceiptId } from 'expo-server-sdk';
import { connect } from 'http2';
import { sign } from 'jsonwebtoken';
import axios from 'axios';
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
      title?: string;
      body?: string;
      data?: any;
      badge?: number;
      sound?: 'default' | null;
      priority?: 'default' | 'normal' | 'high';
      channelId?: string;
      _contentAvailable?: boolean;
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
        _contentAvailable: notification._contentAvailable,
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

      const fcmSent = await this.sendFcmNotification(userId, notification);

      this.logger.log(`Sent ${successCount}/${validTokens.length} Expo and FCM=${fcmSent} push notifications to user ${userId}`);
      return successCount > 0 || fcmSent;

    } catch (error) {
      this.logger.error(`Failed to send push notification to user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Send FCM (Firebase Cloud Messaging) v1 notification to a user's Android tokens.
   */
  private async sendFcmNotification(
    userId: string,
    notification: {
      title?: string;
      body?: string;
      data?: any;
      badge?: number;
      sound?: 'default' | null;
      priority?: 'default' | 'normal' | 'high';
      channelId?: string;
      _contentAvailable?: boolean;
    }
  ): Promise<boolean> {
    try {
      const settings = await this.notificationsService.getUserSettings(userId);
      const fcmTokens = settings.fcm_push_tokens || [];

      if (fcmTokens.length === 0) {
        return false;
      }

      const isCall = ['call_incoming', 'call_ended'].includes(notification.data?.type);

      const data: Record<string, string> = {};
      if (notification.data) {
        Object.entries(notification.data).forEach(([key, value]) => {
          data[key] = typeof value === 'string' ? value : JSON.stringify(value);
        });
      }
      if (!data.dataString && notification.data) {
        data.dataString = JSON.stringify(notification.data);
      }

      const android: any = {
        priority: notification.priority === 'high' ? 'HIGH' : 'NORMAL',
      };

      // Show a notification for non-call payloads. Call payloads are data-only
      // so the mobile FCM handler can trigger the native incoming-call UI.
      if (!isCall && (notification.title || notification.body)) {
        android.notification = {
          channelId: notification.channelId || 'default',
          sound: notification.sound === null ? undefined : 'default',
        };
      }

      // Collapse call push payloads per call session so a later call_ended
      // replaces a still-queued call_incoming when the device is offline.
      const collapseKey = notification.data?.callSessionId
        ? `call_${notification.data.callSessionId}`
        : notification.data?.uuid
          ? `call_${notification.data.uuid}`
          : undefined;

      const fcmPayload: any = {
        data,
        android,
        notification: !isCall && (notification.title || notification.body)
          ? {
              title: notification.title,
              body: notification.body,
            }
          : undefined,
        apns: !isCall
          ? { payload: { aps: { 'content-available': 1 } } }
          : undefined,
      };

      if (collapseKey) {
        fcmPayload.collapseKey = collapseKey;
      }

      return await this.sendFcmToTokens(fcmTokens, fcmPayload);
    } catch (error) {
      this.logger.error(`Failed to send FCM notification to user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Send a single FCM v1 payload to a list of device tokens.
   */
  private async sendFcmToTokens(tokens: string[], payload: any): Promise<boolean> {
    const accessToken = await this.getFcmAccessToken();
    if (!accessToken) {
      this.logger.warn('FCM access token not available; skipping FCM send');
      return false;
    }

    const serviceAccount = this.getFcmServiceAccount();
    if (!serviceAccount) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not configured; skipping FCM send');
      return false;
    }

    const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

    const results = await Promise.allSettled(
      tokens.map(async (token) => {
        try {
          const message = { ...payload, token };
          await axios.post(url, { message }, { headers: { Authorization: `Bearer ${accessToken}` } });
          return true;
        } catch (error: any) {
          this.logger.error(`FCM send failed for token ${token}:`, error?.response?.data || error.message);
          return false;
        }
      })
    );

    return results.some((r) => r.status === 'fulfilled' && r.value);
  }

  /**
   * Get an OAuth2 access token for the FCM v1 API from a service account.
   */
  private async getFcmAccessToken(): Promise<string | null> {
    const serviceAccount = this.getFcmServiceAccount();
    if (!serviceAccount) return null;

    try {
      const now = Math.floor(Date.now() / 1000);
      const jwt = sign(
        {
          iss: serviceAccount.client_email,
          sub: serviceAccount.client_email,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        },
        serviceAccount.private_key,
        { algorithm: 'RS256' }
      );

      const { data } = await axios.post('https://oauth2.googleapis.com/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      });

      return data.access_token || null;
    } catch (error: any) {
      this.logger.error('Failed to get FCM access token:', error?.response?.data || error.message);
      return null;
    }
  }

  private getFcmServiceAccount(): { client_email: string; private_key: string; project_id: string } | null {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
      return null;
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
   * Register a new push token for a user.
   * type can be 'expo' or 'fcm'. Defaults to 'expo' for backwards compatibility.
   */
  async registerPushToken(userId: string, token: string, type = 'expo'): Promise<boolean> {
    try {
      const field = type === 'fcm' ? 'fcm_push_tokens' : 'expo_push_tokens';

      if (type === 'expo' && !Expo.isExpoPushToken(token)) {
        this.logger.warn(`Invalid Expo push token: ${token}`);
        return false;
      }

      if (type === 'fcm' && !token) {
        this.logger.warn('FCM token is empty');
        return false;
      }

      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings[field] || [];

      // Add token if not already exists
      if (!existingTokens.includes(token)) {
        const updatedTokens = [...existingTokens, token];

        await this.notificationsService.updateUserSettings(userId, {
          [field]: updatedTokens
        });

        this.logger.log(`Registered ${type} push token for user ${userId}`);
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
  async unregisterPushToken(userId: string, token: string, type = 'expo'): Promise<boolean> {
    try {
      const field = type === 'fcm' ? 'fcm_push_tokens' : 'expo_push_tokens';
      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings[field] || [];
      const updatedTokens = existingTokens.filter(t => t !== token);

      if (updatedTokens.length !== existingTokens.length) {
        await this.notificationsService.updateUserSettings(userId, {
          [field]: updatedTokens
        });

        this.logger.log(`Unregistered ${type} push token for user ${userId}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to unregister push token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Register an iOS VoIP (PushKit) token for a user
   */
  async registerVoipToken(userId: string, token: string): Promise<boolean> {
    try {
      if (!token || token.length < 10) {
        this.logger.warn(`Invalid VoIP push token: ${token}`);
        return false;
      }

      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings.voip_push_tokens || [];

      if (!existingTokens.includes(token)) {
        const updatedTokens = [...existingTokens, token];
        await this.notificationsService.updateUserSettings(userId, {
          voip_push_tokens: updatedTokens
        });
        this.logger.log(`Registered VoIP push token for user ${userId}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to register VoIP push token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Unregister an iOS VoIP (PushKit) token for a user
   */
  async unregisterVoipToken(userId: string, token: string): Promise<boolean> {
    try {
      const settings = await this.notificationsService.getUserSettings(userId);
      const existingTokens = settings.voip_push_tokens || [];
      const updatedTokens = existingTokens.filter(t => t !== token);

      if (updatedTokens.length !== existingTokens.length) {
        await this.notificationsService.updateUserSettings(userId, {
          voip_push_tokens: updatedTokens
        });
        this.logger.log(`Unregistered VoIP push token for user ${userId}`);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to unregister VoIP push token for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Send a VoIP (PushKit) push to all of a user's iOS VoIP tokens.
   * This bypasses Expo because APNs requires direct HTTP/2 delivery for
   * the `com.apple.pushkit` payload.
   */
  /**
   * Normalize an EC private key from an env var into valid PEM format.
   * Handles keys stored with literal "\n" escape sequences, or as a single
   * unbroken line (header + base64 body + footer with no line breaks at all),
   * both of which are invalid PEM and will fail crypto/jsonwebtoken parsing.
   */
  private normalizeApnsPrivateKey(rawKey: string): string {
    let key = rawKey.trim().replace(/\\n/g, '\n');

    const alreadyValid = /-----BEGIN (?:EC )?PRIVATE KEY-----\r?\n/.test(key);
    if (alreadyValid) {
      return key;
    }

    // Key has no (or insufficient) line breaks between header/body/footer.
    // Rebuild it from the base64 body regardless of original formatting.
    const match = key.match(
      /-----BEGIN (EC )?PRIVATE KEY-----([\s\S]*?)-----END (EC )?PRIVATE KEY-----/
    );
    if (!match) {
      return key;
    }

    const keyKind = match[1] ? 'EC PRIVATE KEY' : 'PRIVATE KEY';
    const base64Body = match[2].replace(/\s+/g, '');
    const wrappedBody = base64Body.match(/.{1,64}/g)?.join('\n') || base64Body;

    return `-----BEGIN ${keyKind}-----\n${wrappedBody}\n-----END ${keyKind}-----\n`;
  }

  async sendVoipPush(userId: string, payload: any): Promise<boolean> {
    try {
      const rawApnsKey = process.env.APN_VOIP_KEY || '';
      const apnsKey = this.normalizeApnsPrivateKey(rawApnsKey);
      const keyId = process.env.APN_VOIP_KEY_ID;
      const teamId = process.env.APN_VOIP_TEAM_ID;
      const bundleId = process.env.APN_VOIP_BUNDLE_ID;

      if (!apnsKey || !keyId || !teamId || !bundleId) {
        this.logger.warn('APNs VoIP credentials not configured; skipping VoIP push');
        return false;
      }

      const settings = await this.notificationsService.getUserSettings(userId);
      const voipTokens = settings.voip_push_tokens || [];

      if (voipTokens.length === 0) {
        return false;
      }

      const authToken = sign({}, apnsKey, {
        algorithm: 'ES256',
        keyid: keyId,
        issuer: teamId,
        expiresIn: '1h',
      });

      const host = process.env.APN_VOIP_HOST || 'api.sandbox.push.apple.com';
      const results = await Promise.all(
        voipTokens.map(token => this.sendVoipApn(token, payload, host, bundleId, authToken))
      );
      const successCount = results.filter(Boolean).length;
      this.logger.log(`Sent ${successCount}/${voipTokens.length} VoIP push notifications to user ${userId}`);
      return successCount > 0;
    } catch (error) {
      this.logger.error(`Failed to send VoIP push to user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
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
   * Send a single VoIP APN to a device token over HTTP/2.
   */
  private async sendVoipApn(
    token: string,
    payload: any,
    host: string,
    bundleId: string,
    authToken: string
  ): Promise<boolean> {
    const body = JSON.stringify(payload);
    const client = connect(`https://${host}`);

    return new Promise<boolean>((resolve) => {
      try {
        // Collapse VoIP pushes for the same call session so a later
        // call_ended replaces a still-queued call_incoming on the device.
        const collapseId = payload?.callSessionId
          ? `call_${payload.callSessionId}`
          : payload?.uuid
            ? `call_${payload.uuid}`
            : undefined;

        const headers: any = {
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          ':scheme': 'https',
          ':authority': host,
          'authorization': `bearer ${authToken}`,
          'apns-topic': bundleId.endsWith('.voip') ? bundleId : `${bundleId}.voip`,
          'apns-push-type': 'voip',
          'apns-priority': '10',
          'content-length': Buffer.byteLength(body),
        };
        if (collapseId) {
          headers['apns-collapse-id'] = collapseId;
        }

        const req = client.request(headers);

        let statusCode: number | undefined;
        req.on('response', (headers) => {
          statusCode = Number(headers[':status']);
        });

        let responseData = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { responseData += chunk; });
        req.on('end', () => {
          client.close();
          if (statusCode === 200) {
            resolve(true);
          } else {
            this.logger.error(
              `APNs VoIP push failed for token ${token}: status=${statusCode} body=${responseData}`
            );
            resolve(false);
          }
        });
        req.on('error', (error) => {
          this.logger.error(`APNs request error for token ${token}:`, error);
          client.close();
          resolve(false);
        });

        req.write(body);
        req.end();
      } catch (error) {
        this.logger.error(`APNs connection error for token ${token}:`, error);
        client.close();
        resolve(false);
      }
    });
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