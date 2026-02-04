import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface RiderAssignmentEvent {
  type: 'assignment_created' | 'assignment_accepted' | 'assignment_rejected' | 'assignment_timeout' | 'replacement_started' | 'replacement_completed' | 'broadcast_sent' | 'broadcast_accepted';
  orderId: string;
  orderNumber: string;
  riderId?: string;
  vendorId: string;
  buyerId: string;
  timestamp: string;
  data?: any;
}

interface BroadcastAssignmentEvent {
  type: 'broadcast_sent' | 'broadcast_accepted' | 'broadcast_expired' | 'broadcast_rejected';
  broadcastId: string;
  orderId: string;
  orderNumber: string;
  riderIds: string[];
  radius: number;
  timestamp: string;
  data?: any;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/rider-assignments',
})
export class RiderAssignmentGateway implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RiderAssignmentGateway.name);
  private supabase: SupabaseClient;
  private connectedClients: Map<string, { userId: string; role: string; socket: Socket }> = new Map();

  constructor(private configService: ConfigService) {
    this.supabase = createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_KEY')!,
    );
  }

  onModuleInit() {
    this.logger.log('🔌 Rider Assignment WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    this.logger.log(`🔌 Client connected: ${client.id}`);
    
    // Wait for authentication
    client.once('authenticate', async (data: { token: string; userId: string; role: string }) => {
      try {
        // Verify token with Supabase
        const { data: { user }, error } = await this.supabase.auth.getUser(data.token);
        
        if (error || !user || user.id !== data.userId) {
          client.emit('error', { message: 'Authentication failed' });
          client.disconnect();
          return;
        }

        // Store client info
        this.connectedClients.set(client.id, {
          userId: data.userId,
          role: data.role,
          socket: client,
        });

        // Join user-specific room
        client.join(`user:${data.userId}`);
        
        // Join role-specific room
        client.join(`role:${data.role}`);
        
        // Join order-specific rooms based on user's orders
        await this.joinUserOrderRooms(client, data.userId, data.role);
        
        client.emit('authenticated', { success: true });
        this.logger.log(`✅ Client authenticated: ${data.userId} (${data.role})`);
        
      } catch (error) {
        this.logger.error('❌ Authentication error:', error);
        client.emit('error', { message: 'Authentication failed' });
        client.disconnect();
      }
    });

    // Set authentication timeout
    setTimeout(() => {
      if (!this.connectedClients.has(client.id)) {
        client.emit('error', { message: 'Authentication timeout' });
        client.disconnect();
      }
    }, 5000);
  }

  async handleDisconnect(client: Socket) {
    const clientInfo = this.connectedClients.get(client.id);
    if (clientInfo) {
      this.logger.log(`🔌 Client disconnected: ${clientInfo.userId} (${clientInfo.role})`);
      this.connectedClients.delete(client.id);
    }
  }

  private async joinUserOrderRooms(client: Socket, userId: string, role: string) {
    try {
      let orders;
      
      if (role === 'buyer') {
        // Get buyer's orders
        const { data } = await this.supabase
          .from('orders')
          .select('id, order_number')
          .eq('buyer_id', userId)
          .in('status', ['paid', 'assigned', 'in_transit']);
        
        orders = data;
      } else if (role === 'vendor') {
        // Get vendor's orders
        const { data } = await this.supabase
          .from('orders')
          .select('id, order_number')
          .eq('vendor_id', userId)
          .in('status', ['paid', 'assigned', 'in_transit']);
        
        orders = data;
      } else if (role === 'rider') {
        // Get rider's assigned orders
        const { data } = await this.supabase
          .from('orders')
          .select('id, order_number')
          .eq('rider_id', userId)
          .in('rider_acceptance_status', ['pending', 'accepted']);
        
        orders = data;
      }

      if (orders) {
        orders.forEach(order => {
          client.join(`order:${order.id}`);
        });
      }
      
    } catch (error) {
      this.logger.error('❌ Error joining order rooms:', error);
    }
  }

  // ===== EVENT EMITTERS =====

  async emitRiderAssignmentEvent(event: RiderAssignmentEvent) {
    try {
      this.logger.log(`📡 Emitting rider assignment event: ${event.type} for order ${event.orderNumber}`);
      
      // Emit to specific users
      this.server.to(`user:${event.vendorId}`).emit('rider_assignment_event', event);
      this.server.to(`user:${event.buyerId}`).emit('rider_assignment_event', event);
      
      if (event.riderId) {
        this.server.to(`user:${event.riderId}`).emit('rider_assignment_event', event);
      }
      
      // Emit to order-specific room
      this.server.to(`order:${event.orderId}`).emit('rider_assignment_event', event);
      
      // Emit to role-specific rooms
      this.server.to('role:admin').emit('rider_assignment_event', event);
      
    } catch (error) {
      this.logger.error('❌ Error emitting rider assignment event:', error);
    }
  }

  async emitBroadcastAssignmentEvent(event: BroadcastAssignmentEvent) {
    try {
      this.logger.log(`📡 Emitting broadcast event: ${event.type} for order ${event.orderNumber}`);
      
      // Emit to all riders in the broadcast
      event.riderIds.forEach(riderId => {
        this.server.to(`user:${riderId}`).emit('broadcast_assignment_event', event);
      });
      
      // Emit to vendor and buyer
      const order = await this.getOrderDetails(event.orderId);
      if (order) {
        this.server.to(`user:${order.vendor_id}`).emit('broadcast_assignment_event', event);
        this.server.to(`user:${order.buyer_id}`).emit('broadcast_assignment_event', event);
      }
      
      // Emit to order-specific room
      this.server.to(`order:${event.orderId}`).emit('broadcast_assignment_event', event);
      
      // Emit to admins
      this.server.to('role:admin').emit('broadcast_assignment_event', event);
      
    } catch (error) {
      this.logger.error('❌ Error emitting broadcast event:', error);
    }
  }

  async emitReplacementStatusUpdate(orderId: string, status: any) {
    try {
      this.logger.log(`📡 Emitting replacement status update for order ${orderId}`);
      
      const event = {
        type: 'replacement_status_update',
        orderId,
        status,
        timestamp: new Date().toISOString(),
      };
      
      // Emit to order-specific room
      this.server.to(`order:${orderId}`).emit('replacement_status_update', event);
      
      // Emit to admins
      this.server.to('role:admin').emit('replacement_status_update', event);
      
    } catch (error) {
      this.logger.error('❌ Error emitting replacement status update:', error);
    }
  }

  async emitTimeoutWarning(orderId: string, timeRemaining: number) {
    try {
      this.logger.log(`📡 Emitting timeout warning for order ${orderId}`);
      
      const event = {
        type: 'timeout_warning',
        orderId,
        timeRemaining,
        timestamp: new Date().toISOString(),
      };
      
      // Emit to order-specific room
      this.server.to(`order:${orderId}`).emit('timeout_warning', event);
      
    } catch (error) {
      this.logger.error('❌ Error emitting timeout warning:', error);
    }
  }

  // ===== MESSAGE HANDLERS =====

  @SubscribeMessage('join_order_room')
  async handleJoinOrderRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string },
  ) {
    try {
      const clientInfo = this.connectedClients.get(client.id);
      if (!clientInfo) {
        client.emit('error', { message: 'Not authenticated' });
        return;
      }

      // Verify user has access to this order
      const hasAccess = await this.verifyOrderAccess(clientInfo.userId, clientInfo.role, data.orderId);
      
      if (hasAccess) {
        client.join(`order:${data.orderId}`);
        client.emit('joined_order_room', { orderId: data.orderId, success: true });
        this.logger.log(`📡 Client ${clientInfo.userId} joined order room: ${data.orderId}`);
      } else {
        client.emit('error', { message: 'Access denied to this order' });
      }
      
    } catch (error) {
      this.logger.error('❌ Error joining order room:', error);
      client.emit('error', { message: 'Failed to join order room' });
    }
  }

  @SubscribeMessage('leave_order_room')
  async handleLeaveOrderRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string },
  ) {
    try {
      client.leave(`order:${data.orderId}`);
      client.emit('left_order_room', { orderId: data.orderId, success: true });
      this.logger.log(`📡 Client left order room: ${data.orderId}`);
      
    } catch (error) {
      this.logger.error('❌ Error leaving order room:', error);
    }
  }

  @SubscribeMessage('ping')
  async handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  // ===== HELPER METHODS =====

  private async verifyOrderAccess(userId: string, role: string, orderId: string): Promise<boolean> {
    try {
      let query;
      
      if (role === 'buyer') {
        query = this.supabase
          .from('orders')
          .select('id')
          .eq('id', orderId)
          .eq('buyer_id', userId);
      } else if (role === 'vendor') {
        query = this.supabase
          .from('orders')
          .select('id')
          .eq('id', orderId)
          .eq('vendor_id', userId);
      } else if (role === 'rider') {
        query = this.supabase
          .from('orders')
          .select('id')
          .eq('id', orderId)
          .eq('rider_id', userId);
      } else if (role === 'admin') {
        return true; // Admins have access to all orders
      } else {
        return false;
      }
      
      const { data, error } = await query.single();
      return !error && !!data;
      
    } catch (error) {
      this.logger.error('❌ Error verifying order access:', error);
      return false;
    }
  }

  private async getOrderDetails(orderId: string): Promise<any> {
    try {
      const { data, error } = await this.supabase
        .from('orders')
        .select('vendor_id, buyer_id, order_number')
        .eq('id', orderId)
        .single();
      
      return error ? null : data;
      
    } catch (error) {
      this.logger.error('❌ Error getting order details:', error);
      return null;
    }
  }

  // ===== PUBLIC API METHODS =====

  getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  getConnectedClientsByRole(role: string): number {
    return Array.from(this.connectedClients.values())
      .filter(client => client.role === role)
      .length;
  }

  async notifyOrderUpdate(orderId: string, updateType: string, data: any) {
    const event = {
      type: 'order_update',
      orderId,
      updateType,
      data,
      timestamp: new Date().toISOString(),
    };
    
    this.server.to(`order:${orderId}`).emit('order_update', event);
  }

  async notifyRiderLocationUpdate(riderId: string, location: any) {
    const event = {
      type: 'rider_location_update',
      riderId,
      location,
      timestamp: new Date().toISOString(),
    };
    
    this.server.to(`user:${riderId}`).emit('rider_location_update', event);
    
    // Also emit to order rooms where this rider is assigned
    const { data: orders } = await this.supabase
      .from('orders')
      .select('id')
      .eq('rider_id', riderId)
      .eq('rider_acceptance_status', 'accepted');
    
    if (orders) {
      orders.forEach(order => {
        this.server.to(`order:${order.id}`).emit('rider_location_update', event);
      });
    }
  }
}
