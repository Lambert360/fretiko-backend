/**
 * FRETIKO NOTIFICATIONS GATEWAY
 * WebSocket gateway for real-time notification delivery
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';

// Interface for authenticated socket
interface AuthenticatedSocket extends Socket {
  userId?: string;
  userData?: any;
}

@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: true, // Allow all origins for development
    credentials: true,
  },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private connectedUsers = new Map<string, Set<string>>(); // userId -> Set of socketIds

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
  ) {}

  // ============================================
  // CONNECTION HANDLING
  // ============================================

  async handleConnection(client: AuthenticatedSocket) {
    try {
      this.logger.log(`Client attempting connection: ${client.id}`);

      // Extract JWT token from auth header or query
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`No token provided for client ${client.id}`);
        client.disconnect();
        return;
      }

      // Verify JWT token (Supabase format)
      const userData = await this.verifySupabaseToken(token);
      if (!userData) {
        this.logger.warn(`Invalid token for client ${client.id}`);
        client.disconnect();
        return;
      }

      // Attach user data to socket
      client.userId = userData.sub || userData.user_id;
      client.userData = userData;

      // Track connected user (with type guard)
      if (client.userId) {
        this.addUserConnection(client.userId, client.id);

        // Join user to their personal notification room
        await client.join(`user:${client.userId}`);

        this.logger.log(`User ${client.userId} connected via socket ${client.id}`);

        // Send initial notification count
        const stats = await this.notificationsService.getUserNotificationStats(client.userId);
        client.emit('notification:stats', stats);
      }

    } catch (error) {
      this.logger.error(`Connection error for client ${client.id}:`, error);
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.userId) {
      this.removeUserConnection(client.userId, client.id);
      this.logger.log(`User ${client.userId} disconnected from socket ${client.id}`);
    } else {
      this.logger.log(`Client ${client.id} disconnected (not authenticated)`);
    }
  }

  // ============================================
  // CLIENT EVENT HANDLERS
  // ============================================

  @SubscribeMessage('notification:subscribe')
  async handleSubscribeToNotifications(@ConnectedSocket() client: AuthenticatedSocket) {
    if (!client.userId) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    this.logger.log(`User ${client.userId} subscribed to notifications`);
    
    // Send current stats
    try {
      const stats = await this.notificationsService.getUserNotificationStats(client.userId);
      client.emit('notification:stats', stats);
    } catch (error) {
      this.logger.error(`Failed to get stats for user ${client.userId}:`, error);
      client.emit('error', { message: 'Failed to get notification stats' });
    }
  }

  @SubscribeMessage('notification:markAsRead')
  async handleMarkAsRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { notificationId: string }
  ) {
    if (!client.userId) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      await this.notificationsService.updateNotification(
        data.notificationId,
        client.userId,
        { is_read: true }
      );

      // Send updated stats
      const stats = await this.notificationsService.getUserNotificationStats(client.userId);
      client.emit('notification:stats', stats);

      this.logger.log(`User ${client.userId} marked notification ${data.notificationId} as read`);
    } catch (error) {
      this.logger.error(`Failed to mark notification as read:`, error);
      client.emit('error', { message: 'Failed to mark notification as read' });
    }
  }

  @SubscribeMessage('notification:markAllAsRead')
  async handleMarkAllAsRead(@ConnectedSocket() client: AuthenticatedSocket) {
    if (!client.userId) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const result = await this.notificationsService.markAllAsRead(client.userId);
      
      // Send updated stats
      const stats = await this.notificationsService.getUserNotificationStats(client.userId);
      client.emit('notification:stats', stats);
      client.emit('notification:allMarkedRead', { count: result.updated_count });

      this.logger.log(`User ${client.userId} marked ${result.updated_count} notifications as read`);
    } catch (error) {
      this.logger.error(`Failed to mark all notifications as read:`, error);
      client.emit('error', { message: 'Failed to mark all notifications as read' });
    }
  }

  @SubscribeMessage('notification:getRecent')
  async handleGetRecentNotifications(@ConnectedSocket() client: AuthenticatedSocket) {
    if (!client.userId) {
      client.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const notifications = await this.notificationsService.getUserNotifications(client.userId, {
        limit: '10',
        sort_by: 'created_at',
        sort_order: 'desc'
      });

      client.emit('notification:recent', notifications.notifications);
    } catch (error) {
      this.logger.error(`Failed to get recent notifications:`, error);
      client.emit('error', { message: 'Failed to get recent notifications' });
    }
  }

  // ============================================
  // BROADCAST METHODS (for other services to call)
  // ============================================

  /**
   * Send a new notification to a specific user in real-time
   */
  async notifyUser(userId: string, notification: any): Promise<void> {
    try {
      this.server.to(`user:${userId}`).emit('notification:new', notification);
      
      // Also send updated stats
      const stats = await this.notificationsService.getUserNotificationStats(userId);
      this.server.to(`user:${userId}`).emit('notification:stats', stats);

      this.logger.log(`Sent real-time notification to user ${userId}: ${notification.title}`);
    } catch (error) {
      this.logger.error(`Failed to send real-time notification to user ${userId}:`, error);
    }
  }

  /**
   * Update notification stats for a user
   */
  async updateUserStats(userId: string): Promise<void> {
    try {
      const stats = await this.notificationsService.getUserNotificationStats(userId);
      this.server.to(`user:${userId}`).emit('notification:stats', stats);
    } catch (error) {
      this.logger.error(`Failed to update stats for user ${userId}:`, error);
    }
  }

  /**
   * Check if a user is currently online
   */
  isUserOnline(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }

  /**
   * Get count of online users
   */
  getOnlineUserCount(): number {
    return this.connectedUsers.size;
  }

  /**
   * Broadcast to all connected users (for system announcements)
   */
  broadcastToAll(event: string, data: any): void {
    this.server.emit(event, data);
    this.logger.log(`Broadcasted ${event} to all connected users`);
  }

  // ============================================
  // PRIVATE HELPER METHODS
  // ============================================

  private extractToken(client: AuthenticatedSocket): string | null {
    // Try to get token from Authorization header
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Try to get token from query parameters
    const tokenFromQuery = client.handshake.query.token;
    if (typeof tokenFromQuery === 'string') {
      return tokenFromQuery;
    }

    // Try to get from auth object (common in some setups)
    const authFromQuery = client.handshake.query.auth;
    if (typeof authFromQuery === 'string') {
      return authFromQuery;
    }

    return null;
  }

  private async verifySupabaseToken(token: string): Promise<any> {
    try {
      // For Supabase JWT tokens, we need to verify them properly
      // Supabase JWTs use a different secret and issuer
      
      // Get Supabase JWT secret from environment
      const supabaseJwtSecret = this.configService.get('SUPABASE_JWT_SECRET') 
        || this.configService.get('JWT_SECRET');

      if (!supabaseJwtSecret) {
        this.logger.error('No JWT secret configured for Supabase token verification');
        return null;
      }

      // Verify the token
      const decoded = this.jwtService.verify(token, {
        secret: supabaseJwtSecret,
        // Supabase tokens typically don't require issuer verification for custom claims
      });

      // Supabase tokens have user info in 'sub' field
      if (!decoded.sub && !decoded.user_id) {
        this.logger.error('Invalid Supabase token: missing user identifier');
        return null;
      }

      return decoded;
    } catch (error) {
      this.logger.error('Failed to verify Supabase JWT token:', error.message);
      return null;
    }
  }

  private addUserConnection(userId: string, socketId: string): void {
    if (!this.connectedUsers.has(userId)) {
      this.connectedUsers.set(userId, new Set());
    }
    const userSockets = this.connectedUsers.get(userId);
    if (userSockets) {
      userSockets.add(socketId);
    }
  }

  private removeUserConnection(userId: string, socketId: string): void {
    if (this.connectedUsers.has(userId)) {
      const userSockets = this.connectedUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        
        // If no more sockets for this user, remove the entry
        if (userSockets.size === 0) {
          this.connectedUsers.delete(userId);
        }
      }
    }
  }
}