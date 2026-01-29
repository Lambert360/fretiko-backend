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
import { Logger, UseGuards, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveSalesService } from './live-sales.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { createSupabaseClient } from '../shared/supabase.client';
import { GiftService } from '../gifts/gift.service';

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
  private connectedUsers = new Map<string, { userId: string; streamId?: string; role: string; accessToken?: string }>();
  private streamViewerCounts = new Map<string, Set<string>>(); // Fallback viewer tracking: streamId -> Set of userIds
  private streamVendorCache = new Map<string, string>();
  private supabase;

  constructor(
    private readonly liveSalesService: LiveSalesService,
    private readonly analyticsService: AnalyticsService,
    private readonly configService: ConfigService,
    private readonly giftService: GiftService,
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  private async getVendorIdForStream(streamId: string): Promise<string | null> {
    const cached = this.streamVendorCache.get(streamId);
    if (cached) return cached;

    try {
      const stream = await this.liveSalesService.getStreamById(streamId);
      const vendorId = stream?.vendor_id || stream?.vendor?.id;
      if (!vendorId) return null;
      this.streamVendorCache.set(streamId, vendorId);
      return vendorId;
    } catch (error) {
      this.logger.warn(`Could not resolve vendor for stream ${streamId}: ${error?.message || error}`);
      return null;
    }
  }

  private async emitToVendorByStreamId(streamId: string, event: string, payload: any): Promise<void> {
    const vendorId = await this.getVendorIdForStream(streamId);
    if (!vendorId) return;
    this.server.to(`vendor:${vendorId}`).emit(event, payload);
  }

  broadcastStreamStatusUpdate(streamId: string, status: string): void {
    const payload = {
      streamId,
      status,
      timestamp: new Date().toISOString(),
    };

    this.server.to(`stream:${streamId}`).emit('stream_status_update', payload);
    void this.emitToVendorByStreamId(streamId, 'stream_status_update', payload);
  }

  // =====================
  // GATEWAY LIFECYCLE
  // =====================

  afterInit(server: Server) {
    this.server = server;
    this.logger.log('Live Stream WebSocket Gateway initialized');
    this.logger.log(`Socket.IO adapter type: ${this.server?.sockets?.adapter?.constructor?.name || 'unknown'}`);
  }

  async handleConnection(client: Socket) {
    try {
      this.logger.log(`Client connected: ${client.id}`);
      
      // Extract JWT token from handshake auth or query parameters
      const token = client.handshake.auth?.token || 
                   client.handshake.query?.token as string || 
                   client.handshake.headers?.authorization?.replace('Bearer ', '');
      
      // Attempt to authenticate on connection if token is provided
      if (token) {
        try {
          const { data: { user }, error } = await this.supabase.auth.getUser(token);
          
          if (error || !user) {
            this.logger.warn(`Invalid token on connection: ${client.id}`, error?.message);
            this.connectedUsers.set(client.id, {
              userId: 'anonymous',
              role: 'viewer',
              accessToken: undefined,
            });
          } else {
            this.logger.log(`Authenticated user on connection: ${user.id}`);
            this.connectedUsers.set(client.id, {
              userId: user.id,
              role: 'viewer',
              accessToken: token,  // Store token for user-authenticated operations
            });
            // Join vendor room if user is a vendor
            if (user.user_metadata?.is_seller || user.user_metadata?.is_vendor) {
              client.join(`vendor:${user.id}`);
              this.connectedUsers.get(client.id)!.role = 'vendor';
            }

            // Emit authentication confirmation to client (industry standard)
            const authData = {
              success: true,
              userId: user.id,
              role: this.connectedUsers.get(client.id)?.role || 'viewer',
              timestamp: new Date().toISOString()
            };

            client.emit('authenticated', authData);
            this.logger.log(`✅ Authentication event emitted to client ${client.id} for user: ${user.id} (role: ${authData.role})`);
          }
        } catch (authError) {
          this.logger.warn(`Auth error on connection: ${client.id}`, authError.message);
          this.connectedUsers.set(client.id, {
            userId: 'anonymous',
            role: 'viewer',
          });
        }
      } else {
        // No token provided - set as anonymous (can authenticate later)
        this.connectedUsers.set(client.id, {
          userId: 'anonymous',
          role: 'viewer',
        });
        this.logger.log(`Anonymous connection: ${client.id} - authentication required`);
      }

    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      
      if (userInfo?.streamId) {
        // Remove from fallback viewer tracking
        if (this.streamViewerCounts.has(userInfo.streamId)) {
          this.streamViewerCounts.get(userInfo.streamId)!.delete(userInfo.userId);
          // Clean up empty sets
          if (this.streamViewerCounts.get(userInfo.streamId)!.size === 0) {
            this.streamViewerCounts.delete(userInfo.streamId);
          }
        }

        // Check if disconnecting user is the vendor
        const isVendor = userInfo.role === 'vendor';

        if (isVendor) {
          // Vendor disconnected - end their stream
          this.logger.log(`🏁 Vendor ${userInfo.userId} disconnected from their stream ${userInfo.streamId} - ending stream`);

          try {
            if (userInfo.accessToken) {
              await this.liveSalesService.endStream(userInfo.streamId, userInfo.userId, userInfo.accessToken);
            } else {
              this.logger.warn(`No access token available for vendor ${userInfo.userId} - cannot end stream properly`);
            }

            // Notify all viewers that stream ended due to disconnect
            this.server.to(`stream:${userInfo.streamId}`).emit('stream_ended', {
              streamId: userInfo.streamId,
              reason: 'vendor_disconnected',
              timestamp: new Date().toISOString(),
            });
          } catch (endError) {
            this.logger.error(`Failed to end stream on vendor disconnect: ${endError.message}`);
          }
        } else {
          // Regular viewer disconnecting
          await this.liveSalesService.leaveStream(userInfo.streamId, userInfo.userId);
          
          // Send updated viewer count after disconnect
          let roomSize = this.streamViewerCounts.get(userInfo.streamId)?.size || 0;
          
          // Try to use adapter if available (more accurate)
          if (this.server?.sockets?.adapter?.rooms) {
            const adapterRoomSize = this.server.sockets.adapter.rooms.get(`stream:${userInfo.streamId}`)?.size || 0;
            roomSize = adapterRoomSize;
          }

          // Emit to both stream viewers AND vendor/broadcaster
          this.server.to(`stream:${userInfo.streamId}`).emit('viewer_count_update', {
            streamId: userInfo.streamId,
            count: roomSize,
          });
          await this.emitToVendorByStreamId(userInfo.streamId, 'viewer_count_update', {
            streamId: userInfo.streamId,
            count: roomSize,
          });
        }
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
    @MessageBody() data: { token: string; userId?: string },
  ) {
    try {
      if (!data.token) {
        client.emit('authentication_error', { message: 'Token is required' });
        return;
      }

      // Verify JWT token using Supabase Auth
      const { data: { user }, error } = await this.supabase.auth.getUser(data.token);
      
      if (error || !user) {
        this.logger.warn(`Authentication failed: ${client.id}`, error?.message);
        client.emit('authentication_error', { 
          message: error?.message || 'Invalid token' 
        });
        return;
      }

      // Verify userId matches token payload (if provided)
      if (data.userId && data.userId !== user.id) {
        this.logger.warn(`User ID mismatch: ${client.id}`, {
          provided: data.userId,
          token: user.id
        });
        client.emit('authentication_error', { 
          message: 'User ID does not match token' 
        });
        return;
      }

      // Update user info with authenticated user
      const userInfo = this.connectedUsers.get(client.id);
      if (userInfo) {
        userInfo.userId = user.id;
        userInfo.role = user.user_metadata?.is_seller || user.user_metadata?.is_vendor 
          ? 'vendor' 
          : 'viewer';
        this.connectedUsers.set(client.id, userInfo);
        
        // Join vendor room if user is a vendor
        if (userInfo.role === 'vendor') {
          client.join(`vendor:${user.id}`);
        }
      } else {
        // Create new entry if doesn't exist
        this.connectedUsers.set(client.id, {
          userId: user.id,
          role: user.user_metadata?.is_seller || user.user_metadata?.is_vendor 
            ? 'vendor' 
            : 'viewer',
        });
        if (this.connectedUsers.get(client.id)!.role === 'vendor') {
          client.join(`vendor:${user.id}`);
        }
      }

      // Emit authentication confirmation to client (industry standard)
      const authData = {
        success: true,
        userId: user.id,
        role: this.connectedUsers.get(client.id)?.role || 'viewer',
        timestamp: new Date().toISOString()
      };

      client.emit('authenticated', authData);
      this.logger.log(`✅ Authentication event emitted to client ${client.id} for user: ${user.id} (role: ${authData.role})`);
    } catch (error) {
      this.logger.error(`Authentication error: ${client.id}`, error);
      client.emit('authentication_error', { 
        message: error instanceof Error ? error.message : 'Authentication failed' 
      });
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

      // Check if user is the stream owner
      try {
        const stream = await this.liveSalesService.getStreamById(data.streamId);
        if (stream && stream.vendor_id === userInfo.userId) {
          userInfo.role = 'vendor';
          this.streamVendorCache.set(data.streamId, userInfo.userId);
          client.join(`vendor:${userInfo.userId}`);
          this.logger.log(`✅ User ${userInfo.userId} is the stream owner - joined as vendor`);
        }
      } catch (err) {
        this.logger.warn(`Could not check stream ownership: ${err.message}`);
      }

      // Join the stream room
      client.join(`stream:${data.streamId}`);
      
      // Update user info
      userInfo.streamId = data.streamId;
      this.connectedUsers.set(client.id, userInfo);

      // Add to fallback viewer tracking
      if (!this.streamViewerCounts.has(data.streamId)) {
        this.streamViewerCounts.set(data.streamId, new Set());
      }
      this.streamViewerCounts.get(data.streamId)!.add(userInfo.userId);

      // Update database
      await this.liveSalesService.joinStream(data.streamId, userInfo.userId, userInfo.accessToken);

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

      // Calculate viewer count using fallback Map
      let roomSize = this.streamViewerCounts.get(data.streamId)?.size || 0;
      
      // Try to use adapter if available (more accurate)
      if (this.server?.sockets?.adapter?.rooms) {
        const adapterRoomSize = this.server.sockets.adapter.rooms.get(`stream:${data.streamId}`)?.size || 0;
        this.logger.log(`📊 Room size - Adapter: ${adapterRoomSize}, Fallback: ${roomSize}`);
        roomSize = adapterRoomSize; // Prefer adapter if available
      } else {
        this.logger.log(`📊 Using fallback viewer count: ${roomSize}`);
      }

      // Emit to both stream viewers AND vendor/broadcaster
      this.server.to(`stream:${data.streamId}`).emit('viewer_count_update', {
        streamId: data.streamId,
        count: roomSize,
      });
      await this.emitToVendorByStreamId(data.streamId, 'viewer_count_update', {
        streamId: data.streamId,
        count: roomSize,
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

      client.emit('joined_stream', { 
        streamId: data.streamId, 
        success: true,
        viewerCount: roomSize,
      });

      this.logger.log(`User ${userInfo.userId} joined stream ${data.streamId} as ${userInfo.role}`);
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

      // Check if this user is the stream owner/vendor
      const isVendor = userInfo.role === 'vendor';

      // Leave the stream room
      client.leave(`stream:${data.streamId}`);
      
      // Update user info
      userInfo.streamId = undefined;
      this.connectedUsers.set(client.id, userInfo);

      // Remove from fallback viewer tracking
      if (this.streamViewerCounts.has(data.streamId)) {
        this.streamViewerCounts.get(data.streamId)!.delete(userInfo.userId);
        // Clean up empty sets
        if (this.streamViewerCounts.get(data.streamId)!.size === 0) {
          this.streamViewerCounts.delete(data.streamId);
        }
      }

      if (userInfo.userId !== 'anonymous') {
        // If vendor is leaving their own stream, end it automatically
        if (isVendor) {
          this.logger.log(`🏁 Vendor ${userInfo.userId} leaving their stream ${data.streamId} - ending stream`);
          if (userInfo.accessToken) {
            await this.liveSalesService.endStream(data.streamId, userInfo.userId, userInfo.accessToken);
          } else {
            this.logger.warn(`No access token available for vendor ${userInfo.userId} - cannot end stream properly`);
          }

          // Notify all viewers that stream ended
          this.server.to(`stream:${data.streamId}`).emit('stream_ended', {
            streamId: data.streamId,
            reason: 'vendor_left',
            timestamp: new Date().toISOString(),
          });

          // Track analytics event
          await this.analyticsService.recordAnalyticsEvent({
            streamId: data.streamId,
            userId: userInfo.userId,
            eventType: 'stream_end',
            metadata: { reason: 'vendor_left', timestamp: new Date().toISOString() },
          });
        } else {
          // Regular viewer leaving
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
        await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);
        }
      }

      // Calculate viewer count using fallback Map
      let roomSize = this.streamViewerCounts.get(data.streamId)?.size || 0;
      
      // Try to use adapter if available (more accurate)
      if (this.server?.sockets?.adapter?.rooms) {
        const adapterRoomSize = this.server.sockets.adapter.rooms.get(`stream:${data.streamId}`)?.size || 0;
        this.logger.log(`📊 Room size after leave - Adapter: ${adapterRoomSize}, Fallback: ${roomSize}`);
        roomSize = adapterRoomSize; // Prefer adapter if available
      } else {
        this.logger.log(`📊 Using fallback viewer count after leave: ${roomSize}`);
      }

      // Emit to both stream viewers AND vendor/broadcaster
      this.server.to(`stream:${data.streamId}`).emit('viewer_count_update', {
        streamId: data.streamId,
        count: roomSize,
      });
      await this.emitToVendorByStreamId(data.streamId, 'viewer_count_update', {
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

      // Broadcast comment to all OTHER viewers in the stream (excluding sender)
      // Use broadcast.to() to exclude the sender from receiving the broadcast
      const commentData = {
        id: comment.id,
        user: comment.user,
        message: comment.message,
        timestamp: comment.created_at,
        isOwn: false,
      };
      
      // Broadcast to all other clients in the stream room (excluding sender)
      client.broadcast.to(`stream:${data.streamId}`).emit('new_comment', commentData);
      
      // Also broadcast to vendor room (excluding sender if they're the vendor)
      // If sender is vendor, they'll get the direct emit below, not this broadcast
      {
        const vendorId = await this.getVendorIdForStream(data.streamId);
        if (vendorId) {
          client.broadcast.to(`vendor:${vendorId}`).emit('new_comment', commentData);
        }
      }

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

      // Send confirmation ONLY to sender with isOwn: true (they won't receive the broadcast above)
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
      // Handle both reactionType and reaction_type for backward compatibility
      const reactionType = data.reactionType || (data as any).reaction_type;
      if (!reactionType) {
        client.emit('error', { message: 'reaction_type is required' });
        return;
      }
      
      await this.liveSalesService.sendReaction(userInfo.userId, {
        stream_id: data.streamId,
        reaction_type: reactionType as any,
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
      const reactionData = {
        userId: userInfo.userId,
        reactionType: data.reactionType,
        timestamp: new Date().toISOString(),
      };
      
      this.server.to(`stream:${data.streamId}`).emit('new_reaction', reactionData);

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

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

      // Verify stream + resolve vendor to gift recipient
      const stream = await this.liveSalesService.getStreamById(data.streamId);

      if (!stream?.vendor?.id) {
        client.emit('error', { message: 'Stream vendor not found' });
        return;
      }

      // Deduct gift from sender inventory and transfer to vendor (Model A)
      await this.giftService.sendGift(userInfo.userId, {
        gift_id: data.giftType,
        quantity: data.quantity,
        recipient_id: stream.vendor.id,
        session_type: 'stream',
        session_id: data.streamId,
        message: data.message,
      } as any);

      // Resolve gift details from virtual gifts system (call/chat gifts)
      let giftEmoji = '🎁';
      let resolvedGiftType = data.giftType;
      let unitValue = 0;

      const { data: virtualGiftById } = await this.supabase
        .from('virtual_gifts')
        .select('id, name, emoji, credit_value, is_active')
        .eq('id', data.giftType)
        .eq('is_active', true)
        .single();

      if (virtualGiftById) {
        giftEmoji = virtualGiftById.emoji || giftEmoji;
        resolvedGiftType = virtualGiftById.name || resolvedGiftType;
        unitValue = virtualGiftById.credit_value || 0;
      } else {
        const { data: virtualGiftByName } = await this.supabase
          .from('virtual_gifts')
          .select('id, name, emoji, credit_value, is_active')
          .eq('name', data.giftType)
          .eq('is_active', true)
          .single();

        if (virtualGiftByName) {
          giftEmoji = virtualGiftByName.emoji || giftEmoji;
          resolvedGiftType = virtualGiftByName.name || resolvedGiftType;
          unitValue = virtualGiftByName.credit_value || 0;
        }
      }

      const totalAmount = unitValue * (data.quantity || 1);

      // Track analytics event
      await this.analyticsService.recordAnalyticsEvent({
        streamId: data.streamId,
        userId: userInfo.userId,
        eventType: 'gift_sent',
        metadata: {
          giftType: resolvedGiftType,
          quantity: data.quantity,
          amount: totalAmount,
          timestamp: new Date().toISOString(),
        },
      });

      // Broadcast gift animation to all viewers
      this.server.to(`stream:${data.streamId}`).emit('new_gift', {
        senderId: userInfo.userId,
        giftType: resolvedGiftType,
        giftEmoji,
        quantity: data.quantity,
        message: data.message,
        amount: totalAmount,
        timestamp: new Date().toISOString(),
      });

      // Notify vendor about the gift
      await this.emitToVendorByStreamId(data.streamId, 'gift_received', {
        senderId: userInfo.userId,
        giftType: resolvedGiftType,
        giftEmoji,
        quantity: data.quantity,
        message: data.message,
        amount: totalAmount,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

      client.emit('gift_sent', { success: true });
      
      this.logger.log(`Gift ${resolvedGiftType} x${data.quantity} sent by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('showcase_item')
  async handleShowcaseItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string;
      item: any;
      showcasedBy?: string;
      type?: string;
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Verify user is the stream owner (vendor) and stream is live
      try {
        const stream = await this.liveSalesService.getStreamById(data.streamId);

        if (stream.vendor_id !== userInfo.userId) {
          client.emit('error', { message: 'Only stream owner can showcase items' });
          return;
        }

        if (stream.status !== 'live') {
          client.emit('error', { message: 'Can only showcase items during live streams' });
          return;
        }
      } catch (error) {
        if (error instanceof NotFoundException) {
          client.emit('error', { message: 'Stream not found' });
        } else {
          client.emit('error', { message: 'Failed to verify stream' });
        }
        return;
      }

      // Broadcast showcase item to all viewers
      this.server.to(`stream:${data.streamId}`).emit('showcase_item', {
        item: data.item,
        showcasedBy: data.showcasedBy || userInfo.userId,
        type: data.type,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Item showcased by ${userInfo.userId} in stream ${data.streamId}`);
    } catch (error) {
      this.logger.error(`Error showcasing item: ${error.message}`);
      client.emit('error', { message: error.message });
    }
  }

  @SubscribeMessage('highlight_item')
  async handleHighlightItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      streamId: string;
      item: any;
      highlightedBy?: string;
      type?: string;
    },
  ) {
    this.logger.log(`🌟 highlight_item event received from client ${client.id} for stream ${data.streamId}`);
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        this.logger.warn(`❌ highlight_item rejected: User not authenticated (client ${client.id})`);
        client.emit('error', { message: 'User not authenticated' });
        return;
      }
      this.logger.log(`✅ highlight_item: User authenticated - ${userInfo.userId}`);

      // Verify user is the stream owner (vendor) and stream is live
      try {
        const stream = await this.liveSalesService.getStreamById(data.streamId);

        if (stream.vendor_id !== userInfo.userId) {
          client.emit('error', { message: 'Only stream owner can highlight items' });
          return;
        }

        if (stream.status !== 'live') {
          client.emit('error', { message: 'Can only highlight items during live streams' });
          return;
        }
      } catch (error) {
        if (error instanceof NotFoundException) {
          client.emit('error', { message: 'Stream not found' });
        } else {
          client.emit('error', { message: 'Failed to verify stream' });
        }
        return;
      }

      // Broadcast highlight item to all OTHER viewers (excluding sender)
      // Use broadcast.to() to exclude the sender from receiving the broadcast
      const highlightData = {
        streamId: data.streamId,
        item: data.item,
        highlightedBy: data.highlightedBy || userInfo.userId,
        type: data.type,
        timestamp: new Date().toISOString(),
      };

      // Get room size for logging (excluding sender) - with safety check
      let roomSize = 0;
      if (this.server && this.server.sockets && this.server.sockets.adapter && this.server.sockets.adapter.rooms) {
        roomSize = this.server.sockets.adapter.rooms.get(`stream:${data.streamId}`)?.size || 0;
      }
      const broadcastCount = Math.max(0, roomSize - 1); // Exclude sender
      this.logger.log(`🌟 Broadcasting highlight_item to ${broadcastCount} other clients in stream:${data.streamId} (total in room: ${roomSize})`);
      
      // Broadcast to all OTHER clients (excluding sender)
      client.broadcast.to(`stream:${data.streamId}`).emit('highlight_item', highlightData);
      this.logger.log(`📡 highlight_item broadcast sent to stream:${data.streamId} room (excluding sender ${client.id})`);

      this.logger.log(`✅ Item highlighted by ${userInfo.userId} in stream ${data.streamId} (type: ${data.type}, item: ${data.item ? 'present' : 'dismissed'})`);
    } catch (error) {
      this.logger.error(`Error highlighting item: ${error.message}`);
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
      await this.emitToVendorByStreamId(data.streamId, 'sale_made', {
        productId: data.productId,
        quantity: data.quantity,
        amount: purchaseResult.total_amount,
        buyerId: userInfo.userId,
        transactionId: purchaseResult.id,
        timestamp: new Date().toISOString(),
      });

      // Broadcast real-time analytics update to vendor
      const realtimeAnalytics = await this.analyticsService.getRealTimeLiveStreamAnalytics(data.streamId);
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

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
      await this.emitToVendorByStreamId(data.streamId, 'service_booked', {
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
      await this.emitToVendorByStreamId(data.streamId, 'analytics_update', realtimeAnalytics);

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

      // Verify user is the vendor of this stream
      const { data: stream, error: streamError } = await this.supabase
        .from('live_streams')
        .select('vendor_id, status')
        .eq('id', data.streamId)
        .single();

      if (streamError || !stream) {
        client.emit('error', { message: 'Stream not found' });
        return;
      }

      if (stream.vendor_id !== userInfo.userId) {
        client.emit('error', { message: 'Unauthorized: Only stream vendor can send vendor messages' });
        this.logger.warn(`Unauthorized vendor message attempt: User ${userInfo.userId} tried to send message for stream ${data.streamId} owned by ${stream.vendor_id}`);
        return;
      }

      if (stream.status !== 'live') {
        client.emit('error', { message: 'Cannot send vendor messages for inactive streams' });
        return;
      }

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
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Get real inventory data from database
      const inventory = await this.liveSalesService.getProductInventory(
        data.streamId,
        data.productId
      );

      // Broadcast inventory update to all viewers
      this.server.to(`stream:${data.streamId}`).emit('inventory_update', {
        streamId: data.streamId,
        productId: data.productId,
        currentStock: inventory.currentStock,
        reservedStock: inventory.reservedStock,
        availableStock: inventory.availableStock,
        soldCount: inventory.soldCount,
        lastUpdated: new Date().toISOString(),
      });

      // Also send to requesting client
      client.emit('inventory_update', {
        streamId: data.streamId,
        productId: data.productId,
        currentStock: inventory.currentStock,
        reservedStock: inventory.reservedStock,
        availableStock: inventory.availableStock,
        soldCount: inventory.soldCount,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(`Error getting inventory: ${error.message}`);
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
      reservationId?: string; 
    },
  ) {
    try {
      const userInfo = this.connectedUsers.get(client.id);
      if (!userInfo || userInfo.userId === 'anonymous') {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      // Get live product ID using service method
      const liveProductId = await this.liveSalesService.getLiveProductId(data.streamId, data.productId);

      if (!liveProductId) {
        client.emit('error', { message: 'Product not found in stream' });
        return;
      }

      // Reserve stock using service method
      const reservationResult = await this.liveSalesService.reserveStock(
        data.streamId,
        data.productId,
        liveProductId,
        userInfo.userId,
        data.quantity,
      );

      if (!reservationResult.success) {
        client.emit('stock_reservation_failed', {
          error: reservationResult.error,
          availableStock: reservationResult.availableStock,
        });
        return;
      }

      // Get updated inventory
      const inventory = await this.liveSalesService.getProductInventory(
        data.streamId,
        data.productId
      );
      
      // Broadcast inventory update to all viewers
      this.server.to(`stream:${data.streamId}`).emit('inventory_update', {
        streamId: data.streamId,
        productId: data.productId,
        currentStock: inventory.currentStock,
        reservedStock: inventory.reservedStock,
        availableStock: inventory.availableStock,
        soldCount: inventory.soldCount,
        lastUpdated: new Date().toISOString(),
      });

      client.emit('stock_reserved', { 
        success: true, 
        reservationId: reservationResult.reservationId,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes from now
      });

      this.logger.log(`Stock reserved by ${userInfo.userId} for product ${data.productId}: ${reservationResult.reservationId}`);
    } catch (error) {
      this.logger.error(`Error reserving stock: ${error.message}`);
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

      // Verify reservation belongs to user
      const { data: reservation, error: reservationError } = await this.liveSalesService['supabase']
        .from('live_stream_stock_reservations')
        .select('user_id, stream_id, product_id')
        .eq('id', data.reservationId)
        .single();

      if (reservationError || !reservation) {
        client.emit('error', { message: 'Reservation not found' });
        return;
      }

      if (reservation.user_id !== userInfo.userId) {
        client.emit('error', { message: 'Unauthorized' });
        return;
      }

      // Confirm reservation using service method
      const success = await this.liveSalesService.confirmReservation(data.reservationId);

      if (!success) {
        client.emit('error', { message: 'Failed to confirm reservation' });
        return;
      }

      // Get updated inventory
      const inventory = await this.liveSalesService.getProductInventory(
        reservation.stream_id,
        reservation.product_id
      );

      // Broadcast inventory update
      this.server.to(`stream:${reservation.stream_id}`).emit('inventory_update', {
        streamId: reservation.stream_id,
        productId: reservation.product_id,
        currentStock: inventory.currentStock,
        reservedStock: inventory.reservedStock,
        availableStock: inventory.availableStock,
        soldCount: inventory.soldCount,
        lastUpdated: new Date().toISOString(),
      });
      
      client.emit('reservation_confirmed', { 
        success: true, 
        reservationId: data.reservationId 
      });

      this.logger.log(`Reservation confirmed by ${userInfo.userId}: ${data.reservationId}`);
    } catch (error) {
      this.logger.error(`Error confirming reservation: ${error.message}`);
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

      // Verify reservation belongs to user
      const { data: reservation, error: reservationError } = await this.liveSalesService['supabase']
        .from('live_stream_stock_reservations')
        .select('user_id, stream_id, product_id')
        .eq('id', data.reservationId)
        .single();

      if (reservationError || !reservation) {
        client.emit('error', { message: 'Reservation not found' });
        return;
      }

      if (reservation.user_id !== userInfo.userId) {
        client.emit('error', { message: 'Unauthorized' });
        return;
      }

      // Cancel reservation using service method
      const success = await this.liveSalesService.cancelReservation(data.reservationId);

      if (!success) {
        client.emit('error', { message: 'Failed to cancel reservation' });
        return;
      }

      // Get updated inventory
      const inventory = await this.liveSalesService.getProductInventory(
        reservation.stream_id,
        reservation.product_id
      );

      // Broadcast inventory update
      this.server.to(`stream:${reservation.stream_id}`).emit('inventory_update', {
        streamId: reservation.stream_id,
        productId: reservation.product_id,
        currentStock: inventory.currentStock,
        reservedStock: inventory.reservedStock,
        availableStock: inventory.availableStock,
        soldCount: inventory.soldCount,
        lastUpdated: new Date().toISOString(),
      });
      
      client.emit('reservation_cancelled', { 
        success: true, 
        reservationId: data.reservationId 
      });

      this.logger.log(`Reservation cancelled by ${userInfo.userId}: ${data.reservationId}`);
    } catch (error) {
      this.logger.error(`Error cancelling reservation: ${error.message}`);
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

      const stream = await this.liveSalesService.getStreamById(data.streamId);
      if (!stream || stream.vendor_id !== userInfo.userId) {
        client.emit('error', { message: 'Only stream owner can join vendor room' });
        return;
      }

      this.streamVendorCache.set(data.streamId, userInfo.userId);
      client.join(`vendor:${userInfo.userId}`);
      

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
    if (this.server && this.server.sockets && this.server.sockets.adapter && this.server.sockets.adapter.rooms) {
    return this.server.sockets.adapter.rooms.get(`stream:${streamId}`)?.size || 0;
    } else {
      this.logger.warn(`⚠️ Cannot access rooms in getStreamViewerCount - adapter not available`);
      return 0;
    }
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
    void this.emitToVendorByStreamId(streamId, 'analytics_update', analytics);
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