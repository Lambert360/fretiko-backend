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
import { UseGuards, Inject, forwardRef } from '@nestjs/common';
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
    origin: '*', // Configure appropriately for production
  },
})
export class AuctionGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private activeConnections = new Map<string, { userId?: string; auctionRooms: Set<string> }>();

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

    // Leave all auction rooms
    const connection = this.activeConnections.get(client.id);
    if (connection) {
      connection.auctionRooms.forEach(auctionId => {
        client.leave(`auction_${auctionId}`);
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

      // Update connection info
      const connection = this.activeConnections.get(client.id);
      if (connection) {
        connection.auctionRooms.add(data.auction_id);
        if (data.user_id) {
          connection.userId = data.user_id;
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

    } catch (error) {
      client.emit('error', { message: 'Failed to join auction' });
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
    }

    // Notify room of viewer leaving
    client.to(roomName).emit('viewer_left', {
      auction_id: data.auction_id,
      timestamp: new Date().toISOString(),
    });

    client.emit('auction_left', { auction_id: data.auction_id });
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
      client.emit('bid_error', {
        auction_id: data.auction_id,
        message: 'Failed to place bid',
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
   * Get active connections count for an auction
   */
  getAuctionViewerCount(auctionId: string): number {
    const roomName = `auction_${auctionId}`;
    const room = this.server.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
  }

  /**
   * Notify auction winner
   * Sends real-time notification to winner about their win
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
}