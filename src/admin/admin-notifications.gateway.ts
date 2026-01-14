/**
 * FRETIKO ADMIN NOTIFICATIONS GATEWAY
 * WebSocket gateway for real-time admin panel notifications
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminNotificationsService } from './admin-notifications.service';

// Interface for authenticated socket
interface AuthenticatedSocket extends Socket {
  staffId?: string;
  staffData?: any;
}

@WebSocketGateway({
  namespace: '/admin-notifications',
  cors: {
    origin: true, // Allow all origins for development
    credentials: true,
  },
})
export class AdminNotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AdminNotificationsGateway.name);
  private connectedStaff = new Map<string, Set<string>>(); // staffId -> Set of socketIds

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    @Inject(forwardRef(() => AdminNotificationsService))
    private notificationsService: AdminNotificationsService,
  ) {
    this.logger.log('🔧 AdminNotificationsGateway constructor called');
    try {
      const jwtSecret = this.configService.get<string>('JWT_SECRET');
      this.logger.log(`🔑 JWT_SECRET configured: ${jwtSecret ? '✅ Yes (length: ' + jwtSecret.length + ')' : '❌ No'}`);
    } catch (error) {
      this.logger.error('❌ Error accessing JWT_SECRET in constructor:', error);
    }

    // Set the gateway reference in the service to break the circular dependency
    this.notificationsService.setGateway(this);
  }

  // ============================================
  // GATEWAY LIFECYCLE
  // ============================================

  /**
   * Called after the gateway is initialized
   * This confirms the WebSocket server is ready
   */
  afterInit(server: Server) {
    this.logger.log('🚀 ========================================');
    this.logger.log('🚀 AdminNotificationsGateway INITIALIZED');
    this.logger.log('🚀 Namespace: /admin-notifications');
    this.logger.log('🚀 CORS: Enabled (origin: true)');
    this.logger.log(`🚀 Server adapter: ${server.adapter?.constructor?.name || 'Default'}`);
    this.logger.log('🚀 ========================================');
  }

  // ============================================
  // CONNECTION HANDLING
  // ============================================

  async handleConnection(client: AuthenticatedSocket) {
    try {
      this.logger.log(`🔌 Admin client attempting connection: ${client.id}`);
      this.logger.debug(`Connection details - Headers: ${JSON.stringify(client.handshake.headers)}`);
      this.logger.debug(`Connection details - Auth: ${JSON.stringify(client.handshake.auth)}`);

      // Extract JWT token from auth header or query
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(`⚠️ No token provided for admin client ${client.id}`);
        client.emit('error', { message: 'Authentication required' });
        client.disconnect();
        return;
      }

      this.logger.debug(`🔑 Token extracted successfully for client ${client.id}`);

      // Verify Staff JWT token
      try {
        const payload = this.jwtService.verify(token);
        this.logger.debug(`✅ Token verified - Payload: ${JSON.stringify(payload)}`);
        if (!payload || !payload.sub) {
          this.logger.warn(`Invalid token for admin client ${client.id}`);
          client.disconnect();
          return;
        }

        // Attach staff data to socket
        client.staffId = payload.sub;
        client.staffData = payload;

        // Track connected staff (with null check)
        if (client.staffId) {
          if (!this.connectedStaff.has(client.staffId)) {
            this.connectedStaff.set(client.staffId, new Set());
          }
          this.connectedStaff.get(client.staffId)!.add(client.id);

          // Join personal room
          await client.join(`staff:${client.staffId}`);

          // Join role-based rooms
          if (payload.role === 'super_admin') {
            await client.join('role:super_admin');
            this.logger.log(`Admin client ${client.id} joined super_admin room`);
          }
          if (payload.role === 'department_head') {
            await client.join('role:department_head');
          }

          // Join department room
          if (payload.departmentId) {
            await client.join(`department:${payload.departmentId}`);
            this.logger.log(`Admin client ${client.id} joined department:${payload.departmentId} room`);
          }

          this.logger.log(`✅ Staff ${client.staffId} (${payload.role}) connected via socket ${client.id}`);

          // Send connection confirmation
          client.emit('connection:confirmed', {
            staffId: client.staffId,
            role: payload.role,
            departmentId: payload.departmentId,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (jwtError: any) {
        this.logger.error(`❌ JWT verification failed for admin client ${client.id}:`, jwtError.message);
        this.logger.error(`JWT Error Details:`, jwtError);
        client.emit('error', { message: 'Invalid authentication token', details: jwtError.message });
        client.disconnect();
        return;
      }
    } catch (error) {
      this.logger.error(`Connection error for admin client ${client.id}:`, error);
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.staffId) {
      const sockets = this.connectedStaff.get(client.staffId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.connectedStaff.delete(client.staffId);
        }
      }
      this.logger.log(`❌ Staff ${client.staffId} disconnected from socket ${client.id}`);
    } else {
      this.logger.log(`Client ${client.id} disconnected (not authenticated)`);
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  private extractToken(client: Socket): string | null {
    // Try authorization header first
    const authHeader = client.handshake.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    // Try auth object
    return client.handshake.auth?.token || null;
  }

  // ============================================
  // SUBSCRIPTION HANDLERS
  // ============================================

  @SubscribeMessage('notification:mark_read')
  handleMarkRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { id: string },
  ) {
    this.logger.log(`Staff ${client.staffId} marked notification ${data.id} as read`);
    // Service layer will handle DB update
    client.emit('notification:mark_read:success', { id: data.id });
  }

  @SubscribeMessage('notification:mark_all_read')
  handleMarkAllRead(@ConnectedSocket() client: AuthenticatedSocket) {
    this.logger.log(`Staff ${client.staffId} marked all notifications as read`);
    // Service layer will handle DB update
    client.emit('notification:mark_all_read:success', {
      timestamp: new Date().toISOString(),
    });
  }

  @SubscribeMessage('notification:delete')
  handleDelete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { id: string },
  ) {
    this.logger.log(`Staff ${client.staffId} deleted notification ${data.id}`);
    client.emit('notification:delete:success', { id: data.id });
  }

  @SubscribeMessage('notification:get_all')
  async handleGetAllNotifications(@ConnectedSocket() client: AuthenticatedSocket) {
    try {
      if (!client.staffId) {
        client.emit('error', { message: 'Not authenticated' });
        return;
      }

      const result = await this.notificationsService.getNotifications(client.staffId);
      client.emit('notification:all', result.data);
    } catch (error) {
      this.logger.error('Failed to get notifications:', error);
      client.emit('error', { message: 'Failed to load notifications' });
    }
  }

  @SubscribeMessage('notification:get_count')
  async handleGetNotificationCount(@ConnectedSocket() client: AuthenticatedSocket) {
    try {
      if (!client.staffId) {
        client.emit('error', { message: 'Not authenticated' });
        return;
      }

      const count = await this.notificationsService.getUnreadCount(client.staffId);
      const total = await this.notificationsService.getTotalCount(client.staffId);
      client.emit('notification:count', { unread: count, total });
    } catch (error) {
      this.logger.error('Failed to get notification count:', error);
      client.emit('error', { message: 'Failed to load notification count' });
    }
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: AuthenticatedSocket) {
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  // ============================================
  // EMISSION METHODS (called by service)
  // ============================================

  /**
   * Emit notification to specific staff member
   */
  notifyStaff(staffId: string, notification: any) {
    this.logger.log(`📤 Sending notification to staff ${staffId}: ${notification.title}`);
    this.server.to(`staff:${staffId}`).emit('notification:new', notification);
  }

  /**
   * Emit notification to all super admins
   */
  notifySuperAdmins(notification: any) {
    this.logger.log(`📤 Broadcasting to super admins: ${notification.title}`);
    this.server.to('role:super_admin').emit('notification:new', notification);
  }

  /**
   * Emit notification to all department heads
   */
  notifyDepartmentHeads(notification: any) {
    this.logger.log(`📤 Broadcasting to department heads: ${notification.title}`);
    this.server.to('role:department_head').emit('notification:new', notification);
  }

  /**
   * Emit notification to specific department
   */
  notifyDepartment(departmentId: string, notification: any) {
    this.logger.log(`📤 Broadcasting to department ${departmentId}: ${notification.title}`);
    this.server.to(`department:${departmentId}`).emit('notification:new', notification);
  }

  /**
   * Broadcast to all connected admin staff
   */
  broadcastToAll(notification: any) {
    this.logger.log(`📣 Broadcasting to all admin staff: ${notification.title}`);
    this.server.emit('notification:broadcast', notification);
  }

  /**
   * Get currently connected staff count
   */
  getConnectedStaffCount(): number {
    return this.connectedStaff.size;
  }

  /**
   * Check if specific staff is connected
   */
  isStaffConnected(staffId: string): boolean {
    return this.connectedStaff.has(staffId);
  }

  /**
   * Emit notification count update
   */
  emitNotificationCount(staffId: string, unread: number, total: number) {
    this.server.to(`staff:${staffId}`).emit('notification:count', {
      unread,
      total,
      timestamp: new Date().toISOString(),
    });
  }
}

