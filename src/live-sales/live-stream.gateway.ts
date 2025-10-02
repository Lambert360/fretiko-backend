import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { LiveSalesService } from './live-sales.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Live Stream WebSocket Gateway
 * 
 * Handles real-time features for live streams:
 * - Stream viewer management
 * - Real-time comments
 * - Reactions and animations
 * - Gift sending
 * - Live commerce interactions
 * - Viewer count updates
 * 
 * Room structure:
 * - stream:{streamId} - All viewers of a specific stream
 * - vendor:{vendorId} - Private room for vendor notifications
 */
@WebSocketGateway({
  cors: {
    origin: '*', // Configure this properly for production
    methods: ['GET', 'POST'],
  },
  namespace: '/live-sales',
})
export class LiveStreamGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(LiveStreamGateway.name);
  private connectedUsers = new Map<string, { userId: string; streamId?: string; role: string }>();

  constructor(
    private readonly liveSalesService: LiveSalesService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  // =====================
  // GATEWAY LIFECYCLE
  // =====================

  afterInit(server: Server) {
    this.logger.log('Live Stream WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    try {
      this.logger.log(`Client connected: ${client.id}`);
      
      // TODO: Implement JWT authentication for WebSocket
      // For now, we'll accept all connections
      // In production, verify JWT token from handshake auth
      
      this.connectedUsers.set(client.id, {
        userId: 'anonymous', // Will be set during authentication
        role: 'viewer',
      });

    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      
      if (userInfo?.streamId) {
        // Leave stream when disconnecting
        await this.handleLeaveStream(client, { streamId: userInfo.streamId });
      }

      this.connectedUsers.delete(client.id);
      this.logger.log(`Client disconnected: ${client.id}`);
    } catch (error) {
      this.logger.error(`Disconnect error: ${error.message}`);
    }
  }

  // =====================
  // AUTHENTICATION
  // =====================

  @SubscribeMessage('authenticate')
  async handleAuthenticate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { token: string; userId: string },
  ) {
    try {
      // TODO: Verify JWT token
      // For now, just accept the userId
      
      const userInfo = this.connectedUsers.get(client.id);
      if (userInfo) {
        userInfo.userId = data.userId;
        this.connectedUsers.set(client.id, userInfo);
      }

      client.emit('authenticated', { success: true });
      this.logger.log(`User authenticated: ${data.userId}`);
    } catch (error) {
      client.emit('authentication_error', { message: error.message });
    }
  }

  // =====================
  // STREAM MANAGEMENT
  // =====================

  @SubscribeMessage('join_stream')
  async handleJoinStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Join the stream room
      client.join(`stream:${data.streamId}`);
      
      // Update user info
      userInfo.streamId = data.streamId;
      this.connectedUsers.set(client.id, userInfo);

      // Update database
      await this.liveSalesService.joinStream(data.streamId, userInfo.userId);

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'viewer_join',
        metadata: { timestamp: new Date().toISOString() },
      });

      // Notify others in the stream
      client.to(`stream:${data.streamId}`).emit('viewer_joined', {
        userId: userInfo.userId,
        timestamp: new Date().toISOString(),
      });

      // Send current viewer count to all in stream
      const roomSize = this.server.sockets.adapter.rooms.get(`stream:${data.streamId}`)?.size || 0;
      this.server.to(`stream:${data.streamId}`).emit('viewer_count_update', {
        streamId: data.streamId,
        count: roomSize,
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      client.emit('joined_stream', { 
        streamId: data.streamId, 
        success: true,
        viewerCount: roomSize,
      });

      this.logger.log(`User ${userInfo.userId} joined stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('leave_stream')
  async handleLeaveStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo) return;

      // Leave the stream room
      client.leave(`stream:${data.streamId}`);
      
      // Update user info
      userInfo.streamId = undefined;
      this.connectedUsers.set(client.id, userInfo);

      if (userInfo.userId !== 'anonymous') {
        // Update database
        await this.liveSalesService.leaveStream(data.streamId, userInfo.userId);

        // Track analytics event
        await this.analyticsService.recordAnalyticsEvent({
          streamId: data.streamId,
          userId: userInfo.userId,
          eventType: 'viewer_leave',
          metadata: { timestamp: new Date().toISOString() },
        });

        // Notify others in the stream
        client.to(`stream:${data.streamId}`).emit('viewer_left', {
          userId: userInfo.userId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast real-time analytics update to vendor
        const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
        this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);
      }

      // Send updated viewer count
      const roomSize = this.server.sockets.adapter.rooms.get(`stream:${data.streamId}`)?.size || 0;
      this.server.to(`stream:${data.streamId}`).emit('viewer_count_update', {
        streamId: data.streamId,
        count: roomSize,
      });

      client.emit('left_stream', { streamId: data.streamId, success: true });
      
      this.logger.log(`User ${userInfo.userId} left stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // REAL-TIME INTERACTIONS
  // =====================

  @SubscribeMessage('send_comment')
  async handleSendComment(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; message: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Save comment to database
      const comment = await this.liveSalesService.postComment(userInfo.userId, {
        stream_id: data.streamId,
        message: data.message,
      });

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'comment',
        metadata: {
          message: data.message,
          timestamp: new Date().toISOString(),
        },
      });

      // Broadcast comment to all viewers in the stream
      this.server.to(`stream:${data.streamId}`).emit('new_comment', {
        id: comment.id,
        user: comment.user,
        message: comment.message,
        timestamp: comment.created_at,
        isOwn: false, // Will be true for the sender
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      // Send confirmation to sender with isOwn: true
      client.emit('new_comment', {
        id: comment.id,
        user: comment.user,
        message: comment.message,
        timestamp: comment.created_at,
        isOwn: true,
      });

      this.logger.log(`Comment sent by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('send_reaction')
  async handleSendReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; reactionType: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Save reaction to database
      await this.liveSalesService.sendReaction(userInfo.userId, {
        stream_id: data.streamId,
        reaction_type: data.reactionType as any,
      });

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'reaction',
        metadata: {
          reactionType: data.reactionType,
          timestamp: new Date().toISOString(),
        },
      });

      // Broadcast reaction animation to all viewers
      this.server.to(`stream:${data.streamId}`).emit('new_reaction', {
        userId: userInfo.userId,
        reactionType: data.reactionType,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      this.logger.log(`Reaction ${data.reactionType} sent by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('send_gift')
  async handleSendGift(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string; 
      giftType: string; 
      quantity: number; 
      message?: string; 
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Process gift with wallet integration using live sales service
      const giftResult = await this.liveSalesService.sendGift(userInfo.userId, {
        stream_id: data.streamId,
        gift_type: data.giftType as any,
        quantity: data.quantity,
        message: data.message,
      });

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'gift_sent',
        metadata: {
          giftType: data.giftType,
          quantity: data.quantity,
          amount: giftResult.total_amount,
          timestamp: new Date().toISOString(),
        },
      });

      // Broadcast gift animation to all viewers
      this.server.to(`stream:${data.streamId}`).emit('new_gift', {
        senderId: userInfo.userId,
        giftType: data.giftType,
        quantity: data.quantity,
        message: data.message,
        amount: giftResult.total_amount,
        timestamp: new Date().toISOString(),
      });

      // Notify vendor about the gift
      this.server.to(`vendor:${data.streamId}`).emit('gift_received', {
        senderId: userInfo.userId,
        giftType: data.giftType,
        quantity: data.quantity,
        message: data.message,
        amount: giftResult.total_amount,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      client.emit('gift_sent', { success: true });
      
      this.logger.log(`Gift ${data.giftType} x${data.quantity} sent by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // LIVE COMMERCE
  // =====================

  @SubscribeMessage('product_purchase')
  async handleProductPurchase(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string; 
      productId: string; 
      quantity: number; 
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Process product purchase using live sales service
      const purchaseResult = await this.liveSalesService.purchaseProduct(userInfo.userId, {
        stream_id: data.streamId,
        product_id: data.productId,
        quantity: data.quantity,
        checkout_option: 'continue_watching', // Default option for live streams
      });

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'product_purchased',
        metadata: {
          productId: data.productId,
          quantity: data.quantity,
          amount: purchaseResult.total_amount,
          timestamp: new Date().toISOString(),
        },
      });

      // Notify all viewers about the purchase (for social proof)
      this.server.to(`stream:${data.streamId}`).emit('product_purchased', {
        productId: data.productId,
        quantity: data.quantity,
        amount: purchaseResult.total_amount,
        timestamp: new Date().toISOString(),
        // Don't reveal buyer identity for privacy
      });

      // Notify vendor about the sale
      this.server.to(`vendor:${data.streamId}`).emit('sale_made', {
        productId: data.productId,
        quantity: data.quantity,
        amount: purchaseResult.total_amount,
        buyerId: userInfo.userId,
        transactionId: purchaseResult.id,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      client.emit('purchase_initiated', { success: true });
      
      this.logger.log(`Product purchase initiated by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('service_booking')
  async handleServiceBooking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string; 
      date: string; 
      time: string; 
      notes?: string; 
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Process service booking using live sales service
      const bookingResult = await this.liveSalesService.bookService(userInfo.userId, {
        stream_id: data.streamId,
        service_date: data.date,
        service_time: data.time,
        service_notes: data.notes,
      });

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'service_booked',
        metadata: {
          date: data.date,
          time: data.time,
          amount: bookingResult.total_amount,
          timestamp: new Date().toISOString(),
        },
      });

      // Notify vendor about the booking
      this.server.to(`vendor:${data.streamId}`).emit('service_booked', {
        date: data.date,
        time: data.time,
        notes: data.notes,
        amount: bookingResult.total_amount,
        buyerId: userInfo.userId,
        bookingId: bookingResult.id,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      this.server.to(`vendor:${data.streamId}`).emit('analytics_update', realtimeAnalytics);

      client.emit('booking_initiated', { success: true });
      
      this.logger.log(`Service booking initiated by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // VENDOR EVENTS
  // =====================

  @SubscribeMessage('vendor_message')
  async handleVendorMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; message: string; type: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // TODO: Verify user is the vendor of this stream

      // Broadcast vendor message to all viewers
      this.server.to(`stream:${data.streamId}`).emit('vendor_message', {
        message: data.message,
        type: data.type,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Vendor message sent in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // INVENTORY MANAGEMENT
  // =====================

  @SubscribeMessage('get_inventory')
  async handleGetInventory(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string; productId: string },
  ) {
    try {
      // TODO: Implement get current inventory logic
      // For now, send mock inventory data
      client.emit('inventory_update', {
        streamId: data.streamId,
        productId: data.productId,
        currentStock: 10,
        reservedStock: 2,
        soldCount: 5,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('reserve_stock')
  async handleReserveStock(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string; 
      productId: string; 
      quantity: number; 
      reservationId: string; 
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // TODO: Implement actual stock reservation logic in database
      
      // Broadcast inventory update to all viewers
      this.server.to(`stream:${data.streamId}`).emit('inventory_update', {
        streamId: data.streamId,
        productId: data.productId,
        currentStock: 8, // Mock data - should come from database
        reservedStock: 4, // Mock data - should come from database
        soldCount: 5,
        lastUpdated: new Date().toISOString(),
      });

      client.emit('stock_reserved', { 
        success: true, 
        reservationId: data.reservationId 
      });

      this.logger.log(`Stock reserved by ${userInfo.userId} for product ${data.productId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('confirm_reservation')
  async handleConfirmReservation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { reservationId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // TODO: Implement reservation confirmation logic
      
      client.emit('reservation_confirmed', { 
        success: true, 
        reservationId: data.reservationId 
      });

      this.logger.log(`Reservation confirmed by ${userInfo.userId}: ${data.reservationId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('cancel_reservation')
  async handleCancelReservation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { reservationId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // TODO: Implement reservation cancellation logic
      
      client.emit('reservation_cancelled', { 
        success: true, 
        reservationId: data.reservationId 
      });

      this.logger.log(`Reservation cancelled by ${userInfo.userId}: ${data.reservationId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // ANALYTICS EVENTS
  // =====================

  @SubscribeMessage('get_analytics')
  async handleGetAnalytics(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Get real-time analytics for the stream
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);

      client.emit('analytics_data', realtimeAnalytics);

      this.logger.log(`Analytics requested for stream ${data.streamId} by ${userInfo.userId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('subscribe_analytics')
  async handleSubscribeAnalytics(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Join analytics room for real-time updates
      client.join(`analytics:${data.streamId}`);

      // Send initial analytics data
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      client.emit('analytics_subscribed', realtimeAnalytics);

      this.logger.log(`User ${userInfo.userId} subscribed to analytics for stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('unsubscribe_analytics')
  async handleUnsubscribeAnalytics(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      // Leave analytics room
      client.leave(`analytics:${data.streamId}`);

      client.emit('analytics_unsubscribed', { streamId: data.streamId });

      this.logger.log(`Client unsubscribed from analytics for stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('vendor_join')
  async handleVendorJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { streamId: string },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Join vendor room for notifications
      client.join(`vendor:${data.streamId}`);

      // Update user role
      userInfo.role = 'vendor';
      this.connectedUsers.set(client.id, userInfo);

      // Send initial analytics data
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      client.emit('vendor_joined', {
        streamId: data.streamId,
        analytics: realtimeAnalytics
      });

      this.logger.log(`Vendor ${userInfo.userId} joined stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  // =====================
  // UTILITY METHODS
  // =====================

  /**
   * Get current viewer count for a stream
   */
  getStreamViewerCount(streamId: string): number {
    return this.server.sockets.adapter.rooms.get(`stream:${streamId}`)?.size || 0;
  }

  /**
   * Broadcast message to all viewers of a stream
   */
  broadcastToStream(streamId: string, event: string, data: any): void {
    this.server.to(`stream:${streamId}`).emit(event, data);
  }

  /**
   * Send message to vendor of a stream
   */
  notifyVendor(vendorId: string, event: string, data: any): void {
    this.server.to(`vendor:${vendorId}`).emit(event, data);
  }

  /**
   * Broadcast analytics update to all analytics subscribers
   */
  broadcastAnalyticsUpdate(streamId: string, analytics: any): void {
    this.server.to(`analytics:${streamId}`).emit('analytics_update', analytics);
    this.server.to(`vendor:${streamId}`).emit('analytics_update', analytics);
  }

  /**
   * Manually trigger analytics update for a stream
   */
  async triggerAnalyticsUpdate(streamId: string): Promise<void> {
    try {
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(streamId);
      this.broadcastAnalyticsUpdate(streamId, realtimeAnalytics);
    } catch (error) {
      this.logger.error(`Error triggering analytics update for stream ${streamId}: ${error.message}`);
    }
  }
}