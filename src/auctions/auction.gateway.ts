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
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuctionsService } from './auctions.service';
import { createServiceSupabaseClient } from '../shared/supabase.client';

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
  server!: Server;

  private readonly logger = new Logger(AuctionGateway.name);

  private activeConnections = new Map<string, { userId?: string; auctionRooms: Set<string>; role?: string }>();
  // Presence tracking, split by where the user is in the app:
  //  - stream watchers: AuctionLiveViewerScreen (context='stream')
  //  - details viewers: details/lobby screens (context='details')
  // Keys are verified userId, or socket.id for anonymous users. The host and
  // update-only joins (no context) are tracked in neither.
  private auctionStreamWatchers = new Map<string, Set<string>>();
  private auctionDetailsViewers = new Map<string, Set<string>>();
  private soundCooldowns = new Map<string, number>(); // client.id -> last play_sound timestamp
  private supabase;

  constructor(
    @Inject(forwardRef(() => AuctionsService))
    private auctionsService: AuctionsService,
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    this.supabase = createServiceSupabaseClient(this.configService);
  }

  afterInit(server: Server) {
    console.log('Auction WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);

    // Verify JWT token from handshake — anonymous connections stay connected
    // but carry no trusted identity (join_auction uses this, never a
    // client-supplied user_id).
    const token = client.handshake.auth?.token || (client.handshake.query?.token as string | undefined);
    if (token) {
      try {
        const decoded = this.jwtService.verify(token);
        if (decoded?.sub) {
          (client as any).user = {
            sub: decoded.sub,
            id: decoded.sub,
            email: decoded.email,
            type: decoded.type,
          };
          this.activeConnections.set(client.id, {
            auctionRooms: new Set(),
            userId: decoded.sub,
          });
        }
      } catch (error) {
        this.logger.warn(`Invalid handshake token for client ${client.id} — continuing as anonymous`);
      }
    }

    if (!this.activeConnections.has(client.id)) {
      this.activeConnections.set(client.id, { auctionRooms: new Set() });
    }

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

        // Remove from presence tracking (same key join_auction used)
        const presenceKey = connection.userId ?? client.id;
        this.auctionStreamWatchers.get(auctionId)?.delete(presenceKey);
        this.auctionDetailsViewers.get(auctionId)?.delete(presenceKey);

        // Ensure the socket leaves the room before recounting
        try {
          client.leave(roomName);
        } catch (leaveErr) {
          this.logger.warn(`Failed to leave room ${roomName} on disconnect`, leaveErr as any);
        }
        
        // Broadcast updated counts
        const viewerData = this.buildViewerCountPayload(auctionId);

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
    this.soundCooldowns.delete(client.id);
  }

  /**
   * Join an auction room for real-time updates
   */
  @SubscribeMessage('join_auction')
  async handleJoinAuction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      auction_id: string;
      user_id?: string;
      /** 'stream' = watching the live video; 'details' = on a details screen */
      context?: 'stream' | 'details';
    },
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
      
      // Identity comes ONLY from the verified handshake token (set in
      // handleConnection). The client-supplied data.user_id is ignored —
      // it was previously trusted for host-role and notification targeting.
      const connection = this.activeConnections.get(client.id);
      const verifiedUserId = connection?.userId;

      // Debug: Log room membership after join
      setTimeout(() => {
        try {
          const room = this.server?.sockets?.adapter?.rooms?.get(roomName);
          this.logger.log(`📊 Room ${roomName} now has ${room?.size || 0} members after ${verifiedUserId?.slice(-8) || 'anonymous'} joined`);
        } catch (error) {
          this.logger.log(`📊 Could not check room size for ${roomName}`);
        }
      }, 100);

      // Update connection info
      if (connection) {
        connection.auctionRooms.add(data.auction_id);

        const isHost = !!verifiedUserId && verifiedUserId === auction.seller_id;
        if (verifiedUserId) {
          connection.role = isHost ? 'host' : 'viewer';
        }

        // Count presence by declared context — key by userId (dedupes a
        // user's devices), falling back to socket.id for anonymous users.
        const presenceKey = verifiedUserId ?? client.id;
        if (data.context === 'stream' && !isHost) {
          if (!this.auctionStreamWatchers.has(data.auction_id)) {
            this.auctionStreamWatchers.set(data.auction_id, new Set());
          }
          this.auctionStreamWatchers.get(data.auction_id)!.add(presenceKey);
          this.logger.log(`👁️ Stream watcher ${presenceKey} joined auction ${data.auction_id}`);
        } else if (data.context === 'details') {
          if (!this.auctionDetailsViewers.has(data.auction_id)) {
            this.auctionDetailsViewers.set(data.auction_id, new Set());
          }
          this.auctionDetailsViewers.get(data.auction_id)!.add(presenceKey);
          this.logger.log(`[details] Details viewer ${presenceKey} joined auction ${data.auction_id}`);
        }

        if (verifiedUserId) {
          this.logger.log(
            isHost
              ? `✅ User ${verifiedUserId} is the auction owner - joined as host`
              : `👤 User ${verifiedUserId} joined as viewer`,
          );
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

      // Broadcast updated counts immediately after join
      const viewerData = this.buildViewerCountPayload(data.auction_id);

      // Send to the joining client first (so they get current count immediately)
      client.emit('view_count_updated', viewerData);
      
      // Then broadcast to all clients (so everyone gets updated count)
      this.server.to(roomName).emit('view_count_updated', viewerData);

      this.logger.log(`📊 Sent viewer counts (watchers=${viewerData.stream_watchers}, details=${viewerData.details_viewers}) to new joiner and broadcasted to room`);

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
      const presenceKey = connection.userId ?? client.id;
      this.auctionStreamWatchers.get(data.auction_id)?.delete(presenceKey);
      this.auctionDetailsViewers.get(data.auction_id)?.delete(presenceKey);
    }

    // Notify room of viewer leaving
    client.to(roomName).emit('viewer_left', {
      auction_id: data.auction_id,
      timestamp: new Date().toISOString(),
    });

    // Broadcast updated counts
    const viewerData = this.buildViewerCountPayload(data.auction_id);

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
      const viewerData = this.buildViewerCountPayload(data.auction_id);

      // Send current counts to requesting client
      client.emit('view_count_updated', viewerData);
      this.logger.log(`📊 Sent viewer counts (watchers=${viewerData.stream_watchers}, details=${viewerData.details_viewers}) for auction ${data.auction_id}`);
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
    @MessageBody() data: { auction_id: string; item_id?: string; amount: number; bid_type?: 'manual' | 'proxy'; max_bid_amount?: number },
  ) {
    const user = (client as any).user;
    if (!user?.sub) {
      client.emit('bid_error', {
        auction_id: data.auction_id,
        message: 'Authentication required to place a bid',
      });
      return;
    }

    try {
      const bid = await this.auctionsService.placeBid(
        user.sub,
        {
          auction_id: data.auction_id,
          item_id: data.item_id,
          amount: data.amount,
          bid_type: data.bid_type || 'manual',
          max_bid_amount: data.max_bid_amount,
        },
        undefined,
        {
          ipAddress: client.handshake.address,
          userAgent: client.handshake.headers?.['user-agent'],
        },
      );

      client.emit('bid_confirmed', {
        auction_id: data.auction_id,
        amount: bid.amount,
        bidder_display_id: bid.bidder_display_id,
        status: bid.is_winning ? 'winning' : 'outbid',
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
        message: error instanceof Error ? error.message : 'Failed to place bid. Please check your connection and try again.',
      });
    }
  }

  /**
   * Handle live auction events (AI auctioneer)
   */
  @SubscribeMessage('auctioneer_event')
  @UseGuards(JwtAuthGuard)
  async handleAuctioneerEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      auction_id: string;
      event_type: 'going_once' | 'going_twice' | 'sold' | 'new_bid';
      message?: string;
    },
  ) {
    const user = (client as any).user;
    if (!user?.sub || !data?.auction_id) {
      return;
    }

    try {
      // Only the auction's seller may speak as the auctioneer
      const auction = await this.auctionsService.findById(data.auction_id);
      if (!auction || auction.seller_id !== user.sub) {
        return;
      }

      const roomName = `auction_${data.auction_id}`;

      // Broadcast auctioneer event to all room members
      this.server.to(roomName).emit('auctioneer_speaks', {
        auction_id: data.auction_id,
        event_type: data.event_type,
        message: data.message,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      this.logger.error(`Error in auctioneer_event for auction ${data?.auction_id}:`, error);
    }
  }

  /**
   * Host plays a soundboard sound — broadcast to all viewers so every
   * device plays the actual audio file natively.
   *
   * Emits 'sound_played' with a server-verified payload:
   *   { auction_id, soundId, name, soundUrl? }
   * soundId is either a 'builtin:*' key (bundled asset on all devices) or a
   * sounds-table UUID that must be an active live_stream sound owned by the
   * platform or by this host — the URL is always taken from the DB.
   *
   * NOTE: unlike join_auction (which trusts a client-supplied user_id),
   * this uses the authenticated JWT identity and verifies seller ownership.
   */
  @SubscribeMessage('play_sound')
  @UseGuards(JwtAuthGuard)
  async handlePlaySound(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; soundId: string; name?: string },
  ) {
    const user = (client as any).user;
    if (!user?.sub) {
      client.emit('error', { message: 'User not authenticated' });
      return;
    }

    try {
      if (!data?.auction_id || !data?.soundId) {
        client.emit('error', { message: 'auction_id and soundId are required' });
        return;
      }

      // Simple per-socket cooldown to prevent sound spam
      const now = Date.now();
      const last = this.soundCooldowns.get(client.id) || 0;
      if (now - last < 800) {
        return; // silently drop — soundboard spam is not an error worth surfacing
      }
      this.soundCooldowns.set(client.id, now);

      // Verify the caller owns this auction and it is live
      const auction = await this.auctionsService.findById(data.auction_id);
      if (!auction) {
        client.emit('error', { message: 'Auction not found' });
        return;
      }

      if (auction.seller_id !== user.sub) {
        client.emit('error', { message: 'Only the auction host can play sounds' });
        return;
      }

      if (auction.status !== 'active') {
        client.emit('error', { message: 'Can only play sounds while the auction is live' });
        return;
      }

      let payload: { auction_id: string; soundId: string; name: string; soundUrl?: string };

      if (data.soundId.startsWith('builtin:')) {
        payload = {
          auction_id: data.auction_id,
          soundId: data.soundId,
          name: data.name || data.soundId.replace('builtin:', ''),
        };
      } else {
        const { data: sound, error: soundError } = await this.supabase
          .from('sounds')
          .select('id, name, sound_url, owner_id')
          .eq('id', data.soundId)
          .eq('context', 'live_stream')
          .eq('is_active', true)
          .single();

        if (soundError || !sound) {
          client.emit('error', { message: 'Sound not found' });
          return;
        }

        if (sound.owner_id && sound.owner_id !== user.sub) {
          client.emit('error', { message: 'You cannot play this sound' });
          return;
        }

        payload = {
          auction_id: data.auction_id,
          soundId: sound.id,
          name: sound.name,
          soundUrl: sound.sound_url,
        };
      }

      // Broadcast to all OTHER clients in the auction room — the host
      // already plays the sound locally on their own device.
      client.broadcast.to(`auction_${data.auction_id}`).emit('sound_played', {
        ...payload,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      this.logger.error(`Error playing sound in auction ${data?.auction_id}:`, error);
      client.emit('error', { message: error.message });
    }
  }

  /**
   * Host taps the gavel — broadcast 'gavel_played' so every viewer shows
   * the gavel lottie animation in sync with the host's gavel sound.
   * JWT + seller + active-status checks, same as play_sound.
   */
  @SubscribeMessage('play_gavel')
  @UseGuards(JwtAuthGuard)
  async handlePlayGavel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; item_id?: string },
  ) {
    const user = (client as any).user;
    if (!user?.sub || !data?.auction_id) {
      return;
    }

    try {
      const auction = await this.auctionsService.findById(data.auction_id);
      if (!auction || auction.seller_id !== user.sub || auction.status !== 'active') {
        return;
      }

      client.broadcast.to(`auction_${data.auction_id}`).emit('gavel_played', {
        auction_id: data.auction_id,
        item_id: data.item_id,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      this.logger.error(`Error broadcasting gavel for auction ${data?.auction_id}:`, error);
    }
  }

  /**
   * Host stops a playing soundboard sound — broadcast so viewers stop
   * playback mid-play too. Emits 'sound_stopped' { auction_id, soundId }.
   * No sound lookup needed: stopping is harmless regardless of the id.
   */
  @SubscribeMessage('stop_sound')
  @UseGuards(JwtAuthGuard)
  async handleStopSound(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; soundId: string },
  ) {
    const user = (client as any).user;
    if (!user?.sub || !data?.auction_id || !data?.soundId) {
      return;
    }

    try {
      const auction = await this.auctionsService.findById(data.auction_id);
      if (!auction || auction.seller_id !== user.sub || auction.status !== 'active') {
        return;
      }

      client.broadcast.to(`auction_${data.auction_id}`).emit('sound_stopped', {
        auction_id: data.auction_id,
        soundId: data.soundId,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      this.logger.error(`Error stopping sound in auction ${data?.auction_id}:`, error);
    }
  }

  /**
   * Broadcast bid update to auction room
   * Called from auctions service when bid is placed
   */
  async broadcastBidUpdate(auctionId: string, bidData: any) {
    const roomName = `auction_${auctionId}`;

    const payload = {
      auction_id: auctionId,
      ...bidData,
      timestamp: new Date().toISOString(),
    };

    this.server.to(roomName).emit('new_bid', payload);
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
      stream_watchers: this.getAuctionViewerCount(auctionId),
      details_viewers: this.getAuctionDetailsViewerCount(auctionId),
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
   * Broadcast broadcast pause/resume state (when host pauses/resumes the live stream)
   */
  async broadcastBroadcastStatus(auctionId: string, status: 'paused' | 'live') {
    const roomName = `auction_${auctionId}`;
    const eventData = {
      auction_id: auctionId,
      broadcast_status: status,
      timestamp: new Date().toISOString(),
    };

    this.server.to(roomName).emit('broadcast_status', eventData);
    this.server.emit('broadcast_status', eventData);
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
   * Stream watchers for an auction (users on the live stream screen).
   */
  getAuctionViewerCount(auctionId: string): number {
    if (!auctionId || typeof auctionId !== 'string') {
      this.logger.error(`Invalid auction ID provided to getAuctionViewerCount: ${auctionId}`);
      return 0;
    }

    return Math.max(0, this.auctionStreamWatchers.get(auctionId)?.size || 0);
  }

  /**
   * Details-screen viewers for an auction (users on details/lobby screens).
   */
  getAuctionDetailsViewerCount(auctionId: string): number {
    if (!auctionId || typeof auctionId !== 'string') {
      return 0;
    }

    return Math.max(0, this.auctionDetailsViewers.get(auctionId)?.size || 0);
  }

  /**
   * Standard view_count_updated payload — every emit carries both presence
   * counts explicitly so each screen can read the one it displays.
   * view_count/current_viewers stay equal to stream watchers so older
   * clients keep showing the watcher count.
   */
  private buildViewerCountPayload(auctionId: string) {
    const streamWatchers = this.getAuctionViewerCount(auctionId);
    const detailsViewers = this.getAuctionDetailsViewerCount(auctionId);
    return {
      auction_id: auctionId,
      view_count: streamWatchers,
      current_viewers: streamWatchers,
      stream_watchers: streamWatchers,
      details_viewers: detailsViewers,
      timestamp: new Date().toISOString(),
    };
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
  @UseGuards(JwtAuthGuard)
  async handleSendReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { auction_id: string; reaction_type: string },
  ) {
    const user = (client as any).user;
    if (!user?.sub) {
      client.emit('error', { message: 'User not authenticated' });
      return;
    }

    try {
      const userId = user.sub;
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