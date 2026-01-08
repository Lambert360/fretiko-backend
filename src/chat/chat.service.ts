import { Injectable, NotFoundException, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSupabaseClient, createUserSupabaseClient } from '../shared/supabase.client';
import { NotificationHelperService } from '../notifications/notification-helper.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  CreateConversationDto,
  SendMessageDto,
  UpdateMessageStatusDto,
  GetConversationsDto,
  GetMessagesDto,
  ConversationResponseDto,
  MessageResponseDto,
  ChatType,
  MessageType,
  MessageStatus,
} from './dto/chat.dto';

@Injectable()
export class ChatService {
  private supabase;
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private configService: ConfigService,
    private notificationHelper: NotificationHelperService,
    @Inject(forwardRef(() => RealtimeGateway))
    private realtimeGateway: RealtimeGateway
  ) {
    this.supabase = createSupabaseClient(this.configService);
  }

  async getConversations(userId: string, query: GetConversationsDto, userToken?: string): Promise<ConversationResponseDto[]> {
    this.logger.log(`Fetching conversations for user: ${userId}`);

    // Create user-authenticated client
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // First, get conversation IDs where the user is a participant
      const { data: userParticipations } = await client
        .from('chat_participants')
        .select('conversation_id')
        .eq('user_id', userId);

      const userConversationIds = userParticipations?.map(p => p.conversation_id) || [];

      this.logger.debug(`📊 User has ${userConversationIds.length} conversations`);

      if (userConversationIds.length === 0) {
        this.logger.log('User has no conversations');
        return [];
      }

      // Then get full conversation data with ALL participants
      let conversationsQuery = client
        .from('chat_conversations')
        .select(`
          id,
          chat_type,
          name,
          description,
          avatar_url,
          is_group,
          created_at,
          updated_at,
          last_message_at,
          metadata,
          chat_participants (
            id,
            user_id,
            role,
            joined_at,
            is_muted,
            is_pinned,
            last_read_at,
            is_archived
          )
        `)
        .eq('is_active', true)
        .in('id', userConversationIds)
        .order('last_message_at', { ascending: false });

      // Apply filters
      if (query.chatType) {
        conversationsQuery = conversationsQuery.eq('chat_type', query.chatType);
      }

      if (query.search) {
        conversationsQuery = conversationsQuery.or(
          `name.ilike.%${query.search}%,description.ilike.%${query.search}%`
        );
      }

      // Handle archived conversations filter
      // Note: For now, we'll filter archived conversations in the response mapping
      // since we're using outer join for AI conversations

      // Apply pagination
      const page = query.page || 1;
      const limit = query.limit || 20;
      const offset = (page - 1) * limit;
      conversationsQuery = conversationsQuery.range(offset, offset + limit - 1);

      const { data: conversations, error } = await conversationsQuery;

      if (error) {
        this.logger.error('Failed to fetch conversations:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.debug(`📊 Fetched ${conversations?.length || 0} conversations from database`);
      // ✅ FIX: Add null check before accessing array element
      if (conversations && conversations.length > 0 && conversations[0]?.chat_participants) {
        this.logger.debug(`📊 First conversation participants: ${JSON.stringify(conversations[0].chat_participants)}`);
      }

      // ✅ FIX: Early return if no conversations
      if (!conversations || conversations.length === 0) {
        return [];
      }

      // Fetch last message for each conversation
      const conversationIds = conversations.map(conv => conv.id);
      
      const { data: lastMessages, error: lastMessagesError } = await client
        .from('chat_messages')
        .select(`
          conversation_id,
          id,
          sender_id,
          message_type,
          content,
          media_url,
          created_at
        `)
        .in('conversation_id', conversationIds)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false });

      if (lastMessagesError) {
        this.logger.error('Error fetching last messages:', lastMessagesError);
        // Continue with empty array rather than failing
      }

      // ✅ FIX: Get unread counts efficiently using SQL aggregation (industry standard)
      // First, fetch last_read_at for each conversation for this user
      const { data: participantRecords, error: participantError } = await client
        .from('chat_participants')
        .select('conversation_id, last_read_at')
        .in('conversation_id', conversationIds)
        .eq('user_id', userId);

      if (participantError) {
        this.logger.error('Error fetching participant records:', participantError);
        // Continue with empty map
      }

      // Create a map of conversation_id -> last_read_at
      const lastReadMap = new Map<string, string | null>();
      participantRecords?.forEach(p => {
        lastReadMap.set(p.conversation_id, p.last_read_at);
      });

      // ✅ Industry standard: keep unread counts as a map (conversationId -> count)
      // This avoids building large arrays and is faster/more memory efficient.
      const unreadCountByConversationId: Record<string, number> = {};
      
      if (conversationIds.length > 0) {
        // Count unread messages per conversation using parallel queries
        const unreadCountPromises = conversationIds.map(async (convId) => {
          try {
            const lastReadAt = lastReadMap.get(convId);
            
            // Build count query for this conversation
            let countQuery = client
              .from('chat_messages')
              .select('*', { count: 'exact', head: true })
              .eq('conversation_id', convId)
              .eq('is_deleted', false);
            
            // If last_read_at exists, only count messages created after it
            if (lastReadAt) {
              countQuery = countQuery.gt('created_at', lastReadAt);
            }
            // If lastReadAt is null, all messages are unread (no date filter)
            
            const { count, error: countError } = await countQuery;
            
            if (countError) {
              this.logger.error(`Error counting unread messages for conversation ${convId}:`, countError);
              return { conversation_id: convId, count: 0 };
            }
            
            return { conversation_id: convId, count: count || 0 };
          } catch (error) {
            this.logger.error(`Error processing unread count for conversation ${convId}:`, error);
            return { conversation_id: convId, count: 0 };
          }
        });
        
        // Wait for all count queries to complete
        const unreadCountResults = await Promise.all(unreadCountPromises);
        
        unreadCountResults.forEach(result => {
          unreadCountByConversationId[result.conversation_id] = result.count || 0;
        });
      }

      // Get user profiles for participants and message senders
      const participantIds = conversations.flatMap(conv =>
        conv.chat_participants?.map(p => p.user_id) || []
      );
      const senderIds = lastMessages?.map(msg => msg.sender_id) || [];
      const allUserIds = [...new Set([...participantIds, ...senderIds])];

      // 🔥 FIX: Filter out invalid UUIDs before querying (prevents PostgreSQL errors)
      const validUserIds = allUserIds.filter(id => {
        // Check if ID exists and is not a string "null" or "undefined"
        if (!id || id === 'null' || id === 'undefined' || id.trim() === '') {
          return false;
        }

        // Validate UUID format (8-4-4-4-12 hex digits)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(id);
      });

      // Log invalid IDs for debugging
      const invalidIds = allUserIds.filter(id => !validUserIds.includes(id));
      if (invalidIds.length > 0) {
        this.logger.warn(`⚠️ Found ${invalidIds.length} invalid user IDs that will be skipped:`, invalidIds);
      }

      this.logger.debug(`📊 Fetching profiles for ${validUserIds.length} valid users (${invalidIds.length} invalid filtered out)`);

      let userProfiles = [];
      if (validUserIds.length > 0) {
        const { data: profiles, error: profilesError } = await client
          .from('user_profiles')
          .select('id, username, avatar_url')
          .in('id', validUserIds);

        if (profilesError) {
          this.logger.error('❌ Error fetching user profiles:', profilesError);
        } else {
          this.logger.debug(`📊 Fetched ${profiles?.length || 0} user profiles: ${JSON.stringify(profiles)}`);
        }

        userProfiles = profiles || [];
      }

      // Transform and return data
      return conversations.map(conv =>
        this.mapConversationResponse(conv, lastMessages || [], unreadCountByConversationId, userProfiles, userId)
      );
    } catch (error) {
      this.logger.error('Error fetching conversations:', error);
      throw error;
    }
  }

  async findOrCreateConversation(userId: string, participantIds: string[], chatType: string, userToken?: string): Promise<ConversationResponseDto> {
    this.logger.log(`Finding or creating conversation for user: ${userId} with participants: ${participantIds.join(', ')}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Industry Standard: Use participant hash for efficient lookup
      const allParticipants = [...new Set([userId, ...participantIds])].sort();

      // Generate participant hash using PostgreSQL function
      // Convert strings to UUIDs for the function call
      const { data: hashResult, error: hashError } = await client
        .rpc('generate_participant_hash', { participant_ids: allParticipants });

      if (hashError) {
        this.logger.error('Error generating participant hash:', hashError);
        throw new Error(`Failed to generate participant hash: ${hashError.message}`);
      }

      const participantHash = hashResult;
      this.logger.log(`Generated participant hash: ${participantHash}`);

      // ✅ FIX: Search by participant_hash AND chat_type to match the unique constraint
      // The database has UNIQUE(participant_hash, chat_type), so we should search by both
      // This ensures we find the correct conversation type (friend, vendor, etc.)
      this.logger.log(`Looking for conversation with hash: ${participantHash}, type: ${chatType}`);

      const { data: existingConversations, error: queryError } = await client
        .from('chat_conversations')
        .select(`
          id,
          chat_type,
          name,
          description,
          avatar_url,
          is_group,
          created_at,
          updated_at,
          last_message_at,
          metadata,
          participant_hash
        `)
        .eq('participant_hash', participantHash)
        .eq('chat_type', chatType) // ✅ Include chat_type in search
        .eq('is_active', true)
        .order('created_at', { ascending: false }); // Get most recent first

      if (queryError) {
        this.logger.error('Error querying existing conversations:', queryError);
        throw new Error(`Database error: ${queryError.message}`);
      }

      // Handle multiple matching conversations (select the most recent one)
      if (existingConversations && existingConversations.length > 0) {
        const selectedConversation = existingConversations[0]; // Most recent due to ordering

        if (existingConversations.length > 1) {
          this.logger.warn(`Found ${existingConversations.length} duplicate conversations with hash ${participantHash}. Using most recent: ${selectedConversation.id}`);
          // TODO: Clean up duplicates in background
        }

        this.logger.log(`Found existing conversation by hash: ${selectedConversation.id} (hash: ${selectedConversation.participant_hash})`);
        return this.getConversationById(selectedConversation.id, userId, userToken);
      }


      // No existing conversation found, create a new one with participant hash
      this.logger.log('No existing conversation found, creating new one with hash');

      const { data: conversation, error: convError } = await client
        .from('chat_conversations')
        .insert({
          chat_type: chatType,
          name: null, // 🔥 FIX: Explicitly set to null for 1:1 chats (enables username derivation)
          created_by: userId,
          is_group: allParticipants.length > 2,
          participant_hash: participantHash,
          is_active: true,
          metadata: {},
        })
        .select()
        .single();

      if (convError) {
        this.logger.error('Failed to create conversation:', convError);
        throw new Error(`Database error: ${convError.message}`);
      }

      // Add participants
      const participantInserts = allParticipants.map(participantId => ({
        conversation_id: conversation.id,
        user_id: participantId,
        role: participantId === userId ? 'admin' : 'member',
      }));

      const { error: participantsError } = await client
        .from('chat_participants')
        .insert(participantInserts);

      if (participantsError) {
        this.logger.error('Failed to add participants:', participantsError);
        // Cleanup conversation if participants failed
        await client.from('chat_conversations').delete().eq('id', conversation.id);
        throw new Error(`Failed to add participants: ${participantsError.message}`);
      }

      this.logger.log(`Created new conversation with hash: ${conversation.id}`);
      return this.getConversationById(conversation.id, userId, userToken);

    } catch (error) {
      this.logger.error('Error in findOrCreateConversation:', error);
      throw error;
    }
  }

  async createConversation(userId: string, createConversationDto: CreateConversationDto, userToken?: string): Promise<ConversationResponseDto> {
    this.logger.log(`Creating conversation for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Create conversation
      const { data: conversation, error: convError } = await client
        .from('chat_conversations')
        .insert({
          chat_type: createConversationDto.chatType,
          name: createConversationDto.name,
          description: createConversationDto.description,
          avatar_url: createConversationDto.avatarUrl,
          is_group: createConversationDto.isGroup || false,
          created_by: userId,
          metadata: createConversationDto.metadata || {},
        })
        .select()
        .single();

      if (convError) {
        this.logger.error('Failed to create conversation:', convError);
        throw new Error(`Database error: ${convError.message}`);
      }

      // Add participants (including creator)
      const allParticipants = [...new Set([userId, ...createConversationDto.participantIds])];
      const participantInserts = allParticipants.map(participantId => ({
        conversation_id: conversation.id,
        user_id: participantId,
        role: participantId === userId ? 'admin' : 'member',
      }));

      const { error: participantsError } = await client
        .from('chat_participants')
        .insert(participantInserts);

      if (participantsError) {
        this.logger.error('Failed to add participants:', participantsError);
        // Cleanup conversation if participants failed
        await client.from('chat_conversations').delete().eq('id', conversation.id);
        throw new Error(`Failed to add participants: ${participantsError.message}`);
      }

      // Return full conversation data
      return this.getConversationById(conversation.id, userId, userToken);
    } catch (error) {
      this.logger.error('Error creating conversation:', error);
      throw error;
    }
  }

  async getMessages(userId: string, query: GetMessagesDto, userToken?: string): Promise<MessageResponseDto[]> {
    this.logger.log(`Fetching messages for conversation: ${query.conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant (restored - RLS should be fixed now)
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', query.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        this.logger.error(`User ${userId} is not a participant in conversation ${query.conversationId}`);
        throw new NotFoundException('Conversation not found or access denied');
      }

      let messagesQuery = client
        .from('chat_messages')
        .select(`
          id,
          conversation_id,
          sender_id,
          message_type,
          content,
          media_url,
          file_metadata,
          created_at,
          updated_at,
          edited_at,
          is_deleted,
          reply_to_id,
          metadata,
          reply_to:chat_messages!reply_to_id (
            id,
            content,
            message_type,
            sender_id
          )
        `)
        .eq('conversation_id', query.conversationId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false }); // 🔥 FIX: Query newest first for pagination, reverse in response

      // Apply filters
      if (query.messageType) {
        messagesQuery = messagesQuery.eq('message_type', query.messageType);
      }

      if (query.before) {
        messagesQuery = messagesQuery.lt('created_at', query.before);
      }

      if (query.after) {
        messagesQuery = messagesQuery.gt('created_at', query.after);
      }

      // Apply pagination
      const page = query.page || 1;
      const limit = query.limit || 20;
      const offset = (page - 1) * limit;
      messagesQuery = messagesQuery.range(offset, offset + limit - 1);

      // Add detailed logging for debugging
      this.logger.log(`Query parameters - ConversationId: ${query.conversationId}, Page: ${page}, Limit: ${limit}, Offset: ${offset}`);

      const { data: messages, error } = await messagesQuery;

      if (error) {
        this.logger.error('Failed to fetch messages:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.log(`Raw messages returned from DB: ${messages ? messages.length : 0}`);
      if (messages && messages.length > 0) {
        this.logger.log(`First message: ${JSON.stringify({
          id: messages[0].id,
          content: messages[0].content,
          created_at: messages[0].created_at,
          sender_id: messages[0].sender_id
        })}`);
      }

      // Get message status for current user
      const messageIds = messages.map(msg => msg.id);
      const { data: messageStatuses } = await client
        .from('message_status')
        .select('message_id, status')
        .in('message_id', messageIds)
        .eq('user_id', userId);

      const statusMap = messageStatuses?.reduce((acc, status) => {
        acc[status.message_id] = status.status;
        return acc;
      }, {}) || {};

      // Get user profiles for message senders and reply senders (including actual senders from metadata)
      const senderIds = messages.flatMap(msg => [
        msg.metadata?.actualSenderId || msg.sender_id, // Use actual sender if available
        ...(msg.reply_to ? [msg.reply_to.metadata?.actualSenderId || msg.reply_to.sender_id] : [])
      ]);
      const userIds = [...new Set(senderIds)];

      let userProfiles = [];
      if (userIds.length > 0) {
        const { data: profiles } = await client
          .from('user_profiles')
          .select('id, username, avatar_url')
          .in('id', userIds);
        userProfiles = profiles || [];
      }

      // Fetch invoice data for invoice messages
      const invoiceMessages = messages.filter(msg => msg.message_type === 'invoice');
      let invoiceData = {};

      if (invoiceMessages.length > 0) {
        const { data: invoices } = await client
          .from('chat_invoices')
          .select(`
            *,
            items:chat_invoice_items(*)
          `)
          .in('message_id', invoiceMessages.map(msg => msg.id));

        if (invoices) {
          invoiceData = invoices.reduce((acc, invoice) => {
            acc[invoice.message_id] = invoice;
            return acc;
          }, {});
        }
      }

      // 🔥 FIX: Reverse messages to chronological order (oldest first) for proper chat display
      const reversedMessages = messages.reverse();
      return reversedMessages.map(msg => this.mapMessageResponse(msg, statusMap[msg.id], userProfiles, invoiceData[msg.id]));
    } catch (error) {
      this.logger.error('Error fetching messages:', error);
      throw error;
    }
  }

  async sendMessage(userId: string, sendMessageDto: SendMessageDto, userToken?: string): Promise<MessageResponseDto> {
    this.logger.log(`Sending message from user: ${userId} to conversation: ${sendMessageDto.conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', sendMessageDto.conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      // Insert message
      const { data: message, error } = await client
        .from('chat_messages')
        .insert({
          conversation_id: sendMessageDto.conversationId,
          sender_id: userId, // Always use authenticated user for RLS compliance
          message_type: sendMessageDto.messageType,
          content: sendMessageDto.content,
          media_url: sendMessageDto.mediaUrl,
          file_metadata: sendMessageDto.fileMetadata,
          reply_to_id: sendMessageDto.replyToId,
          metadata: {
            ...sendMessageDto.metadata || {},
            isAIResponse: sendMessageDto.isAIResponse || false,
            actualSenderId: sendMessageDto.actualSenderId || userId, // Track who actually sent the message
            productData: sendMessageDto.productData || null, // Include product data for bargain messages
          },
        })
        .select(`
          id,
          conversation_id,
          sender_id,
          message_type,
          content,
          media_url,
          file_metadata,
          created_at,
          updated_at,
          edited_at,
          is_deleted,
          reply_to_id,
          metadata
        `)
        .single();

      if (error) {
        this.logger.error('Failed to send message:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      // Create message status for all participants
      const { data: participants } = await client
        .from('chat_participants')
        .select('user_id')
        .eq('conversation_id', sendMessageDto.conversationId);

      const statusInserts = participants
        .filter(p => p.user_id !== userId) // Don't create status for sender
        .map(p => ({
          message_id: message.id,
          user_id: p.user_id,
          status: MessageStatus.SENT,
        }));

      if (statusInserts.length > 0) {
        await client.from('message_status').insert(statusInserts);
      }

      // Get user profile for sender
      const { data: userProfile } = await client
        .from('user_profiles')
        .select('id, username, avatar_url')
        .eq('id', userId)
        .single();

      const userProfiles = userProfile ? [userProfile] : [];

      // Trigger real-time notification via push notifications
      await this.notifyParticipants(sendMessageDto.conversationId, message, userToken);

      // 🔥 CRITICAL FIX: Broadcast message via WebSocket for real-time chat
      // For system-generated messages (wishlist, invoice), broadcast to ALL including sender
      // For user messages, exclude the sender (they already have it optimistically)
      try {
        const messageForBroadcast = this.mapMessageResponse(message, MessageStatus.SENT, userProfiles);
        const excludeUserId = sendMessageDto.broadcastToAll ? undefined : userId; // undefined means don't exclude anyone

        await this.realtimeGateway.notifyNewMessage(
          sendMessageDto.conversationId,
          messageForBroadcast,
          excludeUserId
        );

        if (sendMessageDto.broadcastToAll) {
          this.logger.log(`📡 Real-time message broadcast sent to ALL participants in conversation: ${sendMessageDto.conversationId}`);
        } else {
          this.logger.log(`📡 Real-time message broadcast sent for conversation: ${sendMessageDto.conversationId} (excluded sender: ${userId})`);
        }
      } catch (broadcastError) {
        this.logger.error('❌ Failed to broadcast message via WebSocket:', broadcastError);
        // Don't throw - message was saved successfully, broadcast failure shouldn't fail the request
      }

      return this.mapMessageResponse(message, MessageStatus.SENT, userProfiles);
    } catch (error) {
      this.logger.error('Error sending message:', error);
      throw error;
    }
  }

  async updateMessageStatus(userId: string, updateStatusDto: UpdateMessageStatusDto, userToken?: string): Promise<void> {
    this.logger.log(`Updating message status for user: ${userId}, message: ${updateStatusDto.messageId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { error } = await client
        .from('message_status')
        .upsert({
          message_id: updateStatusDto.messageId,
          user_id: userId,
          status: updateStatusDto.status,
          timestamp: new Date().toISOString(),
        });

      if (error) {
        this.logger.error('Failed to update message status:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      // Update last read timestamp if marking as read
      if (updateStatusDto.status === MessageStatus.READ) {
        const { data: message } = await client
          .from('chat_messages')
          .select('conversation_id')
          .eq('id', updateStatusDto.messageId)
          .single();

        if (message) {
          await client
            .from('chat_participants')
            .update({ last_read_at: new Date().toISOString() })
            .eq('conversation_id', message.conversation_id)
            .eq('user_id', userId);
        }
      }
    } catch (error) {
      this.logger.error('Error updating message status:', error);
      throw error;
    }
  }

  async updateMessage(
    userId: string,
    messageId: string,
    updateData: { content?: string; mediaUrl?: string; fileData?: any },
    userToken?: string
  ): Promise<any> {
    this.logger.log(`Updating message: ${messageId} for user: ${userId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // First verify the user owns this message
      const { data: message, error: fetchError } = await client
        .from('chat_messages')
        .select('sender_id')
        .eq('id', messageId)
        .single();

      if (fetchError || !message) {
        throw new NotFoundException('Message not found');
      }

      if (message.sender_id !== userId) {
        throw new BadRequestException('You can only update your own messages');
      }

      // Update the message
      const updatePayload: any = {
        updated_at: new Date().toISOString(),
      };

      if (updateData.content !== undefined) {
        updatePayload.content = updateData.content;
      }
      if (updateData.mediaUrl !== undefined) {
        updatePayload.media_url = updateData.mediaUrl;
      }
      if (updateData.fileData !== undefined) {
        updatePayload.metadata = { fileData: updateData.fileData };
      }

      const { data: updatedMessage, error: updateError } = await client
        .from('chat_messages')
        .update(updatePayload)
        .eq('id', messageId)
        .select()
        .single();

      if (updateError) {
        this.logger.error('Failed to update message:', updateError);
        throw new Error(`Database error: ${updateError.message}`);
      }

      // 🔥 Broadcast updated message via WebSocket for real-time updates
      try {
        // Get user profile for sender
        const { data: userProfile } = await client
          .from('user_profiles')
          .select('id, username, avatar_url')
          .eq('id', userId)
          .single();

        const userProfiles = userProfile ? [userProfile] : [];

        // Get conversation ID from the updated message
        const { data: fullMessage } = await client
          .from('chat_messages')
          .select('conversation_id')
          .eq('id', messageId)
          .single();

        if (fullMessage) {
          const messageForBroadcast = this.mapMessageResponse(updatedMessage, MessageStatus.SENT, userProfiles);
          await this.realtimeGateway.notifyMessageUpdate(
            fullMessage.conversation_id,
            messageForBroadcast,
            userId // Exclude sender from broadcast
          );
          this.logger.log(`📡 Real-time message update broadcast sent for message: ${messageId}`);
        }
      } catch (broadcastError) {
        this.logger.error('❌ Failed to broadcast message update via WebSocket:', broadcastError);
        // Don't throw - message was updated successfully, broadcast failure shouldn't fail the request
      }

      this.logger.log(`Message updated successfully: ${messageId}`);
      return updatedMessage;
    } catch (error) {
      this.logger.error('Error updating message:', error);
      throw error;
    }
  }

  // =============================================================================
  // EMOJI REACTION METHODS
  // =============================================================================

  async toggleReaction(userId: string, messageId: string, emoji: string, userToken?: string): Promise<any> {
    this.logger.log(`Toggling reaction for message: ${messageId}, user: ${userId}, emoji: ${emoji}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Get existing reactions
      const { data: message, error: fetchError } = await client
        .from('chat_messages')
        .select('reactions, conversation_id')
        .eq('id', messageId)
        .single();

      if (fetchError || !message) {
        throw new NotFoundException('Message not found');
      }

      const reactions = message.reactions || {};
      const users = reactions[emoji] || [];

      // Toggle reaction
      if (users.includes(userId)) {
        // Remove reaction
        const newUsers = users.filter(id => id !== userId);
        if (newUsers.length === 0) {
          delete reactions[emoji];
        } else {
          reactions[emoji] = newUsers;
        }
      } else {
        // Add reaction
        reactions[emoji] = [...users, userId];
      }

      // Update message with new reactions
      // Note: Don't use .single() because RLS might prevent it from returning
      const { error: updateError } = await client
        .from('chat_messages')
        .update({ reactions, updated_at: new Date().toISOString() })
        .eq('id', messageId);

      if (updateError) {
        this.logger.error('Failed to update reactions:', updateError);
        throw new Error(`Database error: ${updateError.message}`);
      }

      // 🔥 Broadcast reaction update via WebSocket
      try {
        await this.realtimeGateway.notifyReactionUpdate(
          message.conversation_id,
          messageId,
          reactions
        );
        this.logger.log(`📡 Real-time reaction update broadcast sent for message: ${messageId}`);
      } catch (broadcastError) {
        this.logger.error('❌ Failed to broadcast reaction update via WebSocket:', broadcastError);
      }

      this.logger.log(`Reaction toggled successfully: ${messageId}`);
      return { messageId, reactions };
    } catch (error) {
      this.logger.error('Error toggling reaction:', error);
      throw error;
    }
  }

  async getReactions(messageId: string, userToken?: string): Promise<any> {
    this.logger.log(`Fetching reactions for message: ${messageId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: message, error } = await client
        .from('chat_messages')
        .select('reactions')
        .eq('id', messageId)
        .single();

      if (error || !message) {
        throw new NotFoundException('Message not found');
      }

      return message.reactions || {};
    } catch (error) {
      this.logger.error('Error fetching reactions:', error);
      throw error;
    }
  }

  // Helper methods
  async getConversationById(conversationId: string, userId: string, userToken?: string): Promise<ConversationResponseDto> {
    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    const { data: conversation, error } = await client
      .from('chat_conversations')
      .select(`
        id,
        chat_type,
        name,
        description,
        avatar_url,
        is_group,
        created_at,
        updated_at,
        last_message_at,
        metadata,
        chat_participants (
          id,
          user_id,
          role,
          joined_at,
          is_muted,
          is_pinned,
          last_read_at,
          user_profiles (
            id,
            username,
            avatar_url
          )
        )
      `)
      .eq('id', conversationId)
      .single();

    if (error) {
      throw new NotFoundException('Conversation not found');
    }

    // Get user profiles for participants
    const userIds = conversation.chat_participants?.map(p => p.user_id) || [];
    let userProfiles = [];
    if (userIds.length > 0) {
      const { data: profiles } = await client
        .from('user_profiles')
        .select('id, username, avatar_url')
        .in('id', userIds);
      userProfiles = profiles || [];
    }

    return this.mapConversationResponse(conversation, [], {}, userProfiles, userId);
  }

  private mapConversationResponse(
    conversation: any,
    lastMessages: any[] = [],
    unreadCountByConversationId: Record<string, number> = {},
    userProfiles: any[] = [],
    currentUserId?: string
  ): ConversationResponseDto {
    const lastMessage = lastMessages?.find(msg => msg.conversation_id === conversation.id);
    const unreadCount = unreadCountByConversationId?.[conversation.id] ?? 0;

    // Determine if this is an AI conversation
    const isAI = conversation.chat_type === 'ai';

    // 🔍 DEBUG: Log input data
    this.logger.debug(`🔍 mapConversationResponse INPUT - conversationId: ${conversation.id}`);
    this.logger.debug(`🔍 currentUserId: ${currentUserId}`);
    this.logger.debug(`🔍 conversation.chat_participants: ${JSON.stringify(conversation.chat_participants)}`);
    this.logger.debug(`🔍 userProfiles count: ${userProfiles?.length || 0}`);
    this.logger.debug(`🔍 userProfiles: ${JSON.stringify(userProfiles)}`);

    // Derive conversation name for 1:1 chats
    let conversationName = conversation.name;
    let conversationAvatar = conversation.avatar_url;
    let otherUserId: string | undefined;

    // 🔥 FIX: Check for null, undefined, empty string, OR whitespace-only strings
    // This ensures the username derivation logic always runs for 1:1 chats without explicit names
    const hasNoName = !conversationName || conversationName.trim() === '';

    if (hasNoName && !conversation.is_group && conversation.chat_participants) {
      // For 1:1 chats, use the other participant's username
      const otherParticipant = conversation.chat_participants.find(p => p.user_id !== currentUserId);
      this.logger.debug(`🔍 otherParticipant: ${JSON.stringify(otherParticipant)}`);

      if (otherParticipant) {
        const otherUserProfile = userProfiles.find(profile => profile.id === otherParticipant.user_id);
        this.logger.debug(`🔍 otherUserProfile: ${JSON.stringify(otherUserProfile)}`);

        conversationName = otherUserProfile?.username || 'Unknown User';
        conversationAvatar = conversationAvatar || otherUserProfile?.avatar_url;
        otherUserId = otherParticipant.user_id; // Store for frontend use
      } else {
        // No other participant found - this shouldn't happen but handle gracefully
        this.logger.warn(`⚠️ No other participant found for 1:1 conversation ${conversation.id}`);
        conversationName = 'Unknown User';
      }
    }

    // AI conversation defaults
    // 🔥 FIX: Use logical OR to catch empty strings too
    if (isAI) {
      conversationName = conversationName?.trim() || 'Iko';
    }

    // 🔥 FIX: Final safety check - ensure we never return null/undefined/empty
    conversationName = conversationName?.trim() || 'Unknown User';

    // Debug logging
    this.logger.debug(`💬 Mapped conversation: id=${conversation.id}, name=${conversationName}, otherUserId=${otherUserId}, isGroup=${conversation.is_group}`);

    return {
      id: conversation.id,
      chatType: conversation.chat_type,
      name: conversationName,
      description: conversation.description,
      avatarUrl: conversationAvatar,
      isGroup: conversation.is_group,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      lastMessageAt: conversation.last_message_at,
      participants: conversation.chat_participants?.map(p => {
        const userProfile = userProfiles.find(profile => profile.id === p.user_id);
        return {
          id: p.id,
          userId: p.user_id,
          role: p.role,
          joinedAt: p.joined_at,
          isMuted: p.is_muted,
          isPinned: p.is_pinned,
          lastReadAt: p.last_read_at,
          user: userProfile ? {
            id: userProfile.id,
            username: userProfile.username,
            avatarUrl: userProfile.avatar_url,
          } : {
            id: p.user_id,
            username: 'Unknown User',
            avatarUrl: null,
          },
        };
      }) || [],
      lastMessage: lastMessage ? this.mapMessageResponse(lastMessage, undefined, userProfiles) : undefined,
      unreadCount,
      isOnline: isAI ? true : undefined, // AI (Iko) is always online
      isAI: isAI,
      isPinned: conversation.chat_participants?.some(p => p.is_pinned) || false,
      verified: isAI ? true : undefined, // AI is always verified
      metadata: conversation.metadata,
      otherUserId: otherUserId, // For 1:1 chats, the other participant's ID
    };
  }

  private mapMessageResponse(message: any, status?: MessageStatus, userProfiles: any[] = [], invoiceData?: any): MessageResponseDto {
    // Use actualSenderId from metadata if available (for AI messages), otherwise use sender_id
    const actualSenderId = message.metadata?.actualSenderId || message.sender_id;

    // Find user profile for actual sender
    const senderProfile = userProfiles.find(profile => profile.id === actualSenderId) ||
                         message.user_profiles || // Fallback to message.user_profiles if exists
                         { id: actualSenderId, username: 'Unknown User', avatar_url: null };

    const response: any = {
      id: message.id,
      conversationId: message.conversation_id,
      senderId: actualSenderId, // Use actual sender ID for frontend
      messageType: message.message_type,
      content: message.content,
      mediaUrl: message.media_url,
      fileMetadata: message.file_metadata,
      createdAt: message.created_at,
      updatedAt: message.updated_at,
      editedAt: message.edited_at,
      isDeleted: message.is_deleted,
      replyToId: message.reply_to_id,
      replyTo: message.reply_to ? this.mapMessageResponse(message.reply_to, undefined, userProfiles) : undefined,
      sender: {
        id: senderProfile.id,
        username: senderProfile.username,
        avatarUrl: senderProfile.avatar_url,
      },
      status,
      metadata: message.metadata,
    };

    // Add product data if this is a product message (bargain)
    if (message.metadata?.productData) {
      response.productData = message.metadata.productData;
    }

    // Add invoice data if this is an invoice message
    if (invoiceData) {
      response.invoiceData = {
        id: invoiceData.id,
        invoiceNumber: invoiceData.invoice_number,
        conversationId: invoiceData.conversation_id,
        messageId: invoiceData.message_id,
        vendorId: invoiceData.vendor_id,
        buyerId: invoiceData.buyer_id,
        totalAmount: invoiceData.total_amount,
        status: invoiceData.status,
        expiresAt: invoiceData.expires_at,
        paidAt: invoiceData.paid_at,
        orderId: invoiceData.order_id,
        createdAt: invoiceData.created_at,
        updatedAt: invoiceData.updated_at,
        items: (invoiceData.items || []).map(item => ({
          id: item.id,
          itemType: item.item_type,
          name: item.name,
          description: item.description,
          price: item.price,
          quantity: item.quantity,
          totalPrice: item.total_price,
          imageUrl: item.image_url,
          appointmentDate: item.appointment_date,
          appointmentTime: item.appointment_time,
          productId: item.product_id,
          serviceId: item.service_id,
        })),
      };
    }

    return response;
  }

  async markConversationAsRead(userId: string, conversationId: string, userToken?: string): Promise<void> {
    this.logger.log(`Marking conversation as read for user: ${userId}, conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // ✅ Verify user is participant and get last_read_at in a single query
      const { data: participant } = await client
        .from('chat_participants')
        .select('id, last_read_at')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      const lastReadAt = participant?.last_read_at;

      // Fetch unread messages (created after last_read_at, or all if last_read_at is null)
      let unreadMessagesQuery = client
        .from('chat_messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('is_deleted', false);

      if (lastReadAt) {
        unreadMessagesQuery = unreadMessagesQuery.gt('created_at', lastReadAt);
      }
      // If lastReadAt is null, all messages are considered unread (no filter needed)

      const { data: unreadMessages } = await unreadMessagesQuery;

      if (unreadMessages && unreadMessages.length > 0) {
        // Mark all messages as read
        const messageIds = unreadMessages.map(msg => msg.id);
        await client
          .from('message_status')
          .upsert(
            messageIds.map(messageId => ({
              message_id: messageId,
              user_id: userId,
              status: MessageStatus.READ,
              timestamp: new Date().toISOString(),
            }))
          );
      }

      // Update last read timestamp
      await client
        .from('chat_participants')
        .update({ last_read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

    } catch (error) {
      this.logger.error('Error marking conversation as read:', error);
      throw error;
    }
  }

  async archiveConversation(userId: string, conversationId: string, userToken?: string): Promise<void> {
    this.logger.log(`Archiving conversation for user: ${userId}, conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update participant record to mark as archived
      const { error } = await client
        .from('chat_participants')
        .update({ is_archived: true, archived_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error('Failed to archive conversation:', error);
        throw new Error(`Database error: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error archiving conversation:', error);
      throw error;
    }
  }

  async unarchiveConversation(userId: string, conversationId: string, userToken?: string): Promise<void> {
    this.logger.log(`Unarchiving conversation for user: ${userId}, conversation: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update participant record to mark as unarchived
      const { error } = await client
        .from('chat_participants')
        .update({ is_archived: false, archived_at: null })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error('Failed to unarchive conversation:', error);
        throw new Error(`Database error: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error unarchiving conversation:', error);
      throw error;
    }
  }

  async togglePinConversation(userId: string, conversationId: string, isPinned: boolean, userToken?: string): Promise<void> {
    this.logger.log(`Toggling pin status for user: ${userId}, conversation: ${conversationId}, isPinned: ${isPinned}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update participant record to set pin status
      const { error } = await client
        .from('chat_participants')
        .update({
          is_pinned: isPinned,
          pinned_at: isPinned ? new Date().toISOString() : null
        })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error('Failed to update pin status:', error);
        throw new Error(`Database error: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error updating pin status:', error);
      throw error;
    }
  }

  async toggleMuteConversation(userId: string, conversationId: string, isMuted: boolean, userToken?: string): Promise<void> {
    this.logger.log(`Toggling mute status for user: ${userId}, conversation: ${conversationId}, isMuted: ${isMuted}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update participant record to set mute status
      const { error } = await client
        .from('chat_participants')
        .update({
          is_muted: isMuted,
          muted_at: isMuted ? new Date().toISOString() : null
        })
        .eq('conversation_id', conversationId)
        .eq('user_id', userId);

      if (error) {
        this.logger.error('Failed to update mute status:', error);
        throw new Error(`Database error: ${error.message}`);
      }
    } catch (error) {
      this.logger.error('Error updating mute status:', error);
      throw error;
    }
  }

  async updateTypingStatus(userId: string, conversationId: string, isTyping: boolean, userToken?: string): Promise<void> {
    this.logger.log(`Updating typing status for user: ${userId}, conversation: ${conversationId}, isTyping: ${isTyping}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Verify user is participant
      const { data: participant } = await client
        .from('chat_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single();

      if (!participant) {
        throw new NotFoundException('Conversation not found or access denied');
      }

      // Store typing status in a temporary table or cache
      // For now, we'll just emit the real-time event
      // In production, you might want to store this in Redis or a temporary table

      // This would trigger the real-time notification
      // The RealtimeGateway would handle broadcasting to other participants
      this.logger.log(`Broadcasting typing status for user ${userId} in conversation ${conversationId}: ${isTyping}`);

    } catch (error) {
      this.logger.error('Error updating typing status:', error);
      throw error;
    }
  }

  async getUserStatus(requestingUserId: string, userId: string, userToken?: string): Promise<{
    userId: string;
    isOnline: boolean;
    lastSeen: string;
    isTyping?: boolean;
  }> {
    this.logger.log(`Getting status for user: ${userId}, requested by: ${requestingUserId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { data: userProfile, error } = await client
        .from('user_profiles')
        .select('id, is_online, last_seen')
        .eq('id', userId)
        .single();

      if (error || !userProfile) {
        throw new NotFoundException('User not found');
      }

      return {
        userId: userProfile.id,
        isOnline: userProfile.is_online || false,
        lastSeen: userProfile.last_seen || new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Error getting user status:', error);
      throw error;
    }
  }

  async updateUserOnlineStatus(userId: string, isOnline: boolean, userToken?: string): Promise<void> {
    this.logger.log(`Updating online status for user: ${userId}, isOnline: ${isOnline}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      const { error } = await client
        .from('user_profiles')
        .update({
          is_online: isOnline,
          last_seen: new Date().toISOString(),
        })
        .eq('id', userId);

      if (error) {
        this.logger.error('Failed to update user online status:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      // This would trigger real-time status broadcast
      this.logger.log(`Broadcasting status change for user ${userId}: ${isOnline ? 'online' : 'offline'}`);

    } catch (error) {
      this.logger.error('Error updating user online status:', error);
      throw error;
    }
  }

  async updateConversationMetadata(userId: string, conversationId: string, lastMessagePreview?: string, userToken?: string): Promise<void> {
    this.logger.log(`Updating conversation metadata for: ${conversationId}`);

    const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

    try {
      // Update conversation's last_message_at timestamp and optionally set a preview
      const updateData: any = {
        last_message_at: new Date().toISOString(),
      };

      // Only update metadata if preview is provided
      if (lastMessagePreview) {
        updateData.metadata = {
          ...{}, // Keep existing metadata
          last_message_preview: lastMessagePreview,
          last_activity: 'ai_conversation',
        };
      }

      const { error } = await client
        .from('chat_conversations')
        .update(updateData)
        .eq('id', conversationId);

      if (error) {
        this.logger.error('Failed to update conversation metadata:', error);
        throw new Error(`Database error: ${error.message}`);
      }

      this.logger.log(`Conversation metadata updated for: ${conversationId}`);
    } catch (error) {
      this.logger.error('Error updating conversation metadata:', error);
      throw error;
    }
  }

  private async notifyParticipants(conversationId: string, message: any, userToken?: string): Promise<void> {
    try {
      this.logger.log(`Creating notifications for conversation ${conversationId} about new message ${message.id}`);

      const client = userToken ? createUserSupabaseClient(this.configService, userToken) : this.supabase;

      // Get conversation details and participants
      const { data: conversation } = await client
        .from('chat_conversations')
        .select(`
          id,
          name,
          is_group,
          chat_participants (
            user_id,
            user_profiles (
              id,
              username,
              avatar_url
            )
          )
        `)
        .eq('id', conversationId)
        .single();

      if (!conversation) {
        this.logger.error(`Conversation ${conversationId} not found for notifications`);
        return;
      }

      // Get sender details
      const { data: sender } = await client
        .from('user_profiles')
        .select('id, username, avatar_url')
        .eq('id', message.sender_id)
        .single();

      if (!sender) {
        this.logger.error(`Sender ${message.sender_id} not found`);
        return;
      }

      // Create notifications for all participants except the sender
      const participants = conversation.chat_participants || [];
      const notifications: string[] = [];

      for (const participant of participants) {
        // Skip the sender - don't notify them about their own message
        if (participant.user_id === message.sender_id) {
          continue;
        }

        // Determine notification content based on conversation type
        let title: string;
        let messageText: string;

        if (conversation.is_group) {
          title = `${sender.username} in ${conversation.name || 'Group Chat'}`;
        } else {
          title = `New message from ${sender.username}`;
        }

        // Truncate message content for notification preview
        if (message.message_type === 'text') {
          messageText = message.content.length > 50
            ? message.content.substring(0, 50) + '...'
            : message.content;
        } else if (message.message_type === 'image') {
          messageText = '📷 Sent a photo';
        } else if (message.message_type === 'video') {
          messageText = '🎥 Sent a video';
        } else if (message.message_type === 'audio') {
          messageText = '🎵 Sent an audio message';
        } else if (message.message_type === 'file') {
          messageText = '📎 Sent a file';
        } else {
          messageText = 'Sent a message';
        }

        // Create notification using the helper service
        await this.notificationHelper.notifyNewMessage(
          participant.user_id,
          {
            id: sender.id,
            username: sender.username,
            avatar_url: sender.avatar_url
          },
          {
            id: message.id,
            conversation_id: conversationId,
            conversation_name: conversation.name,
            message_type: message.message_type,
            content: messageText,
            is_group: conversation.is_group
          }
        );

        notifications.push(participant.user_id);
      }

      this.logger.log(`Created ${notifications.length} chat notifications for message ${message.id}`);

    } catch (error) {
      this.logger.error('Error creating chat notifications:', error);
      // Don't throw - notification failure shouldn't break message sending
    }
  }
}