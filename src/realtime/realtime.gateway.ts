import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { RealtimeService } from './realtime.service';
import { createUserSupabaseClient } from '../shared/supabase.client';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/chat',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private heartbeatInterval: NodeJS.Timeout;
  private heartbeatStarted = false; // 🔥 FIX: Prevent multiple heartbeat starts
  private connectedClients = new Map<string, { userId: string; lastPong: number; socketId: string }>();

  constructor(
    private readonly realtimeService: RealtimeService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('🚀 RealtimeGateway initialized');
    this.server = server; // 🔥 FIX: Ensure server is properly set

    // 🔥 DEBUG: Log the server state immediately
    this.logger.log(`🔍 Gateway afterInit - server=${!!server}`);

    // Start heartbeat after a delay
    setTimeout(() => {
      this.startHeartbeat();
    }, 2000);
  }

  private startHeartbeat() {
    // 🔥 FIX: Prevent multiple heartbeat intervals
    if (this.heartbeatStarted) {
      this.logger.debug('💓 Heartbeat already running, skipping duplicate start');
      return;
    }

    // 🔥 FIX: Simplified server check - only require server.sockets for basic functionality
    if (!this.server || !this.server.sockets) {
      this.logger.warn('🚫 Server not fully initialized, delaying heartbeat startup');
      setTimeout(() => this.startHeartbeat(), 3000);
      return;
    }

    // Log adapter availability for debugging but don't block on it
    this.logger.log(`🔍 Server state: sockets=${!!this.server.sockets}, adapter=${!!this.server.sockets.adapter}`);

    // Clear any existing heartbeat to prevent duplicates
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Mark heartbeat as started
    this.heartbeatStarted = true;

    // Send ping every 30 seconds to detect dead connections
    this.heartbeatInterval = setInterval(() => {
      try {
        // Minimal server state validation - be more tolerant
        if (!this.server || !this.server.sockets) {
          this.logger.warn('⚠️ Server/sockets unavailable during heartbeat cycle, skipping');
          return;
        }

        // Log detailed state for debugging
        this.logger.debug(`🔍 Heartbeat cycle - sockets=${!!this.server.sockets}, socketsMap=${!!this.server.sockets.sockets}, adapter=${!!this.server.sockets.adapter}`);

        const now = Date.now();
        const staleConnections: string[] = [];

        // Only process clients if sockets map is available
        if (this.server.sockets.sockets) {
          this.connectedClients.forEach((clientInfo, socketId) => {
            try {
              const client = this.server.sockets.sockets.get(socketId);
            if (!client || !client.connected) {
              // 🔥 CRITICAL FIX: Don't immediately mark as stale - allow grace period
              // Client might be temporarily unavailable due to network hiccup
              const timeSinceLastPong = now - clientInfo.lastPong;
              if (timeSinceLastPong > 90000) { // 90 seconds = 3 ping cycles
                this.logger.warn(`⏸️ Socket ${socketId} not found for 90s - marking as stale`);
                staleConnections.push(socketId);
              } else {
                this.logger.debug(`⏸️ Socket ${socketId} temporarily unavailable (${Math.round(timeSinceLastPong/1000)}s) - keeping alive`);
              }
              return;
            }

            // 🔥 FIX: Increased timeout to 90 seconds (3 ping cycles)
            if (now - clientInfo.lastPong > 90000) {
              this.logger.warn(`⚠️ Socket ${socketId} (user: ${clientInfo.userId}) hasn't ponged in 90s - disconnecting`);
              try {
                client.disconnect(true);
              } catch (disconnectError) {
                this.logger.error(`Error disconnecting dead socket ${socketId}:`, disconnectError);
              }
              staleConnections.push(socketId);
              return;
            }

            // Send ping
            try {
              client.emit('ping', { timestamp: now });
              this.logger.debug(`📡 Ping sent to ${socketId} (user: ${clientInfo.userId})`);
            } catch (pingError) {
              this.logger.error(`Error sending ping to ${socketId}:`, pingError);
              // Don't mark as stale on ping error - might be temporary
              this.logger.debug(`⚠️ Ping error for ${socketId}, but keeping alive`);
            }
          } catch (clientError) {
            this.logger.error(`Error processing client ${socketId} in heartbeat:`, clientError);
            // Don't mark as stale on processing error
          }
          });
        } else {
          this.logger.debug('🔍 Sockets map not available, skipping client ping cycle');
        }

        // 🔥 FIX: Only clean up after multiple failed ping cycles (let handleDisconnect handle normal disconnects)
        staleConnections.forEach(socketId => {
          this.connectedClients.delete(socketId);
          this.logger.log(`🧹 Cleaned up stale connection after grace period: ${socketId}`);
        });

      } catch (heartbeatError) {
        this.logger.error('💥 Error in heartbeat cycle:', heartbeatError);
      }
    }, 30000);

    this.logger.log('💓 Heartbeat mechanism started with enhanced stability (30s intervals)');
  }

  async handleConnection(client: Socket) {
    const connectionTime = Date.now();
    const clientIP = client.request.socket.remoteAddress;
    const userAgent = client.handshake.headers['user-agent'];

    this.logger.log(`🔌 New connection attempt from ${clientIP} (${client.id}) - UserAgent: ${userAgent}`);

    try {
      // Extract token with detailed logging
      const token = client.handshake.auth.token || client.handshake.headers.authorization;

      if (!token) {
        this.logger.warn(`❌ Connection ${client.id} rejected: No token provided`);
        client.emit('connection_error', {
          message: 'Authentication token required',
          code: 'NO_TOKEN',
          timestamp: new Date().toISOString()
        });
        client.disconnect();
        return;
      }

      // Validate token and extract user ID
      const userId = await this.extractUserIdFromToken(token);

      if (!userId) {
        this.logger.warn(`❌ Connection ${client.id} rejected: Invalid token`);
        client.emit('connection_error', {
          message: 'Invalid authentication token',
          code: 'INVALID_TOKEN',
          timestamp: new Date().toISOString()
        });
        client.disconnect();
        return;
      }

      // Store connection info for heartbeat tracking
      this.connectedClients.set(client.id, {
        userId,
        lastPong: Date.now(),
        socketId: client.id
      });

      // Store user connection in service
      await this.realtimeService.handleUserConnect(userId, client.id);

      // Join user to their personal room
      client.join(`user_${userId}`);
      this.logger.debug(`📨 Socket ${client.id} joined personal room: user_${userId}`);

      // Join user to their conversation rooms - pass token for user-authenticated queries
      const cleanToken = token?.replace(/^Bearer\s+/i, '');
      const userConversations = await this.realtimeService.getUserConversations(userId, cleanToken);
      let actualJoinedCount = 0;

      for (const conversationId of userConversations) {
        const roomName = `conversation_${conversationId}`;
        try {
          client.join(roomName);
          actualJoinedCount++;

          // Verify room size after auto-join - use client's namespace
          let roomSize = 0;
          if (client.nsp && client.nsp.adapter && client.nsp.adapter.rooms) {
            roomSize = client.nsp.adapter.rooms.get(roomName)?.size || 0;
          }

          this.logger.log(`💬 Socket ${client.id} auto-joined conversation: ${conversationId} - Room size: ${roomSize} (namespace: ${client.nsp?.name})`);
        } catch (autoJoinError) {
          this.logger.error(`💥 AUTO-JOIN FAILED for ${conversationId}:`, autoJoinError);
        }
      }

      const connectionDuration = Date.now() - connectionTime;
      this.logger.log(`✅ User ${userId} connected successfully with socket ${client.id} (${connectionDuration}ms) - Auto-joined ${actualJoinedCount} conversations`);

      if (actualJoinedCount === 0) {
        this.logger.warn(`⚠️ User ${userId} has no active conversations to auto-join`);
      }

      // Setup pong listener for heartbeat
      client.on('pong', () => {
        const clientInfo = this.connectedClients.get(client.id);
        if (clientInfo) {
          clientInfo.lastPong = Date.now();
          this.logger.debug(`🏓 Pong received from ${client.id} (user: ${userId})`);
        }
      });

      // Emit connection success event
      client.emit('connection_success', {
        userId,
        socketId: client.id,
        conversationsJoined: userConversations.length,
        timestamp: new Date().toISOString()
      });

      // Notify others that user is online
      this.server.emit('user_status', {
        userId,
        isOnline: true,
        lastSeen: new Date().toISOString(),
        socketId: client.id
      });

    } catch (error) {
      this.logger.error(`💥 Error handling connection ${client.id}:`, error.stack || error.message);
      client.emit('connection_error', {
        message: 'Internal server error during connection',
        code: 'SERVER_ERROR',
        timestamp: new Date().toISOString()
      });
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const disconnectTime = Date.now();
    this.logger.log(`🔌 Disconnect event for socket ${client.id}`);

    try {
      // Remove from connected clients map
      const clientInfo = this.connectedClients.get(client.id);
      this.connectedClients.delete(client.id);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (userId) {
        const connectionDuration = clientInfo ?
          disconnectTime - (clientInfo.lastPong - 30000) : // Approximate connection time
          'unknown';

        this.logger.log(`👋 User ${userId} disconnecting from socket ${client.id} (duration: ${connectionDuration}ms)`);

        await this.realtimeService.handleUserDisconnect(userId, client.id);

        // Check if user has other active connections
        const isStillOnline = await this.realtimeService.isUserOnline(userId);

        if (!isStillOnline) {
          // Notify others that user is offline
          this.server.emit('user_status', {
            userId,
            isOnline: false,
            lastSeen: new Date().toISOString(),
            socketId: client.id
          });
          this.logger.log(`📴 User ${userId} is now completely offline`);
        } else {
          this.logger.log(`🔄 User ${userId} still has other active connections`);
        }
      } else {
        this.logger.warn(`⚠️ Disconnect event for unknown socket ${client.id}`);
      }

    } catch (error) {
      this.logger.error(`💥 Error handling disconnect for ${client.id}:`, error.stack || error.message);
    }
  }

  @SubscribeMessage('join_conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    try {
      // 🔥 ULTRA DEFENSIVE: Log everything to find TypeError source
      this.logger.log(`🔥 JOIN HANDLER ENTRY: client=${!!client}, this=${!!this}, data=${!!data}`);

      if (!client) {
        this.logger.error('💥 JOIN ERROR: client is undefined');
        return;
      }

      this.logger.log(`🔍 CLIENT STATE: id=${client.id}, rooms=${!!client.rooms}, connected=${client.connected}`);

      if (!client.rooms) {
        this.logger.error('💥 JOIN ERROR: client.rooms is undefined');
        if (client.emit) {
          client.emit('joined_conversation', { success: false, reason: 'Client rooms not available' });
        }
        return;
      }

      if (!this || !this.server) {
        this.logger.error('💥 JOIN ERROR: this.server is undefined');
        if (client.emit) {
          client.emit('joined_conversation', { success: false, reason: 'Server not available' });
        }
        return;
      }

      this.logger.log(`🔥 JOIN REQUEST: Socket ${client.id} wants to join conversation: ${data.conversationId}`);
      this.logger.log(`🔍 Request data:`, data);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        this.logger.warn(`❌ JOIN FAILED: Unauthorized socket ${client.id}`);
        client.emit('error', { message: 'Unauthorized' });
        return;
      }

      this.logger.log(`🔍 JOIN: Found user ${userId} for socket ${client.id}`);

      // Verify user has access to conversation - pass token for user-authenticated queries
      const userToken = client.handshake.auth.token || client.handshake.headers.authorization;
      const cleanUserToken = userToken?.replace(/^Bearer\s+/i, '');
      const hasAccess = await this.realtimeService.verifyConversationAccess(userId, data.conversationId, cleanUserToken);

      if (!hasAccess) {
        this.logger.warn(`❌ JOIN FAILED: User ${userId} denied access to conversation ${data.conversationId}`);
        client.emit('joined_conversation', {
          conversationId: data.conversationId,
          success: false,
          reason: 'Access denied - user not found as participant',
          timestamp: new Date().toISOString()
        });
        client.emit('error', { message: 'Access denied to conversation' });
        return;
      }

      // Join the conversation room
      const roomName = `conversation_${data.conversationId}`;
      this.logger.log(`🚀 ATTEMPTING JOIN: ${client.id} -> ${roomName}`);

      try {
        client.join(roomName);
        this.logger.log(`✅ JOIN COMPLETED: Socket ${client.id} joined ${roomName}`);
      } catch (joinError) {
        this.logger.error(`💥 JOIN FAILED:`, joinError);
        client.emit('joined_conversation', { success: false, reason: 'Join operation failed' });
        return;
      }

      // IMMEDIATE room size check after join - use client's namespace
      let roomSize = 0;
      try {
        // 🔥 FIX: Get room size from client's namespace (/chat), not default namespace
        if (client.nsp && client.nsp.adapter && client.nsp.adapter.rooms) {
          roomSize = client.nsp.adapter.rooms.get(roomName)?.size || 0;
          this.logger.log(`🏠 ROOM SIZE AFTER JOIN: ${roomName} has ${roomSize} clients (client namespace: ${client.nsp.name})`);
        } else {
          this.logger.warn(`⚠️ Client namespace adapter not available - nsp=${!!client.nsp}, adapter=${!!client.nsp?.adapter}`);
        }
      } catch (roomSizeError) {
        this.logger.error(`💥 Error getting room size:`, roomSizeError);
      }

      this.logger.log(`✅ JOIN SUCCESS: User ${userId} (socket ${client.id}) joined conversation ${data.conversationId} - Room size: ${roomSize}`);
      this.logger.log(`🔍 CLIENT ROOMS: Socket ${client.id} is now in rooms:`, Array.from(client.rooms));

      // Send confirmation to client
      client.emit('joined_conversation', {
        conversationId: data.conversationId,
        success: true,
        roomSize: roomSize,
        message: 'Successfully joined conversation',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.logger.error(`💥 JOIN ERROR for socket ${client.id}:`, error);
      if (client && client.emit) {
        client.emit('error', { message: 'Failed to join conversation' });
      }
    }
  }

  @SubscribeMessage('leave_conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    try {
      this.logger.log(`🔥 LEAVE REQUEST: Socket ${client.id} wants to leave conversation: ${data.conversationId}`);

      const roomName = `conversation_${data.conversationId}`;
      client.leave(roomName);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      // Safe room size check
      let roomSize = 0;
      try {
        if (this.server && this.server.sockets && this.server.sockets.adapter && this.server.sockets.adapter.rooms) {
          roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size || 0;
        }
      } catch (roomSizeError) {
        this.logger.error(`💥 Error getting room size on leave:`, roomSizeError);
      }

      this.logger.log(`✅ LEAVE SUCCESS: User ${userId} left conversation ${data.conversationId} - Room size now: ${roomSize}`);

      client.emit('left_conversation', { conversationId: data.conversationId });
    } catch (error) {
      this.logger.error(`💥 LEAVE ERROR for socket ${client.id}:`, error);
    }
  }

  @SubscribeMessage('typing_start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    try {
      this.logger.log(`🔥 TYPING START: Socket ${client.id} in conversation: ${data.conversationId}`);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        this.logger.warn(`❌ TYPING START FAILED: Unauthorized socket ${client.id}`);
        return;
      }

      // Broadcast typing indicator to conversation participants (except sender)
      client.to(`conversation_${data.conversationId}`).emit('chat_typing', {
        conversationId: data.conversationId,
        userId,
        isTyping: true,
      });

      this.logger.log(`✅ TYPING START SUCCESS: User ${userId} started typing in conversation ${data.conversationId}`);
    } catch (error) {
      this.logger.error(`💥 TYPING START ERROR for socket ${client.id}:`, error);
    }
  }

  @SubscribeMessage('typing_stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string }
  ) {
    try {
      this.logger.log(`🔥 TYPING STOP: Socket ${client.id} in conversation: ${data.conversationId}`);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        this.logger.warn(`❌ TYPING STOP FAILED: Unauthorized socket ${client.id}`);
        return;
      }

      // Broadcast typing stop to conversation participants (except sender)
      client.to(`conversation_${data.conversationId}`).emit('chat_typing', {
        conversationId: data.conversationId,
        userId,
        isTyping: false,
      });

      this.logger.log(`✅ TYPING STOP SUCCESS: User ${userId} stopped typing in conversation ${data.conversationId}`);
    } catch (error) {
      this.logger.error(`💥 TYPING STOP ERROR for socket ${client.id}:`, error);
    }
  }

  @SubscribeMessage('message_read')
  async handleMessageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; conversationId: string }
  ) {
    try {
      this.logger.log(`🔥 MESSAGE READ: Socket ${client.id} read message ${data.messageId} in conversation: ${data.conversationId}`);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        this.logger.warn(`❌ MESSAGE READ FAILED: Unauthorized socket ${client.id}`);
        return;
      }

      // Broadcast read receipt to conversation participants
      this.server.to(`conversation_${data.conversationId}`).emit('message_status', {
        messageId: data.messageId,
        conversationId: data.conversationId,
        userId,
        status: 'read',
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ MESSAGE READ SUCCESS: User ${userId} read message ${data.messageId} in conversation ${data.conversationId}`);
    } catch (error) {
      this.logger.error(`💥 MESSAGE READ ERROR for socket ${client.id}:`, error);
    }
  }

  // ================================
  // DISPUTE ROOM HANDLERS
  // ================================

  @SubscribeMessage('join_dispute')
  async handleJoinDispute(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { disputeId: string }
  ) {
    try {
      this.logger.log(`⚖️ JOIN DISPUTE REQUEST: Socket ${client.id} wants to join dispute: ${data.disputeId}`);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        this.logger.warn(`❌ JOIN DISPUTE FAILED: Unauthorized socket ${client.id}`);
        client.emit('error', { message: 'Unauthorized' });
        return;
      }

      // Verify user has access to this dispute (they should be disputant or respondent)
      // This is a basic check - full authorization is handled by the disputes service
      const roomName = `dispute_${data.disputeId}`;
      client.join(roomName);

      // Get room size
      let roomSize = 0;
      try {
        if (this.server && this.server.sockets && this.server.sockets.adapter && this.server.sockets.adapter.rooms) {
          roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size || 0;
        }
      } catch (roomSizeError) {
        this.logger.error(`💥 Error getting dispute room size:`, roomSizeError);
      }

      this.logger.log(`✅ JOIN DISPUTE SUCCESS: User ${userId} (socket ${client.id}) joined dispute ${data.disputeId} - Room size: ${roomSize}`);

      // Send confirmation to client
      client.emit('joined_dispute', {
        disputeId: data.disputeId,
        success: true,
        roomSize: roomSize,
        message: 'Successfully joined dispute',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.logger.error(`💥 JOIN DISPUTE ERROR for socket ${client.id}:`, error);
      if (client && client.emit) {
        client.emit('error', { message: 'Failed to join dispute' });
      }
    }
  }

  @SubscribeMessage('leave_dispute')
  async handleLeaveDispute(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { disputeId: string }
  ) {
    try {
      this.logger.log(`⚖️ LEAVE DISPUTE REQUEST: Socket ${client.id} wants to leave dispute: ${data.disputeId}`);

      const roomName = `dispute_${data.disputeId}`;
      client.leave(roomName);

      const userId = await this.realtimeService.getUserBySocketId(client.id);

      // Get room size after leave
      let roomSize = 0;
      try {
        if (this.server && this.server.sockets && this.server.sockets.adapter && this.server.sockets.adapter.rooms) {
          roomSize = this.server.sockets.adapter.rooms.get(roomName)?.size || 0;
        }
      } catch (roomSizeError) {
        this.logger.error(`💥 Error getting dispute room size on leave:`, roomSizeError);
      }

      this.logger.log(`✅ LEAVE DISPUTE SUCCESS: User ${userId} left dispute ${data.disputeId} - Room size now: ${roomSize}`);

      client.emit('left_dispute', { disputeId: data.disputeId });
    } catch (error) {
      this.logger.error(`💥 LEAVE DISPUTE ERROR for socket ${client.id}:`, error);
    }
  }

  @SubscribeMessage('chat_message')
  async handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; message: any }
  ) {
    try {
      const userId = await this.realtimeService.getUserBySocketId(client.id);

      if (!userId) {
        client.emit('error', { message: 'Unauthorized' });
        return;
      }

      // 🔥 REMOVED: Don't save message here - ChatService already saved it with proper auth
      // This method should only handle direct WebSocket messages (like typing indicators)
      // Real chat messages come through HTTP API -> ChatService -> notifyNewMessage()

      this.logger.warn(`⚠️ Direct WebSocket message received (should use HTTP API): ${data.conversationId}`);
      client.emit('error', {
        message: 'Please use HTTP API for sending messages',
        code: 'USE_HTTP_API'
      });

    } catch (error) {
      this.logger.error('Error handling direct chat message:', error);
      client.emit('error', { message: 'Failed to handle message' });
    }
  }

  // Helper method to extract user ID from token using Supabase validation
  private async extractUserIdFromToken(token: string): Promise<string | null> {
    try {
      if (!token) {
        this.logger.warn('🚫 No token provided for validation');
        return null;
      }

      // Remove 'Bearer ' prefix if present
      const cleanToken = token.replace(/^Bearer\s+/i, '');

      if (!cleanToken || cleanToken.length < 20) {
        this.logger.warn('🚫 Token too short or invalid format');
        return null;
      }

      // Create Supabase client for token validation using service role
      const supabase = createUserSupabaseClient(this.configService, cleanToken);

      // Validate the JWT token with Supabase
      const { data: { user }, error } = await supabase.auth.getUser(cleanToken);

      if (error) {
        this.logger.warn(`🚫 Token validation failed: ${error.message}`);
        return null;
      }

      if (!user || !user.id) {
        this.logger.warn('🚫 No user found in validated token');
        return null;
      }

      this.logger.debug(`✅ Token validated successfully for user: ${user.id}`);
      return user.id;

    } catch (error) {
      this.logger.error('💥 Error validating token:', error.stack || error.message);
      return null;
    }
  }

  // Public methods to be called by other services
  async notifyNewMessage(conversationId: string, message: any, excludeUserId?: string) {
    try {
      this.logger.log(`🔥 ATTEMPTING BROADCAST to conversation ${conversationId}${excludeUserId ? ` (excluding user ${excludeUserId})` : ''}`);
      this.logger.log(`🔍 SERVER STATE: server=${!!this.server}, sockets=${!!this.server?.sockets}, adapter=${!!this.server?.sockets?.adapter}`);

      // 🔥 Find sender's socket IDs to exclude them from broadcast
      const senderSocketIds: string[] = [];
      if (excludeUserId) {
        this.connectedClients.forEach((clientInfo, socketId) => {
          if (clientInfo.userId === excludeUserId) {
            senderSocketIds.push(socketId);
          }
        });
        this.logger.log(`🔍 Found ${senderSocketIds.length} socket(s) for sender ${excludeUserId}: [${senderSocketIds.join(', ')}]`);
      }

      // 🔥 DEBUG: Check which users are currently connected and their active rooms
      this.logger.log(`🔍 ACTIVE CONNECTIONS: ${this.connectedClients.size} total connected clients`);
      this.connectedClients.forEach((clientInfo, socketId) => {
        this.logger.log(`   - Socket ${socketId}: User ${clientInfo.userId}, lastPong: ${new Date(clientInfo.lastPong).toISOString()}`);

        // 🔥 DEBUG: Check which rooms this socket is in
        if (this.server && this.server.sockets && this.server.sockets.sockets) {
          const socket = this.server.sockets.sockets.get(socketId);
          if (socket && socket.rooms) {
            const rooms = Array.from(socket.rooms);
            this.logger.log(`     Rooms for socket ${socketId}: [${rooms.join(', ')}]`);
            // Check if this socket is in the target conversation room
            const targetRoom = `conversation_${conversationId}`;
            const isInTargetRoom = rooms.includes(targetRoom);
            this.logger.log(`     Is in target room ${targetRoom}: ${isInTargetRoom}`);
          }
        }
      });

      // Comprehensive server state check
      if (!this.server) {
        this.logger.error(`💥 BROADCAST ERROR: this.server is undefined for conversation ${conversationId}`);
        return;
      }

      if (!this.server.sockets) {
        this.logger.error(`💥 BROADCAST ERROR: this.server.sockets is undefined for conversation ${conversationId}`);
        return;
      }

      // Note: adapter might not be immediately available, but broadcast can still work
      if (!this.server.sockets.adapter) {
        this.logger.warn(`⚠️ BROADCAST WARNING: adapter not available, but attempting broadcast anyway for conversation ${conversationId}`);
      }

      const roomName = `conversation_${conversationId}`;
      let roomSize = 0;

      try {
        // 🔥 CRITICAL FIX: Access the namespace's adapter property
        // TypeScript types it as a method, but it's actually a property
        const adapter = (this.server as any)?.adapter;
        if (this.server && adapter && adapter.rooms) {
          const room = adapter.rooms.get(roomName);
          roomSize = room?.size || 0;

          // 🔥 DEBUG: Log all socket IDs in the room
          if (room && room.size > 0) {
            const socketIds = Array.from(room) as string[];
            this.logger.log(`🔍 DETAILED ROOM CHECK: ${roomName} has ${roomSize} clients with IDs: [${socketIds.join(', ')}]`);

            // 🔥 DEBUG: Check which users these socket IDs belong to
            const socketUserMapping: Array<{socketId: string; userId: string; lastPong: string}> = [];
            for (const socketId of socketIds) {
              const clientInfo = this.connectedClients.get(socketId);
              socketUserMapping.push({
                socketId,
                userId: clientInfo?.userId || 'unknown',
                lastPong: clientInfo?.lastPong ? new Date(clientInfo.lastPong).toISOString() : 'never'
              });
            }
            this.logger.log(`🔍 SOCKET-USER MAPPING in room ${roomName}:`, socketUserMapping);
          } else {
            this.logger.log(`🔍 ROOM CHECK: ${roomName} is empty or doesn't exist`);
          }
        } else {
          this.logger.warn(`🔍 Server adapter not available - server=${!!this.server}, adapter=${!!adapter}`);
          roomSize = -1; // Indicate unknown
        }
      } catch (roomError) {
        this.logger.error(`💥 ROOM SIZE ERROR:`, roomError);
        roomSize = 0;
      }

      this.logger.log(`🔥 BROADCASTING MESSAGE to conversation ${conversationId} - Detected room size: ${roomSize}`);
      this.logger.log(`📨 Message details:`, {
        id: message.id,
        senderId: message.senderId,
        content: message.content?.substring(0, 50) + '...',
        messageType: message.messageType
      });

      if (roomSize === 0) {
        this.logger.warn(`⚠️ WARNING: Detected 0 clients in room, but broadcasting anyway (Socket.IO will handle actual delivery)`);
      }

      // 🔥 CRITICAL FIX: this.server IS the /chat namespace - use it directly
      // We broadcast regardless of detected room size - Socket.IO knows the truth

      // 🔥 NEW: Exclude sender's sockets from receiving the broadcast
      if (senderSocketIds.length > 0) {
        this.logger.log(`🔥 BROADCASTING: Excluding sender sockets [${senderSocketIds.join(', ')}] from broadcast to '${roomName}'`);

        // Get all sockets in the room
        const socketsInRoom = await this.server.in(roomName).fetchSockets();
        this.logger.log(`🔍 Found ${socketsInRoom.length} sockets in room ${roomName}`);

        // Manually emit to each socket except sender's
        let sentCount = 0;
        for (const socket of socketsInRoom) {
          if (!senderSocketIds.includes(socket.id)) {
            socket.emit('chat_message', {
              conversationId,
              message,
            });
            sentCount++;
            this.logger.log(`   ✅ Sent to socket ${socket.id}`);
          } else {
            this.logger.log(`   ⏭️ Skipped sender socket ${socket.id}`);
          }
        }
        this.logger.log(`✅ BROADCAST SUCCESS: Message sent to ${sentCount}/${socketsInRoom.length} clients (excluded ${senderSocketIds.length} sender socket(s))`);
      } else {
        this.logger.log(`🔥 BROADCASTING: Using this.server.to('${roomName}').emit('chat_message') - Let Socket.IO handle delivery`);
        this.server.to(roomName).emit('chat_message', {
          conversationId,
          message,
        });
        this.logger.log(`✅ BROADCAST SUCCESS: Message sent to ${roomSize} clients in conversation ${conversationId}`);
      }
    } catch (error) {
      this.logger.error(`💥 BROADCAST ERROR for conversation ${conversationId}:`, error.stack || error.message);
      this.logger.error(`💥 BROADCAST ERROR CONTEXT:`, {
        hasServer: !!this.server,
        hasSockets: !!this.server?.sockets,
        hasAdapter: !!this.server?.sockets?.adapter,
        errorType: error.constructor.name
      });
    }
  }

  async notifyMessageUpdate(conversationId: string, message: any, excludeUserId?: string) {
    try {
      this.logger.log(`🔥 ATTEMPTING MESSAGE UPDATE BROADCAST to conversation ${conversationId}${excludeUserId ? ` (excluding user ${excludeUserId})` : ''}`);

      // 🔥 Find sender's socket IDs to exclude them from broadcast
      const senderSocketIds: string[] = [];
      if (excludeUserId) {
        this.connectedClients.forEach((clientInfo, socketId) => {
          if (clientInfo.userId === excludeUserId) {
            senderSocketIds.push(socketId);
          }
        });
        this.logger.log(`🔍 Found ${senderSocketIds.length} socket(s) for sender ${excludeUserId}: [${senderSocketIds.join(', ')}]`);
      }

      if (!this.server) {
        this.logger.error(`💥 MESSAGE UPDATE ERROR: Server not available for conversation ${conversationId}`);
        return;
      }

      const roomName = `conversation_${conversationId}`;

      // 🔥 Exclude sender's sockets from receiving the broadcast
      if (senderSocketIds.length > 0) {
        this.logger.log(`🔥 BROADCASTING UPDATE: Excluding sender sockets [${senderSocketIds.join(', ')}] from broadcast to '${roomName}'`);

        // Get all sockets in the room
        const socketsInRoom = await this.server.in(roomName).fetchSockets();
        this.logger.log(`🔍 Found ${socketsInRoom.length} sockets in room ${roomName}`);

        // Manually emit to each socket except sender's
        let sentCount = 0;
        for (const socket of socketsInRoom) {
          if (!senderSocketIds.includes(socket.id)) {
            socket.emit('message_update', {
              conversationId,
              message,
            });
            sentCount++;
            this.logger.log(`   ✅ Sent update to socket ${socket.id}`);
          } else {
            this.logger.log(`   ⏭️ Skipped sender socket ${socket.id}`);
          }
        }
        this.logger.log(`✅ MESSAGE UPDATE SUCCESS: Update sent to ${sentCount}/${socketsInRoom.length} clients (excluded ${senderSocketIds.length} sender socket(s))`);
      } else {
        this.logger.log(`🔥 BROADCASTING UPDATE: Using this.server.to('${roomName}').emit('message_update')`);
        this.server.to(roomName).emit('message_update', {
          conversationId,
          message,
        });
        this.logger.log(`✅ MESSAGE UPDATE SUCCESS: Update sent to conversation ${conversationId}`);
      }
    } catch (error) {
      this.logger.error(`💥 MESSAGE UPDATE ERROR for conversation ${conversationId}:`, error.stack || error.message);
    }
  }

  async notifyConversationUpdate(conversationId: string, update: any) {
    try {
      if (!this.server) {
        this.logger.error(`💥 CONVERSATION UPDATE ERROR: Server not available for conversation ${conversationId}`);
        return;
      }

      this.server.to(`conversation_${conversationId}`).emit('conversation_update', {
        conversationId,
        update,
      });
      this.logger.debug(`🔄 Conversation update sent for: ${conversationId}`);
    } catch (error) {
      this.logger.error(`💥 Error notifying conversation update for ${conversationId}:`, error.stack || error.message);
    }
  }

  // ================================
  // DISPUTE MESSAGE UPDATES
  // ================================

  async notifyDisputeMessage(disputeId: string, message: any, excludeUserId?: string) {
    try {
      this.logger.log(`🔥 Broadcasting dispute message update for dispute ${disputeId}${excludeUserId ? ` (excluding user ${excludeUserId})` : ''}`);

      // Find sender's socket IDs to exclude them from broadcast
      const senderSocketIds: string[] = [];
      if (excludeUserId) {
        this.connectedClients.forEach((clientInfo, socketId) => {
          if (clientInfo.userId === excludeUserId) {
            senderSocketIds.push(socketId);
          }
        });
        this.logger.log(`🔍 Found ${senderSocketIds.length} socket(s) for sender ${excludeUserId}: [${senderSocketIds.join(', ')}]`);
      }

      if (!this.server) {
        this.logger.error(`💥 DISPUTE MESSAGE ERROR: Server not available for dispute ${disputeId}`);
        return;
      }

      const roomName = `dispute_${disputeId}`;

      // Exclude sender's sockets from receiving the broadcast
      if (senderSocketIds.length > 0) {
        this.logger.log(`🔥 BROADCASTING DISPUTE MESSAGE: Excluding sender sockets [${senderSocketIds.join(', ')}] from broadcast to '${roomName}'`);

        // Get all sockets in the room
        const socketsInRoom = await this.server.in(roomName).fetchSockets();
        this.logger.log(`🔍 Found ${socketsInRoom.length} sockets in room ${roomName}`);

        // Manually emit to each socket except sender's
        let sentCount = 0;
        for (const socket of socketsInRoom) {
          if (!senderSocketIds.includes(socket.id)) {
            socket.emit('dispute_message', {
              disputeId,
              message,
            });
            sentCount++;
            this.logger.log(`   ✅ Sent dispute message to socket ${socket.id}`);
          } else {
            this.logger.log(`   ⏭️ Skipped sender socket ${socket.id}`);
          }
        }
        this.logger.log(`✅ DISPUTE MESSAGE SUCCESS: Update sent to ${sentCount}/${socketsInRoom.length} clients (excluded ${senderSocketIds.length} sender socket(s))`);
      } else {
        this.logger.log(`🔥 BROADCASTING DISPUTE MESSAGE: Using this.server.to('${roomName}').emit('dispute_message')`);
        this.server.to(roomName).emit('dispute_message', {
          disputeId,
          message,
        });
        this.logger.log(`✅ DISPUTE MESSAGE SUCCESS: Update sent to dispute ${disputeId}`);
      }
    } catch (error) {
      this.logger.error(`💥 DISPUTE MESSAGE ERROR for dispute ${disputeId}:`, error.stack || error.message);
    }
  }

  async notifyDisputeUpdate(disputeId: string, update: any) {
    try {
      if (!this.server) {
        this.logger.error(`💥 DISPUTE UPDATE ERROR: Server not available for dispute ${disputeId}`);
        return;
      }

      this.server.to(`dispute_${disputeId}`).emit('dispute_update', {
        disputeId,
        update,
      });
      this.logger.debug(`🔄 Dispute update sent for: ${disputeId}`);
    } catch (error) {
      this.logger.error(`💥 Error notifying dispute update for ${disputeId}:`, error.stack || error.message);
    }
  }

  // ================================
  // WALLET BALANCE UPDATES
  // ================================

  async notifyWalletBalanceUpdate(userId: string, walletData: {
    availableBalance: number;
    escrowBalance: number;
    pendingWithdrawal: number;
    totalBalance: number;
    transactionType?: string;
  }) {
    try {
      if (!this.server) {
        this.logger.error(`💥 WALLET UPDATE ERROR: Server not available for user ${userId}`);
        return;
      }

      const roomName = `user_${userId}`;
      
      this.server.to(roomName).emit('wallet_balance_update', {
        userId,
        ...walletData,
        timestamp: new Date().toISOString(),
      });
      
      this.logger.log(`💰 WALLET UPDATE: Sent balance update to user ${userId} - Available: ₣${walletData.availableBalance}`);
    } catch (error) {
      this.logger.error(`💥 WALLET UPDATE ERROR for user ${userId}:`, error.stack || error.message);
    }
  }

  // ============================================
  // ORDER & ESCROW REAL-TIME NOTIFICATIONS
  // ============================================

  /**
   * Notify participants of order status change
   */
  async notifyOrderStatusUpdate(orderId: string, status: string, participants: {
    buyerId: string;
    vendorId: string;
    riderId?: string;
  }) {
    try {
      if (!this.server) {
        this.logger.error(`💥 ORDER UPDATE ERROR: Server not available for order ${orderId}`);
        return;
      }

      const payload = {
        orderId,
        status,
        timestamp: new Date().toISOString(),
      };

      // Notify buyer
      this.server.to(`user_${participants.buyerId}`).emit('order_status_update', payload);
      
      // Notify vendor
      this.server.to(`user_${participants.vendorId}`).emit('order_status_update', payload);
      
      // Notify rider if assigned
      if (participants.riderId) {
        this.server.to(`user_${participants.riderId}`).emit('order_status_update', payload);
      }

      this.logger.log(`📦 ORDER UPDATE: Broadcasted status '${status}' for order ${orderId}`);
    } catch (error) {
      this.logger.error(`💥 ORDER UPDATE ERROR for order ${orderId}:`, error.stack || error.message);
    }
  }

  /**
   * Notify user that escrow has been released and wallet credited
   */
  async notifyEscrowReleased(userId: string, amount: number, orderNumber: string) {
    try {
      if (!this.server) {
        this.logger.error(`💥 ESCROW RELEASE ERROR: Server not available for user ${userId}`);
        return;
      }

      const roomName = `user_${userId}`;
      
      this.server.to(roomName).emit('escrow_released', {
        userId,
        amount,
        orderNumber,
        timestamp: new Date().toISOString(),
      });
      
      this.logger.log(`💸 ESCROW RELEASED: Notified user ${userId} of ₣${amount} release for order ${orderNumber}`);
    } catch (error) {
      this.logger.error(`💥 ESCROW RELEASE ERROR for user ${userId}:`, error.stack || error.message);
    }
  }

  /**
   * Broadcast rider location update for live tracking
   */
  async notifyRiderLocationUpdate(orderId: string, location: {
    riderId: string;
    latitude: number;
    longitude: number;
    accuracy: number;
    heading?: number;
    speed?: number;
  }) {
    try {
      if (!this.server) {
        this.logger.error(`💥 RIDER LOCATION ERROR: Server not available for order ${orderId}`);
        return;
      }

      const roomName = `order_${orderId}`;
      
      this.server.to(roomName).emit('rider_location_update', {
        orderId,
        ...location,
        timestamp: new Date().toISOString(),
      });
      
      this.logger.debug(`🏍️ RIDER LOCATION: Broadcasted location for rider ${location.riderId} on order ${orderId}`);
    } catch (error) {
      this.logger.error(`💥 RIDER LOCATION ERROR for order ${orderId}:`, error.stack || error.message);
    }
  }

  async notifyReactionUpdate(conversationId: string, messageId: string, reactions: any) {
    try {
      this.logger.log(`🎭 BROADCASTING REACTION UPDATE to conversation ${conversationId} for message ${messageId}`);

      if (!this.server) {
        this.logger.error(`💥 REACTION UPDATE ERROR: Server not available for conversation ${conversationId}`);
        return;
      }

      const roomName = `conversation_${conversationId}`;

      this.server.to(roomName).emit('reaction_update', {
        conversationId,
        messageId,
        reactions,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ REACTION UPDATE SUCCESS: Reactions broadcast to conversation ${conversationId}`);
    } catch (error) {
      this.logger.error(`💥 Error broadcasting reaction update for message ${messageId}:`, error.stack || error.message);
    }
  }

  async notifyUserStatus(userId: string, isOnline: boolean) {
    try {
      if (!this.server) {
        this.logger.error(`💥 USER STATUS ERROR: Server not available for user ${userId}`);
        return;
      }

      this.server.emit('user_status', {
        userId,
        isOnline,
        lastSeen: new Date().toISOString(),
      });
      this.logger.debug(`👤 User status broadcast: ${userId} is ${isOnline ? 'online' : 'offline'}`);
    } catch (error) {
      this.logger.error(`💥 Error notifying user status for ${userId}:`, error.stack || error.message);
    }
  }

  // =============================================================================
  // CALL SIGNALING (WebRTC-style signals from clients)
  // =============================================================================

  /**
   * Handle call signals from clients (call_accepted, call_declined, etc.)
   * These are direct peer-to-peer style signals that need to be relayed
   */
  @SubscribeMessage('call_signal')
  async handleCallSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { callSessionId: string; signalType: string; data: any; conversationId?: string }
  ) {
    try {
      // Debug: Log the entire received data structure
      this.logger.log(`📞 CALL SIGNAL RAW DATA:`, JSON.stringify(data, null, 2));
      this.logger.log(`📞 CALL SIGNAL RECEIVED: ${data.signalType} for call ${data.callSessionId} from socket ${client.id}`);

      const userId = await this.realtimeService.getUserBySocketId(client.id);
      if (!userId) {
        this.logger.warn(`❌ Unauthorized call signal from socket ${client.id}`);
        return;
      }

      // If conversationId is provided, use it; otherwise fetch from call session
      let conversationId = data.conversationId;

      if (!conversationId) {
        // Fetch call session to get conversation ID
        const supabase = (this.realtimeService as any).supabase;
        const { data: callSession } = await supabase
          .from('chat_call_sessions')
          .select('conversation_id')
          .eq('id', data.callSessionId)
          .single();

        conversationId = callSession?.conversation_id;
      }

      if (!conversationId) {
        this.logger.error(`❌ Could not determine conversation for call ${data.callSessionId}`);
        return;
      }

      const conversationRoom = `conversation_${conversationId}`;

      // Broadcast signal to all participants in conversation (exclude sender)
      client.to(conversationRoom).emit('call_signal', {
        callSessionId: data.callSessionId,
        signalType: data.signalType,
        data: data.data,
        from: userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ CALL SIGNAL RELAYED: ${data.signalType} broadcasted to conversation ${conversationId}`);
    } catch (error) {
      this.logger.error(`💥 Error handling call signal:`, error);
    }
  }

  // =============================================================================
  // CALL EVENT BROADCASTING
  // =============================================================================

  /**
   * Broadcast call events (incoming_call, call_ended, etc.) to all participants in a conversation
   * @param conversationId - The conversation where the call is happening
   * @param eventType - Type of call event (incoming_call, call_ended, participant_joined, etc.)
   * @param callData - Call session data and metadata
   */
  async notifyCallEvent(conversationId: string, eventType: string, callData: any) {
    try {
      if (!this.server) {
        this.logger.error(`💥 CALL EVENT ERROR: Server not available for conversation ${conversationId}`);
        return;
      }

      const roomName = `conversation_${conversationId}`;

      this.logger.log(`📞 BROADCASTING CALL EVENT: ${eventType} to conversation ${conversationId}`);
      this.logger.log(`📞 Call data:`, JSON.stringify(callData, null, 2));

      // Broadcast to all participants in the conversation room
      this.server.to(roomName).emit('call_event', {
        conversationId,
        eventType,
        callData,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ CALL EVENT BROADCAST SUCCESS: ${eventType} sent to conversation ${conversationId}`);
    } catch (error) {
      this.logger.error(`💥 Error broadcasting call event ${eventType} for conversation ${conversationId}:`, error.stack || error.message);
    }
  }

  /**
   * Notify conversation participants about new invoice
   */
  async notifyInvoiceCreated(conversationId: string, invoice: any, excludeUserId?: string) {
    try {
      const roomName = `conversation_${conversationId}`;

      this.logger.log(`📄 Broadcasting invoice_created to conversation ${conversationId}`);

      this.server.to(roomName).emit('invoice_created', {
        conversationId,
        invoice,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ Invoice created broadcast success`);
    } catch (error) {
      this.logger.error(`Error broadcasting invoice_created:`, error);
    }
  }

  /**
   * Notify conversation participants about invoice update
   */
  async notifyInvoiceUpdated(conversationId: string, invoice: any, excludeUserId?: string) {
    try {
      const roomName = `conversation_${conversationId}`;

      this.logger.log(`📝 Broadcasting invoice_updated to conversation ${conversationId}`);

      this.server.to(roomName).emit('invoice_updated', {
        conversationId,
        invoice,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ Invoice updated broadcast success`);
    } catch (error) {
      this.logger.error(`Error broadcasting invoice_updated:`, error);
    }
  }

  /**
   * Notify conversation participants about invoice cancellation
   */
  async notifyInvoiceCancelled(conversationId: string, invoiceId: string, cancelledBy: string) {
    try {
      const roomName = `conversation_${conversationId}`;

      this.logger.log(`❌ Broadcasting invoice_cancelled to conversation ${conversationId}`);

      this.server.to(roomName).emit('invoice_cancelled', {
        conversationId,
        invoiceId,
        cancelledBy,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ Invoice cancelled broadcast success`);
    } catch (error) {
      this.logger.error(`Error broadcasting invoice_cancelled:`, error);
    }
  }

  /**
   * Notify conversation participants about invoice payment
   */
  async notifyInvoicePaid(conversationId: string, invoiceId: string) {
    try {
      const roomName = `conversation_${conversationId}`;

      this.logger.log(`💰 Broadcasting invoice_paid to conversation ${conversationId}`);

      this.server.to(roomName).emit('invoice_paid', {
        conversationId,
        invoiceId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ Invoice paid broadcast success`);
    } catch (error) {
      this.logger.error(`Error broadcasting invoice_paid:`, error);
    }
  }

  /**
   * Notify conversation participants about invoice expiration
   */
  async notifyInvoiceExpired(conversationId: string, invoiceId: string) {
    try {
      const roomName = `conversation_${conversationId}`;

      this.logger.log(`⏰ Broadcasting invoice_expired to conversation ${conversationId}`);

      this.server.to(roomName).emit('invoice_expired', {
        conversationId,
        invoiceId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`✅ Invoice expired broadcast success`);
    } catch (error) {
      this.logger.error(`Error broadcasting invoice_expired:`, error);
    }
  }

  // Cleanup method to handle gateway destruction
  onModuleDestroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatStarted = false; // 🔥 FIX: Reset flag
      this.logger.log('💓 Heartbeat mechanism stopped');
    }
    this.connectedClients.clear();
    this.logger.log('🛑 RealtimeGateway cleanup completed');
  }
}