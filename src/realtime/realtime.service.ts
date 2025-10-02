import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';

@Injectable()
export class RealtimeService {
  private supabase;
  private readonly logger = new Logger(RealtimeService.name);

  // In-memory store for active connections
  private userConnections = new Map<string, Set<string>>(); // userId -> Set of socketIds
  private socketToUser = new Map<string, string>(); // socketId -> userId

  constructor(private configService: ConfigService) {
    this.supabase = createSupabaseClient(this.configService);

    // 🔥 DEBUG: Test if service role can access chat data at startup
    this.testDatabaseAccess();
  }

  private async testDatabaseAccess() {
    try {
      this.logger.log('🔍 TESTING DATABASE ACCESS with service role...');

      // Test 1: Can we read chat_conversations?
      const { data: conversations, error: convError } = await this.supabase
        .from('chat_conversations')
        .select('id, created_by, chat_type')
        .limit(1);

      this.logger.log('🔍 CONVERSATIONS ACCESS:', {
        success: !convError,
        error: convError?.message,
        count: conversations?.length || 0
      });

      // Test 2: Can we read chat_participants?
      const { data: participants, error: partError } = await this.supabase
        .from('chat_participants')
        .select('conversation_id, user_id, left_at, is_archived')
        .limit(1);

      this.logger.log('🔍 PARTICIPANTS ACCESS:', {
        success: !partError,
        error: partError?.message,
        count: participants?.length || 0
      });

      if (convError || partError) {
        this.logger.error('🚨 SERVICE ROLE CANNOT ACCESS CHAT TABLES - RLS ISSUE!');
      } else {
        this.logger.log('✅ Service role has database access');
      }
    } catch (error) {
      this.logger.error('💥 DATABASE ACCESS TEST FAILED:', error);
    }
  }

  async handleUserConnect(userId: string, socketId: string): Promise<void> {
    try {
      // Add to in-memory store
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId)!.add(socketId);
      this.socketToUser.set(socketId, userId);

      // Update user status in database
      await this.updateUserStatus(userId, true);

      this.logger.log(`User ${userId} connected with socket ${socketId}`);
    } catch (error) {
      this.logger.error('Error handling user connect:', error);
    }
  }

  async handleUserDisconnect(userId: string, socketId: string): Promise<void> {
    try {
      // Remove from in-memory store
      const userSockets = this.userConnections.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
          this.userConnections.delete(userId);
          // User is completely offline
          await this.updateUserStatus(userId, false);
        }
      }
      this.socketToUser.delete(socketId);

      this.logger.log(`User ${userId} disconnected from socket ${socketId}`);
    } catch (error) {
      this.logger.error('Error handling user disconnect:', error);
    }
  }

  async getUserBySocketId(socketId: string): Promise<string | null> {
    return this.socketToUser.get(socketId) || null;
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const userSockets = this.userConnections.get(userId);
    return userSockets ? userSockets.size > 0 : false;
  }

  async getUserConversations(userId: string, userToken?: string): Promise<string[]> {
    try {
      this.logger.log(`🔍 FETCHING CONVERSATIONS for user: ${userId}, hasToken=${!!userToken}`);

      // 🔥 CRITICAL FIX: Use user-authenticated client instead of service role
      const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

      // 🔥 CRITICAL FIX: Use EXACT same query pattern as ChatService for consistency
      // Query conversations via join with participants, matching ChatService exactly
      const { data: conversations, error } = await client
        .from('chat_conversations')
        .select(`
          id,
          chat_participants (
            user_id,
            left_at,
            is_archived
          )
        `)
        .eq('is_active', true)
        .eq('chat_participants.user_id', userId); // Match ChatService - no left_at/archived filters here

      this.logger.log(`🔍 CONVERSATION QUERY RESULT:`, {
        error: error?.message,
        count: conversations?.length || 0,
        conversations: conversations?.map(c => ({ id: c.id, participants: c.chat_participants }))
      });

      if (error) {
        this.logger.error('Error fetching user conversations with join:', error);

        // Fallback to direct participant query if join fails
        this.logger.warn('🔄 Falling back to direct participant query...');
        const { data: fallbackConversations, error: fallbackError } = await client
          .from('chat_participants')
          .select('conversation_id')
          .eq('user_id', userId)
          .is('left_at', null);

        if (fallbackError) {
          this.logger.error('Fallback query also failed:', fallbackError);
          return [];
        }

        this.logger.log(`📊 Found ${fallbackConversations.length} active conversations for user: ${userId} (fallback)`);
        return fallbackConversations.map(conv => conv.conversation_id);
      }

      // 🔥 FILTER: Apply left_at and archived filters after fetch, like ChatService does
      const activeConversations = conversations.filter(conv => {
        const userParticipant = conv.chat_participants.find(p => p.user_id === userId);
        return userParticipant &&
               userParticipant.left_at === null &&
               userParticipant.is_archived === false;
      });

      const conversationIds = activeConversations.map(conv => conv.id);
      this.logger.log(`📊 Found ${conversations.length} total, ${conversationIds.length} active conversations for user: ${userId}`);
      return conversationIds;
    } catch (error) {
      this.logger.error('Error getting user conversations:', error);
      return [];
    }
  }

  async verifyConversationAccess(userId: string, conversationId: string, userToken?: string): Promise<boolean> {
    try {
      this.logger.log(`🔍 VERIFYING ACCESS: userId=${userId}, conversationId=${conversationId}, hasToken=${!!userToken}`);

      // 🔥 CRITICAL FIX: Use user-authenticated client instead of service role to bypass RLS issues
      const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

      // 🔥 DEBUGGING: Test both approaches to see the difference
      if (userToken) {
        this.logger.log(`🔍 COMPARING ACCESS: Testing both service role vs user-authenticated client`);

        // Test with service role
        const { data: serviceRoleTest, error: serviceError } = await this.supabase
          .from('chat_conversations')
          .select('id')
          .eq('id', conversationId)
          .limit(1);

        this.logger.log(`🔍 SERVICE ROLE RESULT:`, {
          success: !serviceError,
          error: serviceError?.message,
          found: serviceRoleTest?.length || 0
        });

        // Test with user client
        const { data: userClientTest, error: userError } = await client
          .from('chat_conversations')
          .select('id')
          .eq('id', conversationId)
          .limit(1);

        this.logger.log(`🔍 USER CLIENT RESULT:`, {
          success: !userError,
          error: userError?.message,
          found: userClientTest?.length || 0
        });
      }

      // 🔥 STEP 1: Check if conversation exists
      this.logger.log(`🔍 DEBUG: Checking if conversation ${conversationId} exists`);
      const { data: conversation, error: convError } = await client
        .from('chat_conversations')
        .select('*')
        .eq('id', conversationId);

      this.logger.log(`🔍 DEBUG CONVERSATION EXISTS:`, {
        error: convError?.message,
        exists: conversation && conversation.length > 0,
        conversation: conversation?.[0]
      });

      if (!conversation || conversation.length === 0) {
        this.logger.warn(`❌ ACCESS DENIED: Conversation ${conversationId} does not exist`);
        return false;
      }

      // 🔥 STEP 2: Check what's actually in the database for this conversation
      this.logger.log(`🔍 DEBUG: Checking all participants for conversation ${conversationId}`);
      const { data: allParticipants, error: debugError } = await client
        .from('chat_participants')
        .select('*')
        .eq('conversation_id', conversationId);

      this.logger.log(`🔍 DEBUG ALL PARTICIPANTS:`, {
        error: debugError?.message,
        count: allParticipants?.length || 0,
        participants: allParticipants
      });

      // 🔥 STEP 3: Check specific user participation
      this.logger.log(`🔍 DEBUG: Checking specific user ${userId} in conversation ${conversationId}`);
      const { data: userParticipant, error: userError } = await client
        .from('chat_participants')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      this.logger.log(`🔍 DEBUG USER PARTICIPANT:`, {
        error: userError?.message,
        count: userParticipant?.length || 0,
        participant: userParticipant
      });

      // 🔥 STEP 4: If user is not a participant, check if they should be (debugging missing data)
      if (!userParticipant || userParticipant.length === 0) {
        this.logger.warn(`🚨 CRITICAL: User ${userId} is NOT found as participant in conversation ${conversationId}`);
        this.logger.warn(`🚨 This means either:`);
        this.logger.warn(`   1. The conversation was created without adding participants`);
        this.logger.warn(`   2. The user was removed from the conversation`);
        this.logger.warn(`   3. There's a database inconsistency`);

        // Check if user created this conversation (they should be automatically added)
        if (conversation[0].created_by === userId) {
          this.logger.error(`🚨 MAJOR ISSUE: User ${userId} created conversation ${conversationId} but is not a participant!`);
        }

        return false;
      }

      // 🔥 STEP 5: Check participant status
      const participant = userParticipant[0];

      // Check if user has left the conversation
      if (participant.left_at !== null) {
        this.logger.warn(`❌ ACCESS DENIED: User ${userId} has left conversation ${conversationId} at ${participant.left_at}`);
        return false;
      }

      // Check if user has archived the conversation (if column exists)
      if (participant.hasOwnProperty('is_archived') && participant.is_archived === true) {
        this.logger.warn(`❌ ACCESS DENIED: User ${userId} has archived conversation ${conversationId}`);
        return false;
      }

      this.logger.log(`✅ ACCESS GRANTED: User ${userId} is active participant in conversation ${conversationId}`);
      return true;

    } catch (error) {
      this.logger.error(`💥 ACCESS CHECK ERROR:`, error);
      return false;
    }
  }

  private async updateUserStatus(userId: string, isOnline: boolean): Promise<void> {
    try {
      // Update user_profiles table with online status
      const { error } = await this.supabase
        .from('user_profiles')
        .update({
          is_online: isOnline,
          last_seen: new Date().toISOString(),
        })
        .eq('id', userId);

      if (error) {
        this.logger.error('Error updating user status:', error);
      }
    } catch (error) {
      this.logger.error('Error updating user status:', error);
    }
  }

  // Methods for other services to trigger real-time events
  async broadcastNewMessage(conversationId: string, message: any): Promise<void> {
    // This would be called by the chat service when a new message is sent
    // The gateway would handle the actual broadcasting
    this.logger.log(`Broadcasting new message for conversation ${conversationId}`);
  }

  async broadcastTypingIndicator(conversationId: string, userId: string, isTyping: boolean): Promise<void> {
    this.logger.log(`Broadcasting typing indicator for user ${userId} in conversation ${conversationId}: ${isTyping}`);
  }

  async broadcastUserStatusChange(userId: string, isOnline: boolean): Promise<void> {
    this.logger.log(`Broadcasting status change for user ${userId}: ${isOnline ? 'online' : 'offline'}`);
  }

  // Utility methods
  getActiveUserCount(): number {
    return this.userConnections.size;
  }

  getActiveUsers(): string[] {
    return Array.from(this.userConnections.keys());
  }

  getUserSocketCount(userId: string): number {
    const userSockets = this.userConnections.get(userId);
    return userSockets ? userSockets.size : 0;
  }

  // Save chat message to database (for AI chat watching)
  async saveChatMessage(conversationId: string, message: any): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from('chat_messages')
        .insert({
          conversation_id: conversationId,
          sender_id: message.senderId,
          content: message.content,
          message_type: message.messageType || 'text',
          media_url: message.mediaUrl || null,
          file_metadata: message.fileData || null,
          created_at: message.createdAt || new Date().toISOString(),
          updated_at: message.updatedAt || new Date().toISOString(),
        });

      if (error) {
        this.logger.error('Error saving chat message:', error);
        throw error;
      }

      this.logger.debug(`Chat message saved for conversation ${conversationId}`);
    } catch (error) {
      this.logger.error('Failed to save chat message:', error);
      throw error;
    }
  }
}