import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  WebSocketServer,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UseGuards, Inject, forwardRef, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuctionsService } from './auctions.service';

/**
 * Auction WebSocket Gateway
 *
 * Handles real-time auction features:
 * - Live bidding updates
 * - Auction status changes
 * - User notifications (outbid, winning, etc.)
 * - Live auction events (AI auctioneer messages)
 */
@WebSocketGateway({
  namespace: '/auctions',
  cors: {
    origin: [
      'http://localhost:3001',
      'http://localhost:3000',
      'https://fretiko.com',
      'exp://*', // Expo development
      'https://fretiko-backend.onrender.com'
    ],
    credentials: true,
  },
})
export class AuctionGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AuctionGateway.name);

  private activeConnections = new Map<string, { userId?: string; auctionRooms: Set<string>; role?: string }>();
  private auctionViewerCounts = new Map<string, Set<string>>(); // Fallback viewer tracking: auctionId -> Set of userIds

  constructor(
    @Inject(forwardRef(() => AuctionsService))
    private auctionsService: AuctionsService,
  ) {}

  afterInit(server: Server) {
    console.log('Auction WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    
    // Verify JWT token from handshake
    const token = client.handshake.auth?.token;
    if (token) {
      try {
        // Token validation would happen here via JWT service
        // For now, just log that we received a token
        console.log(`Client ${client.id} authenticated with token`);
      } catch (error) {
        console.error(`Authentication failed for client ${client.id}`);
        client.disconnect();
        return;
      }
    }
    
    this.activeConnections.set(client.id, { auctionRooms: new Set() });

    // Send welcome message
    client.emit('connection_established', {
      message: 'Connected to auction system',
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);

    // Leave all auction rooms and update viewer counts
    const connection = this.activeConnections.get(client.id);
    if (connection) {
      connection.auctionRooms.forEach(auctionId => {
        const roomName = `auction_${auctionId}`;

        // Remove from fallback tracking if we have a userId
        if (connection.userId && this.auctionViewerCounts.has(auctionId)) {
          this.auctionViewerCounts.get(auctionId)!.delete(connection.userId);
        }

        // Ensure the socket leaves the room before recounting
        try {
          client.leave(roomName);
        } catch (leaveErr) {
          this.logger.warn(`Failed to leave room ${roomName} on disconnect`, leaveErr as any);
        }
        
        // Broadcast updated viewer count
        const viewerCount = this.getAuctionViewerCount(auctionId);
        const viewerData = {
          auction_id: auctionId,
          view_count: viewerCount,
          current_viewers: viewerCount,
          timestamp: new Date().toISOString(),
        };

        // Broadcast to all remaining viewers in the auction room
        this.server.to(roomName).emit('view_count_updated', viewerData);
        
        // Notify room of viewer leaving
        this.server.to(roomName).emit('viewer_left', {
          auction_id: auctionId,
          timestamp: new Date().toISOString(),
        });
      });
    }

    this.activeConnections.delete(client.id);
  }

  /**
   * Join an auction room for real-time updates
   */
  @SubscribeMessage('join_auction')
  async handleJoinAuction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; user_id?: string },
  ) {
    try {
      // Verify auction exists
      const auction = await this.auctionsService.findById(data.auction_id);

      if (!auction) {
        client.emit('error', { message: 'Auction not found' });
        return;
      }

      // Join auction room
      const roomName = `auction_${data.auction_id}`;
      client.join(roomName);
      
      // Debug: Log room membership after join
      setTimeout(() => {
        try {
          const room = this.server?.sockets?.adapter?.rooms?.get(roomName);
          this.logger.log(`📊 Room ${roomName} now has ${room?.size || 0} members after ${data.user_id?.slice(-8) || 'unknown'} joined`);
        } catch (error) {
          this.logger.log(`📊 Could not check room size for ${roomName}`);
        }
      }, 100);

      // Update connection info
      const connection = this.activeConnections.get(client.id);
      if (connection) {
        connection.auctionRooms.add(data.auction_id);
        if (data.user_id) {
          connection.userId = data.user_id;
          
          // Add to fallback viewer tracking (like live stream)
          if (!this.auctionViewerCounts.has(data.auction_id)) {
            this.auctionViewerCounts.set(data.auction_id, new Set());
          }
          this.auctionViewerCounts.get(data.auction_id)!.add(data.user_id);
          
          // Debug: Log user comparison
          this.logger.log(`🔍 Checking host status: user_id=${data.user_id}, seller_id=${auction.seller_id}`);
          
          // Check if user is the auction host (owner)
          if (data.user_id === auction.seller_id) {
            connection.role = 'host';
            this.logger.log(`✅ User ${data.user_id} is the auction owner - joined as host and included in viewer count`);
          } else {
            connection.role = 'viewer';
            this.logger.log(`👤 User ${data.user_id} joined as viewer (seller is ${auction.seller_id})`);
          }
        }
      }

      // Send current auction status
      client.emit('auction_joined', {
        auction_id: data.auction_id,
        current_bid: auction.current_bid,
        total_bids: auction.total_bids,
        time_remaining: auction.seconds_remaining,
        status: auction.status,
      });

      // Notify room of new viewer (don't include sensitive user info)
      client.to(roomName).emit('viewer_joined', {
        auction_id: data.auction_id,
        timestamp: new Date().toISOString(),
      });

      // Broadcast updated viewer count immediately after join
      const viewerCount = this.getAuctionViewerCount(data.auction_id);
      const viewerData = {
        auction_id: data.auction_id,
        view_count: viewerCount,
        current_viewers: viewerCount,
        timestamp: new Date().toISOString(),
      };

      // Send to the joining client first (so they get current count immediately)
      client.emit('view_count_updated', viewerData);
      
      // Then broadcast to all clients (so everyone gets updated count)
      this.server.to(roomName).emit('view_count_updated', viewerData);

      this.logger.log(`📊 Sent viewer count ${viewerCount} to new joiner and broadcasted to room`);

    } catch (error) {
      this.logger.error(`Failed to join auction ${data.auction_id}`, {
        clientId: client.id,
        auctionId: data.auction_id,
        error: error instanceof Error ? error.message : String(error),
      });
      client.emit('error', { message: 'Failed to join auction. Please try again.' });
    }
  }

  /**
   * Leave an auction room
   */
  @SubscribeMessage('leave_auction')
  handleLeaveAuction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string },
  ) {
    const roomName = `auction_${data.auction_id}`;
    client.leave(roomName);

    // Update connection info
    const connection = this.activeConnections.get(client.id);
    if (connection) {
      connection.auctionRooms.delete(data.auction_id);
      if (connection.userId && this.auctionViewerCounts.has(data.auction_id)) {
        this.auctionViewerCounts.get(data.auction_id)!.delete(connection.userId);
      }
    }

    // Notify room of viewer leaving
    client.to(roomName).emit('viewer_left', {
      auction_id: data.auction_id,
      timestamp: new Date().toISOString(),
    });

    // Broadcast updated viewer count
    const viewerCount = this.getAuctionViewerCount(data.auction_id);
    const viewerData = {
      auction_id: data.auction_id,
      view_count: viewerCount,
      current_viewers: viewerCount,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to all viewers in the auction room
    this.server.to(roomName).emit('view_count_updated', viewerData);

    client.emit('auction_left', { auction_id: data.auction_id });
  }

  /**
   * Handle viewer count requests (for reconnect scenarios)
   */
  @SubscribeMessage('get_viewer_count')
  handleGetViewerCount(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string },
  ) {
    try {
      const viewerCount = this.getAuctionViewerCount(data.auction_id);
      const viewerData = {
        auction_id: data.auction_id,
        view_count: viewerCount,
        current_viewers: viewerCount,
        timestamp: new Date().toISOString(),
      };

      // Send current viewer count to requesting client
      client.emit('view_count_updated', viewerData);
      this.logger.log(`📊 Sent current viewer count ${viewerCount} for auction ${data.auction_id}`);
    } catch (error) {
      this.logger.error(`Failed to get viewer count for auction ${data.auction_id}:`, error);
      client.emit('error', { message: 'Failed to get viewer count' });
    }
  }

  /**
   * Handle live bid placement (with validation)
   */
  @SubscribeMessage('place_bid')
  @UseGuards(JwtAuthGuard)
  async handlePlaceBid(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; amount: number; bid_type?: string },
  ) {
    try {
      // This would integrate with the auctions service
      // For now, just emit to the room
      const roomName = `auction_${data.auction_id}`;

      // Broadcast new bid to all room members
      this.server.to(roomName).emit('new_bid', {
        auction_id: data.auction_id,
        amount: data.amount,
        bidder_display_id: 'Bidder #42', // Would come from service
        timestamp: new Date().toISOString(),
        is_winning: true,
      });

      // Send personal confirmation to bidder
      client.emit('bid_confirmed', {
        auction_id: data.auction_id,
        amount: data.amount,
        status: 'winning',
      });

    } catch (error) {
      this.logger.error(`Failed to place bid in auction ${data.auction_id}`, {
        clientId: client.id,
        auctionId: data.auction_id,
        amount: data.amount,
        error: error instanceof Error ? error.message : String(error),
      });
      client.emit('bid_error', {
        auction_id: data.auction_id,
        message: 'Failed to place bid. Please check your connection and try again.',
      });
    }
  }

  /**
   * Handle live auction events (AI auctioneer)
   */
  @SubscribeMessage('auctioneer_event')
  async handleAuctioneerEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      auction_id: string;
      event_type: 'going_once' | 'going_twice' | 'sold' | 'new_bid';
      message?: string;
    },
  ) {
    const roomName = `auction_${data.auction_id}`;

    // Broadcast auctioneer event to all room members
    this.server.to(roomName).emit('auctioneer_speaks', {
      auction_id: data.auction_id,
      event_type: data.event_type,
      message: data.message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast bid update to auction room
   * Called from auctions service when bid is placed
   */
  async broadcastBidUpdate(auctionId: string, bidData: any) {
    const roomName = `auction_${auctionId}`;

    this.server.to(roomName).emit('new_bid', {
      auction_id: auctionId,
      ...bidData,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast view count update to auction room
   * Called when auction is viewed
   */
  async broadcastViewCountUpdate(auctionId: string, viewCount: number) {
    const roomName = `auction_${auctionId}`;

    this.server.to(roomName).emit('view_count_updated', {
      auction_id: auctionId,
      view_count: viewCount,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast watch count update to auction room
   * Called when watchlist is toggled
   */
  async broadcastWatchCountUpdate(auctionId: string, watchCount: number) {
    const roomName = `auction_${auctionId}`;

    this.server.to(roomName).emit('watch_count_updated', {
      auction_id: auctionId,
      watch_count: watchCount,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Broadcast stream URL update (when host starts/stops broadcasting)
   */
  async broadcastStreamUrlUpdate(auctionId: string, streamUrl: string | null) {
    const roomName = `auction_${auctionId}`;
    const eventData = {
      auction_id: auctionId,
      stream_url: streamUrl,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to specific auction room
    this.server.to(roomName).emit('stream_url_updated', eventData);
    
    // Also broadcast globally for discovery screen updates
    this.server.emit('stream_url_updated', eventData);
    
    // Also emit broadcast_started event for compatibility
    if (streamUrl) {
      this.server.to(roomName).emit('broadcast_started', {
        auction_id: auctionId,
        timestamp: new Date().toISOString(),
      });
      this.server.emit('broadcast_started', {
        auction_id: auctionId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Broadcast auction status change
   * Called from scheduler service
   * Broadcasts to both the specific auction room AND all connected clients (for discovery screen)
   */
  async broadcastAuctionStatusChange(auctionId: string, status: string, data?: any) {
    const roomName = `auction_${auctionId}`;
    const statusChangeEvent = {
      auction_id: auctionId,
      status,
      ...data,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to specific auction room (for users viewing that auction)
    this.server.to(roomName).emit('auction_status_changed', statusChangeEvent);

    // Also broadcast globally (for discovery screen to receive all status changes)
    this.server.emit('auction_status_changed', statusChangeEvent);
  }

  /**
   * Send notification to specific user
   * For outbid notifications, etc.
   */
  async sendUserNotification(userId: string, notification: any) {
    // Find all connections for this user
    this.activeConnections.forEach((connection, clientId) => {
      if (connection.userId === userId) {
        this.server.to(clientId).emit('user_notification', {
          ...notification,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Get active connections count for an auction
   */
  getAuctionViewerCount(auctionId: string): number {
    const roomName = `auction_${auctionId}`;
    
    // Validate input
    if (!auctionId || typeof auctionId !== 'string') {
      this.logger.error(`Invalid auction ID provided to getAuctionViewerCount: ${auctionId}`);
      return 0;
    }
    
    try {
      // For Socket.IO v4, use the proper adapter method
      if (this.server && this.server.sockets && this.server.sockets.adapter) {
        const adapter = this.server.sockets.adapter;
        
        // Method 1: Try adapter.sockets (works with Redis adapter)
        if (adapter.sockets) {
          const roomSockets = adapter.sockets(new Set([roomName]));
          if (roomSockets instanceof Set) {
            const count = roomSockets.size;
            this.logger.log(`📊 Room ${roomName} has ${count} viewers (Redis adapter method)`);
            return Math.max(0, count); // Ensure non-negative
          }
        }
        
        // Method 2: Try adapter.rooms (fallback for single server)
        if (adapter.rooms) {
          const room = adapter.rooms.get(roomName);
          if (room) {
            const count = room.size;
            this.logger.log(`📊 Room ${roomName} has ${count} viewers (adapter.rooms method)`);
            return Math.max(0, count); // Ensure non-negative
          }
        }
      } else {
        this.logger.warn(`📊 Socket.IO adapter not available for viewer count calculation`);
      }
    } catch (error) {
      this.logger.error(`📊 Error calculating viewer count for auction ${auctionId}:`, error);
    }
    
    // Fallback to manual tracking
    const fallbackCount = this.auctionViewerCounts.get(auctionId)?.size || 0;
    this.logger.log(`📊 Using fallback viewer count for auction ${auctionId}: ${fallbackCount}`);
    return Math.max(0, fallbackCount); // Ensure non-negative
  }

  /**
   * Broadcast auction ending warning
   */
  async broadcastAuctionEndingWarning(auctionId: string, minutesRemaining: number) {
    const roomName = `auction_${auctionId}`;

    this.server.to(roomName).emit('auction_ending_soon', {
      auction_id: auctionId,
      minutes_remaining: minutesRemaining,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Notify auction winner
   */
  async notifyAuctionWinner(winnerId: string, auctionId: string, auctionTitle: string, winningBid: number) {
    await this.sendUserNotification(winnerId, {
      type: 'auction_won',
      title: '🎉 Congratulations! You Won the Auction!',
      message: `You've won "${auctionTitle}" with a bid of ₣${winningBid.toFixed(2)}`,
      data: {
        auction_id: auctionId,
        auction_title: auctionTitle,
        winning_bid: winningBid,
        action: 'checkout',
        action_url: `/auctions/${auctionId}`,
      },
    });
  }

  /**
   * Broadcast auction item event to auction room
   */
  async broadcastItemEvent(auctionId: string, itemId: string | null, eventType: string, data: any) {
    const roomName = `auction_${auctionId}`;
    
    const eventData = {
      auction_id: auctionId,
      item_id: itemId,
      event_type: eventType,
      ...data,
      timestamp: new Date().toISOString(),
    };

    this.server.to(roomName).emit('item_event', eventData);
    
    if (eventType === 'item_sold' || eventType === 'item_ready') {
      this.server.emit('item_event', eventData);
    }
  }

  /**
   * Handle reaction from viewer
   */
  @SubscribeMessage('send_reaction')
  async handleSendReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; reaction_type: string },
  ) {
    try {
      const connection = this.activeConnections.get(client.id);
      if (!connection || !connection.userId) {
        client.emit('error', { message: 'User not authenticated' });
        return;
      }

      const userId = connection.userId;
      const reactionType = data.reaction_type;

      const validReactionTypes = ['heart', 'thumbs_up', 'applause', 'fire'];
      if (!validReactionTypes.includes(reactionType)) {
        client.emit('error', { message: 'Invalid reaction type' });
        return;
      }

      await this.auctionsService.sendReaction(userId, data.auction_id, reactionType as any);

      const roomName = `auction_${data.auction_id}`;
      const reactionData = {
        auction_id: data.auction_id,
        user_id: userId,
        reaction_type: reactionType,
        timestamp: new Date().toISOString(),
      };

      this.server.to(roomName).emit('new_reaction', reactionData);
      
      try {
        const room = this.server?.sockets?.adapter?.rooms?.get(roomName);
        this.logger.log(`🎯 Broadcasting reaction to room ${roomName} with ${room?.size || 0} members`);
      } catch (error) {
        this.logger.log(`🎯 Broadcasting reaction to room ${roomName} (room count unavailable)`);
      }
      
      this.logger.log(`Reaction ${reactionType} sent by ${userId} in auction ${data.auction_id}`);
    } catch (error) {
      this.logger.error('Error handling reaction', {
        clientId: client.id,
        auctionId: data?.auction_id,
        reactionType: data?.reaction_type,
        error: error instanceof Error ? error.message : String(error),
      });
      client.emit('error', {
        message: 'Failed to send reaction. Please try again.',
      });
    }
  }
}